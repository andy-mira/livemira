/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Projection interface: row-major H, target TL/TR/BR/BL, CSS pixel viewport. */
export function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) throw new RangeError('Point at projective horizon');
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function multiply(a, b) {
  return Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3), c = i % 3;
    return a[r * 3] * b[c] + a[r * 3 + 1] * b[c + 3] + a[r * 3 + 2] * b[c + 6];
  });
}

export function homographyFromCorners(width, height, corners) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new RangeError('Invalid target size');
  if (corners.length !== 4 || corners.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw new RangeError('Invalid corners');
  // Solve in normalized target coordinates to avoid target-size conditioning.
  const source = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const rows = source.flatMap(([x, y], i) => {
    const [u, v] = corners[i];
    return [[x, y, 1, 0, 0, 0, -u*x, -u*y, u], [0, 0, 0, x, y, 1, -v*x, -v*y, v]];
  });
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-10) throw new RangeError('Degenerate quadrilateral');
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const scale = rows[c][c];
    for (let j = c; j <= 8; j++) rows[c][j] /= scale;
    for (let r = 0; r < 8; r++) if (r !== c) {
      const factor = rows[r][c];
      for (let j = c; j <= 8; j++) rows[r][j] -= factor * rows[c][j];
    }
  }
  const n = rows.map(row => row[8]);
  const h = [n[0]/width, n[1]/height, n[2], n[3]/width, n[4]/height, n[5], n[6]/width, n[7]/height, 1];
  validatePlane(h, width, height);
  return h;
}

export function validatePlane(h, width, height) {
  if (h.length !== 9 || !h.every(Number.isFinite)) throw new RangeError('Invalid homography');
  const determinant = h[0]*(h[4]*h[8]-h[5]*h[7])-h[1]*(h[3]*h[8]-h[5]*h[6])+h[2]*(h[3]*h[7]-h[4]*h[6]);
  if (Math.abs(determinant) < 1e-12) throw new RangeError('Singular homography');
  const ws = [[0,0],[width,0],[width,height],[0,height]].map(([x,y]) => h[6]*x+h[7]*y+h[8]);
  if (ws.some(w => !Number.isFinite(w) || Math.abs(w) < 1e-10 || Math.sign(w) !== Math.sign(ws[0]))) throw new RangeError('Plane crosses projective horizon');
}

export function cssMatrix(h) {
  // CSS matrix3d is column-major; preserve projective w (no affine triangle seam).
  const k = h[8];
  if (!Number.isFinite(k) || Math.abs(k) < 1e-10) throw new RangeError('Invalid homogeneous scale');
  const a = h.map(v => v/k);
  return `matrix3d(${[a[0],a[3],0,a[6],a[1],a[4],0,a[7],0,0,1,0,a[2],a[5],0,1].join(',')})`;
}

export function mediaRect(targetWidth, targetHeight, videoWidth, videoHeight, fit = 'contain') {
  if (![targetWidth,targetHeight,videoWidth,videoHeight].every(v => Number.isFinite(v) && v > 0)) throw new RangeError('Invalid media dimensions');
  if (!['contain','cover'].includes(fit)) throw new RangeError('Unknown fit');
  const scale = (fit === 'contain' ? Math.min : Math.max)(targetWidth/videoWidth,targetHeight/videoHeight);
  const width = videoWidth*scale, height = videoHeight*scale;
  return { x:(targetWidth-width)/2, y:(targetHeight-height)/2, width, height };
}

/** Independent-device-free compatibility renderer; browser owns video frame compositing. */
export class PerspectiveVideoRenderer {
  constructor(container, video, { width, height, fit = 'contain' }) {
    mediaRect(width,height,1,1,fit);
    this.width = width; this.height = height;
    this.plane = container.ownerDocument.createElement('div');
    Object.assign(this.plane.style, { position:'absolute',left:'0',top:'0',width:`${width}px`,height:`${height}px`,transformOrigin:'0 0',overflow:'hidden',pointerEvents:'none',display:'none' });
    Object.assign(video.style, { width:'100%',height:'100%',objectFit:fit,display:'block' });
    this.plane.append(video); container.append(this.plane);
  }
  setGroundTruth(corners, viewportFromImage = [1,0,0,0,1,0,0,0,1]) {
    try {
      const h = multiply(viewportFromImage,homographyFromCorners(this.width,this.height,corners));
      validatePlane(h,this.width,this.height);
      this.plane.style.transform = cssMatrix(h);
      this.plane.style.display = 'block';
    } catch (error) { this.hide(); throw error; }
  }
  hide() { this.plane.style.display = 'none'; }
  show() { if(this.plane.style.transform)this.plane.style.display='block'; }
  dispose() { this.plane.remove(); }
}
