/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Target-normalized point-distribution statistics, shared by the optional companions (target-quality scoring and recognition diagnostics).
// NOT imported by the engine runtime: the engine build gates on that. Pure, allocation-light and bounded by the number of points given.
// Coordinates are normalized by the target size (u = x / width, v = y / height), so the image aspect ratio does not matter.
// Only + - * / and comparisons are used after the hull, so identical points give identical results on any JS engine.
import { hullArea } from '../experimental/geometry.mjs';

/** Variance of a uniform distribution over [0, 1] per axis; dispersion 1 means "as spread as uniform scatter over the whole target". */
export const UNIFORM_AXIS_VARIANCE = 1 / 12;

/**
 * count        number of finite points inside the target rectangle
 * hullCoverage convex-hull area / target area, 0..1
 * dispersion   (var(u) + var(v)) / (2 / 12), clamped to 0..1: 1 = uniform scatter, 0 = all points at one place
 * isotropy     4 det(C) / trace(C)^2 of the covariance C of (u, v), 0..1: 1 = equal spread in every direction, 0 = collinear. It is a conditioning proxy for a
 *              homography fit: collinear or very elongated point sets constrain the transform poorly. Defined as 0 for fewer than 3 points or zero spread.
 */
export function pointDistribution(points, width, height) {
  const empty = { count: 0, hullCoverage: 0, dispersion: 0, isotropy: 0 };
  if (!Array.isArray(points) || !(width > 0) || !(height > 0)) return empty;
  const u = [], v = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[1] < 0 || p[0] > width || p[1] > height) continue;
    u.push(p[0] / width); v.push(p[1] / height);
  }
  const n = u.length;
  if (!n) return empty;
  let mu = 0, mv = 0;
  for (let i = 0; i < n; i++) { mu += u[i]; mv += v[i]; }
  mu /= n; mv /= n;
  let suu = 0, svv = 0, suv = 0;
  for (let i = 0; i < n; i++) { const du = u[i] - mu, dv = v[i] - mv; suu += du * du; svv += dv * dv; suv += du * dv; }
  suu /= n; svv /= n; suv /= n;
  const trace = suu + svv, det = suu * svv - suv * suv;
  const hull = n >= 3 ? hullArea(u.map((x, i) => [x, v[i]])) : 0;
  return {
    count: n,
    hullCoverage: Math.min(1, hull),
    dispersion: Math.min(1, trace / (2 * UNIFORM_AXIS_VARIANCE)),
    isotropy: n >= 3 && trace > 0 ? Math.min(1, Math.max(0, 4 * det / (trace * trace))) : 0,
  };
}
