// Odtwarzanie skanu z pomiarami pól: podgląd 3D w przeglądarce oraz w goglach (VR/AR).
// Ten sam stan widoku (pole, tryby, przezroczystości, przekroje) obowiązuje
// na komputerze i w goglach.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomModel, scanBounds } from './scan-model.js';
import { FieldView, FIELD_MODES, FIELD_MODE_NAMES } from './field-view.js';
import { MeasurementSet, formatValue, makeDemoMeasurements } from './fields.js';
import { SimulatedSensor, ManualArduinoSensor, MANUAL_SPEC, SENSOR_KINDS, SENSOR_SHORT_NAMES } from './sensors.js';
import { XRMenu, LegendPanel } from './xr-menu.js';

export const ROOM_MODES = ['solid', 'wire', 'points', 'hidden'];
export const ROOM_MODE_NAMES = { solid: 'Bryła', wire: 'Siatka', points: 'Punkty', hidden: 'Ukryty' };
export const SIDE_CUTS = ['off', 'x+', 'x-', 'z+', 'z-'];
export const SIDE_CUT_NAMES = { off: 'wył.', 'x+': 'X (lewa)', 'x-': 'X (prawa)', 'z+': 'Z (tył)', 'z-': 'Z (przód)' };
export const MAP_AXES = ['off', 'y', 'x', 'z'];
export const MAP_AXIS_NAMES = { off: 'wył.', y: 'poziomo', x: 'pionowo X', z: 'pionowo Z' };
export { FIELD_MODES, FIELD_MODE_NAMES };

const clamp = THREE.MathUtils.clamp;
const cycle = (list, cur, d = 1) => list[(list.indexOf(cur) + d + list.length) % list.length];
const pct = (v) => `${Math.round(v * 100)}%`;

function defaultState() {
  return {
    roomMode: 'solid',
    roomOpacity: 1,
    fieldId: null,
    fieldMode: 'dots',
    fieldOpacity: 0.9,
    band: { lo: 0, hi: 1, invert: false },
    pointSize: 0.035,
    voxelSize: 0.25,
    cutTop: { on: true, h: 2.2 },
    cutSide: { mode: 'off', pos: 0 },
    map: { axis: 'off', pos: 1 },
    measuring: false,
    brush: 0.08,
    dollhouse: false,
    sensorKind: 'sim',
  };
}

export class ScanViewer {
  constructor(renderer, container) {
    this.renderer = renderer;
    this.container = container;
    renderer.localClippingEnabled = true;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1b1f27');
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.02, 200);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;

    this.content = new THREE.Group(); // pokój + pola, w układzie skanu
    this.content.matrixAutoUpdate = false;
    this.scene.add(this.content);
    // Zawsze 2 płaszczyzny (góra, bok); wyłączona = odsunięta daleko.
    this.clipPlanes = [new THREE.Plane(), new THREE.Plane()];

    this.state = defaultState();
    this.model = null;
    this.fieldView = null;
    this.meas = null;
    this.simSensor = null;
    // Udawane Arduino działa cały czas (jak podłączone urządzenie), wartości z gałki/suwaków.
    this.manualSensor = new ManualArduinoSensor();
    this.manualSensor.start();
    this.xr = null; // kontekst aktywnej sesji XR
    this.onChange = null;
    this.onSave = null;

    this.scene.add(new THREE.HemisphereLight('#f4f1ea', '#5b5348', 1.6));
    const sun = new THREE.DirectionalLight('#ffffff', 1.4);
    sun.position.set(2, 5, 3);
    this.scene.add(sun);
    this.grid = new THREE.GridHelper(20, 40, '#3c4555', '#2a303b');
    this.grid.position.y = -0.02;
    this.scene.add(this.grid);

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

  // --- skan ------------------------------------------------------------------

  show(scan) {
    this.clear();
    this.scan = scan;
    this.roomBounds = scanBounds(scan);
    this.model = new RoomModel(scan);
    this.model.setClippingPlanes(this.clipPlanes);
    this.content.add(this.model);

    this.meas = MeasurementSet.from(scan.measurements);
    this.simSensor = new SimulatedSensor(this.roomBounds);
    for (const f of [...this.simSensor.fields, ...this.manualSensor.fields]) this.meas.ensureField(f);
    this.savedVersion = this.meas.version;
    this.fieldView = new FieldView(this.clipPlanes);
    this.content.add(this.fieldView);
    this.refreshBounds();

    const b = this.roomBounds;
    const c = b.getCenter(new THREE.Vector3());
    const prevField = this.state.fieldId;
    const keep = this.state;
    this.state = {
      ...defaultState(),
      // ustawienia wyglądu zostają między skanami
      fieldMode: keep.fieldMode, fieldOpacity: keep.fieldOpacity, roomMode: keep.roomMode,
      roomOpacity: keep.roomOpacity, pointSize: keep.pointSize, voxelSize: keep.voxelSize, brush: keep.brush,
      sensorKind: keep.sensorKind,
      fieldId: this.meas.field(prevField) ? prevField : this.firstFieldWithData(),
      cutTop: { on: true, h: +(b.max.y > 1.6 ? b.max.y - 0.3 : b.max.y + 0.1).toFixed(2) },
      cutSide: { mode: 'off', pos: +c.x.toFixed(2) },
      map: { axis: 'off', pos: 1 },
    };
    this.applyState();
    this.viewPerspective();
    this.resize();
    this.startDesktopLoop();
  }

  firstFieldWithData() {
    for (const f of this.meas.fields) {
      for (let i = 0; i < this.meas.count; i++) if (Number.isFinite(this.meas.scalar(f.id, i))) return f.id;
    }
    return this.meas.fields[0]?.id || null;
  }

  /** Obszar dla przekrojów i mapy: pokój + pomiary. */
  refreshBounds() {
    this.bounds = this.roomBounds.clone();
    if (this.meas.count) this.bounds.union(this.meas.bounds());
    this.fieldView.setData(this.meas, this.bounds);
  }

  clear() {
    for (const key of ['model', 'fieldView']) {
      if (this[key]) {
        this.content.remove(this[key]);
        this[key].dispose();
        this[key] = null;
      }
    }
  }

  // --- stan widoku -------------------------------------------------------------

  /** Zmiana stanu, np. set({ fieldMode: 'arrows' }) albo set({ cutTop: { h: 1.5 } }). */
  set(patch) {
    const s = this.state;
    for (const [k, v] of Object.entries(patch)) {
      s[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...v } : v;
    }
    this.applyState();
    this.onChange?.();
  }

  applyState() {
    const s = this.state;
    if (!this.model) return;
    this.model.setMode(s.roomMode);
    this.model.setOpacity(s.roomOpacity);
    this.fieldView.configure({
      fieldId: s.fieldId, mode: s.fieldMode, opacity: s.fieldOpacity, band: s.band,
      pointSize: s.pointSize, voxelSize: s.voxelSize, map: s.map,
    });
    this.updateContentMatrix();
  }

  updateContentMatrix() {
    const m = this.content.matrix;
    if (this.xr?.dollMatrix && this.state.dollhouse) m.copy(this.xr.dollMatrix);
    else if (this.xr?.align) m.copy(this.xr.align);
    else m.identity();
    this.content.matrixWorldNeedsUpdate = true;
    this.content.updateMatrixWorld(true);
    this.updateClipPlanes();
  }

  updateClipPlanes() {
    const s = this.state;
    const [top, side] = this.clipPlanes;
    const far = 1e6;
    if (s.cutTop.on) top.set(new THREE.Vector3(0, -1, 0), s.cutTop.h);
    else top.set(new THREE.Vector3(0, -1, 0), far);
    const mode = s.cutSide.mode;
    if (mode === 'off') side.set(new THREE.Vector3(1, 0, 0), far);
    else {
      const axis = mode[0];
      const sign = mode[1] === '+' ? -1 : 1; // 'x+' zostawia x <= pos (część "lewa")
      const n = new THREE.Vector3(axis === 'x' ? sign : 0, 0, axis === 'z' ? sign : 0);
      side.set(n, -sign * s.cutSide.pos);
    }
    top.applyMatrix4(this.content.matrixWorld);
    side.applyMatrix4(this.content.matrixWorld);
  }

  fieldDef() { return this.meas?.field(this.state.fieldId); }

  /** Aktywne źródło danych pomiarowych. */
  get sensor() {
    return this.state.sensorKind === 'arduino-manual' ? this.manualSensor : this.simSensor;
  }

  /** Wartość skalarna bieżącego pola z odczytu czujnika (wektor -> długość). */
  readingValue(reading, fieldId = this.state.fieldId) {
    const v = reading?.[fieldId];
    if (v === undefined) return NaN;
    return Array.isArray(v) ? Math.hypot(...v) : v;
  }

  /** Wartość granicy zakresu ('lo' | 'hi') w jednostkach pola. */
  bandValue(which) {
    const r = this.fieldView.getRange();
    return r.min + this.state.band[which] * (r.max - r.min);
  }

  bandValueText(which) {
    const def = this.fieldDef();
    const edge = which === 'lo' ? this.state.band.lo <= 0 : this.state.band.hi >= 1;
    if (edge) return which === 'lo' ? 'min' : 'max';
    return formatValue(def, this.bandValue(which));
  }

  legendInfo() {
    const def = this.fieldDef();
    if (!def) return { name: 'Brak pól', minText: '', maxText: '', unit: '' };
    const r = this.fieldView.getRange();
    const extra = def.components === 3 ? ' (długość wektora)' : '';
    return {
      name: `${def.name}${extra}`,
      unit: def.unit,
      min: r.min, max: r.max,
      band: this.state.band,
      minText: r.count ? formatValue(def, r.min) : 'brak pomiarów',
      maxText: r.count ? formatValue(def, r.max) : '',
      count: r.count,
    };
  }

  // --- pomiary -----------------------------------------------------------------

  /** Krok wartości udawanego Arduino (5 % zakresu) dla bieżącego pola. */
  nudgeManual(sign) {
    const spec = MANUAL_SPEC[this.state.fieldId];
    if (!spec || this.state.sensorKind !== 'arduino-manual') return;
    this.manualSensor.setValue(this.state.fieldId, this.manualSensor.values[this.state.fieldId] + sign * (spec.max - spec.min) * 0.05);
  }

  addDemoMeasurements() {
    const demo = makeDemoMeasurements(this.roomBounds);
    const st = demo.toStorable();
    for (let i = 0; i < st.count; i++) {
      const reading = {};
      for (const f of st.fields) {
        reading[f.id] = f.components === 1 ? st.values[f.id][i] : Array.from(st.values[f.id].subarray(i * 3, i * 3 + 3));
      }
      this.meas.add(new THREE.Vector3().fromArray(st.positions, i * 3), st.radii[i], reading, st.times[i]);
    }
    this.afterMeasurementsChanged();
  }

  clearMeasurements() {
    this.meas.clear();
    this.afterMeasurementsChanged();
  }

  afterMeasurementsChanged() {
    this.refreshBounds();
    if (!this.state.fieldId || !this.meas.field(this.state.fieldId)) this.state.fieldId = this.firstFieldWithData();
    this.fieldView.markDirty();
    this.applyState();
    this.onChange?.();
  }

  hasUnsavedMeasurements() { return this.meas && this.meas.version !== this.savedVersion; }

  async save() {
    if (!this.scan) return;
    this.scan.measurements = this.meas.toStorable();
    this.savedVersion = this.meas.version;
    await this.onSave?.(this.scan);
  }

  // --- podgląd na komputerze ------------------------------------------------------

  viewPerspective() {
    const b = this.roomBounds;
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 2);
    this.controls.target.set(center.x, Math.min(center.y, 1), center.z);
    this.camera.position.set(center.x + radius * 0.6, radius * 1.1 + 1, center.z + radius * 0.9);
    this.controls.update();
  }

  viewTop() {
    const b = this.roomBounds;
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.z, 2);
    this.controls.target.set(center.x, 0, center.z);
    this.camera.position.set(center.x, radius * 1.7 + 1, center.z + 0.01);
    this.controls.update();
  }

  startDesktopLoop() {
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.fieldView?.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  stop() {
    this.renderer.setAnimationLoop(null);
    this.clear();
  }

  // --- gogle -------------------------------------------------------------------------

  /**
   * mode = 'immersive-vr' (wirtualny pokój) albo 'immersive-ar' (nałożony na prawdziwy pokój).
   */
  async enterXR(mode = 'immersive-vr') {
    const renderer = this.renderer;
    const isAR = mode === 'immersive-ar';
    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: isAR ? ['hand-tracking', 'mesh-detection', 'plane-detection'] : ['hand-tracking'],
    });
    const ended = new Promise((resolve) => session.addEventListener('end', resolve, { once: true }));
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);

    const baseRef = renderer.xr.getReferenceSpace();
    const prevBackground = this.scene.background;
    if (isAR) this.scene.background = null;
    this.grid.visible = !isAR;

    const xr = {
      session, isAR, align: null, dollMatrix: null, aligned: false,
      head: new THREE.Vector3(), headQuat: new THREE.Quaternion(), hasHead: false,
    };
    this.xr = xr;
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.02, 200);
    const ui = new THREE.Group(); // elementy interfejsu (bez przycinania)
    this.scene.add(ui);

    // --- menu ---
    const s = () => this.state;
    const fieldIds = () => this.meas.fields.map((f) => f.id);
    const b = () => this.bounds;
    const menu = new XRMenu([
      { type: 'legend', get: () => this.legendInfo() },
      { type: 'stepper', label: 'Pole', value: () => this.fieldDef()?.name || '—',
        dec: () => this.set({ fieldId: cycle(fieldIds(), s().fieldId, -1) }),
        inc: () => this.set({ fieldId: cycle(fieldIds(), s().fieldId, 1) }) },
      { type: 'stepper', label: 'Widok pola', value: () => FIELD_MODE_NAMES[s().fieldMode],
        dec: () => this.set({ fieldMode: cycle(FIELD_MODES, s().fieldMode, -1) }),
        inc: () => this.set({ fieldMode: cycle(FIELD_MODES, s().fieldMode, 1) }) },
      { type: 'stepper', label: 'Krycie pól', value: () => pct(s().fieldOpacity),
        dec: () => this.set({ fieldOpacity: clamp(+(s().fieldOpacity - 0.1).toFixed(2), 0.1, 1) }),
        inc: () => this.set({ fieldOpacity: clamp(+(s().fieldOpacity + 0.1).toFixed(2), 0.1, 1) }) },
      { type: 'stepper', label: 'Pokaż od', value: () => this.bandValueText('lo'),
        dec: () => this.set({ band: { lo: clamp(+(s().band.lo - 0.05).toFixed(2), 0, s().band.hi - 0.05) } }),
        inc: () => this.set({ band: { lo: clamp(+(s().band.lo + 0.05).toFixed(2), 0, s().band.hi - 0.05) } }) },
      { type: 'stepper', label: 'Pokaż do', value: () => this.bandValueText('hi'),
        dec: () => this.set({ band: { hi: clamp(+(s().band.hi - 0.05).toFixed(2), s().band.lo + 0.05, 1) } }),
        inc: () => this.set({ band: { hi: clamp(+(s().band.hi + 0.05).toFixed(2), s().band.lo + 0.05, 1) } }) },
      { type: 'buttons', items: [
        { label: 'Wytnij zakres (odwróć)', active: () => s().band.invert, onClick: () => this.set({ band: { invert: !s().band.invert } }) },
        { label: 'Cała skala', onClick: () => this.set({ band: { lo: 0, hi: 1, invert: false } }) },
      ] },
      { type: 'stepper', label: 'Wielkość kostki/strzałki', value: () => `${Math.round(s().voxelSize * 100)} cm`,
        dec: () => this.set({ voxelSize: clamp(+(s().voxelSize - 0.05).toFixed(2), 0.1, 0.6) }),
        inc: () => this.set({ voxelSize: clamp(+(s().voxelSize + 0.05).toFixed(2), 0.1, 0.6) }) },
      { type: 'stepper', label: 'Pokój', value: () => ROOM_MODE_NAMES[s().roomMode],
        dec: () => this.set({ roomMode: cycle(ROOM_MODES, s().roomMode, -1) }),
        inc: () => this.set({ roomMode: cycle(ROOM_MODES, s().roomMode, 1) }) },
      { type: 'stepper', label: 'Krycie pokoju', value: () => pct(s().roomOpacity),
        dec: () => this.set({ roomOpacity: clamp(+(s().roomOpacity - 0.1).toFixed(2), 0.1, 1) }),
        inc: () => this.set({ roomOpacity: clamp(+(s().roomOpacity + 0.1).toFixed(2), 0.1, 1) }) },
      { type: 'stepper', label: 'Cięcie dachu', value: () => (s().cutTop.on ? `${s().cutTop.h.toFixed(1)} m` : 'wył.'),
        dec: () => this.set({ cutTop: s().cutTop.on ? { h: clamp(+(s().cutTop.h - 0.1).toFixed(2), 0.1, 5) } : { on: true, h: +(b().max.y - 0.1).toFixed(2) } }),
        inc: () => {
          const h = +(s().cutTop.h + 0.1).toFixed(2);
          this.set({ cutTop: h > b().max.y + 0.05 ? { on: false } : { on: true, h } });
        } },
      { type: 'stepper', label: 'Przekrój pionowy', value: () => SIDE_CUT_NAMES[s().cutSide.mode],
        dec: () => this.set({ cutSide: { mode: cycle(SIDE_CUTS, s().cutSide.mode, -1) } }),
        inc: () => this.set({ cutSide: { mode: cycle(SIDE_CUTS, s().cutSide.mode, 1) } }) },
      { type: 'stepper', label: '  pozycja przekroju', value: () => `${s().cutSide.pos.toFixed(1)} m`,
        dec: () => this.set({ cutSide: { pos: +(s().cutSide.pos - 0.1).toFixed(2) } }),
        inc: () => this.set({ cutSide: { pos: +(s().cutSide.pos + 0.1).toFixed(2) } }) },
      { type: 'stepper', label: 'Mapa pola (płaszczyzna)', value: () => MAP_AXIS_NAMES[s().map.axis],
        dec: () => this.set({ map: { axis: cycle(MAP_AXES, s().map.axis, -1) } }),
        inc: () => this.set({ map: { axis: cycle(MAP_AXES, s().map.axis, 1) } }) },
      { type: 'stepper', label: '  pozycja mapy', value: () => `${s().map.pos.toFixed(1)} m`,
        dec: () => this.set({ map: { pos: +(s().map.pos - 0.1).toFixed(2) } }),
        inc: () => this.set({ map: { pos: +(s().map.pos + 0.1).toFixed(2) } }) },
      { type: 'stepper', label: 'Czujnik', value: () => SENSOR_SHORT_NAMES[s().sensorKind],
        dec: () => this.set({ sensorKind: cycle(SENSOR_KINDS, s().sensorKind, -1) }),
        inc: () => this.set({ sensorKind: cycle(SENSOR_KINDS, s().sensorKind, 1) }) },
      { type: 'stepper', label: '  wartość z Arduino', value: () => (s().sensorKind === 'arduino-manual'
        ? formatValue(this.fieldDef(), this.readingValue(this.manualSensor.read())) : '—'),
        dec: () => this.nudgeManual(-1), inc: () => this.nudgeManual(1) },
      { type: 'stepper', label: 'Wielkość kulki pomiaru', value: () => `${Math.round(s().brush * 100)} cm`,
        dec: () => this.set({ brush: clamp(+(s().brush - 0.02).toFixed(2), 0.02, 0.5) }),
        inc: () => this.set({ brush: clamp(+(s().brush + 0.02).toFixed(2), 0.02, 0.5) }) },
      { type: 'buttons', items: [
        { label: 'Rysuj pomiary', active: () => s().measuring, onClick: () => this.set({ measuring: !s().measuring }) },
        { label: 'Makieta z góry', active: () => s().dollhouse, onClick: () => toggleDollhouse() },
      ] },
      { type: 'buttons', items: [
        { label: 'Zapisz', onClick: () => { this.save(); flash('Zapisano'); } },
        { label: 'Wyczyść pomiary', onClick: () => clearClicked() },
        { label: 'Schowaj menu', onClick: () => { menu.mesh.visible = false; } },
      ] },
    ]);
    let confirmClear = false;
    const clearRow = menu.rows[menu.rows.length - 1].items[1];
    const clearClicked = () => {
      if (!confirmClear) { confirmClear = true; clearRow.label = 'Na pewno?'; return; }
      confirmClear = false;
      clearRow.label = 'Wyczyść pomiary';
      this.clearMeasurements();
    };
    let flashText = '', flashUntil = 0;
    const flash = (t) => { flashText = t; flashUntil = performance.now() + 2000; };
    ui.add(menu.mesh);
    let menuNeedsPlacement = true;

    const legend = new LegendPanel();
    ui.add(legend.mesh);

    // --- kulka pomiarowa i promienie ---
    const brush = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }),
    );
    const brushWire = new THREE.Mesh(brush.geometry, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.5 }));
    brush.add(brushWire);
    ui.add(brush);

    const rayGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const rays = new Map(); // inputSource -> Line
    const getRay = (src) => {
      let line = rays.get(src);
      if (!line) {
        line = new THREE.Line(rayGeom, new THREE.LineBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.8 }));
        line.matrixAutoUpdate = false;
        ui.add(line);
        rays.set(src, line);
      }
      return line;
    };

    // --- makieta (pokój w miniaturze przed użytkownikiem) ---
    const toggleDollhouse = () => {
      if (!this.state.dollhouse && xr.hasHead) {
        const rb = this.roomBounds;
        const c = rb.getCenter(new THREE.Vector3());
        const size = rb.getSize(new THREE.Vector3());
        const k = 0.7 / Math.max(size.x, size.z, 0.5);
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(xr.headQuat).setY(0).normalize();
        const at = xr.head.clone().addScaledVector(fwd, 0.75);
        at.y = Math.max(0.5, xr.head.y - 0.65);
        const yaw = Math.atan2(-fwd.x, -fwd.z);
        xr.dollMatrix = new THREE.Matrix4().makeTranslation(at.x, at.y, at.z)
          .multiply(new THREE.Matrix4().makeRotationY(yaw))
          .multiply(new THREE.Matrix4().makeScale(k, k, k))
          .multiply(new THREE.Matrix4().makeTranslation(-c.x, -rb.min.y, -c.z));
      }
      this.set({ dollhouse: !this.state.dollhouse });
    };

    // --- lokomocja (tylko VR) ---
    const worldFromBase = new THREE.Matrix4();
    const tmpM = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    const applyOffset = () => {
      tmpM.copy(worldFromBase).invert().decompose(pos, quat, scl);
      renderer.xr.setReferenceSpace(baseRef.getOffsetReferenceSpace(new XRRigidTransform(
        { x: pos.x, y: pos.y, z: pos.z, w: 1 }, { x: quat.x, y: quat.y, z: quat.z, w: quat.w })));
    };

    // --- zdarzenia spustu ---
    const painting = new Map(); // inputSource -> ostatni punkt próbki (układ skanu)
    const hits = new Map(); // inputSource -> trafienie w menu
    const onSelectStart = (e) => {
      const hit = menu.mesh.visible ? hits.get(e.inputSource) : null;
      if (hit) { menu.click(hit); return; }
      if (this.state.measuring && !this.state.dollhouse) painting.set(e.inputSource, null);
    };
    const onSelectEnd = (e) => painting.delete(e.inputSource);
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('selectend', onSelectEnd);

    const pressed = new Map();
    const edge = (k, down) => { const was = pressed.get(k) || false; pressed.set(k, down); return down && !was; };
    let turnArmed = true;
    let last = performance.now();
    let lastMenuRedraw = 0;
    const raycaster = new THREE.Raycaster();
    const rayOrigin = new THREE.Vector3(), rayDir = new THREE.Vector3();
    const poseM = new THREE.Matrix4();
    const tip = new THREE.Vector3(), tipScan = new THREE.Vector3(), dirScan = new THREE.Vector3();
    const contentInv = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const fwd = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3();
    const alignTmp = new THREE.Matrix4();
    const refMatrix = this.scan.reference ? new THREE.Matrix4().fromArray(this.scan.reference.matrix) : null;
    let frameNo = 0;

    renderer.setAnimationLoop((time, frame) => {
      if (!frame) return;
      frameNo++;
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const ref = renderer.xr.getReferenceSpace();
      const pose = frame.getViewerPose(ref);
      if (pose) {
        const t = pose.transform;
        xr.head.set(t.position.x, t.position.y, t.position.z);
        xr.headQuat.set(t.orientation.x, t.orientation.y, t.orientation.z, t.orientation.w);
        xr.hasHead = true;
      }

      // Wyrównanie skanu do prawdziwego pokoju (AR): szukamy tej samej siatki/podłogi.
      if (isAR && refMatrix && (!xr.aligned || frameNo % 60 === 0)) {
        const label = this.scan.reference.label.toLowerCase();
        const items = this.scan.reference.kind === 'plane' ? frame.detectedPlanes : frame.detectedMeshes;
        if (items) {
          for (const it of items) {
            if ((it.semanticLabel || '').toLowerCase() !== label) continue;
            const p = frame.getPose(it.meshSpace || it.planeSpace, ref);
            if (!p) continue;
            xr.align = alignTmp.fromArray(p.transform.matrix).multiply(refMatrix.clone().invert()).clone();
            xr.aligned = true;
            this.updateContentMatrix();
            break;
          }
        }
      }

      // Przyciski i gałki.
      let moved = false;
      let primary = null;
      for (const src of session.inputSources) {
        if (!primary || src.handedness === 'right') primary = src;
        const gp = src.gamepad;
        if (!gp) continue;
        const hand = src.handedness;
        const ax = gp.axes.length >= 4 ? gp.axes[2] : gp.axes[0] || 0;
        const ay = gp.axes.length >= 4 ? gp.axes[3] : gp.axes[1] || 0;
        const btn = (i) => !!gp.buttons[i]?.pressed;
        if (hand === 'left') {
          if (!isAR && !this.state.dollhouse && pose && Math.hypot(ax, ay) > 0.15) {
            fwd.set(0, 0, -1).applyQuaternion(xr.headQuat).setY(0).normalize();
            right.set(-fwd.z, 0, fwd.x);
            move.copy(fwd).multiplyScalar(-ay).addScaledVector(right, ax).multiplyScalar(1.6 * dt);
            worldFromBase.premultiply(tmpM.makeTranslation(move.x, 0, move.z));
            moved = true;
          }
          if (edge('l5', btn(5))) { // Y: menu
            menu.mesh.visible = !menu.mesh.visible;
            menuNeedsPlacement = menu.mesh.visible;
          }
          if (edge('l4', btn(4))) this.set({ fieldId: cycle(fieldIds(), this.state.fieldId, 1) }); // X: pole
          if (edge('l3', btn(3)) && !isAR) { worldFromBase.identity(); moved = true; } // gałka: start
        } else if (hand === 'right') {
          if (!isAR && pose && Math.abs(ax) > Math.abs(ay)) {
            if (turnArmed && Math.abs(ax) > 0.7) {
              const angle = -Math.sign(ax) * THREE.MathUtils.degToRad(30);
              const turn = new THREE.Matrix4().makeTranslation(xr.head.x, 0, xr.head.z)
                .multiply(tmpM.makeRotationY(angle))
                .multiply(new THREE.Matrix4().makeTranslation(-xr.head.x, 0, -xr.head.z));
              worldFromBase.premultiply(turn);
              moved = true;
              turnArmed = false;
            }
          } else if (Math.abs(ay) > 0.2) {
            // Gałka góra/dół: z Arduino (gałka) zmienia wartość pola; z wciśniętym grip – wielkość kulki.
            const manual = this.state.sensorKind === 'arduino-manual';
            if (manual && !btn(1)) this.manualSensor.adjust(this.state.fieldId, -ay * dt);
            else if (this.state.measuring) this.state.brush = clamp(this.state.brush * (1 - ay * dt * 1.2), 0.02, 0.5);
          }
          if (Math.abs(ax) < 0.3) turnArmed = true;
          if (edge('r4', btn(4))) this.set({ fieldMode: cycle(FIELD_MODES, this.state.fieldMode, 1) }); // A
          if (edge('r5', btn(5))) this.set({ measuring: !this.state.measuring }); // B
        }
      }
      if (moved) applyOffset();

      // Menu: ustawienie przed użytkownikiem.
      if (menuNeedsPlacement && xr.hasHead) {
        fwd.set(0, 0, -1).applyQuaternion(xr.headQuat).setY(0).normalize();
        menu.mesh.position.copy(xr.head).addScaledVector(fwd, 0.8);
        menu.mesh.position.y = xr.head.y - 0.15;
        menu.mesh.lookAt(xr.head.x, menu.mesh.position.y, xr.head.z);
        menuNeedsPlacement = false;
      }

      // Promienie, trafienia w menu, kulka, rysowanie.
      contentInv.copy(this.content.matrixWorld).invert();
      const contentScale = this.state.dollhouse && xr.dollMatrix ? new THREE.Vector3().setFromMatrixScale(xr.dollMatrix).x : 1;
      let hoverHit = null;
      brush.visible = false;
      for (const src of session.inputSources) {
        const rp = src.targetRaySpace && frame.getPose(src.targetRaySpace, ref);
        const line = getRay(src);
        if (!rp) { line.visible = false; continue; }
        poseM.fromArray(rp.transform.matrix);
        rayOrigin.setFromMatrixPosition(poseM);
        rayDir.set(0, 0, -1).applyQuaternion(tmpQ.setFromRotationMatrix(poseM));
        let len = 0.3;
        let hit = null;
        if (menu.mesh.visible) {
          raycaster.set(rayOrigin, rayDir);
          const ix = raycaster.intersectObject(menu.mesh, false)[0];
          if (ix) { hit = menu.hitTest(ix.uv); len = ix.distance; if (hit) hoverHit = hit; }
          else len = 1.5;
        }
        hits.set(src, hit);
        line.matrix.copy(poseM).multiply(tmpM.makeScale(1, 1, len));
        line.matrixWorldNeedsUpdate = true;
        line.visible = src.targetRayMode !== 'screen';

        // Kierunek pilota = oś trzyosiowego czujnika (dla pól wektorowych udawanego Arduino).
        if (src === primary) this.manualSensor.setDirection(dirScan.copy(rayDir).transformDirection(contentInv));

        // Kulka pomiarowa kilka cm przed pilotem.
        const r = this.state.brush;
        tip.copy(rayOrigin).addScaledVector(rayDir, 0.06 + r);
        if (src === primary && this.state.measuring && !this.state.dollhouse && !hit) {
          brush.visible = true;
          brush.position.copy(tip);
          brush.scale.setScalar(r);
          brush.material.color.set(painting.has(src) ? 0x7dff9a : 0xffffff);
        }
        if (painting.has(src)) {
          tipScan.copy(tip).applyMatrix4(contentInv);
          const prev = painting.get(src);
          const minStep = Math.max(0.01, r * 0.5) / contentScale;
          const reading = this.sensor.read(tipScan);
          if (reading && (!prev || prev.distanceTo(tipScan) >= minStep)) {
            this.meas.add(tipScan, r / contentScale, reading, now / 1000);
            painting.set(src, tipScan.clone());
            this.fieldView.markDirty();
          }
        }
      }
      // Usuń promienie po rozłączonych pilotach.
      for (const [src, line] of rays) {
        if (![...session.inputSources].includes(src)) { ui.remove(line); line.material.dispose(); rays.delete(src); }
      }
      menu.setHover(hoverHit);
      if (now - lastMenuRedraw > 300 && menu.mesh.visible) { menu.redraw(); lastMenuRedraw = now; }

      // Legenda + sonda (wartość w miejscu kulki).
      const L = this.legendInfo();
      const def = this.fieldDef();
      let probeText = '', t;
      if (primary) {
        const rp = primary.targetRaySpace && frame.getPose(primary.targetRaySpace, ref);
        if (rp) {
          poseM.fromArray(rp.transform.matrix);
          rayOrigin.setFromMatrixPosition(poseM);
          rayDir.set(0, 0, -1).applyQuaternion(tmpQ.setFromRotationMatrix(poseM));
          tip.copy(rayOrigin).addScaledVector(rayDir, 0.06 + this.state.brush).applyMatrix4(contentInv);
          if (this.state.sensorKind === 'arduino-manual') {
            const reading = this.manualSensor.read();
            const v = this.readingValue(reading);
            probeText = reading ? `Arduino: ${formatValue(def, v)}` : 'Arduino: brak danych';
            t = (v - L.min) / (L.max - L.min);
          } else if (this.state.measuring && def) {
            const v = this.readingValue(this.sensor.read(tip));
            probeText = `Czujnik: ${formatValue(def, v)}`;
            t = (v - L.min) / (L.max - L.min);
          } else {
            const v = this.fieldView.probe(tip, this.state.brush / contentScale);
            probeText = `Tutaj: ${formatValue(def, v)}`;
            t = (v - L.min) / (L.max - L.min);
          }
        }
      }
      const manual = this.state.sensorKind === 'arduino-manual';
      const status = now < flashUntil ? flashText
        : this.state.measuring && manual ? `● Spust = rysuj · gałka ↕ = wartość · grip+gałka = kulka`
        : this.state.measuring ? `● Pomiar: spust = rysuj, kulka ${Math.round(this.state.brush * 100)} cm`
        : manual ? `Arduino: ${this.manualSensor.status()} · gałka ↕ = wartość`
          : isAR && refMatrix ? (xr.aligned ? 'Wyrównano do pokoju' : 'Szukam pokoju do wyrównania...')
            : `Pomiarów: ${this.meas.count}  ·  Y = menu`;
      legend.set({ name: L.name, minText: L.minText, maxText: L.maxText, probeText, status, t, band: L.band });
      // Legenda nad lewym pilotem albo w dolnej części widoku.
      const left = [...session.inputSources].find((x) => x.handedness === 'left');
      const lp = left && (left.gripSpace || left.targetRaySpace) && frame.getPose(left.gripSpace || left.targetRaySpace, ref);
      if (lp) {
        legend.mesh.position.set(lp.transform.position.x, lp.transform.position.y + 0.12, lp.transform.position.z);
      } else if (xr.hasHead) {
        fwd.set(0, 0, -1).applyQuaternion(xr.headQuat).setY(0).normalize();
        legend.mesh.position.copy(xr.head).addScaledVector(fwd, 0.7);
        legend.mesh.position.y -= 0.35;
      }
      legend.mesh.lookAt(xr.head);

      this.fieldView.update(now);
      renderer.render(this.scene, xrCamera);
    });

    await ended;
    session.removeEventListener('selectstart', onSelectStart);
    session.removeEventListener('selectend', onSelectEnd);
    this.scene.remove(ui);
    menu.dispose();
    legend.dispose();
    brush.geometry.dispose();
    brush.material.dispose();
    brushWire.material.dispose();
    rayGeom.dispose();
    for (const line of rays.values()) line.material.dispose();
    this.xr = null;
    this.state.dollhouse = false;
    this.updateContentMatrix();
    this.scene.background = prevBackground;
    this.grid.visible = true;
    if (this.hasUnsavedMeasurements()) {
      this.refreshBounds();
      await this.save();
    }
    this.onChange?.();
    this.resize();
    if (this.model) this.startDesktopLoop();
  }

  dispose() {
    this.manualSensor.stop();
    window.removeEventListener('resize', this._resize);
    this.stop();
    this.controls.dispose();
  }
}
