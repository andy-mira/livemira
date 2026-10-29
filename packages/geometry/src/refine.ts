// SPDX-License-Identifier: Apache-2.0
// Levenberg–Marquardt refinement of a homography over geometric (image-space) reprojection error with a Huber
// loss, and the covariance of the target corners it implies.

import { invertSymmetric, solveInPlace } from './linalg.ts';

export interface RefineResult {
  readonly H: Float64Array;
  /** RMS of the inlier residuals after refinement, px. */
  readonly rmsPx: number;
  /** Covariance of the 8 parameters h0..h7 (h8 = 1), row-major 8×8, or null when singular. */
  readonly paramCovariance: Float64Array | null;
}

/** Huber IRLS weight for a residual of length r with threshold k. */
const huber = (r: number, k: number): number => (r <= k ? 1 : k / r);

/**
 * Refines `h` (normalised so h8 = 1) over the correspondences with `mask[i]` set. `huberPx` bounds the influence of
 * residuals above it. Deterministic: fixed iteration and damping schedule.
 */
export function refineHomography(
  h: Float64Array,
  target: Float64Array,
  image: Float64Array,
  mask: Uint8Array,
  count: number,
  options: { readonly iterations?: number; readonly huberPx?: number } = {},
): RefineResult {
  const iterations = options.iterations ?? 8;
  const k = options.huberPx ?? 1.5;
  let p = Float64Array.from(h.subarray(0, 8));
  let lambda = 1e-3;
  const jtj = new Float64Array(64);
  const jtr = new Float64Array(8);
  const jx = new Float64Array(8);
  const jy = new Float64Array(8);
  const cost = (params: Float64Array): number => {
    let c = 0;
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      const x = target[2 * i]!;
      const y = target[2 * i + 1]!;
      const w = params[6]! * x + params[7]! * y + 1;
      if (!(w > 1e-12)) return Infinity;
      const ex = (params[0]! * x + params[1]! * y + params[2]!) / w - image[2 * i]!;
      const ey = (params[3]! * x + params[4]! * y + params[5]!) / w - image[2 * i + 1]!;
      const r = Math.hypot(ex, ey);
      c += r <= k ? r * r : 2 * k * r - k * k;
    }
    return c;
  };
  let current = cost(p);
  for (let it = 0; it < iterations; it++) {
    jtj.fill(0);
    jtr.fill(0);
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      const x = target[2 * i]!;
      const y = target[2 * i + 1]!;
      const w = p[6]! * x + p[7]! * y + 1;
      const u = (p[0]! * x + p[1]! * y + p[2]!) / w;
      const v = (p[3]! * x + p[4]! * y + p[5]!) / w;
      const ex = u - image[2 * i]!;
      const ey = v - image[2 * i + 1]!;
      const wt = huber(Math.hypot(ex, ey), k);
      jx.set([x / w, y / w, 1 / w, 0, 0, 0, (-u * x) / w, (-u * y) / w]);
      jy.set([0, 0, 0, x / w, y / w, 1 / w, (-v * x) / w, (-v * y) / w]);
      for (let a = 0; a < 8; a++) {
        jtr[a]! += wt * (jx[a]! * ex + jy[a]! * ey);
        for (let b = a; b < 8; b++) jtj[a * 8 + b]! += wt * (jx[a]! * jx[b]! + jy[a]! * jy[b]!);
      }
    }
    for (let a = 0; a < 8; a++) for (let b = 0; b < a; b++) jtj[a * 8 + b] = jtj[b * 8 + a]!;
    let improved = false;
    for (let attempt = 0; attempt < 4 && !improved; attempt++) {
      const a = new Float64Array(jtj);
      for (let d = 0; d < 8; d++) a[d * 9]! *= 1 + lambda;
      const step = Float64Array.from(jtr, (v) => -v);
      if (!solveInPlace(a, step, 8)) {
        lambda *= 10;
        continue;
      }
      const next = Float64Array.from(p, (v, i) => v + step[i]!);
      const c = cost(next);
      if (c < current) {
        p = next;
        current = c;
        lambda = Math.max(1e-7, lambda / 10);
        improved = true;
      } else lambda *= 10;
    }
    if (!improved) break;
  }
  // Residual scale and parameter covariance from the final normal matrix.
  let n = 0;
  let sum = 0;
  jtj.fill(0);
  for (let i = 0; i < count; i++) {
    if (!mask[i]) continue;
    const x = target[2 * i]!;
    const y = target[2 * i + 1]!;
    const w = p[6]! * x + p[7]! * y + 1;
    const u = (p[0]! * x + p[1]! * y + p[2]!) / w;
    const v = (p[3]! * x + p[4]! * y + p[5]!) / w;
    sum += (u - image[2 * i]!) ** 2 + (v - image[2 * i + 1]!) ** 2;
    n++;
    jx.set([x / w, y / w, 1 / w, 0, 0, 0, (-u * x) / w, (-u * y) / w]);
    jy.set([0, 0, 0, x / w, y / w, 1 / w, (-v * x) / w, (-v * y) / w]);
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) jtj[a * 8 + b]! += jx[a]! * jx[b]! + jy[a]! * jy[b]!;
  }
  const sigma2 = n > 4 ? sum / (2 * n - 8) : sum;
  const inv = invertSymmetric(jtj, 8);
  return {
    H: Float64Array.from([...p, 1]),
    rmsPx: n ? Math.sqrt(sum / n) : Infinity,
    paramCovariance: inv ? inv.map((v) => v * sigma2) : null,
  };
}

/** Covariance (8×8) of the four target corners' image coordinates, propagated from the parameter covariance. */
export function cornerCovariance(
  h: Float64Array,
  width: number,
  height: number,
  paramCovariance: Float64Array,
): Float64Array {
  const J = new Float64Array(64);
  const xs = [0, width, width, 0];
  const ys = [0, 0, height, height];
  for (let c = 0; c < 4; c++) {
    const x = xs[c]!;
    const y = ys[c]!;
    const w = h[6]! * x + h[7]! * y + 1;
    const u = (h[0]! * x + h[1]! * y + h[2]!) / w;
    const v = (h[3]! * x + h[4]! * y + h[5]!) / w;
    J.set([x / w, y / w, 1 / w, 0, 0, 0, (-u * x) / w, (-u * y) / w], 2 * c * 8);
    J.set([0, 0, 0, x / w, y / w, 1 / w, (-v * x) / w, (-v * y) / w], (2 * c + 1) * 8);
  }
  const tmp = new Float64Array(64);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += J[r * 8 + k]! * paramCovariance[k * 8 + c]!;
      tmp[r * 8 + c] = s;
    }
  const out = new Float64Array(64);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += tmp[r * 8 + k]! * J[c * 8 + k]!;
      out[r * 8 + c] = s;
    }
  return out;
}
