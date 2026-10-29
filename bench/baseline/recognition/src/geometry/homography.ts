/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Normalized least-squares homography fitting and plane validity checks. Homographies here are plain 9-element
// arrays, row-major, mapping target points to image points.

import type { Point2 } from '@livemira/contracts';

import type { PointPair } from '../matching/packed-matcher.ts';

/** Projects a point; a point at (or numerically near) the horizon maps to Infinity. */
export function project(h: readonly number[], [x, y]: Point2): Point2 {
  const z = h[6]! * x + h[7]! * y + h[8]!;
  return Math.abs(z) < 1e-10
    ? [Infinity, Infinity]
    : [(h[0]! * x + h[1]! * y + h[2]!) / z, (h[3]! * x + h[4]! * y + h[5]!) / z];
}

function multiply(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce((s, k) => s + a[Math.floor(i / 3) * 3 + k]! * b[k * 3 + (i % 3)]!, 0),
  );
}

interface Normalization {
  readonly points: Point2[];
  readonly t: number[];
  readonly inv: number[];
}

/** Hartley normalization: centroid to the origin, mean distance √2. Null for collapsed points. */
function normalize(points: readonly Point2[]): Normalization | null {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const radius = Math.sqrt(
    points.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / points.length,
  );
  if (radius < 1e-8) return null;
  const s = Math.SQRT2 / radius;
  return {
    points: points.map(([x, y]) => [(x - cx) * s, (y - cy) * s]),
    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  };
}

/** Gauss-Jordan elimination with partial pivoting; null for a (near) singular system. */
function solve(a: readonly number[][], b: readonly number[]): number[] | null {
  const m = a.map((row, i) => [...row, b[i]!]);
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(m[j]![i]!) > Math.abs(m[pivot]![i]!)) pivot = j;
    if (Math.abs(m[pivot]![i]!) < 1e-9) return null;
    [m[i], m[pivot]] = [m[pivot]!, m[i]!];
    const divisor = m[i]![i]!;
    for (let k = i; k <= n; k++) m[i]![k]! /= divisor;
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        const f = m[j]![i]!;
        for (let k = i; k <= n; k++) m[j]![k]! -= f * m[i]![k]!;
      }
    }
  }
  return m.map((row) => row[n]!);
}

/** Least-squares homography (h8 = 1) through the normal equations of the normalized points; null when undetermined. */
export function fitHomography(pairs: readonly PointPair[]): number[] | null {
  if (pairs.length < 4) return null;
  const a = normalize(pairs.map((p) => p.target));
  const b = normalize(pairs.map((p) => p.image));
  if (!a || !b) return null;
  const ata = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  const atb = Array<number>(8).fill(0);
  for (let i = 0; i < pairs.length; i++) {
    const [x, y] = a.points[i]!;
    const [u, v] = b.points[i]!;
    for (const [row, rhs] of [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ] as const) {
      for (let j = 0; j < 8; j++) {
        atb[j]! += row[j]! * rhs;
        for (let k = 0; k < 8; k++) ata[j]![k]! += row[j]! * row[k]!;
      }
    }
  }
  const h = solve(ata, atb);
  if (!h) return null;
  const denormalized = multiply(multiply(b.inv, [...h, 1]), a.t);
  const z = denormalized[8]!;
  if (Math.abs(z) < 1e-10) return null;
  const result = denormalized.map((v) => v / z);
  return result.every(Number.isFinite) ? result : null;
}

const cross = (o: Point2, a: Point2, b: Point2): number =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Area of the convex hull (monotone chain); 0 for fewer than three points. */
export function hullArea(points: readonly Point2[]): number {
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

/**
 * True when the homography maps the target rectangle (corners at 0 and width − 1, height − 1) to a convex,
 * consistently oriented quadrilateral in front of the camera.
 */
export function validateHomography(
  h: readonly number[] | null,
  width: number,
  height: number,
): boolean {
  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return false;
  const det =
    h[0]! * (h[4]! * h[8]! - h[5]! * h[7]!) -
    h[1]! * (h[3]! * h[8]! - h[5]! * h[6]!) +
    h[2]! * (h[3]! * h[7]! - h[4]! * h[6]!);
  if (Math.abs(det) < 1e-10) return false;
  const corners: Point2[] = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
  const denominators = corners.map(([x, y]) => h[6]! * x + h[7]! * y + h[8]!);
  if (!(denominators.every((v) => v > 1e-7) || denominators.every((v) => v < -1e-7))) return false;
  const projected = corners.map((p) => project(h, p));
  return (
    projected.every((p) => p.every(Number.isFinite)) &&
    projected.every((p, i) => cross(p, projected[(i + 1) % 4]!, projected[(i + 2) % 4]!) > 1e-6)
  );
}
