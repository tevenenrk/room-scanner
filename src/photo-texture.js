// Nakładanie zdjęć z gogli na siatkę skanu ("tekstura" jako kolory gęstej siatki).
//
// 1. Siatka pokoju jest dzielona na małe trójkąty (ok. 4–6 cm).
// 2. Dla każdego zdjęcia liczymy mapę głębi z jego punktu widzenia (GPU), żeby wiedzieć,
//    co było zasłonięte (np. podłoga za stołem nie dostanie koloru stołu).
// 3. Każdy wierzchołek bierze kolor ze zdjęć, które widziały go najbardziej "na wprost"
//    i z bliska (mieszanie kilku najlepszych, żeby zatrzeć szwy).

import * as THREE from 'three';
import { layerOf } from './scan-model.js';
import { projFromFov } from './photo-capture.js';

const DEPTH_FAR = 20; // m
const DEPTH_W = 256;

const depthMaterial = () => new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: `
    varying float vDepth;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vDepth = -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying float vDepth;
    void main() {
      float v = clamp(vDepth / ${DEPTH_FAR.toFixed(1)}, 0.0, 0.9999);
      vec3 enc = fract(v * vec3(1.0, 255.0, 65025.0));
      enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
      gl_FragColor = vec4(enc, 1.0);
    }`,
});

const tick = () => new Promise((r) => setTimeout(r, 0));

async function decodePhoto(p) {
  const bmp = await createImageBitmap(p.blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** Obiekty skanu, na które nakładamy zdjęcia: siatka pokoju, a gdy jej brak – płaszczyzny. */
export function photoTargets(scan) {
  const global = scan.objects.filter((o) => layerOf(o) === 'global');
  return global.length ? global : scan.objects.filter((o) => layerOf(o) === 'planes');
}

/** Dzieli trójkąty na siatkę o boku ~edge. Zwraca { positions, indices, normals(na wierzchołek) }. */
function subdivide(objects, edge) {
  const pos = [], idx = [], nor = [];
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  for (const o of objects) {
    const p = o.positions, ix = o.indices;
    for (let t = 0; t + 2 < ix.length; t += 3) {
      A.fromArray(p, ix[t] * 3); B.fromArray(p, ix[t + 1] * 3); C.fromArray(p, ix[t + 2] * 3);
      n.crossVectors(e1.subVectors(B, A), e2.subVectors(C, A));
      if (n.lengthSq() < 1e-12) continue;
      n.normalize();
      const longest = Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A));
      const k = Math.min(64, Math.max(1, Math.ceil(longest / edge)));
      const base = pos.length / 3;
      const id = (i, j) => base + (i * (2 * k + 3 - i)) / 2 + j; // wiersz i ma (k - i + 1) wierzchołków
      for (let i = 0; i <= k; i++) {
        for (let j = 0; j <= k - i; j++) {
          const u = i / k, v = j / k;
          pos.push(A.x + (B.x - A.x) * u + (C.x - A.x) * v, A.y + (B.y - A.y) * u + (C.y - A.y) * v, A.z + (B.z - A.z) * u + (C.z - A.z) * v);
          nor.push(n.x, n.y, n.z);
        }
      }
      for (let i = 0; i < k; i++) {
        for (let j = 0; j < k - i; j++) {
          idx.push(id(i, j), id(i + 1, j), id(i, j + 1));
          if (j < k - i - 1) idx.push(id(i + 1, j), id(i + 1, j + 1), id(i, j + 1));
        }
      }
    }
  }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx), normals: new Float32Array(nor) };
}

function estimateTriangles(objects, edge) {
  let total = 0;
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  for (const o of objects) {
    for (let t = 0; t + 2 < o.indices.length; t += 3) {
      A.fromArray(o.positions, o.indices[t] * 3); B.fromArray(o.positions, o.indices[t + 1] * 3); C.fromArray(o.positions, o.indices[t + 2] * 3);
      const k = Math.min(64, Math.max(1, Math.ceil(Math.max(A.distanceTo(B), B.distanceTo(C), C.distanceTo(A)) / edge)));
      total += k * k;
    }
  }
  return total;
}

/**
 * Nakłada zdjęcia na skan. Zwraca photoMesh = { positions, indices, colors (Uint8 RGB, sRGB), photos, bakedAt }.
 * opts.fovH – poprawiony kąt widzenia dla zdjęć przybliżonych (getUserMedia).
 */
export async function bakePhotoMesh(renderer, scan, { fovH = null, maxTriangles = 300000, edge = 0.045, onProgress } = {}) {
  const photos = scan.photos || [];
  if (!photos.length) throw new Error('Brak zdjęć do nałożenia.');
  const targets = photoTargets(scan);
  if (!targets.length) throw new Error('Skan nie ma siatki, na którą można nałożyć zdjęcia.');
  onProgress?.('Wczytuję zdjęcia…', 0);

  // Kamery zdjęć.
  const cams = [];
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const img = await decodePhoto(p);
    const world = new THREE.Matrix4().fromArray(p.matrix);
    const proj = new THREE.Matrix4().fromArray(p.approx && fovH ? projFromFov(fovH, p.approx.aspect) : p.proj);
    const view = world.clone().invert();
    cams.push({
      img, world, view, proj,
      viewProj: proj.clone().multiply(view),
      pos: new THREE.Vector3().setFromMatrixPosition(world),
      depth: null, dw: 0, dh: 0,
    });
    if (i % 8 === 0) { onProgress?.(`Wczytuję zdjęcia… ${i + 1}/${photos.length}`, 0.1 * (i / photos.length)); await tick(); }
  }

  // Mapy głębi (co było widać z każdego zdjęcia).
  const depthScene = new THREE.Scene();
  const dMat = depthMaterial();
  for (const o of targets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(o.positions, 3));
    g.setIndex(new THREE.BufferAttribute(o.indices, 1));
    depthScene.add(new THREE.Mesh(g, dMat));
  }
  const prevXR = renderer.xr.enabled;
  const prevRT = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevPlanes = renderer.clippingPlanes;
  renderer.xr.enabled = false;
  renderer.clippingPlanes = [];
  renderer.setClearColor(0x000000, 0);
  const cam = new THREE.Camera();
  cam.matrixAutoUpdate = false;
  for (let i = 0; i < cams.length; i++) {
    const c = cams[i];
    const dw = DEPTH_W, dh = Math.max(1, Math.round((DEPTH_W * c.img.height) / c.img.width));
    const rt = new THREE.WebGLRenderTarget(dw, dh, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    cam.projectionMatrix.copy(c.proj);
    cam.projectionMatrixInverse.copy(c.proj).invert();
    cam.matrixWorld.copy(c.world);
    cam.matrixWorldInverse.copy(c.view);
    renderer.setRenderTarget(rt);
    renderer.clear();
    renderer.render(depthScene, cam);
    const px = new Uint8Array(dw * dh * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, dw, dh, px);
    rt.dispose();
    const depth = new Float32Array(dw * dh); // 0 = brak powierzchni
    for (let k = 0; k < dw * dh; k++) {
      depth[k] = px[k * 4 + 3] ? (px[k * 4] / 255 + px[k * 4 + 1] / 65025 + px[k * 4 + 2] / 16581375) * DEPTH_FAR : 0;
    }
    Object.assign(c, { depth, dw, dh });
  }
  renderer.setRenderTarget(prevRT);
  renderer.setClearColor(prevClear, prevAlpha);
  renderer.clippingPlanes = prevPlanes;
  renderer.xr.enabled = prevXR;
  depthScene.traverse((o) => o.geometry?.dispose());
  dMat.dispose();
  onProgress?.('Dzielę siatkę…', 0.2);
  await tick();

  // Gęsta siatka.
  let e = edge;
  const est = estimateTriangles(targets, e);
  if (est > maxTriangles) e *= Math.sqrt(est / maxTriangles);
  const mesh = subdivide(targets, e);
  const nv = mesh.positions.length / 3;
  const colors = new Uint8Array(nv * 3);

  // Kolory wierzchołków.
  const P = mesh.positions, N = mesh.normals;
  const best = [0, 0, 0], bestW = [0, 0, 0]; // trzy najlepsze zdjęcia
  const rgb = [0, 0, 0];
  const sample = (img, u, v, out) => {
    const x = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
    const y = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
    const x0 = x | 0, y0 = y | 0, x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
    const fx = x - x0, fy = y - y0, d = img.data, W = img.width;
    for (let ch = 0; ch < 3; ch++) {
      const a = d[(y0 * W + x0) * 4 + ch], b = d[(y0 * W + x1) * 4 + ch];
      const c = d[(y1 * W + x0) * 4 + ch], dd = d[(y1 * W + x1) * 4 + ch];
      out[ch] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + dd * fx) * fy;
    }
  };
  const chunk = 4000;
  let seen = 0;
  for (let vtx = 0; vtx < nv; vtx++) {
    const x = P[vtx * 3], y = P[vtx * 3 + 1], z = P[vtx * 3 + 2];
    const nx = N[vtx * 3], ny = N[vtx * 3 + 1], nz = N[vtx * 3 + 2];
    bestW[0] = bestW[1] = bestW[2] = 0;
    for (let ci = 0; ci < cams.length; ci++) {
      const c = cams[ci];
      const m = c.viewProj.elements;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0.1) continue; // za kamerą / za blisko
      const ndcX = (m[0] * x + m[4] * y + m[8] * z + m[12]) / cw;
      const ndcY = (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw;
      if (ndcX < -1 || ndcX > 1 || ndcY < -1 || ndcY > 1) continue;
      // zasłonięcie
      const u = ndcX * 0.5 + 0.5, v = ndcY * 0.5 + 0.5;
      const di = Math.min(c.dh - 1, (v * c.dh) | 0) * c.dw + Math.min(c.dw - 1, (u * c.dw) | 0);
      const dm = c.depth[di];
      if (dm > 0 && cw > dm + 0.05 + 0.03 * cw) continue;
      // jak bardzo "na wprost" i z jakiej odległości
      const dx = c.pos.x - x, dy = c.pos.y - y, dz = c.pos.z - z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const facing = Math.abs((nx * dx + ny * dy + nz * dz) / dist);
      if (facing < 0.15) continue;
      const edgeFall = 1 - Math.max(Math.abs(ndcX), Math.abs(ndcY)) ** 6;
      const w = (facing * facing * edgeFall) / (dist * dist + 0.25);
      // trzymamy trzy najlepsze
      if (w > bestW[2]) {
        if (w > bestW[0]) { bestW[2] = bestW[1]; best[2] = best[1]; bestW[1] = bestW[0]; best[1] = best[0]; bestW[0] = w; best[0] = ci; }
        else if (w > bestW[1]) { bestW[2] = bestW[1]; best[2] = best[1]; bestW[1] = w; best[1] = ci; }
        else { bestW[2] = w; best[2] = ci; }
      }
    }
    if (bestW[0] > 0) {
      let r = 0, g = 0, b = 0, ws = 0;
      for (let k = 0; k < 3; k++) {
        if (!bestW[k]) break;
        const c = cams[best[k]];
        const m = c.viewProj.elements;
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        const u = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw) * 0.5 + 0.5;
        const v = 1 - (((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw) * 0.5 + 0.5); // obraz od góry
        sample(c.img, u, v, rgb);
        const w = bestW[k] ** 3; // przewaga najlepszego zdjęcia
        r += rgb[0] * w; g += rgb[1] * w; b += rgb[2] * w; ws += w;
      }
      colors[vtx * 3] = r / ws; colors[vtx * 3 + 1] = g / ws; colors[vtx * 3 + 2] = b / ws;
      seen++;
    } else {
      colors[vtx * 3] = colors[vtx * 3 + 1] = colors[vtx * 3 + 2] = 96; // nie widziane na zdjęciach
    }
    if (vtx % chunk === 0) {
      onProgress?.(`Nakładam zdjęcia… ${Math.round((vtx / nv) * 100)}%`, 0.25 + 0.75 * (vtx / nv));
      await tick();
    }
  }
  onProgress?.('Gotowe', 1);
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    colors,
    coverage: nv ? seen / nv : 0,
    photos: photos.length,
    fovH: fovH || null,
    bakedAt: Date.now(),
  };
}
