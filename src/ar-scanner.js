// Skanowanie pomieszczenia w goglach (WebXR immersive-ar, Quest Browser).
//
// Quest udostępnia stronom (po zgodzie użytkownika) model pokoju z "Space Setup":
//  - mesh-detection  -> trójkątna siatka całego pokoju ("global mesh") + bryły mebli,
//  - plane-detection -> ściany, podłoga, sufit, drzwi, okna jako wielokąty.
// Tutaj zbieramy te dane, pokazujemy je na żywo na obrazie z kamer (passthrough)
// i po zakończeniu zwracamy gotowy skan w przestrzeni 'local-floor'.

import * as THREE from 'three';
import { colorForLabel, createScan } from './scan-model.js';
import { XRPanel } from './xr-panel.js';

export async function isImmersiveSupported(mode) {
  try {
    return !!navigator.xr && (await navigator.xr.isSessionSupported(mode));
  } catch {
    return false;
  }
}

function planeGeometry(plane) {
  const contour = plane.polygon.map((p) => new THREE.Vector2(p.x, p.z));
  if (contour.length < 3) return null;
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const positions = new Float32Array(contour.length * 3);
  contour.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 2] = p.y; });
  const indices = new Uint32Array(tris.length * 3);
  tris.forEach((t, i) => indices.set(t, i * 3));
  return { positions, indices };
}

export class RoomScanner {
  /**
   * @param {THREE.WebGLRenderer} renderer
   */
  constructor(renderer) {
    this.renderer = renderer;
  }

  /**
   * Uruchamia sesję AR. Wywołuj bezpośrednio z obsługi kliknięcia.
   * Zwraca { scan, session }:
   *  - spust: skan gotowy, sesja ZOSTAJE otwarta (session != null), żeby od razu
   *    robić pomiary w tym samym układzie współrzędnych,
   *  - B / Y albo wyjście z gogli: sesja zakończona (session = null).
   * scan = null, gdy nic nie zebrano.
   */
  async start() {
    const session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['mesh-detection', 'plane-detection', 'hand-tracking', 'bounded-floor', 'camera-access'],
    });
    const ended = new Promise((resolve) => session.addEventListener('end', resolve, { once: true }));
    const enabled = session.enabledFeatures ? [...session.enabledFeatures] : null;
    const renderer = this.renderer;
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    // Granica (Guardian) – jej początek układu jest stały między sesjami; zapamiętujemy go
    // jako zapasowy punkt odniesienia do wyrównania skanu w kolejnych sesjach.
    const boundedSpace = await session.requestReferenceSpace('bounded-floor').catch(() => null);
    let boundedMatrix = null;

    let finishMode = null; // 'measure' | 'exit'
    let resolveFinish;
    const finished = new Promise((r) => { resolveFinish = r; });
    ended.then(() => { finishMode = finishMode || 'exit'; resolveFinish(); });

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 50);
    const overlay = new THREE.Group();
    scene.add(overlay);
    const panel = new XRPanel();
    scene.add(panel);

    /** @type {Map<any, {kind:string,label:string,lastChangedTime:number,local:{positions:Float32Array,indices:Uint32Array},matrix:THREE.Matrix4,object:THREE.Object3D}>} */
    const tracked = new Map();
    const startTime = performance.now();
    let roomCaptureRequested = false;
    let message = '';
    let panelPlaced = false;
    const headPos = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();

    const featureMissing = enabled && !enabled.includes('mesh-detection') && !enabled.includes('plane-detection');

    const requestRoomCapture = async () => {
      if (typeof session.initiateRoomCapture !== 'function') {
        message = 'Uruchom Space Setup w Ustawieniach gogli.';
        return;
      }
      if (roomCaptureRequested) {
        message = 'Skanowanie już było uruchomione w tej sesji.';
        return;
      }
      roomCaptureRequested = true;
      message = 'Rozglądaj się powoli po całym pokoju...';
      try {
        await session.initiateRoomCapture();
      } catch (err) {
        message = `Nie udało się uruchomić skanowania: ${err?.message || err}`;
      }
    };

    const onSelect = () => {
      if (tracked.size === 0 && !roomCaptureRequested) requestRoomCapture();
      else if (!finishMode) { finishMode = 'measure'; resolveFinish(); }
    };
    const exitPressed = new Map();
    const onSqueeze = () => requestRoomCapture();
    session.addEventListener('select', onSelect);
    session.addEventListener('squeeze', onSqueeze);

    const upsert = (item, kind, frame, ref) => {
      let entry = tracked.get(item);
      if (!entry || entry.lastChangedTime !== item.lastChangedTime) {
        let local;
        if (kind === 'mesh') {
          local = { positions: new Float32Array(item.vertices), indices: new Uint32Array(item.indices) };
        } else {
          local = planeGeometry(item);
        }
        if (!local || local.indices.length < 3) return;
        const label = item.semanticLabel || (kind === 'plane' ? 'plane' : 'mesh');
        if (entry) {
          overlay.remove(entry.object);
          entry.object.geometry.dispose();
          entry.object.material.dispose();
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(local.positions, 3));
        g.setIndex(new THREE.BufferAttribute(local.indices, 1));
        const isGlobal = label.toLowerCase().includes('global');
        const material = new THREE.MeshBasicMaterial({
          color: isGlobal ? 0x66ddff : colorForLabel(label),
          wireframe: kind === 'mesh',
          transparent: true,
          opacity: kind === 'mesh' ? (isGlobal ? 0.35 : 0.6) : 0.18,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const object = new THREE.Mesh(g, material);
        object.matrixAutoUpdate = false;
        overlay.add(object);
        entry = {
          kind, label, lastChangedTime: item.lastChangedTime, local, object,
          matrix: entry ? entry.matrix : new THREE.Matrix4(),
          hasPose: entry ? entry.hasPose : false,
        };
        tracked.set(item, entry);
      }
      const space = kind === 'mesh' ? item.meshSpace : item.planeSpace;
      const pose = frame.getPose(space, ref);
      if (pose) {
        entry.matrix.fromArray(pose.transform.matrix);
        entry.hasPose = true;
        entry.object.matrix.copy(entry.matrix);
        entry.object.matrixWorldNeedsUpdate = true;
      }
    };

    const updatePanel = (frame) => {
      let meshes = 0, planes = 0, vertices = 0;
      for (const e of tracked.values()) {
        if (e.kind === 'mesh') meshes++; else planes++;
        vertices += e.local.positions.length / 3;
      }
      const lines = ['Skanowanie pokoju'];
      if (featureMissing) {
        lines.push('Gogle nie udostępniły danych o pokoju.');
        lines.push('Zezwól na dostęp do "danych przestrzennych".');
      } else if (tracked.size === 0) {
        lines.push(performance.now() - startTime > 2500
          ? 'Brak zapisanego modelu tego pokoju.'
          : 'Czekam na dane z gogli...');
        lines.push('Spust / szczypnięcie: uruchom skanowanie');
      } else {
        lines.push(`Siatki: ${meshes}   Płaszczyzny: ${planes}`);
        lines.push(`Wierzchołki: ${vertices.toLocaleString('pl-PL')}`);
        lines.push('Spust: ZAPISZ skan i rób pomiary');
        lines.push('B / Y: zapisz i wyjdź · Grip: skanuj ponownie');
      }
      if (message) lines.push(message);
      panel.setLines(lines);

      const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
      if (pose) {
        const t = pose.transform;
        headPos.set(t.position.x, t.position.y, t.position.z);
        headQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        panel.follow(headPos, headQuat, { snap: !panelPlaced, distance: 1.0, drop: 0.3 });
        panelPlaced = true;
      }
    };

    renderer.setAnimationLoop((time, frame) => {
      if (!frame) return;
      const ref = renderer.xr.getReferenceSpace();
      const seen = new Set();
      if (frame.detectedMeshes) {
        for (const m of frame.detectedMeshes) { seen.add(m); upsert(m, 'mesh', frame, ref); }
      }
      if (frame.detectedPlanes) {
        for (const p of frame.detectedPlanes) { seen.add(p); upsert(p, 'plane', frame, ref); }
      }
      for (const [item, entry] of tracked) {
        if (!seen.has(item)) {
          overlay.remove(entry.object);
          entry.object.geometry.dispose();
          entry.object.material.dispose();
          tracked.delete(item);
        }
      }
      if (boundedSpace) {
        const bp = frame.getPose(boundedSpace, ref);
        if (bp) boundedMatrix = Array.from(bp.transform.matrix);
      }
      // B / Y: zapisz i wyjdź z gogli
      for (const src of session.inputSources) {
        const down = !!src.gamepad?.buttons[5]?.pressed;
        if (down && !exitPressed.get(src) && tracked.size) session.end();
        exitPressed.set(src, down);
      }
      updatePanel(frame);
      renderer.render(scene, camera);
    });

    await finished;
    renderer.setAnimationLoop(null);
    session.removeEventListener('select', onSelect);
    session.removeEventListener('squeeze', onSqueeze);
    const keepSession = finishMode === 'measure' ? session : null;

    // Przenosimy wierzchołki do wspólnej przestrzeni 'local-floor'.
    const objects = [];
    const v = new THREE.Vector3();
    for (const e of tracked.values()) {
      e.object.geometry.dispose();
      e.object.material.dispose();
      if (!e.hasPose) continue;
      const src = e.local.positions;
      const positions = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(e.matrix);
        positions[i] = v.x; positions[i + 1] = v.y; positions[i + 2] = v.z;
      }
      objects.push({ kind: e.kind, label: e.label, positions, indices: e.local.indices });
    }
    panel.dispose();
    if (!objects.length) {
      if (keepSession) await session.end();
      return { scan: null, session: null };
    }
    const scan = createScan({ source: 'quest', objects });
    if (boundedMatrix) scan.bounded = { matrix: boundedMatrix };
    // Punkt odniesienia: położenie siatki pokoju (albo podłogi) w tej sesji.
    // W kolejnych sesjach AR gogle podadzą jej nowe położenie, co pozwala
    // nałożyć skan i pomiary dokładnie na prawdziwy pokój.
    const ref = [...tracked.values()].find((e) => e.hasPose && e.label.toLowerCase().includes('global'))
      || [...tracked.values()].find((e) => e.hasPose && e.kind === 'plane' && e.label.toLowerCase().includes('floor'));
    if (ref) scan.reference = { kind: ref.kind, label: ref.label, matrix: Array.from(ref.matrix.elements) };
    return { scan, session: keepSession };
  }
}
