// Prosty panel z tekstem wyświetlany w goglach (canvas -> tekstura).

import * as THREE from 'three';

export class XRPanel extends THREE.Mesh {
  constructor({ width = 0.56, height = 0.3, pixelsPerMeter = 1800 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * pixelsPerMeter);
    canvas.height = Math.round(height * pixelsPerMeter);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    super(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }),
    );
    this.renderOrder = 999;
    this.canvas = canvas;
    this.texture = texture;
    this.lastText = null;
    this._target = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** lines: tablica stringów; pierwsza linia to tytuł. */
  setLines(lines) {
    const text = lines.join('\n');
    if (text === this.lastText) return;
    this.lastText = text;
    const ctx = this.canvas.getContext('2d');
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(16, 20, 28, 0.86)';
    const r = 36;
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, r);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.7)';
    ctx.lineWidth = 4;
    ctx.stroke();
    const pad = 44;
    let y = pad;
    lines.forEach((line, i) => {
      const size = i === 0 ? 56 : 38;
      ctx.font = `${i === 0 ? 'bold ' : ''}${size}px system-ui, sans-serif`;
      ctx.fillStyle = i === 0 ? '#9fdcff' : '#f2f4f8';
      ctx.textBaseline = 'top';
      ctx.fillText(line, pad, y, w - pad * 2);
      y += size * 1.35;
    });
    this.texture.needsUpdate = true;
  }

  /** Płynnie ustawia panel przed użytkownikiem (lekko poniżej linii wzroku). */
  follow(headPos, headQuat, { distance = 0.9, drop = 0.18, smoothing = 0.08, snap = false } = {}) {
    this._fwd.set(0, 0, -1).applyQuaternion(headQuat);
    this._fwd.y = 0;
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._target.copy(headPos).addScaledVector(this._fwd, distance);
    this._target.y -= drop;
    if (snap) this.position.copy(this._target);
    else this.position.lerp(this._target, smoothing);
    this.lookAt(headPos.x, this.position.y, headPos.z);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
