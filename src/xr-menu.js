// Menu w goglach obsługiwane promieniem z pilota (spust = klik)
// oraz mała legenda kolorów z odczytem "sondy".

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

function drawGradient(ctx, x, y, w, h) {
  for (let i = 0; i < w; i++) {
    const [r, g, b] = turboRGB(i / (w - 1));
    ctx.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`;
    ctx.fillRect(x + i, y, 1, h);
  }
}

/**
 * rows: tablica wierszy:
 *  { type: 'stepper', label, value: () => string, dec: () => void, inc: () => void }
 *  { type: 'buttons', items: [{ label, onClick, active?: () => bool }] }
 *  { type: 'legend', get: () => ({ name, unit, min, max, decimals }) }
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
      const h = row.type === 'legend' ? 120 : this.rowH;
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
    this.redraw();
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
    return [];
  }

  /** uv z raycastera -> trafienie {entryIndex, zoneId} albo null */
  hitTest(uv) {
    if (!uv) return null;
    const x = uv.x * this.W;
    const y = (1 - uv.y) * this.H;
    for (let i = 0; i < this.layout.length; i++) {
      for (const z of this.zones(this.layout[i])) {
        if (x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h) return { index: i, zone: z.id };
      }
    }
    return null;
  }

  setHover(hit) {
    const same = (a, b) => (a === b) || (a && b && a.index === b.index && a.zone === b.zone);
    if (same(hit, this.hover)) return;
    this.hover = hit;
    this.redraw();
  }

  click(hit) {
    if (!hit) return false;
    const { row } = this.layout[hit.index];
    if (row.type === 'stepper') (hit.zone === 'dec' ? row.dec : row.inc)();
    else if (row.type === 'buttons') row.items[hit.zone].onClick();
    this.redraw();
    return true;
  }

  redraw() {
    const { ctx, W, H } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(16, 20, 28, 0.92)';
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
      if (row.type === 'legend') {
        const L = row.get();
        ctx.fillStyle = '#9fdcff';
        ctx.font = 'bold 40px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(L.name, this.pad + 8, y + 26, W - 2 * this.pad);
        drawGradient(ctx, this.pad + 8, y + 58, W - 2 * this.pad - 16, 26);
        ctx.font = '28px system-ui, sans-serif';
        ctx.fillStyle = '#f2f4f8';
        ctx.fillText(L.minText, this.pad + 8, y + 104);
        ctx.textAlign = 'right';
        ctx.fillText(L.maxText, W - this.pad - 8, y + 104);
        ctx.textAlign = 'left';
        return;
      }
      for (const z of this.zones(entry)) {
        const hot = this.hover && this.hover.index === index && this.hover.zone === z.id;
        const active = row.type === 'buttons' && row.items[z.id].active?.();
        ctx.fillStyle = hot ? '#4fb3ff' : active ? '#2f6f9f' : '#2a313d';
        ctx.beginPath();
        ctx.roundRect(z.x, z.y + 4, z.w, z.h - 8, 14);
        ctx.fill();
        ctx.fillStyle = hot ? '#04131f' : '#f2f4f8';
        ctx.textAlign = 'center';
        ctx.font = row.type === 'stepper' ? 'bold 44px system-ui, sans-serif' : '32px system-ui, sans-serif';
        const text = row.type === 'stepper' ? (z.id === 'dec' ? '◀' : '▶') : row.items[z.id].label;
        ctx.fillText(text, z.x + z.w / 2, mid, z.w - 12);
      }
      if (row.type === 'stepper') {
        ctx.textAlign = 'left';
        ctx.font = '32px system-ui, sans-serif';
        ctx.fillStyle = '#c9d2e0';
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

  set({ name, minText, maxText, probeText, status, t }) {
    const key = [name, minText, maxText, probeText, status, t?.toFixed(3)].join('|');
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
    drawGradient(ctx, 18, 62, W - 36, 24);
    if (Number.isFinite(t)) {
      const x = 18 + Math.min(1, Math.max(0, t)) * (W - 36);
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
