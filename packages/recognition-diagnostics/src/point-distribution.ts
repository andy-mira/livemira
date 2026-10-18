/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Target-normalized point-distribution statistics. This package may depend only on contracts, so it keeps its own copy
// of the function in @livemira/recognition (stats/point-distribution.ts); keep both identical. Only + - * / and
// comparisons are used after the hull, so identical points give identical results on any JavaScript engine.

import type { Point2 } from '@livemira/contracts';

const UNIFORM_AXIS_VARIANCE = 1 / 12;

const cross = (o: Point2, a: Point2, b: Point2): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function hullArea(points: readonly Point2[]): number {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const half = (values: readonly Point2[]): Point2[] => {
    const h: Point2[] = [];
    for (const p of values) {
      while (h.length >= 2 && cross(h.at(-2)!, h.at(-1)!, p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return (
    Math.abs(
      hull.reduce((s, p, i) => {
        const q = hull[(i + 1) % hull.length]!;
        return s + p[0] * q[1] - p[1] * q[0];
      }, 0),
    ) / 2
  );
}

export interface PointDistribution {
  readonly count: number;
  readonly hullCoverage: number;
  readonly dispersion: number;
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
