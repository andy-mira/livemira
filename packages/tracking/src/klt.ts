// SPDX-License-Identifier: Apache-2.0
// Pyramidal Lucas–Kanade point tracking (Bouguet's formulation) with a forward–backward consistency check.
// Coordinates are level-0 pixel-edge coordinates; level l divides them by exactly 2^l (see imaging/pyramid.ts).

import type { ImagePyramid } from '@livemira-next/contracts';
import { inside, sample, sampleField, type Gradients } from '@livemira-next/imaging';

export interface KltOptions {
  /** Window radius (window side 2r + 1). */
  readonly radius?: number;
  readonly iterations?: number;
  /** Stop when the update is below this many pixels. */
  readonly epsilon?: number;
  /** Minimum smaller eigenvalue of the window's gradient matrix, per pixel of the window. */
  readonly minEigen?: number;
  /** Highest level used (clamped to the pyramids). */
  readonly maxLevel?: number;
}

export interface KltResult {
  /** Interleaved tracked positions in the next image. */
  readonly positions: Float64Array;
  /** 1 where the point was tracked. */
  readonly status: Uint8Array;
}

const W = 31 * 31;
const winI = new Float32Array(W);
const winX = new Float32Array(W);
const winY = new Float32Array(W);

/** Tracks `points` from `prev` to `next`; `guesses` (interleaved displacements) seed the search. */
export function trackPoints(
  prev: ImagePyramid,
  prevGradients: (level: number) => Gradients,
  next: ImagePyramid,
  points: Float64Array,
  guesses: Float64Array,
  options: KltOptions = {},
): KltResult {
  const r = Math.min(15, options.radius ?? 5);
  const iterations = options.iterations ?? 10;
  const eps = options.epsilon ?? 0.01;
  const minEigen = (options.minEigen ?? 2) * (2 * r + 1) ** 2;
  const top = Math.min(options.maxLevel ?? 3, prev.levels.length - 1, next.levels.length - 1);
  const n = points.length / 2;
  const positions = new Float64Array(2 * n);
  const status = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    let gx = guesses[2 * k]! / 2 ** top;
    let gy = guesses[2 * k + 1]! / 2 ** top;
    let ok = true;
    for (let l = top; l >= 0 && ok; l--) {
      const I = prev.levels[l]!;
      const Jm = next.levels[l]!;
      const grad = prevGradients(l);
      const px = points[2 * k]! / 2 ** l;
      const py = points[2 * k + 1]! / 2 ** l;
      if (!inside(I.width, I.height, px - r, py - r, 1.5) || !inside(I.width, I.height, px + r, py + r, 1.5)) {
        // Too close to the border at this level: skip it and carry the guess down.
        if (l === 0) ok = false;
        gx *= 2;
        gy *= 2;
        continue;
      }
      let gxx = 0;
      let gyy = 0;
      let gxy = 0;
      let m = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++, m++) {
          const x = px + dx;
          const y = py + dy;
          const ix = sampleField(grad.gx, grad.width, x, y);
          const iy = sampleField(grad.gy, grad.width, x, y);
          winI[m] = sample(I, x, y);
          winX[m] = ix;
          winY[m] = iy;
          gxx += ix * ix;
          gyy += iy * iy;
          gxy += ix * iy;
        }
      const tr = (gxx + gyy) / 2;
      const minEig = tr - Math.sqrt(Math.max(0, tr * tr - (gxx * gyy - gxy * gxy)));
      const det = gxx * gyy - gxy * gxy;
      if (minEig < minEigen || det <= 0) {
        if (l === 0) ok = false;
        gx *= 2;
        gy *= 2;
        continue;
      }
      let vx = 0;
      let vy = 0;
      for (let it = 0; it < iterations; it++) {
        let bx = 0;
        let by = 0;
        m = 0;
        const ox = px + gx + vx;
        const oy = py + gy + vy;
        if (!inside(Jm.width, Jm.height, ox - r, oy - r, 1) || !inside(Jm.width, Jm.height, ox + r, oy + r, 1)) {
          ok = l > 0;
          break;
        }
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++, m++) {
            const diff = winI[m]! - sample(Jm, ox + dx, oy + dy);
            bx += diff * winX[m]!;
            by += diff * winY[m]!;
          }
        const ex = (gyy * bx - gxy * by) / det;
        const ey = (gxx * by - gxy * bx) / det;
        vx += ex;
        vy += ey;
        if (ex * ex + ey * ey < eps * eps) break;
      }
      if (l > 0) {
        gx = 2 * (gx + vx);
        gy = 2 * (gy + vy);
      } else {
        gx += vx;
        gy += vy;
      }
    }
    positions[2 * k] = points[2 * k]! + gx;
    positions[2 * k + 1] = points[2 * k + 1]! + gy;
    status[k] = ok && Number.isFinite(gx) && Number.isFinite(gy) ? 1 : 0;
  }
  return { positions, status };
}

/** Forward–backward tracking: points whose round trip returns within `maxErrorPx` keep status 1. */
export function trackPointsChecked(
  prev: ImagePyramid,
  prevGradients: (level: number) => Gradients,
  next: ImagePyramid,
  nextGradients: (level: number) => Gradients,
  points: Float64Array,
  guesses: Float64Array,
  maxErrorPx: number,
  options: KltOptions = {},
): KltResult & { readonly error: Float64Array } {
  const forward = trackPoints(prev, prevGradients, next, points, guesses, options);
  const backGuess = Float64Array.from(forward.positions, (p, i) => points[i]! - p);
  const back = trackPoints(next, nextGradients, prev, forward.positions, backGuess, options);
  const n = points.length / 2;
  const error = new Float64Array(n);
  const status = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    error[k] = Math.hypot(back.positions[2 * k]! - points[2 * k]!, back.positions[2 * k + 1]! - points[2 * k + 1]!);
    status[k] = forward.status[k]! && back.status[k]! && error[k]! <= maxErrorPx ? 1 : 0;
  }
  return { positions: forward.positions, status, error };
}
