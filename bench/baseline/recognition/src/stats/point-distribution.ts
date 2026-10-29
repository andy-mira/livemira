/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Target-normalized point-distribution statistics, used by the target quality score. Not used by recognition itself.
// Coordinates are normalized by the target size (u = x / width, v = y / height), so the aspect ratio does not matter.
// Only + - * / and comparisons follow the hull, so identical points give identical results on any JavaScript engine.
//
// A copy lives in @livemira/recognition-diagnostics, which may depend only on contracts; keep both identical.

import type { Point2 } from '@livemira/contracts';

import { hullArea } from '../geometry/homography.ts';

/** Variance of a uniform distribution over [0, 1] per axis; dispersion 1 = as spread as uniform scatter. */
export const UNIFORM_AXIS_VARIANCE = 1 / 12;

export interface PointDistribution {
  /** Finite points inside the target rectangle. */
  readonly count: number;
  /** Convex-hull area / target area, 0..1. */
  readonly hullCoverage: number;
  /** (var(u) + var(v)) / (2 / 12), clamped to 0..1: 1 = uniform scatter, 0 = all points at one place. */
  readonly dispersion: number;
  /**
   * 4 det(C) / trace(C)² of the covariance C of (u, v), 0..1: 1 = equal spread in every direction, 0 = collinear. A
   * conditioning proxy for a homography fit. 0 for fewer than 3 points or zero spread.
   */
  readonly isotropy: number;
}

export function pointDistribution(
  points: readonly Point2[],
  widthPx: number,
  heightPx: number,
): PointDistribution {
  const empty = { count: 0, hullCoverage: 0, dispersion: 0, isotropy: 0 };
  if (!Array.isArray(points) || !(widthPx > 0) || !(heightPx > 0)) return empty;
  const u: number[] = [];
  const v: number[] = [];
  for (const p of points) {
    if (
      !Array.isArray(p) ||
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      p[0] < 0 ||
      p[1] < 0 ||
      p[0] > widthPx ||
      p[1] > heightPx
    )
      continue;
    u.push(p[0] / widthPx);
    v.push(p[1] / heightPx);
  }
  const n = u.length;
  if (!n) return empty;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    mu += u[i]!;
    mv += v[i]!;
  }
  mu /= n;
  mv /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (let i = 0; i < n; i++) {
    const du = u[i]! - mu;
    const dv = v[i]! - mv;
    suu += du * du;
    svv += dv * dv;
    suv += du * dv;
  }
  suu /= n;
  svv /= n;
  suv /= n;
  const trace = suu + svv;
  const det = suu * svv - suv * suv;
  const hull = n >= 3 ? hullArea(u.map((x, i) => [x, v[i]!] as const)) : 0;
  return {
    count: n,
    hullCoverage: Math.min(1, hull),
    dispersion: Math.min(1, trace / (2 * UNIFORM_AXIS_VARIANCE)),
    isotropy: n >= 3 && trace > 0 ? Math.min(1, Math.max(0, (4 * det) / (trace * trace))) : 0,
  };
}
