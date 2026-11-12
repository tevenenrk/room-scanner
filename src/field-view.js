// Wizualizacja pomiarów pola: kropki, kulki, kostki (woksele), strzałki
// oraz kolorowa mapa pola na płaszczyźnie przekroju.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { computeGradients, computeRange, sampleVoxels, turboColor, turboRGB, voxelize } from './fields.js';

export const FIELD_MODES = ['dots', 'spheres', 'voxels', 'arrows', 'hidden'];
export const FIELD_MODE_NAMES = {
  dots: 'Kropki',
  spheres: 'Kulki pomiaru',
  voxels: 'Kostki 3D',
  arrows: 'Strzałki',
  hidden: 'Ukryte',
};

const MAX_SPHERES = 6000;

function circleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.7, 'rgba(255,255,255,1)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(32, 32, 32, 0, Math.PI * 2);
  ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function arrowGeometry() {
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.62, 6);
  shaft.translate(0, 0.31, 0);
  const head = new THREE.ConeGeometry(0.15, 0.38, 10);
  head.translate(0, 0.81, 0);
  const g = mergeGeometries([shaft.toNonIndexed(), head.toNonIndexed()]);
  g.translate(0, -0.5, 0); // środek strzałki w środku woksela
  return g;
}

export class FieldView extends THREE.Group {
  /** @param {THREE.Plane[]} clipPlanes wspólna tablica płaszczyzn cięcia */
  constructor(clipPlanes) {
    super();
    this.name = 'field-view';
    this.clipPlanes = clipPlanes;
    this.set = null;
    this.bounds = new THREE.Box3();
    this.cfg = {
      fieldId: null, mode: 'dots', opacity: 0.9, band: { lo: 0, hi: 1, invert: false },
      pointSize: 0.035, voxelSize: 0.25, map: { axis: 'off', pos: 1 },
    };
    this.dirty = true;
    this.mapDirty = true;
    this.lastBuild = 0;
    this.lastMapBuild = 0;
    this.range = { min: 0, max: 1, count: 0 };
    this._rangeKey = '';
    this._vox = null;
    this._voxKey = '';
    this._voxTime = 0;

    this.geoms = {
      sphere: new THREE.IcosahedronGeometry(1, 1),
      box: new THREE.BoxGeometry(1, 1, 1),
      arrow: arrowGeometry(),
    };
    this.materials = {
      dots: new THREE.PointsMaterial({
        size: 0.035, vertexColors: true, map: circleTexture(), transparent: true,
        alphaTest: 0.4, sizeAttenuation: true, clippingPlanes: clipPlanes,
      }),
      inst: new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, clippingPlanes: clipPlanes }),
      map: new THREE.MeshBasicMaterial({
        side: THREE.DoubleSide, transparent: true, alphaTest: 0.02, depthWrite: false,
      }),
    };
    this.current = null; // obiekt aktualnego trybu
    this.mapMesh = null;
  }

  setData(set, bounds) {
    this.set = set;
    this.bounds.copy(bounds);
    this.dirty = this.mapDirty = true;
  }

  configure(cfg) {
    const prev = this.cfg;
    const next = { ...prev, ...cfg, map: { ...prev.map, ...(cfg.map || {}) }, band: { ...prev.band, ...(cfg.band || {}) } };
    const changed = (k) => prev[k] !== next[k];
    const bandChanged = ['lo', 'hi', 'invert'].some((k) => prev.band[k] !== next.band[k]);
    if (changed('fieldId') || changed('mode') || bandChanged || changed('voxelSize')) this.dirty = true;
    if (changed('fieldId') || changed('voxelSize') || bandChanged || prev.map.axis !== next.map.axis || prev.map.pos !== next.map.pos) this.mapDirty = true;
    this.cfg = next;
    this.applyMaterial();
  }

  /** Zmiany danych (nowe próbki). */
  markDirty() { this.dirty = this.mapDirty = true; }

  applyMaterial() {
    const o = this.cfg.opacity;
    const solid = o >= 0.99;
    const { dots, inst, map } = this.materials;
    dots.opacity = o;
    dots.size = this.cfg.pointSize;
    dots.alphaTest = Math.min(0.4, o * 0.45);
    dots.depthWrite = solid;
    inst.opacity = o;
    inst.depthWrite = solid;
    map.opacity = Math.max(0.15, o);
  }

  fieldDef() { return this.set?.field(this.cfg.fieldId); }

  getRange() {
    const k = `${this.cfg.fieldId}|${this.set?.version}`;
    if (k !== this._rangeKey && this.set) {
      this.range = computeRange(this.set, this.cfg.fieldId);
      this._rangeKey = k;
    }
    return this.range;
  }

  /** Woksele bieżącego pola; podczas rysowania odświeżane najwyżej co maxAge ms. */
  getVox(maxAge = 0) {
    const k = `${this.cfg.fieldId}|${this.cfg.voxelSize}`;
    const now = performance.now();
    const stale = this._vox?.version !== this.set.version;
    if (!this._vox || k !== this._voxKey || (stale && now - this._voxTime >= maxAge)) {
      this._vox = voxelize(this.set, this.cfg.fieldId, this.cfg.voxelSize);
      this._vox.version = this.set.version;
      this._voxKey = k;
      this._voxTime = now;
    }
    return this._vox;
  }

  /** Wartość pola w punkcie (do "sondy" pod kulką). */
  probe(p, radius) {
    if (!this.set?.count) return NaN;
    const vox = this.getVox(400);
    return sampleVoxels(vox, p.x, p.y, p.z, Math.max(radius, vox.size * 1.2));
  }

  norm(v) {
    const { min, max } = this.range;
    return (v - min) / (max - min);
  }

  /**
   * Czy wartość (znormalizowana do skali kolorów) jest widoczna.
   * Zakres [lo, hi] zostaje; z invert = true ten zakres jest wycinany.
   * Wartości poza skalą (poniżej 2. / powyżej 98. percentyla) należą do skrajnych końców.
   */
  inBand(t) {
    if (!Number.isFinite(t)) return false;
    const { lo, hi, invert } = this.cfg.band;
    const inside = (t >= lo || lo <= 0) && (t <= hi || hi >= 1);
    return invert ? !inside : inside;
  }

  update(now = performance.now(), force = false) {
    if (!this.set) return;
    if (this.dirty && (force || now - this.lastBuild > 250)) {
      this.dirty = false;
      this.lastBuild = now;
      this.rebuild();
    }
    if (this.mapDirty && (force || now - this.lastMapBuild > 500)) {
      this.mapDirty = false;
      this.lastMapBuild = now;
      this.rebuildMap();
    }
  }

  disposeCurrent() {
    if (!this.current) return;
    this.remove(this.current);
    if (this.current.isPoints) this.current.geometry.dispose();
    if (this.current.isInstancedMesh) this.current.dispose();
    this.current = null;
  }

  rebuild() {
    this.disposeCurrent();
    const { set, cfg } = this;
    const def = this.fieldDef();
    if (!def || !set.count || cfg.mode === 'hidden') return;
    this.getRange();
    const color = new THREE.Color();

    if (cfg.mode === 'dots') {
      const pos = new Float32Array(set.count * 3);
      const col = new Float32Array(set.count * 3);
      let n = 0;
      for (let i = 0; i < set.count; i++) {
        const t = this.norm(set.scalar(cfg.fieldId, i));
        if (!this.inBand(t)) continue;
        pos.set(set.positions.subarray(i * 3, i * 3 + 3), n * 3);
        turboColor(t, color).toArray(col, n * 3);
        n++;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, n * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(col.subarray(0, n * 3), 3));
      this.current = new THREE.Points(g, this.materials.dots);
    } else if (cfg.mode === 'spheres') {
      const idx = [];
      for (let i = 0; i < set.count; i++) {
        const t = this.norm(set.scalar(cfg.fieldId, i));
        if (this.inBand(t)) idx.push(i);
      }
      const stride = Math.max(1, Math.ceil(idx.length / MAX_SPHERES));
      const chosen = idx.filter((_, k) => k % stride === 0);
      const mesh = new THREE.InstancedMesh(this.geoms.sphere, this.materials.inst, Math.max(1, chosen.length));
      const m = new THREE.Matrix4();
      chosen.forEach((i, k) => {
        const r = set.radii[i] || 0.05;
        m.makeScale(r, r, r).setPosition(set.positions[i * 3], set.positions[i * 3 + 1], set.positions[i * 3 + 2]);
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, turboColor(this.norm(set.scalar(cfg.fieldId, i)), color));
      });
      mesh.count = chosen.length;
      this.current = mesh;
    } else {
      const vox = this.getVox();
      const cells = vox.cells.filter((c) => this.inBand(this.norm(c.value)));
      const isArrows = cfg.mode === 'arrows';
      const mesh = new THREE.InstancedMesh(isArrows ? this.geoms.arrow : this.geoms.box, this.materials.inst, Math.max(1, cells.length));
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const p = new THREE.Vector3();
      const dir = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      let gradScale = 1;
      if (isArrows && def.components === 1) {
        computeGradients(vox);
        const mags = vox.cells.map((c) => Math.hypot(...c.grad)).sort((a, b) => a - b);
        gradScale = mags[Math.floor(mags.length * 0.9)] || 1;
      }
      let k = 0;
      for (const c of cells) {
        const t = this.norm(c.value);
        p.set(c.x, c.y, c.z);
        if (isArrows) {
          let len;
          if (def.components === 3) {
            dir.fromArray(c.vec);
            len = 0.35 + 0.65 * Math.min(1, Math.max(0, t));
          } else {
            dir.fromArray(c.grad);
            len = 0.3 + 0.7 * Math.min(1, dir.length() / gradScale);
          }
          if (dir.lengthSq() < 1e-12) continue;
          q.setFromUnitVectors(up, dir.normalize());
          const L = vox.size * 0.95 * len;
          m.compose(p, q, s.set(L, L, L));
        } else {
          const w = vox.size * 0.86;
          m.compose(p, q.identity(), s.set(w, w, w));
        }
        mesh.setMatrixAt(k, m);
        mesh.setColorAt(k, turboColor(t, color));
        k++;
      }
      mesh.count = k;
      this.current = mesh;
    }
    if (this.current.isInstancedMesh) {
      this.current.instanceMatrix.needsUpdate = true;
      if (this.current.instanceColor) this.current.instanceColor.needsUpdate = true;
      this.current.computeBoundingSphere();
    }
    this.current.frustumCulled = false;
    this.add(this.current);
  }

  /** Mapa pola na płaszczyźnie (przekrój pola). */
  rebuildMap() {
    if (this.mapMesh) {
      this.remove(this.mapMesh);
      this.mapMesh.geometry.dispose();
      this.materials.map.map?.dispose();
      this.materials.map.map = null;
      this.mapMesh = null;
    }
    const { axis, pos } = this.cfg.map;
    if (axis === 'off' || !this.set?.count || !this.fieldDef()) return;
    this.getRange();
    const b = this.bounds;
    const size = b.getSize(new THREE.Vector3());
    // (u, v) -> punkt na płaszczyźnie
    const toWorld = {
      y: (u, v, out) => out.set(b.min.x + u * size.x, pos, b.min.z + v * size.z),
      x: (u, v, out) => out.set(pos, b.min.y + v * size.y, b.min.z + u * size.z),
      z: (u, v, out) => out.set(b.min.x + u * size.x, b.min.y + v * size.y, pos),
    }[axis];
    const extentU = axis === 'z' ? size.x : axis === 'x' ? size.z : size.x;
    const extentV = axis === 'y' ? size.z : size.y;
    const vox = this.getVox();
    const cell = vox.size / 3;
    const W = THREE.MathUtils.clamp(Math.round(extentU / cell), 8, 160);
    const H = THREE.MathUtils.clamp(Math.round(extentV / cell), 8, 160);
    const data = new Uint8Array(W * H * 4);
    const p = new THREE.Vector3();
    const radius = vox.size * 1.6;
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        toWorld((i + 0.5) / W, (j + 0.5) / H, p);
        const v = sampleVoxels(vox, p.x, p.y, p.z, radius);
        const o = (j * W + i) * 4;
        if (!Number.isFinite(v)) continue;
        const t = this.norm(v);
        const [r, g, bb] = turboRGB(t);
        data[o] = r * 255; data[o + 1] = g * 255; data[o + 2] = bb * 255;
        data[o + 3] = this.inBand(t) ? 255 : 0;
      }
    }
    const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.materials.map.map = tex;
    this.materials.map.needsUpdate = true;

    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const positions = new Float32Array(12);
    corners.forEach(([u, v], k) => toWorld(u, v, p).toArray(positions, k * 3));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.mapMesh = new THREE.Mesh(g, this.materials.map);
    this.mapMesh.renderOrder = 2;
    this.add(this.mapMesh);
  }

  dispose() {
    this.disposeCurrent();
    this.cfg.map = { ...this.cfg.map, axis: 'off' };
    this.rebuildMap();
    Object.values(this.geoms).forEach((g) => g.dispose());
    this.materials.dots.map.dispose();
    Object.values(this.materials).forEach((m) => m.dispose());
  }
}
