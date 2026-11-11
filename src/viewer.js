// Odtwarzanie skanu: podgląd 3D w przeglądarce (mysz/dotyk) oraz w goglach (VR lub AR).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomModel, scanBounds } from './scan-model.js';
import { XRPanel } from './xr-panel.js';

const MODES = ['solid', 'wire', 'points'];
const MODE_NAMES = { solid: 'Bryła', wire: 'Siatka', points: 'Chmura punktów' };

export class ScanViewer {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {HTMLElement} container element, w którym jest canvas renderera
   */
  constructor(renderer, container) {
    this.renderer = renderer;
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1b1f27');
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 200);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.model = null;
    this.cutHeight = 1.9;
    this.cutEnabled = true;
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), this.cutHeight);
    this.onChange = null;

    this.scene.add(new THREE.HemisphereLight('#f4f1ea', '#5b5348', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(2, 5, 3);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(20, 40, '#3c4555', '#2a303b');
    grid.position.y = -0.02;
    this.scene.add(grid);

    this._resize = () => this.resize();
    window.addEventListener('resize', this._resize);
  }

  resize() {
    if (this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(scan) {
    this.clear();
    this.scan = scan;
    this.model = new RoomModel(scan);
    this.scene.add(this.model);
    const box = scanBounds(scan);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 2);
    this.controls.target.set(center.x, Math.min(center.y, 1), center.z);
    this.camera.position.set(center.x + radius * 0.6, radius * 1.1 + 1, center.z + radius * 0.9);
    this.controls.update();
    this.resize();
    this.startDesktopLoop();
  }

  clear() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model.dispose();
      this.model = null;
    }
  }

  setMode(mode) { this.model?.setMode(mode); this.onChange?.(); }
  setLayerVisible(layer, on) { this.model?.setLayerVisible(layer, on); this.onChange?.(); }
  setCut(enabled) { this.cutEnabled = enabled; }

  startDesktopLoop() {
    this.renderer.setAnimationLoop(() => {
      this.renderer.clippingPlanes = this.cutEnabled ? [this.clipPlane] : [];
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() {
    this.renderer.setAnimationLoop(null);
    this.clear();
  }

  /**
   * Odtwarza skan w goglach.
   * mode = 'immersive-vr' (wirtualny pokój) albo 'immersive-ar' (nałożony na rzeczywistość).
   */
  async enterXR(mode = 'immersive-vr') {
    const renderer = this.renderer;
    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking'],
    });
    const ended = new Promise((resolve) => session.addEventListener('end', resolve, { once: true }));
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    renderer.clippingPlanes = [];

    const baseRef = renderer.xr.getReferenceSpace();
    const prevBackground = this.scene.background;
    if (mode === 'immersive-ar') this.scene.background = null;

    // Osobna kamera dla XR, żeby nie nadpisywać pozycji kamery podglądu 3D.
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.02, 200);
    const panel = new XRPanel({ width: 0.62, height: 0.34 });
    this.scene.add(panel);
    let helpUntil = performance.now() + 15000;
    let panelNeedsPlacement = true;

    // worldFromBase: przesunięcie/obrót użytkownika w wirtualnym pokoju (lokomocja).
    const worldFromBase = new THREE.Matrix4();
    const tmpM = new THREE.Matrix4();
    const headPos = new THREE.Vector3();
    const headQuat = new THREE.Quaternion();
    const fwd = new THREE.Vector3();
    const right = new THREE.Vector3();
    const move = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const pressed = new Map();
    const turnArmed = new Map();
    let last = performance.now();

    const applyOffset = () => {
      tmpM.copy(worldFromBase).invert().decompose(pos, quat, scl);
      const offset = new XRRigidTransform(
        { x: pos.x, y: pos.y, z: pos.z, w: 1 },
        { x: quat.x, y: quat.y, z: quat.z, w: quat.w },
      );
      renderer.xr.setReferenceSpace(baseRef.getOffsetReferenceSpace(offset));
    };

    const edge = (key, isDown) => {
      const was = pressed.get(key) || false;
      pressed.set(key, isDown);
      return isDown && !was;
    };

    const cycleMode = () => {
      const i = MODES.indexOf(this.model.mode);
      this.setMode(MODES[(i + 1) % MODES.length]);
    };
    const cycleLayers = () => {
      // Przełącza: tylko siatka -> siatka + meble -> wszystko -> płaszczyzny + meble
      const m = this.model;
      const presets = m.hasGlobal
        ? [
          { global: true, objects: true, planes: false },
          { global: true, objects: false, planes: false },
          { global: true, objects: true, planes: true },
          { global: false, objects: true, planes: true },
        ]
        : [{ global: false, objects: true, planes: true }, { global: false, objects: false, planes: true }];
      const cur = presets.findIndex((p) => p.global === m.visibleLayers.global
        && p.objects === m.visibleLayers.objects && p.planes === m.visibleLayers.planes);
      const next = presets[(cur + 1) % presets.length];
      for (const [k, v] of Object.entries(next)) m.setLayerVisible(k, v);
      this.onChange?.();
    };

    renderer.setAnimationLoop((time, frame) => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const pose = frame?.getViewerPose(renderer.xr.getReferenceSpace());
      if (pose) {
        const t = pose.transform;
        headPos.set(t.position.x, t.position.y, t.position.z);
        headQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
      }

      let moved = false;
      for (const src of session.inputSources) {
        const gp = src.gamepad;
        if (!gp) continue;
        const hand = src.handedness;
        const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
        const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;

        if (hand === 'left' && pose && Math.hypot(ax, ay) > 0.15) {
          // Płynny ruch w kierunku patrzenia (lewa gałka).
          fwd.set(0, 0, -1).applyQuaternion(headQuat).setY(0).normalize();
          right.set(-fwd.z, 0, fwd.x);
          move.copy(fwd).multiplyScalar(-ay).addScaledVector(right, ax).multiplyScalar(1.6 * dt);
          worldFromBase.premultiply(tmpM.makeTranslation(move.x, 0, move.z));
          moved = true;
        }
        if (hand === 'right' && pose) {
          // Skokowy obrót o 30° (prawa gałka).
          const armed = turnArmed.get(hand) ?? true;
          if (armed && Math.abs(ax) > 0.7) {
            const angle = -Math.sign(ax) * THREE.MathUtils.degToRad(30);
            const turn = new THREE.Matrix4().makeTranslation(headPos.x, 0, headPos.z)
              .multiply(tmpM.makeRotationY(angle))
              .multiply(new THREE.Matrix4().makeTranslation(-headPos.x, 0, -headPos.z));
            worldFromBase.premultiply(turn);
            moved = true;
            turnArmed.set(hand, false);
          } else if (Math.abs(ax) < 0.3) {
            turnArmed.set(hand, true);
          }
        }
        // A / X: tryb wyświetlania;  B / Y: warstwy;  wciśnięcie gałki: powrót na start.
        if (edge(`${hand}-4`, !!gp.buttons[4]?.pressed)) { cycleMode(); helpUntil = now + 4000; }
        if (edge(`${hand}-5`, !!gp.buttons[5]?.pressed)) { cycleLayers(); helpUntil = now + 4000; }
        if (edge(`${hand}-3`, !!gp.buttons[3]?.pressed)) {
          worldFromBase.identity();
          moved = true;
          helpUntil = now + 4000;
          panelNeedsPlacement = true;
        }
      }
      if (moved) applyOffset();

      panel.visible = now < helpUntil;
      if (panel.visible) {
        const vis = this.model.visibleLayers;
        panel.setLines([
          this.scan.name,
          `Tryb: ${MODE_NAMES[this.model.mode]}   (A / X: zmień)`,
          `Warstwy: ${[vis.global && 'siatka', vis.objects && 'meble', vis.planes && 'płaszczyzny'].filter(Boolean).join(', ') || 'brak'}   (B / Y)`,
          'Lewa gałka: chodzenie   Prawa: obrót',
          'Wciśnij gałkę: powrót na start',
        ]);
        if (pose) {
          panel.follow(headPos, headQuat, { snap: panelNeedsPlacement, distance: 1.1, drop: 0.25, smoothing: 0.05 });
          panelNeedsPlacement = false;
        }
      }
      renderer.render(this.scene, xrCamera);
    });

    await ended;
    this.scene.remove(panel);
    panel.dispose();
    this.scene.background = prevBackground;
    this.resize();
    if (this.model) this.startDesktopLoop();
  }

  dispose() {
    window.removeEventListener('resize', this._resize);
    this.stop();
    this.controls.dispose();
  }
}

export { MODES, MODE_NAMES };
