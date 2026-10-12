/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export function multiply3(a, b) {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3), col = i % 3;
    return a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6];
  });
}
export function transformPoint(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Coordinates refer to pixel edges. Physical image normalization is downstream. */
export function createGeometry({ width, height, rotation = 0, mirrored = false,
  crop = { x: 0, y: 0, width, height }, longEdge = 640,
  cssWidth = width, cssHeight = height, dpr = 1, fit = 'cover', viewportMirrored = false }) {
  if (![width, height, crop.width, crop.height, cssWidth, cssHeight, dpr].every(v => Number.isFinite(v) && v > 0)
    || (longEdge !== 'native' && !(Number.isFinite(longEdge) && longEdge > 0))
    || ![crop.x, crop.y].every(v => Number.isFinite(v) && v >= 0)
    || crop.x + crop.width > width || crop.y + crop.height > height
    || ![0, 90, 180, 270].includes(rotation) || !['contain', 'cover'].includes(fit)) throw new RangeError('Invalid frame geometry');
  const w = crop.width, h = crop.height;
  const unmirror = mirrored ? [-1, 0, w, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rotations = {
    0: [1, 0, 0, 0, 1, 0, 0, 0, 1], 90: [0, -1, h, 1, 0, 0, 0, 0, 1],
    180: [-1, 0, w, 0, -1, h, 0, 0, 1], 270: [0, 1, 0, -1, 0, w, 0, 0, 1],
  };
  const rw = rotation % 180 ? h : w, rh = rotation % 180 ? w : h;
  const targetEdge = longEdge === 'native' ? Math.max(rw, rh) : longEdge;
  const scale = Math.min(1, targetEdge / Math.max(rw, rh));
  const canonicalWidth = Math.max(1, Math.round(rw * scale)), canonicalHeight = Math.max(1, Math.round(rh * scale));
  const inputToCanonical = multiply3([canonicalWidth / rw, 0, 0, 0, canonicalHeight / rh, 0, 0, 0, 1],
    multiply3(rotations[rotation], multiply3(unmirror, [1, 0, -crop.x, 0, 1, -crop.y, 0, 0, 1])));
  const viewportScale = Math[fit === 'cover' ? 'max' : 'min'](cssWidth / canonicalWidth, cssHeight / canonicalHeight);
  let canonicalToViewport = [viewportScale, 0, (cssWidth - canonicalWidth * viewportScale) / 2,
    0, viewportScale, (cssHeight - canonicalHeight * viewportScale) / 2, 0, 0, 1];
  if (viewportMirrored) canonicalToViewport = multiply3([-1, 0, cssWidth, 0, 1, 0, 0, 0, 1], canonicalToViewport);
  return { inputToCanonical, canonicalToViewport, canonicalWidth, canonicalHeight,
    crop: { ...crop }, rotation, mirrored, fit, cssWidth, cssHeight, dpr, viewportMirrored };
}
