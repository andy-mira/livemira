/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// CPU feature extraction (Harris corners, BRIEF-256). No shared SDK or backend contract is defined here.
import { selectAnms } from '../src/anms.mjs';
export const ALGORITHM = 'm0-harris-brief256-v1';
/** Same detector, descriptor and matcher as ALGORITHM; only the spatial selection of the per-level corners differs (ANMS, CVPR 2005 section 3). */
export const ANMS_ALGORITHM = 'm0-harris-anms-brief256-v1';
export const SELECTIONS = Object.freeze(['greedy-min-distance', 'anms']);
export const LIMITS = Object.freeze({ pixels: 4_194_304, dimension: 4096, features: 512, levels: 4, targets: 10, bundleBytes: 2_000_000 });

export function validateGray(image) {
  const { width, height, data } = image ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 ||
      width > LIMITS.dimension || height > LIMITS.dimension || width * height > LIMITS.pixels ||
      !(data instanceof Uint8Array) || data.length !== width * height) throw new Error('INVALID_GRAY8');
}

export function pyramid(image, levels = 3) {
  validateGray(image);
  if (!Number.isInteger(levels) || levels < 1 || levels > LIMITS.levels) throw new Error('INVALID_LEVELS');
  const result = [{ ...image, scale: 1 }];
  while (result.length < levels) {
    const prev = result.at(-1), width = Math.floor(prev.width / 2), height = Math.floor(prev.height / 2);
    if (Math.min(width, height) < 32) break;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = 2 * y * prev.width + 2 * x;
      data[y * width + x] = Math.round((prev.data[i] + prev.data[i + 1] + prev.data[i + prev.width] + prev.data[i + prev.width + 1]) / 4);
    }
    result.push({ width, height, data, scale: prev.scale * 2 });
  }
  return result;
}

let seed = 0x9e3779b9;
const offset = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % 17 - 8; };
const pattern = Array.from({ length: 256 }, () => [offset(), offset(), offset(), offset()]);

// Integer equivalence proof:
// Each pixel is an unsigned 8-bit integer in [0, 255].
// For row y, the horizontal sum of 3 neighboring pixels is:
//   rowSum(x, y) = data[y * w + x - 1] + data[y * w + x] + data[y * w + x + 1] <= 3 * 255 = 765.
// The 3x3 sum is the vertical sum of 3 consecutive horizontal row sums:
//   allsum(x, y) = rowSum(x, y - 1) + rowSum(x, y) + rowSum(x, y + 1) <= 3 * 765 = 2295.
// Because integer addition is associative and commutative, and no intermediate division or rounding
// is performed, allsum(x, y) is mathematically identical to the unrolled sum of the 9 pixels.
// The single final Math.round(sum / 9) evaluates to the exact same smoothed Uint8 value.
// Scratch is bounded per call (Uint16Array of length w * 3, max 24 KiB for w <= 4096),
// with all reads preceded by initialized writes for every pyramid layer and non-zero byteOffset view.
function smooth({ width: w, height: h, data }) {
  const out = new Uint8Array(data);
  const rowSums = new Uint16Array(w * 3);
  const fillRow = y => {
    const base = y * w, slot = (y % 3) * w;
    let a = data[base], b = data[base + 1];
    for (let x = 1; x < w - 1; x++) {
      const c = data[base + x + 1];
      rowSums[slot + x] = a + b + c;
      a = b;
      b = c;
    }
  };
  fillRow(0);
  fillRow(1);
  for (let y = 1; y < h - 1; y++) {
    fillRow(y + 1);
    const r0 = ((y - 1) % 3) * w, r1 = (y % 3) * w, r2 = ((y + 1) % 3) * w;
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      const sum = rowSums[r0 + x] + rowSums[r1 + x] + rowSums[r2 + x];
      out[base + x] = Math.round(sum / 9);
    }
  }
  return out;
}

// Three rows of horizontal tensor sums replace nine repeated gradients per center.
// Byte differences/products and all 3x3 sums are exact integers (|sum| <= 585225),
// so regrouping them preserves the original Float64 Harris expression exactly.
// Scratch belongs to this extraction, is reused across its pyramid levels, and
// every row/column read is overwritten first. Scores retain their zero-filled
// NMS halo and ROI exterior; no persistent or cross-instance state is kept.
function harrisScores(data, w, h, scale, roi, scores, rows) {
  let x0 = 10, x1 = w - 10, y0 = 10, y1 = h - 10;
  if (roi) {
    while (x0 < x1 && (x0 + 0.5) * scale - 0.5 < roi.x) x0++;
    while (x1 > x0 && (x1 - 0.5) * scale - 0.5 >= roi.x + roi.width) x1--;
    while (y0 < y1 && (y0 + 0.5) * scale - 0.5 < roi.y) y0++;
    while (y1 > y0 && (y1 - 0.5) * scale - 0.5 >= roi.y + roi.height) y1--;
  }
  if (x0 >= x1 || y0 >= y1) return;
  const [xxRows, yyRows, xyRows] = rows;
  const row = y => {
    const base = y * w, slot = (y % 3) * w;
    let i = base + x0 - 1;
    let gx = data[i + 1] - data[i - 1], gy = data[i + w] - data[i - w];
    let ax = gx * gx, ay = gy * gy, az = gx * gy;
    i++;
    gx = data[i + 1] - data[i - 1]; gy = data[i + w] - data[i - w];
    let bx = gx * gx, by = gy * gy, bz = gx * gy;
    for (let x = x0; x < x1; x++) {
      i = base + x + 1;
      gx = data[i + 1] - data[i - 1]; gy = data[i + w] - data[i - w];
      const cx = gx * gx, cy = gy * gy, cz = gx * gy;
      xxRows[slot + x] = ax + bx + cx;
      yyRows[slot + x] = ay + by + cy;
      xyRows[slot + x] = az + bz + cz;
      ax = bx; ay = by; az = bz; bx = cx; by = cy; bz = cz;
    }
  };
  row(y0 - 1); row(y0);
  for (let y = y0; y < y1; y++) {
    row(y + 1);
    const a = ((y - 1) % 3) * w, b = (y % 3) * w, c = ((y + 1) % 3) * w;
    for (let x = x0; x < x1; x++) {
      const xx = xxRows[a + x] + xxRows[b + x] + xxRows[c + x];
      const yy = yyRows[a + x] + yyRows[b + x] + yyRows[c + x];
      const xy = xyRows[a + x] + xyRows[b + x] + xyRows[c + x];
      scores[y * w + x] = xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
    }
  }
}

export function extractFeatures(image, { maxFeatures = 384, levels = 3, roi = null, selection = 'greedy-min-distance' } = {}) {
  validateGray(image);
  if (!SELECTIONS.includes(selection)) throw new Error('INVALID_SELECTION');
  if (!Number.isInteger(maxFeatures) || maxFeatures < 16 || maxFeatures > LIMITS.features) throw new Error('INVALID_FEATURE_LIMIT');
  if (roi && (!['x', 'y', 'width', 'height'].every(k => Number.isFinite(roi[k])) || roi.width <= 0 || roi.height <= 0 ||
      roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.width || roi.y + roi.height > image.height)) throw new Error('INVALID_ROI');
  const layers = pyramid(image, levels), features = [];
  const rows = [new Int32Array(image.width * 3), new Int32Array(image.width * 3), new Int32Array(image.width * 3)];
  for (let level = 0; level < layers.length; level++) {
    const layer = layers[level], { width: w, height: h, scale } = layer, data = smooth(layer);
    const scores = new Float64Array(w * h), candidates = [];
    harrisScores(data, w, h, scale, roi, scores, rows);
    for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) {
      const score = scores[y * w + x];
      if (score < 1e6) continue;
      // Monotonic NMS condition proof:
      // peak is initialized to true and only transitions true -> false when any neighbor
      // has a strictly higher score or wins the deterministic tie-breaking order.
      // Once peak becomes false, no subsequent neighbor can reset it to true.
      // Therefore, breaking both dy/dx loops immediately upon the first suppression
      // yields the identical boolean peak value, candidate set, tie order, and scores.
      let peak = true;
      nms: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const other = scores[(y + dy) * w + x + dx];
          if (other > score || (other === score && (dy < 0 || (dy === 0 && dx < 0)))) {
            peak = false;
            break nms;
          }
        }
      }
      if (peak) candidates.push({ x, y, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const selected = [], quota = Math.floor(maxFeatures / layers.length) + (level < maxFeatures % layers.length ? 1 : 0);
    const anms = selection === 'anms', ordered = anms ? selectAnms(candidates, quota) : candidates;
    for (const point of ordered) {
      if (!anms && selected.some(p => (p.x - point.x) ** 2 + (p.y - point.y) ** 2 < 36)) continue;
      const descriptor = Array(32).fill(0);
      for (let bit = 0; bit < 256; bit++) {
        const [ax, ay, bx, by] = pattern[bit];
        if (data[(point.y + ay) * w + point.x + ax] < data[(point.y + by) * w + point.x + bx]) descriptor[bit >> 3] |= 1 << (bit & 7);
      }
      selected.push(point);
      features.push({ x: (point.x + 0.5) * scale - 0.5, y: (point.y + 0.5) * scale - 0.5, level, score: point.score, descriptor });
      if (selected.length >= quota) break;
    }
  }
  return { features, pyramid: layers.map(({ width, height, scale }) => ({ width, height, scale })) };
}

const bitCounts = Uint8Array.from({ length: 256 }, (_, value) => { let n = 0; while (value) { value &= value - 1; n++; } return n; });
export function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 32; i++) n += bitCounts[a[i] ^ b[i]];
  return n;
}

export function matchFeatures(target, frame) {
  const reverse = Array(frame.length).fill(-1), reverseDistance = Array(frame.length).fill(257), nearest = [];
  for (let i = 0; i < target.length; i++) {
    let best = 257, second = 257, index = -1;
    for (let j = 0; j < frame.length; j++) {
      const distance = hamming(target[i].descriptor, frame[j].descriptor);
      if (distance < best) { second = best; best = distance; index = j; } else if (distance < second) second = distance;
      if (distance < reverseDistance[j]) { reverseDistance[j] = distance; reverse[j] = i; }
      else if (distance === reverseDistance[j]) reverse[j] = -1;
    }
    nearest.push({ index, best, second });
  }
  return nearest.flatMap(({ index, best, second }, i) => index >= 0 && best <= 64 && best < 0.75 * second && reverse[index] === i
    ? [{ target: [target[i].x, target[i].y], image: [frame[index].x, frame[index].y], distance: best }] : []);
}
