import * as THREE from 'three';
import { RoomScanner, isImmersiveSupported } from './ar-scanner.js';
import {
  ScanViewer, FIELD_MODES, FIELD_MODE_NAMES, SIDE_CUTS, SIDE_CUT_NAMES, MAP_AXES, MAP_AXIS_NAMES,
} from './viewer.js';
import { SENSOR_KINDS, SENSOR_NAMES, MANUAL_SPEC } from './sensors.js';
import { formatValue } from './fields.js';
import { drawBandGradient } from './xr-menu.js';
import { LAYERS, LAYER_NAMES, layerOf, makeDemoScan, scanStats } from './scan-model.js';
import { listScans, saveScan, deleteScan, getScan, requestPersistence } from './storage.js';
import {
  downloadBlob, exportGLB, exportJSON, exportPLY, exportMeasurementsPLY, importFile, safeFileName,
} from './file-formats.js';

const $ = (sel) => document.querySelector(sel);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
$('#canvas-host').appendChild(renderer.domElement);

const viewer = new ScanViewer(renderer, $('#canvas-host'));
const scanner = new RoomScanner(renderer);
viewer.onSave = (scan) => saveScan(scan);

let current = null; // aktualnie otwarty skan
let support = { ar: false, vr: false };
let busy = false;

// --- komunikaty --------------------------------------------------------------

let toastTimer = null;
function toast(text, ms = 4000) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function fmtDate(ms) {
  return new Date(ms).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtStats(scan) {
  const s = scanStats(scan);
  const meas = scan.measurements?.count || 0;
  return `${s.objects} obiektów · ${s.triangles.toLocaleString('pl-PL')} trójkątów · ${s.area.toFixed(1)} m²`
    + (meas ? ` · ${meas.toLocaleString('pl-PL')} pomiarów` : '');
}

const SOURCE_NAMES = { quest: 'Quest', demo: 'demo', import: 'import' };

// --- ekran główny ------------------------------------------------------------

async function renderSupport() {
  const [ar, vr] = await Promise.all([isImmersiveSupported('immersive-ar'), isImmersiveSupported('immersive-vr')]);
  support = { ar, vr };
  const el = $('#support');
  if (!window.isSecureContext) {
    el.className = 'card warn';
    el.innerHTML = 'Strona nie jest otwarta przez <b>HTTPS</b> — gogle nie pozwolą uruchomić WebXR. Otwórz ją z adresu https:// (np. GitHub Pages).';
  } else if (ar) {
    el.className = 'card ok';
    el.textContent = 'Gogle gotowe: możesz skanować pokój, robić pomiary i odtwarzać skany w VR.';
  } else if (vr) {
    el.className = 'card warn';
    el.textContent = 'To urządzenie obsługuje VR, ale nie tryb AR — skanowanie niedostępne, odtwarzanie działa.';
  } else {
    el.className = 'card';
    el.innerHTML = 'Brak WebXR w tej przeglądarce. Otwórz tę stronę w <b>przeglądarce Meta Quest</b>, aby skanować. Tutaj możesz oglądać skany i pomiary w 3D.';
  }
  $('#btn-scan').disabled = !ar;
  $('#btn-vr').disabled = !vr;
  $('#btn-ar').disabled = !ar;
}

async function renderList() {
  const scans = await listScans();
  const list = $('#scan-list');
  list.replaceChildren();
  $('#scan-empty').hidden = scans.length > 0;
  for (const scan of scans) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = scan.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${fmtDate(scan.createdAt)} · ${SOURCE_NAMES[scan.source] || scan.source} · ${fmtStats(scan)}`;
    info.append(name, meta);
    const open = document.createElement('button');
    open.textContent = 'Otwórz';
    open.addEventListener('click', () => openScan(scan.id));
    const vr = document.createElement('button');
    vr.className = 'primary';
    vr.textContent = 'VR';
    vr.title = 'Odtwórz od razu w VR';
    vr.disabled = !support.vr;
    vr.addEventListener('click', async () => {
      await openScan(scan.id);
      enterXR('immersive-vr');
    });
    li.append(info, open, vr);
    list.append(li);
  }
}

async function showHome() {
  if (viewer.hasUnsavedMeasurements()) await viewer.save();
  viewer.stop();
  current = null;
  $('#viewer').hidden = true;
  $('#home').hidden = false;
  renderList();
}

// --- panel podglądu ----------------------------------------------------------

function fillSelect(sel, values, names) {
  sel.replaceChildren(...values.map((v) => {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = names[v] ?? v;
    return o;
  }));
}
fillSelect($('#field-mode'), FIELD_MODES, FIELD_MODE_NAMES);
fillSelect($('#cut-side'), SIDE_CUTS, SIDE_CUT_NAMES);
fillSelect($('#map-axis'), MAP_AXES, MAP_AXIS_NAMES);
fillSelect($('#sensor-kind'), SENSOR_KINDS, SENSOR_NAMES);

// Suwaki udawanego Arduino (po jednym na pole).
const manualInputs = {};
for (const f of viewer.manualSensor.fields) {
  const spec = MANUAL_SPEC[f.id];
  if (!spec) continue;
  const label = document.createElement('label');
  label.className = 'field';
  const out = document.createElement('output');
  const input = document.createElement('input');
  Object.assign(input, { type: 'range', min: spec.min, max: spec.max, step: (spec.max - spec.min) / 200 });
  input.addEventListener('input', () => viewer.manualSensor.setValue(f.id, parseFloat(input.value)));
  label.append(`${f.name}${f.components === 3 ? ' (długość)' : ''} `, out, input);
  $('#manual-sliders').append(label);
  manualInputs[f.id] = { input, out, def: f };
}

/** Odświeża podgląd strumienia z Arduino (wartości mogą się zmieniać z gogli). */
function refreshSensorPanel() {
  if ($('#viewer').hidden) return;
  const m = viewer.manualSensor;
  $('#manual-box').hidden = viewer.state.sensorKind !== 'arduino-manual';
  for (const [id, { input, out, def }] of Object.entries(manualInputs)) {
    if (document.activeElement !== input) input.value = m.values[id];
    out.textContent = formatValue(def, m.values[id]);
  }
  $('#sensor-rate').textContent = m.connected() ? `Połączono · ${m.status()} · odebrano ${m.packets}` : 'Brak danych';
  $('#sensor-rate').classList.toggle('on', m.connected());
  $('#sensor-line').textContent = m.lastLine;
}
setInterval(refreshSensorPanel, 250);

// Granice zaokrąglone do kroku suwaka (0,05 m), żeby wartości były "okrągłe".
function setRange(input, min, max) {
  input.min = (Math.floor(min * 20) / 20).toFixed(2);
  input.max = (Math.ceil(max * 20) / 20).toFixed(2);
}

/** Uzupełnia kontrolki, które zależą od skanu (pola, zakresy suwaków, warstwy). */
function buildViewerControls() {
  const fields = viewer.meas.fields;
  fillSelect($('#field-select'), fields.map((f) => f.id), Object.fromEntries(fields.map((f) => [f.id, `${f.name} [${f.unit}]`])));

  const b = viewer.bounds;
  setRange($('#cut-top-h'), Math.max(0.1, b.min.y), b.max.y + 0.1);
  const axis = viewer.state.cutSide.mode[0];
  setRange($('#cut-side-pos'), axis === 'z' ? b.min.z : b.min.x, axis === 'z' ? b.max.z : b.max.x);
  const ma = viewer.state.map.axis;
  setRange($('#map-pos'), ma === 'x' ? b.min.x : ma === 'z' ? b.min.z : b.min.y, ma === 'x' ? b.max.x : ma === 'z' ? b.max.z : b.max.y);

  const counts = { global: 0, objects: 0, planes: 0 };
  for (const o of current.objects) counts[layerOf(o)]++;
  const host = $('#layers');
  host.replaceChildren();
  for (const layer of LAYERS) {
    if (!counts[layer]) continue;
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.layer = layer;
    input.addEventListener('change', () => {
      viewer.model.setLayerVisible(layer, input.checked);
      syncViewerControls();
    });
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `(${counts[layer]})`;
    label.append(input, ` ${LAYER_NAMES[layer]} `, count);
    host.append(label);
  }
}

function syncViewerControls() {
  if (!viewer.model) return;
  const s = viewer.state;
  for (const b of document.querySelectorAll('#mode-seg button')) b.classList.toggle('active', b.dataset.mode === s.roomMode);
  for (const input of document.querySelectorAll('#layers input')) input.checked = viewer.model.visibleLayers[input.dataset.layer];

  $('#field-select').value = s.fieldId ?? '';
  $('#field-mode').value = s.fieldMode;
  $('#field-opacity').value = s.fieldOpacity;
  $('#field-opacity-out').textContent = `${Math.round(s.fieldOpacity * 100)}%`;
  $('#band-lo').value = s.band.lo;
  $('#band-hi').value = s.band.hi;
  $('#band-lo-out').textContent = viewer.bandValueText('lo');
  $('#band-hi-out').textContent = viewer.bandValueText('hi');
  $('#band-invert').checked = s.band.invert;
  // pasek skali: cały = min..max pomiarów, widoczny zakres ma całą tęczę
  const bar = $('#legend-bar');
  drawBandGradient(bar.getContext('2d'), 0, 0, bar.width, bar.height, s.band);
  $('#point-size').value = s.pointSize;
  $('#point-size-out').textContent = `${(s.pointSize * 100).toFixed(1)} cm`;
  $('#voxel-size').value = s.voxelSize;
  $('#voxel-size-out').textContent = `${Math.round(s.voxelSize * 100)} cm`;
  $('#point-size-row').hidden = s.fieldMode !== 'dots';
  $('#voxel-size-row').hidden = !['voxels', 'arrows'].includes(s.fieldMode) && s.map.axis === 'off';
  $('#room-opacity').value = s.roomOpacity;
  $('#room-opacity-out').textContent = `${Math.round(s.roomOpacity * 100)}%`;

  $('#sensor-kind').value = s.sensorKind;
  refreshSensorPanel();
  $('#cut-top').checked = s.cutTop.on;
  $('#cut-top-h').value = s.cutTop.h;
  $('#cut-top-h').disabled = !s.cutTop.on;
  $('#cut-top-out').textContent = `${s.cutTop.h.toFixed(2)} m`;
  $('#cut-side').value = s.cutSide.mode;
  $('#cut-side-pos').hidden = s.cutSide.mode === 'off';
  $('#cut-side-pos').value = s.cutSide.pos;
  $('#map-axis').value = s.map.axis;
  $('#map-axis option[value=free]').disabled = !s.map.free;
  $('#map-pos').hidden = s.map.axis === 'off' || s.map.axis === 'free';
  $('#map-pos').value = s.map.pos;

  const L = viewer.legendInfo();
  $('#legend-min').textContent = L.minText;
  $('#legend-max').textContent = L.maxText;
  const def = viewer.fieldDef();
  let info = `${viewer.meas.count.toLocaleString('pl-PL')} pomiarów`;
  if (def?.components === 3) info += ' · kolor = długość wektora, strzałki = kierunek';
  else if (s.fieldMode === 'arrows') info += ' · strzałki pokazują, w którą stronę wartość rośnie';
  $('#legend-info').textContent = info;
  $('#btn-clear-meas').disabled = viewer.meas.count === 0;
}

viewer.onChange = syncViewerControls;

async function openScan(id) {
  const scan = await getScan(id);
  if (!scan) { toast('Nie znaleziono skanu.'); return; }
  showScan(scan);
}

function showScan(scan) {
  current = scan;
  $('#home').hidden = true;
  $('#viewer').hidden = false;
  $('#viewer-title').textContent = scan.name;
  $('#viewer-stats').textContent = `${fmtDate(scan.createdAt)}\n${fmtStats(scan)}`;
  viewer.show(scan);
  buildViewerControls();
  syncViewerControls();
}

async function enterXR(mode) {
  if (!viewer.model || busy) return;
  busy = true;
  try {
    await viewer.enterXR(mode);
    $('#viewer-stats').textContent = `${fmtDate(current.createdAt)}\n${fmtStats(current)}`;
  } catch (err) {
    console.error(err);
    toast(`Nie udało się uruchomić ${mode === 'immersive-ar' ? 'AR' : 'VR'}: ${err.message || err}`);
  } finally {
    busy = false;
  }
}

// --- skanowanie --------------------------------------------------------------

$('#btn-scan').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    const scan = await scanner.start();
    if (!scan) {
      toast('Nie zebrano danych pokoju. Wykonaj Space Setup i zezwól na dostęp do danych przestrzennych.', 8000);
      return;
    }
    await saveScan(scan);
    requestPersistence();
    toast(`Zapisano: ${scan.name}`);
    showScan(scan);
  } catch (err) {
    console.error(err);
    toast(`Błąd skanowania: ${err.message || err}`, 8000);
  } finally {
    busy = false;
  }
});

$('#btn-demo').addEventListener('click', async () => {
  const scan = makeDemoScan();
  await saveScan(scan);
  showScan(scan);
});

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const scan = await importFile(file);
    await saveScan(scan);
    toast(`Wczytano: ${scan.name}`);
    showScan(scan);
  } catch (err) {
    console.error(err);
    toast(`Nie udało się wczytać pliku: ${err.message || err}`, 8000);
  }
});

// --- kontrolki podglądu ------------------------------------------------------

const num = (sel) => parseFloat($(sel).value);
const on = (sel, ev, fn) => $(sel).addEventListener(ev, fn);

on('#btn-back', 'click', showHome);
on('#btn-vr', 'click', () => enterXR('immersive-vr'));
on('#btn-ar', 'click', () => enterXR('immersive-ar'));
on('#btn-top', 'click', () => viewer.viewTop());
on('#btn-persp', 'click', () => viewer.viewPerspective());
for (const b of document.querySelectorAll('#mode-seg button')) {
  b.addEventListener('click', () => viewer.set({ roomMode: b.dataset.mode }));
}
on('#room-opacity', 'input', () => viewer.set({ roomOpacity: num('#room-opacity') }));
on('#field-select', 'change', () => viewer.set({ fieldId: $('#field-select').value }));
on('#field-mode', 'change', () => viewer.set({ fieldMode: $('#field-mode').value }));
on('#field-opacity', 'input', () => viewer.set({ fieldOpacity: num('#field-opacity') }));
on('#band-lo', 'input', () => {
  const lo = Math.min(num('#band-lo'), viewer.state.band.hi - 0.01);
  viewer.set({ band: { lo } });
});
on('#band-hi', 'input', () => {
  const hi = Math.max(num('#band-hi'), viewer.state.band.lo + 0.01);
  viewer.set({ band: { hi } });
});
on('#band-invert', 'change', () => viewer.set({ band: { invert: $('#band-invert').checked } }));
on('#band-reset', 'click', () => viewer.set({ band: { lo: 0, hi: 1, invert: false } }));
on('#point-size', 'input', () => viewer.set({ pointSize: num('#point-size') }));
on('#voxel-size', 'input', () => viewer.set({ voxelSize: num('#voxel-size') }));
on('#sensor-kind', 'change', () => viewer.set({ sensorKind: $('#sensor-kind').value }));
on('#cut-top', 'change', () => viewer.set({ cutTop: { on: $('#cut-top').checked } }));
on('#cut-top-h', 'input', () => viewer.set({ cutTop: { h: num('#cut-top-h') } }));
on('#cut-side', 'change', () => {
  const mode = $('#cut-side').value;
  const b = viewer.bounds;
  const c = b.getCenter(new THREE.Vector3());
  viewer.set({ cutSide: { mode, pos: +(mode[0] === 'z' ? c.z : c.x).toFixed(2) } });
  buildViewerControls();
  syncViewerControls();
});
on('#cut-side-pos', 'input', () => viewer.set({ cutSide: { pos: num('#cut-side-pos') } }));
on('#map-axis', 'change', () => {
  const axis = $('#map-axis').value;
  const c = viewer.bounds.getCenter(new THREE.Vector3());
  viewer.set({ map: { axis, pos: +(axis === 'y' ? 1 : axis === 'x' ? c.x : c.z).toFixed(2) } });
  buildViewerControls();
  syncViewerControls();
});
on('#map-pos', 'input', () => viewer.set({ map: { pos: num('#map-pos') } }));

on('#btn-demo-meas', 'click', async () => {
  viewer.addDemoMeasurements();
  await viewer.save();
  buildViewerControls();
  syncViewerControls();
  $('#viewer-stats').textContent = `${fmtDate(current.createdAt)}\n${fmtStats(current)}`;
  toast(`Dodano symulowane pomiary (razem: ${viewer.meas.count.toLocaleString('pl-PL')}).`);
});
on('#btn-clear-meas', 'click', async () => {
  if (!confirm('Usunąć wszystkie pomiary z tego skanu?')) return;
  viewer.clearMeasurements();
  await viewer.save();
  $('#viewer-stats').textContent = `${fmtDate(current.createdAt)}\n${fmtStats(current)}`;
});

on('#exp-glb', 'click', async () => {
  try {
    downloadBlob(await exportGLB(current), `${safeFileName(current.name)}.glb`);
  } catch (err) {
    toast(`Eksport GLB nie powiódł się: ${err.message || err}`);
  }
});
on('#exp-ply', 'click', () => {
  const objects = viewer.model.visibleObjects();
  if (!objects.length) { toast('Włącz przynajmniej jedną warstwę pokoju.'); return; }
  const { blob, points } = exportPLY(objects);
  downloadBlob(blob, `${safeFileName(current.name)}.ply`);
  toast(`Chmura punktów: ${points.toLocaleString('pl-PL')} punktów`);
});
on('#exp-meas', 'click', () => {
  if (!viewer.meas.count) { toast('Ten skan nie ma pomiarów.'); return; }
  downloadBlob(exportMeasurementsPLY(viewer.meas), `${safeFileName(current.name)}_pomiary.ply`);
});
on('#exp-json', 'click', async () => {
  if (viewer.hasUnsavedMeasurements()) await viewer.save();
  downloadBlob(exportJSON(current), `${safeFileName(current.name)}.json`);
});

on('#btn-rename', 'click', async () => {
  const name = prompt('Nowa nazwa skanu:', current.name);
  if (!name || !name.trim()) return;
  current.name = name.trim();
  await saveScan(current);
  $('#viewer-title').textContent = current.name;
});

on('#btn-delete', 'click', async () => {
  if (!confirm(`Usunąć skan „${current.name}”?`)) return;
  await deleteScan(current.id);
  viewer.savedVersion = viewer.meas.version; // nie zapisuj ponownie usuniętego skanu
  toast('Skan usunięty.');
  showHome();
});

// --- start -------------------------------------------------------------------

renderSupport().then(renderList);
