/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic, bounded RANSAC: a fixed xorshift sequence draws minimal samples, the model with most inliers
// (then the smallest squared error) wins, and it is refined twice by least squares over its inliers.

import { EngineError } from '@livemira/contracts';

import type { PointPair } from '../matching/packed-matcher.ts';
import { fitHomography, hullArea, project, validateHomography } from './homography.ts';

export interface GeometryOptions {
  readonly iterations?: number;
  /** Inlier reprojection threshold in image pixels. */
  readonly threshold?: number;
  readonly minInliers?: number;
  /** Minimum convex hull of inlier target points relative to the target area. */
  readonly minCoverage?: number;
  readonly seed?: number;
}

export type GeometryRejection =
  | 'INSUFFICIENT_MATCHES'
  | 'NO_ROBUST_MODEL'
  | 'DEGENERATE_MODEL'
  | 'DEGENERATE_REFINEMENT'
  | 'LOW_INLIER_SUPPORT'
  | 'LOW_SPATIAL_COVERAGE';

export type GeometryResult =
  | {
      readonly accepted: false;
      readonly reason: GeometryRejection;
      readonly H: null;
      readonly pairs: readonly PointPair[];
      readonly inlierMask: boolean[];
    }
  | {
      readonly accepted: true;
      readonly reason: 'GEOMETRY_VERIFIED';
      readonly H: number[];
      readonly pairs: readonly PointPair[];
      readonly inlierMask: boolean[];
      readonly inlierCount: number;
      readonly inlierRatio: number;
      readonly coverage: number;
      readonly rmsErrorPx: number;
      readonly maxErrorPx: number;
    };

function checkInput(
  pairs: readonly PointPair[],
  width: number,
  height: number,
  options: Required<Omit<GeometryOptions, 'seed'>>,
): void {
  const { iterations, threshold, minInliers, minCoverage } = options;
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 4096 ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 20 ||
    !Number.isInteger(minInliers) ||
    minInliers < 4 ||
    !Number.isFinite(minCoverage) ||
    minCoverage < 0 ||
    minCoverage > 1
  ) {
    throw new EngineError('INVALID_CONFIG', 'INVALID_GEOMETRY_OPTIONS', { isRecoverable: false });
  }
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 2 ||
    height < 2 ||
    pairs.length > 512 ||
    pairs.some(
      (p) =>
        ![p.target, p.image].every(
          (q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite),
        ),
    )
  ) {
    throw new EngineError('FRAME_FAILED', 'INVALID_PAIRS', { isRecoverable: false });
  }
}

/** Robust homography from target/image pairs of a target of `width` × `height` pixels. */
export function verifyGeometry(
  pairs: readonly PointPair[],
  width: number,
  height: number,
  options: GeometryOptions = {},
): GeometryResult {
  const { iterations = 256, threshold = 3, minInliers = 12, minCoverage = 0.08 } = options;
  let seed = options.seed ?? 12345;
  checkInput(pairs, width, height, { iterations, threshold, minInliers, minCoverage });
  const reject = (reason: GeometryRejection): GeometryResult => ({
    accepted: false,
    reason,
    H: null,
    pairs,
    inlierMask: pairs.map(() => false),
  });
  if (pairs.length < minInliers) return reject('INSUFFICIENT_MATCHES');
  const errors = (h: readonly number[]): number[] =>
    pairs.map((p) => {
      const q = project(h, p.target);
      return Math.hypot(q[0] - p.image[0], q[1] - p.image[1]);
    });
  let best: number[] = [];
  let bestError = Infinity;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  if (!(seed >>> 0)) seed = 12345;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const indices = new Set<number>();
    while (indices.size < 4) indices.add(random() % pairs.length);
    const h = fitHomography([...indices].map((i) => pairs[i]!));
    if (!validateHomography(h, width, height)) continue;
    const e = errors(h!);
    const indicesIn = e.flatMap((v, i) => (v <= threshold ? [i] : []));
    const total = indicesIn.reduce((s, i) => s + e[i]! ** 2, 0);
    if (indicesIn.length > best.length || (indicesIn.length === best.length && total < bestError)) {
      best = indicesIn;
      bestError = total;
    }
  }
  if (best.length < minInliers) return reject('NO_ROBUST_MODEL');
  return refine(pairs, best, width, height, threshold, minInliers, minCoverage, errors, reject);
}

function refine(
  pairs: readonly PointPair[],
  best: readonly number[],
  width: number,
  height: number,
  threshold: number,
  minInliers: number,
  minCoverage: number,
  errors: (h: readonly number[]) => number[],
  reject: (reason: GeometryRejection) => GeometryResult,
): GeometryResult {
  let h = fitHomography(best.map((i) => pairs[i]!));
  if (!validateHomography(h, width, height)) return reject('DEGENERATE_MODEL');
  let e = errors(h!);
  let mask = e.map((v) => v <= threshold);
  h = fitHomography(pairs.filter((_, i) => mask[i]));
  if (!validateHomography(h, width, height)) return reject('DEGENERATE_REFINEMENT');
  e = errors(h!);
  mask = e.map((v) => v <= threshold);
  const selected = pairs.filter((_, i) => mask[i]);
  const inlierCount = selected.length;
  const ratio = inlierCount / pairs.length;
  const coverage = hullArea(selected.map((p) => p.target)) / ((width - 1) * (height - 1));
  if (inlierCount < minInliers || ratio < 0.35) return reject('LOW_INLIER_SUPPORT');
  if (coverage < minCoverage) return reject('LOW_SPATIAL_COVERAGE');
  const inlierErrors = e.filter((_, i) => mask[i]);
  return {
    accepted: true,
    reason: 'GEOMETRY_VERIFIED',
    H: h!,
    pairs,
    inlierMask: mask,
    inlierCount,
    inlierRatio: ratio,
    coverage,
    rmsErrorPx: Math.sqrt(inlierErrors.reduce((s, v) => s + v * v, 0) / inlierCount),
    maxErrorPx: Math.max(...inlierErrors),
  };
}
