// Eksport / import skanów: GLB (model 3D), PLY (chmura punktów), JSON (format aplikacji).

import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createScan, geometryFor, samplePointCloud } from './scan-model.js';

// Tylko ASCII: Chromium potrafi zignorować nazwę pliku z polskimi znakami.
export function safeFileName(name) {
  return (name || 'skan')
    .replace(/ł/g, 'l').replace(/Ł/g, 'L')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'skan';
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// --- GLB --------------------------------------------------------------------

export async function exportGLB(scan) {
  const scene = new THREE.Scene();
  scene.name = scan.name;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.95, metalness: 0,
  });
  scan.objects.forEach((obj, i) => {
    const mesh = new THREE.Mesh(geometryFor(obj), material);
    mesh.name = `${obj.label || obj.kind}_${i}`;
    mesh.userData = { kind: obj.kind, label: obj.label };
    scene.add(mesh);
  });
  scene.userData = { app: 'room-scanner', name: scan.name, createdAt: scan.createdAt };
  const buffer = await new GLTFExporter().parseAsync(scene, { binary: true });
  scene.traverse((o) => o.geometry?.dispose());
  material.dispose();
  return new Blob([buffer], { type: 'model/gltf-binary' });
}

export async function importGLB(arrayBuffer, name) {
  const gltf = await new GLTFLoader().parseAsync(arrayBuffer, '');
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const objects = [];
  const v = new THREE.Vector3();
  root.traverse((node) => {
    if (!node.isMesh || !node.geometry?.attributes.position) return;
    const attr = node.geometry.attributes.position;
    const positions = new Float32Array(attr.count * 3);
    for (let i = 0; i < attr.count; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(node.matrixWorld);
      positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
    }
    const indices = node.geometry.index
      ? Uint32Array.from(node.geometry.index.array)
      : Uint32Array.from({ length: attr.count }, (_, i) => i);
    const label = node.userData.label || node.name || 'global mesh';
    const kind = node.userData.kind === 'plane' ? 'plane' : 'mesh';
    objects.push({ kind, label, positions, indices });
  });
  if (!objects.length) throw new Error('Plik GLB nie zawiera żadnych siatek.');
  const scan = createScan({ name: root.userData?.name || name, source: 'import', objects });
  if (typeof root.userData?.createdAt === 'number') scan.createdAt = root.userData.createdAt;
  return scan;
}

// --- PLY (chmura punktów) ---------------------------------------------------

export function exportPLY(objects) {
  const cloud = samplePointCloud(objects, { maxPoints: 1_000_000, density: 2500 });
  const n = cloud.positions.length / 3;
  const header =
    'ply\nformat binary_little_endian 1.0\ncomment room-scanner point cloud (metry, Y w gore)\n' +
    `element vertex ${n}\n` +
    'property float x\nproperty float y\nproperty float z\n' +
    'property float nx\nproperty float ny\nproperty float nz\n' +
    'property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const headerBytes = new TextEncoder().encode(header);
  const stride = 6 * 4 + 3;
  const body = new DataView(new ArrayBuffer(n * stride));
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    for (let k = 0; k < 3; k++) {
      body.setFloat32(o + k * 4, cloud.positions[i * 3 + k], true);
      body.setFloat32(o + 12 + k * 4, cloud.normals[i * 3 + k], true);
      body.setUint8(o + 24 + k, Math.round(THREE.MathUtils.clamp(cloud.colors[i * 3 + k], 0, 1) * 255));
    }
  }
  return { blob: new Blob([headerBytes, body.buffer], { type: 'application/octet-stream' }), points: n };
}

// --- JSON (format aplikacji, bezstratny) -----------------------------------

function toBase64(typed) {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer);
}

export function exportJSON(scan) {
  const data = {
    format: 'room-scanner',
    version: 1,
    name: scan.name,
    createdAt: scan.createdAt,
    source: scan.source,
    objects: scan.objects.map((o) => ({
      kind: o.kind,
      label: o.label,
      positions: toBase64(o.positions),
      indices: toBase64(o.indices),
    })),
    reference: scan.reference || null,
    bounded: scan.bounded || null,
    measurements: scan.measurements?.count ? {
      fields: scan.measurements.fields,
      count: scan.measurements.count,
      positions: toBase64(scan.measurements.positions),
      radii: toBase64(scan.measurements.radii),
      times: toBase64(scan.measurements.times),
      values: Object.fromEntries(Object.entries(scan.measurements.values).map(([k, v]) => [k, toBase64(v)])),
    } : null,
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export function importJSON(text) {
  const data = JSON.parse(text);
  if (data.format !== 'room-scanner') throw new Error('To nie jest plik skanu room-scanner.');
  const scan = createScan({
    name: data.name,
    source: data.source || 'import',
    objects: data.objects.map((o) => ({
      kind: o.kind === 'plane' ? 'plane' : 'mesh',
      label: o.label,
      positions: fromBase64(o.positions, Float32Array),
      indices: fromBase64(o.indices, Uint32Array),
    })),
  });
  if (data.createdAt) scan.createdAt = data.createdAt;
  if (data.reference) scan.reference = data.reference;
  if (data.bounded) scan.bounded = data.bounded;
  const m = data.measurements;
  if (m?.count) {
    scan.measurements = {
      fields: m.fields,
      count: m.count,
      positions: fromBase64(m.positions, Float32Array),
      radii: fromBase64(m.radii, Float32Array),
      times: m.times ? fromBase64(m.times, Float32Array) : new Float32Array(m.count),
      values: Object.fromEntries(Object.entries(m.values).map(([k, v]) => [k, fromBase64(v, Float32Array)])),
    };
  }
  return scan;
}

// --- PLY z pomiarami (CloudCompare: każde pole jako "scalar field") ---------

export function exportMeasurementsPLY(set) {
  const n = set.count;
  const props = [['x'], ['y'], ['z'], ['radius']];
  for (const f of set.fields) {
    if (f.components === 1) props.push([f.id, f.id, 0]);
    else props.push([`${f.id}_x`, f.id, 0], [`${f.id}_y`, f.id, 1], [`${f.id}_z`, f.id, 2], [`${f.id}_magnitude`, f.id, -1]);
  }
  const header = 'ply\nformat binary_little_endian 1.0\ncomment room-scanner pomiary pol\n'
    + set.fields.map((f) => `comment field ${f.id}: ${f.name} [${f.unit}]\n`).join('')
    + `element vertex ${n}\n` + props.map((p) => `property float ${p[0]}\n`).join('') + 'end_header\n';
  // PLY: nagłówek ASCII – zamieniamy znaki spoza ASCII (np. µ, °)
  const headerAscii = header.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ł/g, 'l').replace(/µ/g, 'u').replace(/°/g, 'deg').replace(/[^\x00-\x7f]/g, '?');
  const body = new DataView(new ArrayBuffer(n * props.length * 4));
  let o = 0;
  for (let i = 0; i < n; i++) {
    for (const p of props) {
      let v;
      if (p[0] === 'x' || p[0] === 'y' || p[0] === 'z') v = set.positions[i * 3 + 'xyz'.indexOf(p[0])];
      else if (p[0] === 'radius') v = set.radii[i];
      else if (p[2] === -1) v = set.scalar(p[1], i);
      else {
        const f = set.field(p[1]);
        v = set.values[p[1]][i * f.components + p[2]];
      }
      body.setFloat32(o, v, true);
      o += 4;
    }
  }
  return new Blob([new TextEncoder().encode(headerAscii), body.buffer], { type: 'application/octet-stream' });
}

export async function importFile(file) {
  const base = file.name.replace(/\.[^.]+$/, '');
  if (/\.glb$/i.test(file.name)) return importGLB(await file.arrayBuffer(), base);
  if (/\.json$/i.test(file.name)) return importJSON(await file.text());
  throw new Error('Obsługiwane pliki: .glb (model 3D) i .json (eksport z tej aplikacji).');
}
