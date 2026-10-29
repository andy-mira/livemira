// SPDX-License-Identifier: Apache-2.0
// Robust homography: PROSAC sampling in match-quality order, MSAC scoring, adaptive termination, local
// optimisation on every new best model, and a final Huber Levenberg–Marquardt refinement over geometric error.
// Deterministic for a given seed.

import { fitHomography, hullArea, isPlausible, solve4 } from './homography.ts';
import { refineHomography } from './refine.ts';

export interface RobustOptions {
  /** Inlier reprojection threshold, image px. */
  readonly thresholdPx?: number;
  readonly confidence?: number;
  readonly maxIterations?: number;
  readonly minInliers?: number;
  readonly minInlierRatio?: number;
  /** Minimum convex hull of the inlier target points over the target area. */
  readonly minCoverage?: number;
  readonly seed?: number;
}

export type RobustRejection =
  'INSUFFICIENT_MATCHES' | 'NO_MODEL' | 'LOW_INLIER_SUPPORT' | 'LOW_SPATIAL_COVERAGE' | 'IMPLAUSIBLE_MODEL';

export type RobustResult =
  | { readonly accepted: false; readonly reason: RobustRejection; readonly iterations: number }
  | {
      readonly accepted: true;
      readonly H: Float64Array;
      readonly mask: Uint8Array;
      readonly inliers: number;
      readonly ratio: number;
      readonly rmsPx: number;
      readonly coverage: number;
      readonly paramCovariance: Float64Array | null;
      readonly iterations: number;
    };

function xorshift(seed: number): () => number {
  let s = seed >>> 0 || 0x2545f491;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/** MSAC score (sum of truncated squared residuals) and inlier mask of `h`. */
function evaluate(
  h: Float64Array,
  target: Float64Array,
  image: Float64Array,
  count: number,
  thr2: number,
  mask: Uint8Array,
): { score: number; inliers: number } {
  let score = 0;
  let inliers = 0;
  for (let i = 0; i < count; i++) {
    const x = target[2 * i]!;
    const y = target[2 * i + 1]!;
    const w = h[6]! * x + h[7]! * y + h[8]!;
    let r2 = thr2;
    if (w > 1e-12) {
      const dx = (h[0]! * x + h[1]! * y + h[2]!) / w - image[2 * i]!;
      const dy = (h[3]! * x + h[4]! * y + h[5]!) / w - image[2 * i + 1]!;
      r2 = Math.min(thr2, dx * dx + dy * dy);
    }
    const isIn = r2 < thr2;
    mask[i] = isIn ? 1 : 0;
    if (isIn) inliers++;
    score += r2;
  }
  return { score, inliers };
}

function indicesOf(mask: Uint8Array, count: number): Int32Array {
  let n = 0;
  for (let i = 0; i < count; i++) if (mask[i]) n++;
  const out = new Int32Array(n);
  for (let i = 0, k = 0; i < count; i++) if (mask[i]) out[k++] = i;
  return out;
}

function collinear(xy: Float64Array, a: number, b: number, c: number): boolean {
  const area =
    (xy[2 * b]! - xy[2 * a]!) * (xy[2 * c + 1]! - xy[2 * a + 1]!) -
    (xy[2 * b + 1]! - xy[2 * a + 1]!) * (xy[2 * c]! - xy[2 * a]!);
  return Math.abs(area) < 1e-3 * (1 + Math.abs(xy[2 * a]!) + Math.abs(xy[2 * b]!));
}

/**
 * Robust homography of a target `width` × `height` from `count` correspondences (interleaved xy) whose order is
 * best-first (PROSAC draws from the head of the list first).
 */
export function estimateHomography(
  target: Float64Array,
  image: Float64Array,
  count: number,
  width: number,
  height: number,
  options: RobustOptions = {},
): RobustResult {
  const thr = options.thresholdPx ?? 3;
  const thr2 = thr * thr;
  const confidence = options.confidence ?? 0.995;
  const maxIterations = options.maxIterations ?? 500;
  const minInliers = options.minInliers ?? 12;
  const minRatio = options.minInlierRatio ?? 0.2;
  const minCoverage = options.minCoverage ?? 0.08;
  if (count < Math.max(4, minInliers)) return { accepted: false, reason: 'INSUFFICIENT_MATCHES', iterations: 0 };
  const random = xorshift(options.seed ?? 12345);
  const mask = new Uint8Array(count);
  const bestMask = new Uint8Array(count);
  let best: Float64Array | null = null;
  let bestScore = Infinity;
  let bestInliers = 0;
  let limit = maxIterations;
  // PROSAC growth schedule (Chum & Matas 2005) with T_N = maxIterations.
  let n = 4;
  let tn = maxIterations;
  for (let i = 0; i < 4; i++) tn *= (n - i) / (count - i);
  let tnPrime = 1;
  const sample = new Int32Array(4);
  let t = 0;
  const consider = (h: Float64Array | null): void => {
    if (!h || !isPlausible(h, width, height)) return;
    const { score, inliers } = evaluate(h, target, image, count, thr2, mask);
    if (score >= bestScore) return;
    best = h;
    bestScore = score;
    bestInliers = inliers;
    bestMask.set(mask);
    // Local optimisation: least squares on the inliers, re-scored, while it keeps improving.
    for (let lo = 0; lo < 3 && bestInliers >= 8; lo++) {
      const refit = fitHomography(target, image, indicesOf(bestMask, count), bestInliers);
      if (!refit || !isPlausible(refit, width, height)) break;
      const e = evaluate(refit, target, image, count, thr2, mask);
      if (e.score >= bestScore) break;
      best = refit;
      bestScore = e.score;
      bestInliers = e.inliers;
      bestMask.set(mask);
    }
    const w = bestInliers / count;
    const k = Math.log(1 - confidence) / Math.log(Math.max(1e-12, 1 - w ** 4));
    limit = Math.min(maxIterations, Math.max(16, Math.ceil(k)));
  };
  while (t < limit) {
    t++;
    if (t >= tnPrime && n < count) {
      const next = (tn * (n + 1)) / (n + 1 - 4);
      n++;
      tnPrime += Math.ceil(next - tn);
      tn = next;
    }
    // Draw the sample: three from the top n−1 plus the n-th, or four from the top n once the schedule allows.
    const pool = tnPrime > t ? n - 1 : n;
    let k = 0;
    if (tnPrime > t) sample[k++] = n - 1;
    let guard = 0;
    while (k < 4 && guard++ < 64) {
      const c = random() % pool;
      let dup = false;
      for (let j = 0; j < k; j++) if (sample[j] === c) dup = true;
      if (!dup) sample[k++] = c;
    }
    if (k < 4) continue;
    const [a, b, c, d] = [sample[0]!, sample[1]!, sample[2]!, sample[3]!];
    if (
      collinear(target, a, b, c) ||
      collinear(target, a, b, d) ||
      collinear(target, a, c, d) ||
      collinear(target, b, c, d)
    )
      continue;
    consider(solve4(target, image, sample));
  }
  if (!best || bestInliers < minInliers) return { accepted: false, reason: 'NO_MODEL', iterations: t };
  // Final refinement over geometric error, twice with the inlier set updated in between.
  let H: Float64Array = best;
  let refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
  for (let pass = 0; pass < 2; pass++) {
    if (!isPlausible(refined.H, width, height)) return { accepted: false, reason: 'IMPLAUSIBLE_MODEL', iterations: t };
    H = refined.H;
    const e = evaluate(H, target, image, count, thr2, bestMask);
    bestInliers = e.inliers;
    if (pass === 0) refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
  }
  const ratio = bestInliers / count;
  if (bestInliers < minInliers || ratio < minRatio)
    return { accepted: false, reason: 'LOW_INLIER_SUPPORT', iterations: t };
  const coverage = hullArea(target, bestMask, count) / (width * height);
  if (coverage < minCoverage) return { accepted: false, reason: 'LOW_SPATIAL_COVERAGE', iterations: t };
  return {
    accepted: true,
    H,
    mask: bestMask,
    inliers: bestInliers,
    ratio,
    rmsPx: refined.rmsPx,
    coverage,
    paramCovariance: refined.paramCovariance,
    iterations: t,
  };
}
