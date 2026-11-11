import * as THREE from 'three';
import { RoomScanner, isImmersiveSupported } from './ar-scanner.js';
import { ScanViewer } from './viewer.js';
import { LAYERS, LAYER_NAMES, layerOf, makeDemoScan, scanStats } from './scan-model.js';
import { listScans, saveScan, deleteScan, getScan, requestPersistence } from './storage.js';
import { downloadBlob, exportGLB, exportJSON, exportPLY, importFile, safeFileName } from './file-formats.js';

const $ = (sel) => document.querySelector(sel);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;
$('#canvas-host').appendChild(renderer.domElement);

const viewer = new ScanViewer(renderer, $('#canvas-host'));
const scanner = new RoomScanner(renderer);

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

function fmtStats(s) {
  return `${s.objects} obiektów · ${s.triangles.toLocaleString('pl-PL')} trójkątów · ${s.area.toFixed(1)} m² powierzchni`;
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
    el.textContent = 'Gogle gotowe: możesz skanować pokój i odtwarzać skany w VR.';
  } else if (vr) {
    el.className = 'card warn';
    el.textContent = 'To urządzenie obsługuje VR, ale nie tryb AR — skanowanie niedostępne, odtwarzanie działa.';
  } else {
    el.className = 'card';
    el.innerHTML = 'Brak WebXR w tej przeglądarce. Otwórz tę stronę w <b>przeglądarce Meta Quest</b>, aby skanować. Tutaj możesz oglądać i eksportować skany w 3D.';
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
    const s = scanStats(scan);
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'info';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = scan.name;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${fmtDate(scan.createdAt)} · ${SOURCE_NAMES[scan.source] || scan.source} · ${fmtStats(s)}`;
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

function showHome() {
  viewer.stop();
  current = null;
  $('#viewer').hidden = true;
  $('#home').hidden = false;
  renderList();
}

// --- podgląd skanu -----------------------------------------------------------

function syncViewerControls() {
  const model = viewer.model;
  if (!model) return;
  for (const b of document.querySelectorAll('#mode-seg button')) {
    b.classList.toggle('active', b.dataset.mode === model.mode);
  }
  for (const input of document.querySelectorAll('#layers input')) {
    input.checked = model.visibleLayers[input.dataset.layer];
  }
}

function buildLayerControls() {
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
    input.addEventListener('change', () => viewer.setLayerVisible(layer, input.checked));
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = `(${counts[layer]})`;
    label.append(input, ` ${LAYER_NAMES[layer]} `, count);
    host.append(label);
  }
}

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
  $('#viewer-stats').textContent = `${fmtDate(scan.createdAt)}\n${fmtStats(scanStats(scan))}`;
  viewer.setCut($('#cut').checked);
  viewer.show(scan);
  buildLayerControls();
  syncViewerControls();
}

viewer.onChange = syncViewerControls;

async function enterXR(mode) {
  if (!viewer.model || busy) return;
  busy = true;
  try {
    await viewer.enterXR(mode);
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

// --- przyciski podglądu ------------------------------------------------------

$('#btn-back').addEventListener('click', showHome);
$('#btn-vr').addEventListener('click', () => enterXR('immersive-vr'));
$('#btn-ar').addEventListener('click', () => enterXR('immersive-ar'));
$('#cut').addEventListener('change', (e) => viewer.setCut(e.target.checked));
for (const b of document.querySelectorAll('#mode-seg button')) {
  b.addEventListener('click', () => viewer.setMode(b.dataset.mode));
}

$('#exp-glb').addEventListener('click', async () => {
  try {
    downloadBlob(await exportGLB(current), `${safeFileName(current.name)}.glb`);
  } catch (err) {
    toast(`Eksport GLB nie powiódł się: ${err.message || err}`);
  }
});
$('#exp-ply').addEventListener('click', () => {
  const objects = viewer.model.visibleObjects();
  if (!objects.length) { toast('Włącz przynajmniej jedną warstwę.'); return; }
  const { blob, points } = exportPLY(objects);
  downloadBlob(blob, `${safeFileName(current.name)}.ply`);
  toast(`Chmura punktów: ${points.toLocaleString('pl-PL')} punktów`);
});
$('#exp-json').addEventListener('click', () => {
  downloadBlob(exportJSON(current), `${safeFileName(current.name)}.json`);
});

$('#btn-rename').addEventListener('click', async () => {
  const name = prompt('Nowa nazwa skanu:', current.name);
  if (!name || !name.trim()) return;
  current.name = name.trim();
  await saveScan(current);
  $('#viewer-title').textContent = current.name;
});

$('#btn-delete').addEventListener('click', async () => {
  if (!confirm(`Usunąć skan „${current.name}”?`)) return;
  await deleteScan(current.id);
  toast('Skan usunięty.');
  showHome();
});

// --- start -------------------------------------------------------------------

renderSupport().then(renderList);
