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
export const MAP_AXES = ['off', 'y', 'x', 'z', 'free'];
export const MAP_AXIS_NAMES = { off: 'wył.', y: 'poziomo', x: 'pionowo X', z: 'pionowo Z', free: 'ręczna (z gogli)', hand: 'w ręce' };
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
    map: { axis: 'off', pos: 1, free: null, size: 1.0, live: false },
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
      map: { axis: 'off', pos: 1, free: null, size: keep.map.size, live: false },
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
    if (!this.fieldView.getRange().count) return '—';
    return formatValue(this.fieldDef(), this.bandValue(which));
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
      loText: this.bandValueText('lo'),
      hiText: this.bandValueText('hi'),
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
   * opts.session – już otwarta sesja (prosto ze skanowania): skan jest w jej układzie
   *   współrzędnych, więc nie trzeba niczego wyrównywać.
   * opts.startMeasuring – od razu tryb pomiaru.
   */
  async enterXR(mode = 'immersive-vr', { session: existing = null, startMeasuring = false } = {}) {
    const renderer = this.renderer;
    const isAR = mode === 'immersive-ar';
    const session = existing || await navigator.xr.requestSession(mode, {
      requiredFeatures: ['local-floor'],
      optionalFeatures: ['hand-tracking', 'mesh-detection', 'plane-detection', 'bounded-floor'],
    });
    const ended = new Promise((resolve) => session.addEventListener('end', resolve, { once: true }));
    if (!existing) {
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);
    }

    const baseRef = renderer.xr.getReferenceSpace();
    const prevBackground = this.scene.background;
    const prevRoomMode = this.state.roomMode;
    if (isAR) {
      this.scene.background = null;
      // w AR pokój jako siatka, żeby widzieć prawdziwe otoczenie
      if (this.state.roomMode === 'solid') this.set({ roomMode: 'wire' });
    }
    this.grid.visible = !isAR;
    // Granica (Guardian) jako zapasowy punkt odniesienia.
    const boundedSpace = !existing && this.scan.bounded
      ? await session.requestReferenceSpace('bounded-floor').catch(() => null) : null;

    const xr = {
      session, isAR, align: null, dollMatrix: null,
      // jak skan jest dopasowany do prawdziwego pokoju:
      // 'session' (ta sama sesja co skanowanie) | 'mesh' | 'bounded' | 'manual' | 'none'
      alignMode: existing ? 'session' : 'none',
      head: new THREE.Vector3(), headQuat: new THREE.Quaternion(), hasHead: false,
    };
    const ALIGN_NAMES = {
      session: 'skan z tej sesji', mesh: 'wg siatki pokoju', bounded: 'wg granicy (Guardian)',
      manual: 'ręczne', none: 'BRAK – użyj „Dopasuj ręcznie”',
    };
    let aligning = false; // tryb ręcznego dopasowania (grip przesuwa/obraca pokój)
    if (startMeasuring) this.state.measuring = true;
    this.xr = xr;
    const xrCamera = new THREE.PerspectiveCamera(70, 1, 0.02, 200);
    const ui = new THREE.Group(); // elementy interfejsu (bez przycinania)
    this.scene.add(ui);

    // --- menu ---
    const s = () => this.state;
    const fieldIds = () => this.meas.fields.map((f) => f.id);
    const b = () => this.bounds;
    let flashText = '', flashUntil = 0;
    const flash = (t) => { flashText = t; flashUntil = performance.now() + 2000; };

    // Suwaki zakresu na pasku skali (przeciągane promieniem).
    const setBand = (which, u) => {
      const band = this.state.band;
      if (which === 'lo') this.set({ band: { lo: clamp(+u.toFixed(3), 0, band.hi - 0.01) } });
      else this.set({ band: { hi: clamp(+u.toFixed(3), band.lo + 0.01, 1) } });
    };

    // Mapa pola: płaszczyzny XYZ, "w ręce" (trzymana lewym pilotem) albo postawiona ręczna.
    let holdingPlane = false;
    const mapChoice = () => (holdingPlane ? 'hand' : this.state.map.axis);
    const chooseMap = (d) => {
      const options = ['off', 'y', 'x', 'z', 'hand'];
      if (this.state.map.free) options.push('free');
      const next = cycle(options, mapChoice(), d);
      holdingPlane = next === 'hand';
      if (holdingPlane) this.set({ map: { axis: 'free', live: true } });
      else this.set({ map: { axis: next, live: false } });
    };
    const putDownPlane = () => {
      holdingPlane = false;
      this.set({ map: { live: false } });
      flash('Mapa postawiona (lewy spust = weź znowu)');
    };

    const menu = new XRMenu([
      { type: 'legend', get: () => this.legendInfo(), onBand: (which, u) => setBand(which, u) },
      { type: 'stepper', label: 'Pole', value: () => this.fieldDef()?.name || '—',
        dec: () => this.set({ fieldId: cycle(fieldIds(), s().fieldId, -1) }),
        inc: () => this.set({ fieldId: cycle(fieldIds(), s().fieldId, 1) }) },
      { type: 'stepper', label: 'Widok pola', value: () => FIELD_MODE_NAMES[s().fieldMode],
        dec: () => this.set({ fieldMode: cycle(FIELD_MODES, s().fieldMode, -1) }),
        inc: () => this.set({ fieldMode: cycle(FIELD_MODES, s().fieldMode, 1) }) },
      { type: 'stepper', label: 'Krycie pól', value: () => pct(s().fieldOpacity),
        dec: () => this.set({ fieldOpacity: clamp(+(s().fieldOpacity - 0.1).toFixed(2), 0.1, 1) }),
        inc: () => this.set({ fieldOpacity: clamp(+(s().fieldOpacity + 0.1).toFixed(2), 0.1, 1) }) },
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
      { type: 'stepper', label: 'Mapa pola (płaszczyzna)', value: () => MAP_AXIS_NAMES[mapChoice()],
        dec: () => chooseMap(-1), inc: () => chooseMap(1) },
      { type: 'stepper', label: '  rozmiar mapy w ręce', value: () => `${s().map.size.toFixed(1)} m`,
        dec: () => this.set({ map: { size: clamp(+(s().map.size - 0.2).toFixed(1), 0.4, 4) } }),
        inc: () => this.set({ map: { size: clamp(+(s().map.size + 0.2).toFixed(1), 0.4, 4) } }) },
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
        { label: 'Dopasuj ręcznie', active: () => aligning, onClick: () => {
          aligning = !aligning;
          if (aligning) { this.set({ dollhouse: false }); flash('Grip: przesuń/obróć pokój'); }
        } },
        { label: 'Auto wyrównanie', onClick: () => { aligning = false; xr.alignMode = 'none'; xr.align = null; this.updateContentMatrix(); } },
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
    ui.add(menu.mesh);
    let menuNeedsPlacement = !startMeasuring;
    if (startMeasuring) {
      menu.mesh.visible = false;
      flash('Pomiary: spust = rysuj · Y = menu');
    }

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

    // Promień: cienki walec (lepiej widoczny niż linia 1 px) + kursor w miejscu trafienia w menu.
    const rayGeom = new THREE.CylinderGeometry(0.0018, 0.0018, 1, 6, 1, true);
    rayGeom.rotateX(-Math.PI / 2);
    rayGeom.translate(0, 0, -0.5);
    const cursorRing = new THREE.RingGeometry(0.009, 0.015, 32);
    const cursorDot = new THREE.CircleGeometry(0.0045, 16);
    const rays = new Map(); // inputSource -> { line, cursor }
    const getRay = (src) => {
      let r = rays.get(src);
      if (!r) {
        const line = new THREE.Mesh(rayGeom, new THREE.MeshBasicMaterial({ color: 0x9fdcff, transparent: true, opacity: 0.9 }));
        line.matrixAutoUpdate = false;
        const top = { depthTest: false, depthWrite: false, transparent: true };
        const cursor = new THREE.Group();
        const ring = new THREE.Mesh(cursorRing, new THREE.MeshBasicMaterial({ color: 0xffe14d, ...top }));
        const dot = new THREE.Mesh(cursorDot, new THREE.MeshBasicMaterial({ color: 0xffffff, ...top }));
        ring.renderOrder = dot.renderOrder = 1002;
        cursor.add(ring, dot);
        cursor.visible = false;
        ui.add(line, cursor);
        r = { line, cursor, ring };
        rays.set(src, r);
      }
      return r;
    };
    // Punkt promienia na (nieskończonej) płaszczyźnie menu -> uv; do przeciągania poza krawędź.
    const menuPlane = new THREE.Plane();
    const menuHitPoint = new THREE.Vector3();
    const menuUV = (ray) => {
      menu.mesh.updateMatrixWorld();
      menuPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1).applyQuaternion(menu.mesh.quaternion), menu.mesh.position);
      if (!ray.intersectPlane(menuPlane, menuHitPoint)) return null;
      const local = menu.mesh.worldToLocal(menuHitPoint.clone());
      const { width, height } = menu.mesh.geometry.parameters;
      return new THREE.Vector2(local.x / width + 0.5, local.y / height + 0.5);
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
    const dragging = new Set(); // piloty przeciągające suwak w menu
    const onSelectStart = (e) => {
      const src = e.inputSource;
      const hit = menu.mesh.visible ? hits.get(src) : null;
      if (hit) {
        menu.press(hit);
        if (menu.drag) dragging.add(src);
        return;
      }
      if (holdingPlane && src.handedness !== 'right') { putDownPlane(); return; }
      if (!holdingPlane && this.state.map.axis === 'free' && src.handedness === 'left' && !this.state.measuring) {
        holdingPlane = true;
        this.set({ map: { live: true } });
        return;
      }
      if (this.state.measuring && !this.state.dollhouse) painting.set(src, null);
    };
    const onSelectEnd = (e) => {
      painting.delete(e.inputSource);
      if (dragging.delete(e.inputSource)) menu.release();
    };
    session.addEventListener('selectstart', onSelectStart);
    session.addEventListener('selectend', onSelectEnd);

    // --- chwytanie makiety (grip): jedna ręka = przesuwanie i obracanie, dwie = też skala ---
    const grabs = new Set();
    let grabBase = null;
    const onSqueezeStart = (e) => {
      if (!this.state.dollhouse && !aligning) return;
      grabs.add(e.inputSource);
      grabBase = null; // nowa baza w następnej klatce
    };
    const onSqueezeEnd = (e) => {
      if (grabs.delete(e.inputSource)) grabBase = null;
    };
    session.addEventListener('squeezestart', onSqueezeStart);
    session.addEventListener('squeezeend', onSqueezeEnd);
    const gripMatrix = (frame, ref, src) => {
      const space = src.gripSpace || src.targetRaySpace;
      const p = space && frame.getPose(space, ref);
      return p ? new THREE.Matrix4().fromArray(p.transform.matrix) : null;
    };
    const updateGrab = (frame, ref) => {
      if (aligning && !this.state.dollhouse && grabs.size) { updateAlignGrab(frame, ref); return; }
      if (!this.state.dollhouse || !xr.dollMatrix || !grabs.size) return;
      const srcs = [...grabs].slice(0, 2);
      const mats = srcs.map((src) => gripMatrix(frame, ref, src));
      if (mats.some((m) => !m)) return;
      if (!grabBase) { grabBase = { D0: xr.dollMatrix.clone(), mats }; return; }
      let D;
      if (mats.length === 1) {
        // makieta podąża za dłonią (przesunięcie + obrót)
        D = mats[0].clone().multiply(grabBase.mats[0].clone().invert()).multiply(grabBase.D0);
      } else {
        const p = mats.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
        const q = grabBase.mats.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
        const mid = p[0].clone().add(p[1]).multiplyScalar(0.5);
        const mid0 = q[0].clone().add(q[1]).multiplyScalar(0.5);
        const v = p[1].clone().sub(p[0]), v0 = q[1].clone().sub(q[0]);
        const dAngle = Math.atan2(v.x, v.z) - Math.atan2(v0.x, v0.z);
        const scale0 = new THREE.Vector3().setFromMatrixScale(grabBase.D0).x;
        const k = clamp(v.length() / Math.max(v0.length(), 1e-3), 0.02 / scale0, 1.5 / scale0);
        D = new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z)
          .multiply(new THREE.Matrix4().makeRotationY(dAngle))
          .multiply(new THREE.Matrix4().makeScale(k, k, k))
          .multiply(new THREE.Matrix4().makeTranslation(-mid0.x, -mid0.y, -mid0.z))
          .multiply(grabBase.D0);
      }
      xr.dollMatrix = D;
      this.updateContentMatrix();
    };
    // Ręczne dopasowanie skanu do prawdziwego pokoju: przesunięcie w poziomie + obrót wokół pionu.
    const yawOf = (m) => { const f = new THREE.Vector3(0, 0, -1).transformDirection(m); return Math.atan2(f.x, f.z); };
    const updateAlignGrab = (frame, ref) => {
      const src = [...grabs][0];
      const m = gripMatrix(frame, ref, src);
      if (!m) return;
      if (!grabBase) { grabBase = { A0: (xr.align || new THREE.Matrix4()).clone(), mats: [m] }; return; }
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const p0 = new THREE.Vector3().setFromMatrixPosition(grabBase.mats[0]);
      const dYaw = yawOf(m) - yawOf(grabBase.mats[0]);
      xr.align = new THREE.Matrix4().makeTranslation(p.x, 0, p.z)
        .multiply(new THREE.Matrix4().makeRotationY(dYaw))
        .multiply(new THREE.Matrix4().makeTranslation(-p0.x, 0, -p0.z))
        .multiply(grabBase.A0);
      xr.alignMode = 'manual';
      this.updateContentMatrix();
    };

    // obrót makiety wokół jej środka (prawa gałka w bok)
    const spinDollhouse = (angle) => {
      const c = this.roomBounds.getCenter(new THREE.Vector3()).applyMatrix4(xr.dollMatrix);
      xr.dollMatrix = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
        .multiply(new THREE.Matrix4().makeRotationY(angle))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z))
        .multiply(xr.dollMatrix);
      grabBase = null;
      this.updateContentMatrix();
    };

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
    const refInv = refMatrix ? refMatrix.clone().invert() : null;
    const boundedInv = this.scan.bounded ? new THREE.Matrix4().fromArray(this.scan.bounded.matrix).invert() : null;
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

      // Wyrównanie skanu do prawdziwego pokoju (VR i AR). Pozycje w układzie bazowym
      // (bez lokomocji). Najpierw siatka pokoju z Space Setup, potem granica Guardian.
      const autoAlign = xr.alignMode === 'none' || xr.alignMode === 'bounded' || (xr.alignMode === 'mesh' && frameNo % 60 === 0);
      if (autoAlign && !aligning) {
        let found = false;
        if (refMatrix) {
          const label = this.scan.reference.label.toLowerCase();
          const items = this.scan.reference.kind === 'plane' ? frame.detectedPlanes : frame.detectedMeshes;
          for (const it of items || []) {
            if ((it.semanticLabel || '').toLowerCase() !== label) continue;
            const p = frame.getPose(it.meshSpace || it.planeSpace, baseRef);
            if (!p) continue;
            xr.align = alignTmp.fromArray(p.transform.matrix).multiply(refInv).clone();
            xr.alignMode = 'mesh';
            found = true;
            this.updateContentMatrix();
            break;
          }
        }
        if (!found && boundedSpace && xr.alignMode === 'none') {
          const p = frame.getPose(boundedSpace, baseRef);
          if (p) {
            xr.align = alignTmp.fromArray(p.transform.matrix).multiply(boundedInv).clone();
            xr.alignMode = 'bounded';
            this.updateContentMatrix();
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
          if (this.state.dollhouse && xr.dollMatrix && Math.abs(ax) > Math.abs(ay)) {
            if (Math.abs(ax) > 0.15) spinDollhouse(-ax * dt * 1.8);
          } else if (!isAR && pose && Math.abs(ax) > Math.abs(ay)) {
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
      updateGrab(frame, ref);

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
        const { line, cursor, ring } = getRay(src);
        cursor.visible = false;
        if (!rp) { line.visible = false; continue; }
        poseM.fromArray(rp.transform.matrix);
        rayOrigin.setFromMatrixPosition(poseM);
        rayDir.set(0, 0, -1).applyQuaternion(tmpQ.setFromRotationMatrix(poseM));
        let len = 0.3;
        let hit = null;
        if (menu.mesh.visible) {
          raycaster.set(rayOrigin, rayDir);
          if (dragging.has(src)) menu.dragTo(menuUV(raycaster.ray));
          const ix = raycaster.intersectObject(menu.mesh, false)[0];
          if (ix) {
            hit = menu.hitTest(ix.uv);
            len = ix.distance;
            if (hit) hoverHit = hit;
            // kursor: żółty pierścień z białą kropką, tuż przed menu
            cursor.visible = true;
            cursor.position.copy(ix.point).addScaledVector(rayDir, -0.004);
            cursor.quaternion.copy(menu.mesh.quaternion);
            const big = hit || dragging.has(src);
            cursor.scale.setScalar(big ? 1.35 : 1);
            ring.material.color.set(big ? 0xffe14d : 0x9fdcff);
          } else len = 1.5;
        }
        hits.set(src, hit);
        line.matrix.copy(poseM).multiply(tmpM.makeScale(1, 1, len));
        line.matrixWorldNeedsUpdate = true;
        line.material.color.set(hit || dragging.has(src) ? 0xffe14d : 0x9fdcff);
        line.visible = src.targetRayMode !== 'screen';

        // Płaszczyzna mapy trzymana w lewej ręce: rozpięta na osi X pilota i kierunku wskazywania.
        if (holdingPlane && (src.handedness === 'left' || session.inputSources.length === 1)) {
          const size = this.state.map.size;
          const U = new THREE.Vector3(1, 0, 0).applyQuaternion(tmpQ);
          const center = rayOrigin.clone().addScaledVector(rayDir, 0.08 + size / 2).applyMatrix4(contentInv);
          const cs = contentScale;
          this.state.map = {
            ...this.state.map, axis: 'free', live: true,
            free: {
              c: center.toArray(),
              u: U.transformDirection(contentInv).toArray(),
              v: rayDir.clone().transformDirection(contentInv).toArray(),
              w: size / cs, h: size / cs,
            },
          };
          this.fieldView.configure({ map: this.state.map });
        }

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
      for (const [src, r] of rays) {
        if (![...session.inputSources].includes(src)) {
          ui.remove(r.line, r.cursor);
          r.line.material.dispose();
          r.cursor.children.forEach((c) => c.material.dispose());
          rays.delete(src);
        }
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
        : holdingPlane ? 'Mapa w ręce · lewy spust = postaw'
        : this.state.dollhouse ? 'Makieta: grip = chwyć (2 ręce = skala)'
        : aligning ? 'Dopasowanie: grip = przesuń/obróć pokój'
        : xr.alignMode === 'none' && !this.state.dollhouse ? '⚠ Skan nie wyrównany – menu: Dopasuj ręcznie'
        : this.state.measuring && manual ? `● Spust = rysuj · gałka ↕ = wartość · grip+gałka = kulka`
        : this.state.measuring ? `● Pomiar: spust = rysuj, kulka ${Math.round(this.state.brush * 100)} cm`
        : manual ? `Arduino: ${this.manualSensor.status()} · gałka ↕ = wartość`
        : `Wyrównanie: ${ALIGN_NAMES[xr.alignMode]} · Y = menu`;
      const inv = this.state.band.invert;
      legend.set({ name: L.name, minText: inv ? L.minText : L.loText, maxText: inv ? L.maxText : L.hiText, probeText, status, t, band: L.band });
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
    session.removeEventListener('squeezestart', onSqueezeStart);
    session.removeEventListener('squeezeend', onSqueezeEnd);
    if (holdingPlane) { holdingPlane = false; this.state.map = { ...this.state.map, live: false }; }
    this.scene.remove(ui);
    menu.dispose();
    legend.dispose();
    brush.geometry.dispose();
    brush.material.dispose();
    brushWire.material.dispose();
    rayGeom.dispose();
    cursorRing.dispose();
    cursorDot.dispose();
    for (const r of rays.values()) {
      r.line.material.dispose();
      r.cursor.children.forEach((c) => c.material.dispose());
    }
    this.xr = null;
    this.state.dollhouse = false;
    this.applyState();
    this.scene.background = prevBackground;
    this.grid.visible = true;
    if (isAR && this.state.roomMode === 'wire' && prevRoomMode === 'solid') this.state.roomMode = 'solid';
    this.applyState();
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
