/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** Region of interest in base-image pixels. */
export interface Roi {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** A Harris corner of one level, in that level's pixels. */
export interface CornerCandidate {
  readonly x: number;
  readonly y: number;
  readonly score: number;
}

/** Three rows of horizontal structure-tensor sums, reused across the levels of one extraction. */
export type TensorRows = readonly [Int32Array, Int32Array, Int32Array];

export function createTensorRows(widthPx: number): TensorRows {
  return [new Int32Array(widthPx * 3), new Int32Array(widthPx * 3), new Int32Array(widthPx * 3)];
}

/**
 * Harris response det(M) − 0.04 · trace(M)² with central-difference gradients and a 3×3 window, written into `scores`
 * for the interior [10, w − 10) × [10, h − 10), clipped to the ROI. Three rows of horizontal tensor sums replace nine
 * repeated gradients per centre; byte differences and products and all 3×3 sums are exact integers
 * (|sum| ≤ 585225), so the regrouping keeps the Float64 expression exact. Scores outside stay zero.
 */
function harrisScores(
  data: Uint8Array,
  w: number,
  h: number,
  scale: number,
  roi: Roi | null,
  scores: Float64Array,
  rows: TensorRows,
): void {
  let x0 = 10;
  let x1 = w - 10;
  let y0 = 10;
  let y1 = h - 10;
  if (roi) {
    while (x0 < x1 && (x0 + 0.5) * scale - 0.5 < roi.x) x0++;
    while (x1 > x0 && (x1 - 0.5) * scale - 0.5 >= roi.x + roi.width) x1--;
    while (y0 < y1 && (y0 + 0.5) * scale - 0.5 < roi.y) y0++;
    while (y1 > y0 && (y1 - 0.5) * scale - 0.5 >= roi.y + roi.height) y1--;
  }
  if (x0 >= x1 || y0 >= y1) return;
  const [xxRows, yyRows, xyRows] = rows;
  const row = (y: number): void => {
    const base = y * w;
    const slot = (y % 3) * w;
    let i = base + x0 - 1;
    let gx = data[i + 1]! - data[i - 1]!;
    let gy = data[i + w]! - data[i - w]!;
    let ax = gx * gx;
    let ay = gy * gy;
    let az = gx * gy;
    i++;
    gx = data[i + 1]! - data[i - 1]!;
    gy = data[i + w]! - data[i - w]!;
    let bx = gx * gx;
    let by = gy * gy;
    let bz = gx * gy;
    for (let x = x0; x < x1; x++) {
      i = base + x + 1;
      gx = data[i + 1]! - data[i - 1]!;
      gy = data[i + w]! - data[i - w]!;
      const cx = gx * gx;
      const cy = gy * gy;
      const cz = gx * gy;
      xxRows[slot + x] = ax + bx + cx;
      yyRows[slot + x] = ay + by + cy;
      xyRows[slot + x] = az + bz + cz;
      ax = bx;
      ay = by;
      az = bz;
      bx = cx;
      by = cy;
      bz = cz;
    }
  };
  row(y0 - 1);
  row(y0);
  for (let y = y0; y < y1; y++) {
    row(y + 1);
    const a = ((y - 1) % 3) * w;
    const b = (y % 3) * w;
    const c = ((y + 1) % 3) * w;
    for (let x = x0; x < x1; x++) {
      const xx = xxRows[a + x]! + xxRows[b + x]! + xxRows[c + x]!;
      const yy = yyRows[a + x]! + yyRows[b + x]! + yyRows[c + x]!;
      const xy = xyRows[a + x]! + xyRows[b + x]! + xyRows[c + x]!;
      scores[y * w + x] = xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
    }
  }
}

/**
 * Harris corners of one smoothed level: responses of at least 1e6 that are the maximum of their 5×5 neighbourhood
 * (ties go to the earlier pixel in row order), sorted by score descending, then y, then x.
 */
export function detectCorners(
  data: Uint8Array,
  w: number,
  h: number,
  scale: number,
  roi: Roi | null,
  rows: TensorRows,
): CornerCandidate[] {
  const scores = new Float64Array(w * h);
  const candidates: CornerCandidate[] = [];
  harrisScores(data, w, h, scale, roi, scores, rows);
  for (let y = 10; y < h - 10; y++) {
    for (let x = 10; x < w - 10; x++) {
      const score = scores[y * w + x]!;
      if (score < 1e6) continue;
      // `peak` only ever turns from true to false, so stopping at the first stronger (or tie-winning) neighbour gives
      // the same result as visiting all of them.
      let peak = true;
      nms: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const other = scores[(y + dy) * w + x + dx]!;
          if (other > score || (other === score && (dy < 0 || (dy === 0 && dx < 0)))) {
            peak = false;
            break nms;
          }
        }
      }
      if (peak) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return candidates;
}
