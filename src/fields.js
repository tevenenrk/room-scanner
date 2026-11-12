// Pomiary pól w pomieszczeniu: przechowywanie próbek, symulowany czujnik,
// mapa kolorów, uśrednianie do siatki 3D (wokseli), gradient i interpolacja.

import * as THREE from 'three';

/** Domyślne pola symulowanego czujnika. components: 1 = skalar, 3 = wektor. */
export const SIM_FIELDS = [
  { id: 'wifi', name: 'Sygnał WiFi', unit: 'dBm', components: 1, decimals: 0 },
  { id: 'mag', name: 'Pole magnetyczne', unit: 'µT', components: 3, decimals: 1 },
  { id: 'temp', name: 'Temperatura', unit: '°C', components: 1, decimals: 1 },
];

// --- mapa kolorów (Turbo, przybliżenie wielomianowe) -----------------------

export function turboRGB(t) {
  // Bez skrajnie ciemnych końców Turbo: klasyczna tęcza fiolet/niebieski -> zielony -> czerwony.
  t = 0.07 + 0.88 * Math.min(1, Math.max(0, t));
  const r = 0.13572138 + t * (4.6153926 + t * (-42.66032258 + t * (132.13108234 + t * (-152.94239396 + t * 59.28637943))));
  const g = 0.09140261 + t * (2.19418839 + t * (4.84296658 + t * (-14.18503333 + t * (4.27729857 + t * 2.82956604))));
  const b = 0.1066733 + t * (12.64194608 + t * (-60.58204836 + t * (110.36276771 + t * (-89.90310912 + t * 27.34824973))));
  return [Math.min(1, Math.max(0, r)), Math.min(1, Math.max(0, g)), Math.min(1, Math.max(0, b))];
}

/** Kolor three.js (w przestrzeni liniowej) dla t w [0, 1]. */
export function turboColor(t, target = new THREE.Color()) {
  const [r, g, b] = turboRGB(t);
  return target.setRGB(r, g, b, THREE.SRGBColorSpace);
}

export function formatValue(def, v) {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(def?.decimals ?? 1)} ${def?.unit ?? ''}`.trim();
}

// --- zbiór pomiarów ----------------------------------------------------------

export class MeasurementSet {
  constructor() {
    this.fields = [];
    this.values = {};
    this.count = 0;
    this.capacity = 0;
    this.positions = new Float32Array(0);
    this.radii = new Float32Array(0);
    this.times = new Float32Array(0);
    this.version = 0;
    this.grow(1024);
  }

  static from(stored) {
    const set = new MeasurementSet();
    if (!stored || !stored.count) {
      for (const f of stored?.fields || []) set.ensureField(f);
      return set;
    }
    set.grow(stored.count + 1024);
    for (const f of stored.fields) set.ensureField(f);
    set.positions.set(stored.positions.subarray(0, stored.count * 3));
    set.radii.set(stored.radii.subarray(0, stored.count));
    if (stored.times) set.times.set(stored.times.subarray(0, stored.count));
    for (const f of stored.fields) {
      const src = stored.values[f.id];
      if (src) set.values[f.id].set(src.subarray(0, stored.count * f.components));
    }
    set.count = stored.count;
    return set;
  }

  grow(min) {
    if (min <= this.capacity) return;
    const cap = Math.max(min, this.capacity * 2);
    const resize = (arr, n) => { const a = new Float32Array(n).fill(NaN); a.set(arr); return a; };
    this.positions = resize(this.positions, cap * 3);
    this.radii = resize(this.radii, cap);
    this.times = resize(this.times, cap);
    for (const f of this.fields) this.values[f.id] = resize(this.values[f.id], cap * f.components);
    this.capacity = cap;
  }

  field(id) { return this.fields.find((f) => f.id === id); }

  ensureField(def) {
    if (this.field(def.id)) return;
    this.fields.push({ id: def.id, name: def.name, unit: def.unit, components: def.components, decimals: def.decimals });
    this.values[def.id] = new Float32Array(this.capacity * def.components).fill(NaN);
  }

  /** reading: { [fieldId]: number | [x, y, z] } */
  add(pos, radius, reading, time = performance.now() / 1000) {
    if (this.count + 1 > this.capacity) this.grow(this.count + 1);
    const i = this.count;
    this.positions[i * 3] = pos.x; this.positions[i * 3 + 1] = pos.y; this.positions[i * 3 + 2] = pos.z;
    this.radii[i] = radius;
    this.times[i] = time;
    for (const f of this.fields) {
      const v = reading[f.id];
      const arr = this.values[f.id];
      if (f.components === 1) arr[i] = Number.isFinite(v) ? v : NaN;
      else for (let k = 0; k < f.components; k++) arr[i * f.components + k] = v ? v[k] : NaN;
    }
    this.count++;
    this.version++;
  }

  clear() {
    this.count = 0;
    this.version++;
  }

  /** Wartość skalarna próbki (dla wektorów: długość). */
  scalar(fieldId, i) {
    const f = this.field(fieldId);
    const arr = this.values[fieldId];
    if (!f) return NaN;
    if (f.components === 1) return arr[i];
    let s = 0;
    for (let k = 0; k < f.components; k++) s += arr[i * f.components + k] ** 2;
    return Math.sqrt(s);
  }

  toStorable() {
    const n = this.count;
    const values = {};
    for (const f of this.fields) values[f.id] = this.values[f.id].slice(0, n * f.components);
    return {
      fields: this.fields.map((f) => ({ ...f })),
      count: n,
      positions: this.positions.slice(0, n * 3),
      radii: this.radii.slice(0, n),
      times: this.times.slice(0, n),
      values,
    };
  }

  bounds(target = new THREE.Box3()) {
    target.makeEmpty();
    const v = new THREE.Vector3();
    for (let i = 0; i < this.count; i++) target.expandByPoint(v.fromArray(this.positions, i * 3));
    return target;
  }
}

/** Zakres wartości: najmniejszy i największy pomiar (cały pasek skali). */
export function computeRange(set, fieldId) {
  let min = Infinity, max = -Infinity, count = 0;
  for (let i = 0; i < set.count; i++) {
    const v = set.scalar(fieldId, i);
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (!count) return { min: 0, max: 1, count: 0 };
  if (max - min < 1e-6) { min -= 0.5; max += 0.5; }
  return { min, max, count };
}

// --- siatka 3D (woksele) ------------------------------------------------------

const OFF = 1024;
const key = (ix, iy, iz) => ((ix + OFF) * 2048 + (iy + OFF)) * 2048 + (iz + OFF);

/**
 * Uśrednia próbki w sześcianach o boku `size`.
 * Zwraca { size, cells: [{ix,iy,iz,x,y,z,value,vec,n}], map }.
 */
export function voxelize(set, fieldId, size) {
  const f = set.field(fieldId);
  const map = new Map();
  if (!f) return { size, cells: [], map };
  const arr = set.values[fieldId];
  const comps = f.components;
  for (let i = 0; i < set.count; i++) {
    const s = set.scalar(fieldId, i);
    if (!Number.isFinite(s)) continue;
    const x = set.positions[i * 3], y = set.positions[i * 3 + 1], z = set.positions[i * 3 + 2];
    const ix = Math.floor(x / size), iy = Math.floor(y / size), iz = Math.floor(z / size);
    const k = key(ix, iy, iz);
    let c = map.get(k);
    if (!c) {
      c = { ix, iy, iz, x: (ix + 0.5) * size, y: (iy + 0.5) * size, z: (iz + 0.5) * size, sum: 0, n: 0, vec: comps === 3 ? [0, 0, 0] : null };
      map.set(k, c);
    }
    c.sum += s;
    c.n++;
    if (comps === 3) for (let j = 0; j < 3; j++) c.vec[j] += arr[i * 3 + j];
  }
  const cells = [];
  for (const c of map.values()) {
    c.value = c.sum / c.n;
    if (c.vec) for (let j = 0; j < 3; j++) c.vec[j] /= c.n;
    cells.push(c);
  }
  return { size, cells, map };
}

/** Gradient pola skalarnego w każdym wokselu (różnice centralne). */
export function computeGradients(vox) {
  const { map, size } = vox;
  const at = (ix, iy, iz) => map.get(key(ix, iy, iz))?.value;
  for (const c of vox.cells) {
    const g = [0, 0, 0];
    const dims = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    dims.forEach(([dx, dy, dz], j) => {
      const p = at(c.ix + dx, c.iy + dy, c.iz + dz);
      const m = at(c.ix - dx, c.iy - dy, c.iz - dz);
      if (p !== undefined && m !== undefined) g[j] = (p - m) / (2 * size);
      else if (p !== undefined) g[j] = (p - c.value) / size;
      else if (m !== undefined) g[j] = (c.value - m) / size;
    });
    c.grad = g;
  }
}

/** Interpolacja (odwrotność odległości) wartości w punkcie p z wokseli w promieniu radius. */
export function sampleVoxels(vox, x, y, z, radius) {
  const { map, size } = vox;
  const r = Math.ceil(radius / size);
  const cx = Math.floor(x / size), cy = Math.floor(y / size), cz = Math.floor(z / size);
  const r2 = radius * radius;
  const eps = (size * 0.3) ** 2;
  let ws = 0, vs = 0;
  for (let ix = cx - r; ix <= cx + r; ix++) {
    for (let iy = cy - r; iy <= cy + r; iy++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const c = map.get(key(ix, iy, iz));
        if (!c) continue;
        const d2 = (c.x - x) ** 2 + (c.y - y) ** 2 + (c.z - z) ** 2;
        if (d2 > r2) continue;
        const w = 1 / (d2 + eps);
        ws += w;
        vs += w * c.value;
      }
    }
  }
  return ws > 0 ? vs / ws : NaN;
}

// --- symulowany czujnik ------------------------------------------------------

/**
 * Udaje czujnik na pilocie: wartości wynikają z wymyślonych źródeł
 * rozmieszczonych względem wymiarów pokoju. Docelowo zastąpi go czujnik
 * z Arduino o tym samym interfejsie: { fields, read(position) }.
 */
export class SimulatedSensor {
  constructor(roomBounds) {
    const b = roomBounds.clone();
    if (b.isEmpty()) b.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2.5, 2));
    const min = b.min, max = b.max;
    const size = b.getSize(new THREE.Vector3());
    const c = b.getCenter(new THREE.Vector3());
    const top = Math.max(min.y + 1, max.y);
    this.fields = SIM_FIELDS;
    this.router = new THREE.Vector3(max.x - 0.35, Math.min(top - 0.6, 1.9), c.z - size.z * 0.15);
    this.magnet = new THREE.Vector3(c.x + size.x * 0.13, 0.8, c.z - size.z * 0.24); // np. głośnik na stole
    this.magnetMoment = new THREE.Vector3(0, 0.9, 0.3); // µT·m³ (po przemnożeniu przez µ0/4π)
    this.wire = { z: min.z + 0.08, y: 0.3, current: 6 }; // kabel wzdłuż tylnej ściany (oś X)
    this.radiator = new THREE.Vector3(c.x - size.x * 0.13, 0.45, min.z + 0.15);
    this.door = new THREE.Vector3(max.x - 0.9, 1.0, max.z - 0.05);
    this.earth = new THREE.Vector3(0, -45, -19); // ok. 49 µT, inklinacja ~67° (Polska)
    this._v = new THREE.Vector3();
    this._r = new THREE.Vector3();
  }

  read(p) {
    const noise = (a) => (Math.random() - 0.5) * a;

    // WiFi: tłumienie z odległością + interferencje wielodrogowe.
    const d = Math.max(0.15, p.distanceTo(this.router));
    let wifi = -30 - 26 * Math.log10(d / 0.15) * 0.9;
    wifi += 2.6 * Math.sin(p.x * 31 + p.z * 17) * Math.cos(p.y * 23 - p.z * 11);
    if (p.x > this.router.x - 0.6 && p.z > this.router.z + 0.6) wifi -= 6; // "cień" za szafą
    wifi += noise(1.5);

    // Pole magnetyczne: pole Ziemi + dipol (głośnik) + przewód z prądem.
    const B = this._v.copy(this.earth);
    const r = this._r.subVectors(p, this.magnet);
    const rl = Math.max(0.07, r.length());
    r.divideScalar(rl);
    const m = this.magnetMoment;
    const mdotr = m.dot(r);
    B.x += (3 * mdotr * r.x - m.x) / rl ** 3;
    B.y += (3 * mdotr * r.y - m.y) / rl ** 3;
    B.z += (3 * mdotr * r.z - m.z) / rl ** 3;
    const wy = p.y - this.wire.y, wz = p.z - this.wire.z;
    const wr = Math.max(0.05, Math.hypot(wy, wz));
    const bw = (0.2 * this.wire.current) / wr; // µT
    // przewód wzdłuż +X: kierunek B = x̂ × r̂ = (0, -wz, wy) / r
    B.y += (bw * -wz) / wr;
    B.z += (bw * wy) / wr;
    const mag = [B.x + noise(0.4), B.y + noise(0.4), B.z + noise(0.4)];

    // Temperatura: cieplej wyżej, kaloryfer pod oknem, chłód od drzwi.
    let temp = 20.5 + 0.9 * p.y;
    const dx = p.x - this.radiator.x, dz = p.z - this.radiator.z;
    const rise = Math.max(0, p.y - 0.2);
    temp += 7 * Math.exp(-(dx * dx) / (0.35 + 0.2 * rise) - (dz * dz) / (0.12 + 0.25 * rise)) * Math.exp(-rise * 0.35);
    temp -= 2.5 * Math.exp(-p.distanceToSquared(this.door) / 0.5);
    temp += noise(0.15);

    return { wifi, mag, temp };
  }
}

// --- przykładowe pomiary ------------------------------------------------------

/** Generuje pomiary tak, jakby ktoś "malował" pokój kulką czujnika. */
export function makeDemoMeasurements(roomBounds, { spacing = 0.06, radius = 0.08 } = {}) {
  const sensor = new SimulatedSensor(roomBounds);
  const set = new MeasurementSet();
  for (const f of sensor.fields) set.ensureField(f);
  const b = roomBounds;
  const m = 0.3;
  const p = new THREE.Vector3();
  let t = 0;
  const add = () => { set.add(p, radius, sensor.read(p), t); t += 0.05; };

  // poziome "zamiatanie" na kilku wysokościach
  const top = Math.min(b.max.y - 0.3, 2.1);
  for (const h of [0.35, 0.85, 1.35, top]) {
    let dir = 1;
    for (let z = b.min.z + m; z <= b.max.z - m; z += 0.38) {
      const x0 = dir > 0 ? b.min.x + m : b.max.x - m;
      const x1 = dir > 0 ? b.max.x - m : b.min.x + m;
      const steps = Math.ceil(Math.abs(x1 - x0) / spacing);
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        p.set(x, h + 0.08 * Math.sin(x * 5 + z * 3), z + 0.06 * Math.sin(x * 7));
        add();
      }
      dir = -dir;
    }
  }
  // pionowe pociągnięcia w kilku miejscach
  for (let x = b.min.x + 0.5; x <= b.max.x - 0.4; x += 0.9) {
    for (let z = b.min.z + 0.5; z <= b.max.z - 0.4; z += 0.9) {
      for (let y = 0.2; y <= top; y += spacing) {
        p.set(x + 0.05 * Math.sin(y * 9), y, z + 0.05 * Math.cos(y * 7));
        add();
      }
    }
  }
  return set;
}
