// Model danych skanu + budowanie obiektów three.js do wyświetlania.
//
// Skan (scan) to zwykły obiekt, który da się zapisać w IndexedDB:
// {
//   id, name, createdAt (ms), source: 'quest' | 'demo' | 'import',
//   objects: [{ kind: 'mesh' | 'plane', label: string,
//               positions: Float32Array (xyz, metry, przestrzeń 'local-floor'),
//               indices: Uint32Array (trójkąty) }]
// }
// Podłoga skanu leży na y = 0, bo zbieramy dane w przestrzeni 'local-floor'.

import * as THREE from 'three';
import { makeDemoMeasurements } from './fields.js';

export const LAYERS = /** @type {const} */ (['global', 'objects', 'planes']);

export const LAYER_NAMES = {
  global: 'Siatka pokoju',
  objects: 'Meble (bryły)',
  planes: 'Płaszczyzny (ściany, podłoga)',
};

const LABEL_COLORS = [
  ['floor', '#8f9c7a'],
  ['ceiling', '#e9e6df'],
  ['wall', '#d6cfc0'],
  ['door', '#a8683c'],
  ['window', '#7cc3e6'],
  ['table', '#b9814f'],
  ['desk', '#b9814f'],
  ['couch', '#6c80b8'],
  ['sofa', '#6c80b8'],
  ['bed', '#9273b8'],
  ['screen', '#4a4f5c'],
  ['monitor', '#4a4f5c'],
  ['lamp', '#f0cf62'],
  ['plant', '#5da35d'],
  ['storage', '#c79c6a'],
  ['shelf', '#c79c6a'],
  ['art', '#d9739b'],
];
const DEFAULT_COLOR = '#b4b4b4';

export function colorForLabel(label) {
  const l = (label || '').toLowerCase();
  for (const [key, color] of LABEL_COLORS) if (l.includes(key)) return new THREE.Color(color);
  return new THREE.Color(DEFAULT_COLOR);
}

export function layerOf(obj) {
  if (obj.kind === 'plane') return 'planes';
  if ((obj.label || '').toLowerCase().includes('global')) return 'global';
  return 'objects';
}

export function newScanId() {
  return `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function defaultScanName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Pokój ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createScan({ name, source, objects }) {
  return {
    id: newScanId(),
    name: name || defaultScanName(),
    createdAt: Date.now(),
    source,
    objects: objects.filter((o) => o.positions.length >= 9 && o.indices.length >= 3),
  };
}

function triangleArea(p, a, b, c) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
}

function objectArea(obj) {
  let area = 0;
  const { positions: p, indices: idx } = obj;
  for (let i = 0; i + 2 < idx.length; i += 3) area += triangleArea(p, idx[i], idx[i + 1], idx[i + 2]);
  return area;
}

export function scanStats(scan) {
  let vertices = 0, triangles = 0, area = 0;
  const layers = { global: 0, objects: 0, planes: 0 };
  for (const o of scan.objects) {
    vertices += o.positions.length / 3;
    triangles += Math.floor(o.indices.length / 3);
    area += objectArea(o);
    layers[layerOf(o)]++;
  }
  return { objects: scan.objects.length, vertices, triangles, area, layers };
}

export function scanBounds(scan) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const o of scan.objects) {
    const p = o.positions;
    for (let i = 0; i < p.length; i += 3) box.expandByPoint(v.set(p[i], p[i + 1], p[i + 2]));
  }
  if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  return box;
}

/** Kolory wierzchołków: meble/płaszczyzny wg etykiety, globalna siatka gradientem wysokości. */
export function vertexColorsFor(obj) {
  const p = obj.positions;
  const out = new Float32Array(p.length);
  if (layerOf(obj) === 'global') {
    const low = new THREE.Color('#b79f82');
    const mid = new THREE.Color('#d9d3c7');
    const high = new THREE.Color('#9fb6cf');
    const c = new THREE.Color();
    for (let i = 0; i < p.length; i += 3) {
      const t = THREE.MathUtils.clamp(p[i + 1] / 2.6, 0, 1);
      if (t < 0.5) c.lerpColors(low, mid, t * 2);
      else c.lerpColors(mid, high, (t - 0.5) * 2);
      out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b;
    }
  } else {
    const c = colorForLabel(obj.label);
    for (let i = 0; i < p.length; i += 3) { out[i] = c.r; out[i + 1] = c.g; out[i + 2] = c.b; }
  }
  return out;
}

export function geometryFor(obj) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(obj.positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(vertexColorsFor(obj), 3));
  g.setIndex(new THREE.BufferAttribute(obj.indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Losuje punkty równomiernie na powierzchni obiektów (chmura punktów).
 * Zwraca { positions, normals, colors } jako Float32Array.
 */
export function samplePointCloud(objects, { maxPoints = 250000, density = 1500 } = {}) {
  const areas = objects.map(objectArea);
  const total = areas.reduce((a, b) => a + b, 0) || 1;
  const d = Math.min(density, maxPoints / total);
  const rand = mulberry32(12345);
  const pos = [], nor = [], col = [];
  const light = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  objects.forEach((obj) => {
    const p = obj.positions, idx = obj.indices;
    const colors = vertexColorsFor(obj);
    for (let i = 0; i + 2 < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      const area = triangleArea(p, a, b, c);
      const expected = area * d;
      let count = Math.floor(expected);
      if (rand() < expected - count) count++;
      if (!count) continue;
      A.fromArray(p, a * 3); B.fromArray(p, b * 3); C.fromArray(p, c * 3);
      n.crossVectors(e1.subVectors(B, A), e2.subVectors(C, A)).normalize();
      const shade = 0.55 + 0.45 * Math.abs(n.dot(light));
      for (let k = 0; k < count; k++) {
        let u = rand(), v = rand();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const w = 1 - u - v;
        pos.push(A.x * w + B.x * u + C.x * v, A.y * w + B.y * u + C.y * v, A.z * w + B.z * u + C.z * v);
        nor.push(n.x, n.y, n.z);
        for (let ch = 0; ch < 3; ch++) {
          col.push((colors[a * 3 + ch] * w + colors[b * 3 + ch] * u + colors[c * 3 + ch] * v) * shade);
        }
      }
    }
  });
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), colors: new Float32Array(col) };
}

/**
 * Grupa three.js z całym skanem. Obsługuje tryby wyświetlania
 * ('solid' | 'wire' | 'points') i widoczność warstw.
 */
export class RoomModel extends THREE.Group {
  constructor(scan) {
    super();
    this.name = 'room-model';
    this.scan = scan;
    this.mode = 'solid';
    this.opacity = 1;
    this.entries = [];
    this.pointsByLayer = {};
    this.hasGlobal = scan.objects.some((o) => layerOf(o) === 'global');
    this.visibleLayers = {
      global: true,
      objects: true,
      planes: !this.hasGlobal,
    };

    const common = { vertexColors: true, side: THREE.DoubleSide };
    this.materials = {
      solid: new THREE.MeshStandardMaterial({
        ...common, flatShading: true, roughness: 0.95, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }),
      solidGhost: new THREE.MeshStandardMaterial({
        ...common, flatShading: true, roughness: 0.95, metalness: 0,
        transparent: true, opacity: 0.4, depthWrite: false,
      }),
      wire: new THREE.MeshBasicMaterial({ ...common, wireframe: true }),
      edges: new THREE.LineBasicMaterial({ vertexColors: true }),
      points: new THREE.PointsMaterial({ vertexColors: true, size: 0.012, sizeAttenuation: true }),
    };

    for (const obj of scan.objects) {
      const layer = layerOf(obj);
      const geometry = geometryFor(obj);
      // Meble nachodzą na globalną siatkę, więc pokazujemy je półprzezroczyste.
      const ghost = layer === 'objects' && this.hasGlobal;
      const solid = new THREE.Mesh(geometry, ghost ? this.materials.solidGhost : this.materials.solid);
      solid.name = obj.label;
      const wire = new THREE.Mesh(geometry, this.materials.wire);
      let edges = null;
      if (layer !== 'global') {
        const eg = new THREE.EdgesGeometry(geometry, 20);
        const c = colorForLabel(obj.label);
        const colors = new Float32Array(eg.attributes.position.count * 3);
        for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
        eg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        edges = new THREE.LineSegments(eg, this.materials.edges);
      }
      this.add(solid, wire);
      if (edges) this.add(edges);
      this.entries.push({ obj, layer, solid, wire, edges });
    }
    this.apply();
  }

  setMode(mode) {
    this.mode = mode;
    this.apply();
  }

  /** Wspólna tablica płaszczyzn cięcia (przekroje). */
  setClippingPlanes(planes) {
    for (const m of Object.values(this.materials)) m.clippingPlanes = planes;
  }

  /** Przezroczystość całego pokoju (1 = nieprzezroczysty). */
  setOpacity(opacity) {
    if (this.opacity === opacity) return;
    this.opacity = opacity;
    const transparent = opacity < 0.99;
    for (const [name, m] of Object.entries(this.materials)) {
      const base = name === 'solidGhost' ? 0.4 : 1;
      const wasTransparent = m.transparent;
      m.opacity = base * opacity;
      m.transparent = transparent || name === 'solidGhost';
      m.depthWrite = !m.transparent;
      if (wasTransparent !== m.transparent) m.needsUpdate = true;
    }
  }

  setLayerVisible(layer, visible) {
    this.visibleLayers[layer] = visible;
    this.apply();
  }

  /** Obiekty skanu z widocznych warstw (np. do eksportu chmury punktów). */
  visibleObjects() {
    return this.entries.filter((e) => this.visibleLayers[e.layer]).map((e) => e.obj);
  }

  pointsFor(layer) {
    if (!this.pointsByLayer[layer]) {
      const objs = this.entries.filter((e) => e.layer === layer).map((e) => e.obj);
      const cloud = samplePointCloud(objs, { maxPoints: 200000 });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3));
      const pts = new THREE.Points(g, this.materials.points);
      pts.name = `points-${layer}`;
      this.add(pts);
      this.pointsByLayer[layer] = pts;
    }
    return this.pointsByLayer[layer];
  }

  apply() {
    for (const e of this.entries) {
      const on = this.visibleLayers[e.layer];
      e.solid.visible = on && this.mode === 'solid';
      e.wire.visible = on && this.mode === 'wire';
      if (e.edges) e.edges.visible = on && this.mode === 'solid';
    }
    for (const layer of LAYERS) {
      const has = this.entries.some((e) => e.layer === layer);
      if (!has) continue;
      const wantPoints = this.mode === 'points' && this.visibleLayers[layer];
      if (wantPoints) this.pointsFor(layer).visible = true;
      else if (this.pointsByLayer[layer]) this.pointsByLayer[layer].visible = false;
    }
  }

  dispose() {
    this.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    for (const m of Object.values(this.materials)) m.dispose();
  }
}

// ---------------------------------------------------------------------------
// Przykładowy pokój – do testów bez gogli.

function boxObject(label, cx, cy, cz, sx, sy, sz, kind = 'mesh') {
  const g = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  g.translate(cx, cy, cz);
  const positions = new Float32Array(g.attributes.position.array);
  const indices = new Uint32Array(positions.length / 3).map((_, i) => i);
  return { kind, label, positions, indices };
}

function planeObject(label, w, h, matrix) {
  const g = new THREE.PlaneGeometry(w, h, 1, 1);
  g.applyMatrix4(matrix);
  return {
    kind: 'plane', label,
    positions: new Float32Array(g.attributes.position.array),
    indices: new Uint32Array(g.index.array),
  };
}

export function makeDemoScan() {
  const W = 4.6, D = 3.8, H = 2.6;
  const R = (x, y, z) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z));
  const objects = [
    planeObject('floor', W, D, R(-Math.PI / 2, 0, 0)),
    planeObject('ceiling', W, D, new THREE.Matrix4().makeTranslation(0, H, 0).multiply(R(Math.PI / 2, 0, 0))),
    planeObject('wall', W, H, new THREE.Matrix4().makeTranslation(0, H / 2, -D / 2)),
    planeObject('wall', W, H, new THREE.Matrix4().makeTranslation(0, H / 2, D / 2).multiply(R(0, Math.PI, 0))),
    planeObject('wall', D, H, new THREE.Matrix4().makeTranslation(-W / 2, H / 2, 0).multiply(R(0, Math.PI / 2, 0))),
    planeObject('wall', D, H, new THREE.Matrix4().makeTranslation(W / 2, H / 2, 0).multiply(R(0, -Math.PI / 2, 0))),
    planeObject('door frame', 0.9, 2.05, new THREE.Matrix4().makeTranslation(1.4, 1.025, D / 2 - 0.01).multiply(R(0, Math.PI, 0))),
    planeObject('window frame', 1.4, 1.2, new THREE.Matrix4().makeTranslation(-0.6, 1.5, -D / 2 + 0.01)),
    boxObject('table', 0.6, 0.375, -0.9, 1.4, 0.75, 0.8),
    boxObject('couch', -1.5, 0.42, 0.6, 0.95, 0.85, 2.1),
    boxObject('storage', 1.95, 0.9, -0.6, 0.55, 1.8, 1.2),
    boxObject('lamp', -1.8, 0.8, -1.5, 0.35, 1.6, 0.35),
  ];

  // "Globalna siatka" – zaszumiona skorupa pokoju + meble, jak z Quest Space Setup.
  const parts = [];
  const shell = new THREE.BoxGeometry(W, H, D, 24, 14, 20);
  shell.translate(0, H / 2, 0);
  parts.push(shell);
  for (const o of objects.filter((x) => x.kind === 'mesh')) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(o.positions.slice(), 3));
    parts.push(g);
  }
  const rand = mulberry32(7);
  const pos = [], idx = [];
  for (const geo of parts) {
    const base = pos.length / 3;
    const p = geo.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      const noise = () => (rand() - 0.5) * 0.03;
      pos.push(p[i] + noise(), Math.max(0, p[i + 1] + noise()), p[i + 2] + noise());
    }
    if (geo.index) for (const v of geo.index.array) idx.push(base + v);
    else for (let i = 0; i < p.length / 3; i++) idx.push(base + i);
  }
  objects.push({ kind: 'mesh', label: 'global mesh', positions: new Float32Array(pos), indices: new Uint32Array(idx) });

  const scan = createScan({ name: 'Przykładowy pokój z pomiarami (demo)', source: 'demo', objects });
  scan.measurements = makeDemoMeasurements(scanBounds(scan)).toStorable();
  return scan;
}
