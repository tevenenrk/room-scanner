// Źródła danych pomiarowych ("czujniki").
//
// Każdy czujnik ma ten sam interfejs:
//   fields          – lista pól [{ id, name, unit, components, decimals }]
//   read(position)  – ostatni odczyt { [fieldId]: liczba | [x, y, z] } albo null (brak danych)
//   status()        – krótki opis stanu do wyświetlenia
//
// Czujniki "strumieniowe" (Arduino) dostają dane jako linie tekstu – protokół opisany niżej.
// Na razie Arduino jest udawane: ManualArduinoSensor sam generuje takie linie, a wartości
// ustawia się gałką pilota (albo suwakami na komputerze). Prawdziwe połączenie (Bluetooth LE /
// WebSocket) będzie tylko podawać linie do tego samego parsera.

import * as THREE from 'three';
import { SIM_FIELDS, SimulatedSensor } from './fields.js';

export { SimulatedSensor };

export const SENSOR_KINDS = ['sim', 'arduino-manual'];
export const SENSOR_NAMES = {
  sim: 'Symulacja pól (wg miejsca)',
  'arduino-manual': 'Arduino (symulacja, gałka)',
};
export const SENSOR_SHORT_NAMES = { sim: 'Symulacja pól', 'arduino-manual': 'Arduino (gałka)' };

/**
 * Protokół "linia JSON" (jedna linia = jeden pakiet, zakończona \n):
 *
 *   {"fields":[{"id":"wifi","name":"Sygnał WiFi","unit":"dBm","components":1}, ...]}   (opcjonalnie, na start)
 *   {"t":12345,"wifi":-52,"mag":[12.1,-40.3,-18.0],"temp":21.4}                          (pomiar)
 *
 * t – czas w ms z Arduino (millis()), pola – wartości; wektor jako tablica [x, y, z].
 */
export function parseSensorLine(line) {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  let msg;
  try { msg = JSON.parse(text); } catch { return null; }
  if (Array.isArray(msg.fields)) return { type: 'fields', fields: msg.fields };
  const reading = {};
  for (const [k, v] of Object.entries(msg)) {
    if (k === 't') continue;
    if (typeof v === 'number' && Number.isFinite(v)) reading[k] = v;
    else if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) reading[k] = v;
  }
  return { type: 'reading', t: msg.t, reading };
}

/** Wspólna część czujników strumieniowych: przyjmuje linie, trzyma ostatni odczyt. */
export class StreamSensor {
  constructor(fields) {
    this.fields = fields;
    this.latest = null;
    this.lastLine = '';
    this.lastTime = 0;
    this.packetTimes = [];
    this.packets = 0;
  }

  ingest(line) {
    const msg = parseSensorLine(line);
    if (!msg) return;
    if (msg.type === 'fields') { this.fields = msg.fields; return; }
    const now = performance.now();
    this.latest = msg.reading;
    this.lastLine = line.trim();
    this.lastTime = now;
    this.packets++;
    this.packetTimes.push(now);
    while (this.packetTimes.length && now - this.packetTimes[0] > 1000) this.packetTimes.shift();
  }

  /** Odczyt nie zależy od pozycji – czujnik mierzy tam, gdzie akurat jest pilot. */
  read() {
    if (!this.latest || performance.now() - this.lastTime > 1000) return null;
    return this.latest;
  }

  rate() { return this.packetTimes.length; }

  connected() { return !!this.latest && performance.now() - this.lastTime <= 1000; }

  status() {
    return this.connected() ? `${this.rate()} pakietów/s` : 'brak danych';
  }
}

/** Zakresy i szybkość zmian (na sekundę przy pełnym wychyleniu gałki). */
export const MANUAL_SPEC = {
  wifi: { min: -100, max: -20, start: -60, speed: 15 },
  mag: { min: 0, max: 300, start: 50, speed: 40 },
  temp: { min: -10, max: 60, start: 21, speed: 3 },
};

/**
 * Udawane Arduino: co 50 ms "wysyła" linię JSON z bieżącymi wartościami.
 * Wartości pól zmienia się gałką (adjust) lub suwakiem (setValue).
 * Pole wektorowe (magnetyczne) ma kierunek, w którym wskazuje pilot – jak
 * trzyosiowy czujnik przymocowany do pilota.
 */
export class ManualArduinoSensor extends StreamSensor {
  constructor({ intervalMs = 50, noise = true } = {}) {
    super(SIM_FIELDS);
    this.values = Object.fromEntries(Object.entries(MANUAL_SPEC).map(([k, s]) => [k, s.start]));
    this.direction = new THREE.Vector3(0, 0, -1);
    this.noise = noise;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.t0 = performance.now();
    // Arduino na początku przedstawia listę pól.
    this.ingest(JSON.stringify({ fields: SIM_FIELDS }));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.ingest(this.makeLine()), this.intervalMs);
    this.ingest(this.makeLine());
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Tak wyglądałaby linia wysłana przez Arduino przez Serial.println(). */
  makeLine() {
    const n = (a) => (this.noise ? (Math.random() - 0.5) * a : 0);
    const d = this.direction;
    const m = this.values.mag;
    const msg = {
      t: Math.round(performance.now() - this.t0),
      wifi: +(this.values.wifi + n(1)).toFixed(1),
      mag: [+(d.x * m + n(0.3)).toFixed(2), +(d.y * m + n(0.3)).toFixed(2), +(d.z * m + n(0.3)).toFixed(2)],
      temp: +(this.values.temp + n(0.05)).toFixed(2),
    };
    return `${JSON.stringify(msg)}\n`;
  }

  /** k: wychylenie gałki × czas (dodatnie = w górę). */
  adjust(fieldId, k) {
    const s = MANUAL_SPEC[fieldId];
    if (!s) return;
    this.values[fieldId] = THREE.MathUtils.clamp(this.values[fieldId] + k * s.speed, s.min, s.max);
  }

  setValue(fieldId, v) {
    const s = MANUAL_SPEC[fieldId];
    if (s) this.values[fieldId] = THREE.MathUtils.clamp(v, s.min, s.max);
  }

  setDirection(dir) {
    if (dir.lengthSq() > 1e-9) this.direction.copy(dir).normalize();
  }
}
