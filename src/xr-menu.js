// Menu w goglach obsługiwane promieniem z pilota (spust = klik, przytrzymanie = przeciąganie)
// oraz mała tabliczka z legendą kolorów i odczytem "sondy".

import * as THREE from 'three';
import { turboRGB } from './fields.js';

function makeCanvasMesh(widthM, pxW, pxH) {
  const canvas = document.createElement('canvas');
  canvas.width = pxW;
  canvas.height = pxH;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const heightM = (widthM * pxH) / pxW;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(widthM, heightM),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
  );
  mesh.renderOrder = 1000;
  return { mesh, canvas, texture, ctx: canvas.getContext('2d') };
}

/**
 * Pasek skali: cała szerokość = min..max pomiarów. Widoczny zakres [lo, hi]
 * dostaje całą tęczę (rozciągniętą), reszta jest szara (niewidoczna).
 * Przy band.invert wycięty zakres jest szary, a reszta ma pełną skalę.
 */
export function drawBandGradient(ctx, x, y, w, h, band = { lo: 0, hi: 1, invert: false }) {
  const { lo, hi, invert } = band;
  for (let i = 0; i < w; i++) {
    const t = i / (w - 1);
    const inside = t >= lo - 1e-6 && t <= hi + 1e-6;
    const visible = invert ? !inside : inside;
    if (!visible) {
      ctx.fillStyle = (i >> 2) % 2 ? '#2b303a' : '#353b47';
    } else {
      const ct = invert || hi - lo <= 1e-6 ? t : (t - lo) / (hi - lo);
      const [r, g, b] = turboRGB(ct);
      ctx.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
    }
    ctx.fillRect(x + i, y, 1, h);
  }
}

function drawHandle(ctx, x, top, bottom, hot) {
  ctx.fillStyle = hot ? '#ffe14d' : '#ffffff';
  ctx.strokeStyle = '#04131f';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(x - 9, top - 6, 18, bottom - top + 12, 6);
  ctx.fill();
  ctx.stroke();
  // trójkąty nad i pod paskiem
  ctx.beginPath();
  ctx.moveTo(x - 16, top - 24); ctx.lineTo(x + 16, top - 24); ctx.lineTo(x, top - 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

/**
 * rows: tablica wierszy:
 *  { type: 'stepper', label, value: () => string, dec: () => void, inc: () => void }
 *  { type: 'buttons', items: [{ label, onClick, active?: () => bool }] }
 *  { type: 'legend', get: () => ({ name, minText, maxText, loText, hiText, band }),
 *    onBand: (which: 'lo' | 'hi', u: 0..1) => void }   – pasek z suwakami zakresu
 */
export class XRMenu {
  constructor(rows, { width = 0.52 } = {}) {
    this.rows = rows;
    this.W = 1024;
    this.rowH = 64;
    this.pad = 20;
    this.layout = [];
    let y = this.pad;
    for (const row of rows) {
      const h = row.type === 'legend' ? 200 : this.rowH;
      this.layout.push({ row, y, h });
      y += h + 6;
    }
    this.H = y + this.pad;
    const { mesh, canvas, texture, ctx } = makeCanvasMesh(width, this.W, this.H);
    this.mesh = mesh;
    this.canvas = canvas;
    this.texture = texture;
    this.ctx = ctx;
    this.hover = null;
    this.drag = null;
    this.redraw();
  }

  trackRect(entry) {
    return { x: this.pad + 30, y: entry.y + 110, w: this.W - 2 * this.pad - 60, h: 44 };
  }

  zones(entry) {
    const { row, y, h } = entry;
    const W = this.W;
    if (row.type === 'stepper') {
      return [
        { id: 'dec', x: W - 400, y, w: 84, h },
        { id: 'inc', x: W - 104, y, w: 84, h },
      ];
    }
    if (row.type === 'buttons') {
      const n = row.items.length;
      const gap = 12;
      const w = (W - 2 * this.pad - gap * (n - 1)) / n;
      return row.items.map((item, i) => ({ id: i, x: this.pad + i * (w + gap), y, w, h }));
    }
    if (row.type === 'legend' && row.onBand) {
      const t = this.trackRect(entry);
      // strefa chwytania szersza niż sam pasek
      return [{ id: 'track', x: t.x - 30, y: t.y - 40, w: t.w + 60, h: t.h + 70 }];
    }
    return [];
  }

  /** Piksele płótna z uv raycastera. */
  toPx(uv) { return { x: uv.x * this.W, y: (1 - uv.y) * this.H }; }

  /** uv z raycastera -> trafienie { index, zone, u? } albo null */
  hitTest(uv) {
    if (!uv) return null;
    const { x, y } = this.toPx(uv);
    for (let i = 0; i < this.layout.length; i++) {
      for (const z of this.zones(this.layout[i])) {
        if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) {
          const hit = { index: i, zone: z.id };
          if (z.id === 'track') {
            const t = this.trackRect(this.layout[i]);
            hit.u = THREE.MathUtils.clamp((x - t.x) / t.w, 0, 1);
          }
          return hit;
        }
      }
    }
    return null;
  }

  setHover(hit) {
    const same = (a, b) => (a === b) || (a && b && a.index === b.index && a.zone === b.zone
      && (a.zone !== 'track' || Math.abs(a.u - b.u) < 0.01));
    if (same(hit, this.hover)) return;
    this.hover = hit;
    this.redraw();
  }

  /** Wciśnięcie spustu na menu: przycisk = klik, pasek = początek przeciągania uchwytu. */
  press(hit) {
    if (!hit) return false;
    const { row } = this.layout[hit.index];
    if (hit.zone === 'track') {
      const { band } = row.get();
      const dLo = Math.abs(hit.u - band.lo), dHi = Math.abs(hit.u - band.hi);
      const handle = dLo < dHi || (dLo === dHi && hit.u < band.lo) ? 'lo' : 'hi';
      this.drag = { index: hit.index, handle };
      row.onBand(handle, hit.u);
    } else if (row.type === 'stepper') {
      (hit.zone === 'dec' ? row.dec : row.inc)();
    } else if (row.type === 'buttons') {
      row.items[hit.zone].onClick();
    }
    this.redraw();
    return true;
  }

  /** Przeciąganie uchwytu (uv punktu, w który celuje promień). */
  dragTo(uv) {
    if (!this.drag || !uv) return;
    const entry = this.layout[this.drag.index];
    const t = this.trackRect(entry);
    const u = THREE.MathUtils.clamp((this.toPx(uv).x - t.x) / t.w, 0, 1);
    entry.row.onBand(this.drag.handle, u);
    this.redraw();
  }

  release() { this.drag = null; }

  redraw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(16, 20, 28, 0.94)';
    ctx.beginPath();
    ctx.roundRect(2, 2, W - 4, H - 4, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.textBaseline = 'middle';

    this.layout.forEach((entry, index) => {
      const { row, y, h } = entry;
      const mid = y + h / 2;
      const rowHot = this.hover && this.hover.index === index;
      if (rowHot && row.type !== 'legend') {
        ctx.fillStyle = 'rgba(79, 179, 255, 0.12)';
        ctx.fillRect(this.pad, y, W - 2 * this.pad, h);
      }
      if (row.type === 'legend') {
        const L = row.get();
        const band = L.band || { lo: 0, hi: 1, invert: false };
        ctx.textAlign = 'left';
        ctx.fillStyle = '#9fdcff';
        ctx.font = 'bold 40px system-ui, sans-serif';
        ctx.fillText(L.name, this.pad + 8, y + 28, W - 2 * this.pad);
        ctx.fillStyle = '#ffffff';
        ctx.font = '30px system-ui, sans-serif';
        const visText = band.invert ? `ukryte: ${L.loText} … ${L.hiText}` : `widoczne: ${L.loText} … ${L.hiText}`;
        ctx.fillText(visText, this.pad + 8, y + 68, W - 2 * this.pad);
        const t = this.trackRect(entry);
        drawBandGradient(ctx, t.x, t.y, t.w, t.h, band);
        ctx.strokeStyle = '#8894a8';
        ctx.lineWidth = 2;
        ctx.strokeRect(t.x, t.y, t.w, t.h);
        if (row.onBand) {
          const hotHandle = this.drag?.index === index ? this.drag.handle
            : rowHot && this.hover.zone === 'track'
              ? (Math.abs(this.hover.u - band.lo) <= Math.abs(this.hover.u - band.hi) ? 'lo' : 'hi') : null;
          drawHandle(ctx, t.x + band.lo * t.w, t.y, t.y + t.h, hotHandle === 'lo');
          drawHandle(ctx, t.x + band.hi * t.w, t.y, t.y + t.h, hotHandle === 'hi');
        }
        ctx.font = '26px system-ui, sans-serif';
        ctx.fillStyle = '#c9d2e0';
        ctx.fillText(L.minText, t.x, t.y + t.h + 26);
        ctx.textAlign = 'right';
        ctx.fillText(L.maxText, t.x + t.w, t.y + t.h + 26);
        ctx.textAlign = 'left';
        return;
      }
      for (const z of this.zones(entry)) {
        const hot = this.hover && this.hover.index === index && this.hover.zone === z.id;
        const active = row.type === 'buttons' && row.items[z.id].active?.();
        ctx.fillStyle = hot ? '#ffe14d' : active ? '#2f6f9f' : '#2a313d';
        ctx.beginPath();
        ctx.roundRect(z.x, z.y + 4, z.w, z.h - 8, 14);
        ctx.fill();
        if (hot) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 5;
          ctx.stroke();
        }
        ctx.fillStyle = hot ? '#04131f' : '#f2f4f8';
        ctx.textAlign = 'center';
        ctx.font = row.type === 'stepper' ? 'bold 44px system-ui, sans-serif' : '32px system-ui, sans-serif';
        const text = row.type === 'stepper' ? (z.id === 'dec' ? '◀' : '▶') : row.items[z.id].label;
        ctx.fillText(text, z.x + z.w / 2, mid, z.w - 12);
      }
      if (row.type === 'stepper') {
        ctx.textAlign = 'left';
        ctx.font = '32px system-ui, sans-serif';
        ctx.fillStyle = rowHot ? '#ffffff' : '#c9d2e0';
        ctx.fillText(row.label, this.pad + 8, mid, W - 440);
        ctx.textAlign = 'center';
        ctx.font = 'bold 32px system-ui, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(row.value(), W - 210, mid, 200);
      }
    });
    ctx.textAlign = 'left';
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}

/** Mała tabliczka: nazwa pola, skala kolorów, wartość pod kulką. */
export class LegendPanel {
  constructor({ width = 0.2 } = {}) {
    const { mesh, canvas, texture, ctx } = makeCanvasMesh(width, 512, 230);
    Object.assign(this, { mesh, canvas, texture, ctx });
    this.last = '';
  }

  /** minText/maxText – granice widocznego zakresu; t – pozycja wartości na całej skali. */
  set({ name, minText, maxText, probeText, status, t, band }) {
    const key = [name, minText, maxText, probeText, status, t?.toFixed(3), band?.lo, band?.hi, band?.invert].join('|');
    if (key === this.last) return;
    this.last = key;
    const { ctx } = this;
    const W = 512, H = 230;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(16, 20, 28, 0.88)';
    ctx.beginPath();
    ctx.roundRect(2, 2, W - 4, H - 4, 20);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9fdcff';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillText(name, 18, 32, W - 36);
    // Na tabliczce tylko widoczna część skali – cała tęcza = widoczny zakres.
    const b = band || { lo: 0, hi: 1, invert: false };
    drawBandGradient(ctx, 18, 62, W - 36, 24, b.invert ? b : { lo: 0, hi: 1, invert: false });
    if (Number.isFinite(t)) {
      const ct = b.invert || b.hi - b.lo <= 1e-6 ? t : (t - b.lo) / (b.hi - b.lo);
      const x = 18 + Math.min(1, Math.max(0, ct)) * (W - 36);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x - 3, 56, 6, 36);
    }
    ctx.font = '24px system-ui, sans-serif';
    ctx.fillStyle = '#f2f4f8';
    ctx.fillText(minText, 18, 108);
    ctx.textAlign = 'right';
    ctx.fillText(maxText, W - 18, 108);
    ctx.textAlign = 'left';
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.fillText(probeText, 18, 152, W - 36);
    ctx.font = '26px system-ui, sans-serif';
    ctx.fillStyle = status?.startsWith('●') ? '#7dff9a' : '#c9d2e0';
    ctx.fillText(status || '', 18, 198, W - 36);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.texture.dispose();
  }
}
