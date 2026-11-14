// Robienie zdjęć z kamer gogli podczas sesji AR – do późniejszego nałożenia na skan.
//
// Dwie drogi (zależnie od tego, co udostępni przeglądarka Quest):
//  1. WebXR "camera-access": obraz kamery dokładnie zgrany z widokiem (pozycja i obiektyw
//     znane z WebXR) – najlepsza jakość nakładania.
//  2. getUserMedia: zwykły strumień wideo z kamery; pozycję bierzemy z gogli, a kąt widzenia
//     jest przybliżony (można go potem skorygować przy nakładaniu).
//
// Zdjęcie = { blob (JPEG), w, h, matrix (kamera -> układ skanu, 16 liczb), proj (16 liczb),
//             approx?: { fovH, aspect }, t }

import * as THREE from 'three';

const PHOTO_W = 640;
export const DEFAULT_VIDEO_FOV_H = 80; // stopnie – przybliżenie dla getUserMedia

function flipToImageData(pixels, w, h) {
  const out = new ImageData(w, h);
  const row = w * 4;
  for (let y = 0; y < h; y++) out.data.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row);
  return out;
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

export class PhotoCapture {
  constructor(renderer, session) {
    this.renderer = renderer;
    this.session = session;
    this.mode = null; // 'xr' | 'video' | null
    this.binding = null;
    this.video = null;
    this.stream = null;
    this.error = '';
    this.canvas = document.createElement('canvas');
    this._quad = null;
  }

  /** Czy WebXR podaje obraz kamery (sprawdzane na bieżącej klatce). */
  static viewHasCamera(pose) {
    return !!pose?.views?.[0]?.camera;
  }

  /** Wybiera sposób robienia zdjęć. pose – bieżąca pozycja widza (do sprawdzenia camera-access). */
  async start(pose) {
    if (this.mode) return true;
    if (PhotoCapture.viewHasCamera(pose) && typeof XRWebGLBinding !== 'undefined') {
      try {
        this.binding = new XRWebGLBinding(this.session, this.renderer.getContext());
        this.mode = 'xr';
        return true;
      } catch (err) {
        this.error = String(err?.message || err);
      }
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('brak getUserMedia');
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: 'environment' },
        audio: false,
      });
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;
      this.mode = 'video';
      return true;
    } catch (err) {
      this.error = String(err?.message || err);
      return false;
    }
  }

  /**
   * Robi zdjęcie. Wywoływać w pętli klatki XR.
   * pose – XRViewerPose w bieżącej przestrzeni; scanFromWorld – macierz świat -> układ skanu.
   * Zwraca Promise<zdjęcie | null>.
   */
  capture(pose, scanFromWorld) {
    if (!pose) return Promise.resolve(null);
    if (this.mode === 'xr') return this.captureXR(pose, scanFromWorld);
    if (this.mode === 'video') return this.captureVideo(pose, scanFromWorld);
    return Promise.resolve(null);
  }

  captureXR(pose, scanFromWorld) {
    const view = pose.views[0];
    if (!view?.camera) return Promise.resolve(null);
    const glTex = this.binding.getCameraImage(view.camera);
    if (!glTex) return Promise.resolve(null);
    const renderer = this.renderer;
    const w = PHOTO_W;
    const h = Math.max(1, Math.round((PHOTO_W * view.camera.height) / view.camera.width));
    if (!this._quad) {
      const tex = new THREE.Texture();
      const scene = new THREE.Scene();
      const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, depthTest: false });
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
      this._quad = { tex, scene, mat, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), rt: null };
    }
    const q = this._quad;
    if (!q.rt || q.rt.width !== w || q.rt.height !== h) {
      q.rt?.dispose();
      q.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    }
    // Tekstura kamery z WebXR podpięta pod obiekt three.js (jak w WebXRDepthSensing).
    renderer.properties.get(q.tex).__webglTexture = glTex;
    const prevRT = renderer.getRenderTarget();
    const prevXR = renderer.xr.enabled;
    renderer.xr.enabled = false; // zwykłe renderowanie do bufora, nie do gogli
    renderer.setRenderTarget(q.rt);
    renderer.render(q.scene, q.cam);
    const pixels = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(q.rt, 0, 0, w, h, pixels);
    renderer.setRenderTarget(prevRT);
    renderer.xr.enabled = prevXR;

    const matrix = new THREE.Matrix4().fromArray(view.transform.matrix).premultiply(scanFromWorld);
    const proj = Array.from(view.projectionMatrix);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').putImageData(flipToImageData(pixels, w, h), 0, 0);
    return canvasToBlob(this.canvas).then((blob) => (blob ? {
      blob, w, h, matrix: Array.from(matrix.elements), proj, t: Date.now(),
    } : null));
  }

  captureVideo(pose, scanFromWorld) {
    const v = this.video;
    if (!v || !v.videoWidth) return Promise.resolve(null);
    const w = PHOTO_W;
    const h = Math.round((PHOTO_W * v.videoHeight) / v.videoWidth);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    // Pozycja: środek głowy (kamera jest kilka cm obok – przybliżenie).
    const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix).premultiply(scanFromWorld);
    const aspect = w / h;
    const approx = { fovH: DEFAULT_VIDEO_FOV_H, aspect };
    return canvasToBlob(this.canvas).then((blob) => (blob ? {
      blob, w, h, matrix: Array.from(matrix.elements), proj: projFromFov(approx.fovH, aspect), approx, t: Date.now(),
    } : null));
  }

  dispose() {
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this._quad) {
      this._quad.rt?.dispose();
      this._quad.mat.dispose();
      this._quad.scene.children[0].geometry.dispose();
    }
    this.mode = null;
  }
}

/** Macierz projekcji z poziomego kąta widzenia (stopnie) i proporcji obrazu. */
export function projFromFov(fovH, aspect) {
  const fovY = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(fovH) / 2) / aspect));
  const cam = new THREE.PerspectiveCamera(fovY, aspect, 0.05, 30);
  return Array.from(cam.projectionMatrix.elements);
}
