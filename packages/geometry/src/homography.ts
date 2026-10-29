// SPDX-License-Identifier: Apache-2.0
// Homography math on Float64Array(9), row-major, mapping target pixels to image pixels.

import { smallestEigenvector, solveInPlace } from './linalg.ts';

export function multiply3(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return out;
}

export function invert3(m: ArrayLike<number>): Float64Array | null {
  const [a, b, c, d, e, f, g, h, i] = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!, m[7]!, m[8]!];
  const cof = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const det = a * cof[0]! + b * cof[3]! + c * cof[6]!;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  return Float64Array.from(cof, (v) => v / det);
}

/** Scales `h` so its last element is 1; null when that element is (near) zero. */
export function normalizeH(h: Float64Array): Float64Array | null {
  const k = h[8]!;
  if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return null;
  for (let i = 0; i < 9; i++) h[i]! /= k;
  return h.every(Number.isFinite) ? h : null;
}

/** Hartley normalisation of a point subset: x' = s (x − c). Returns [s, cx, cy]. */
function normalization(xy: Float64Array, indices: ArrayLike<number>, count: number): [number, number, number] | null {
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    cx += xy[2 * i]!;
    cy += xy[2 * i + 1]!;
  }
  cx /= count;
  cy /= count;
  let r = 0;
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    r += Math.hypot(xy[2 * i]! - cx, xy[2 * i + 1]! - cy);
  }
  r /= count;
  if (r < 1e-9) return null;
  return [Math.SQRT2 / r, cx, cy];
}

function denormalize(
  hn: ArrayLike<number>,
  ta: [number, number, number],
  ib: [number, number, number],
): Float64Array | null {
  // H = Tb⁻¹ · Hn · Ta with T = [s 0 −s·cx; 0 s −s·cy; 0 0 1].
  const [sa, ax, ay] = ta;
  const [sb, bx, by] = ib;
  const Ta = [sa, 0, -sa * ax, 0, sa, -sa * ay, 0, 0, 1];
  const TbInv = [1 / sb, 0, bx, 0, 1 / sb, by, 0, 0, 1];
  return normalizeH(multiply3(multiply3(TbInv, hn), Ta));
}

/**
 * Least-squares homography (normalised DLT, smallest eigenvector of AᵀWA) over `count` correspondences selected by
 * `indices`; `weights` (per correspondence index) defaults to 1. Null when undetermined.
 */
export function fitHomography(
  target: Float64Array,
  image: Float64Array,
  indices: ArrayLike<number>,
  count: number,
  weights?: Float64Array,
): Float64Array | null {
  if (count < 4) return null;
  const ta = normalization(target, indices, count);
  const ib = normalization(image, indices, count);
  if (!ta || !ib) return null;
  const ata = new Float64Array(81);
  const row = new Float64Array(9);
  for (let k = 0; k < count; k++) {
    const i = indices[k]!;
    const w = weights ? weights[i]! : 1;
    if (w <= 0) continue;
    const x = ta[0] * (target[2 * i]! - ta[1]);
    const y = ta[0] * (target[2 * i + 1]! - ta[2]);
    const u = ib[0] * (image[2 * i]! - ib[1]);
    const v = ib[0] * (image[2 * i + 1]! - ib[2]);
    for (let r = 0; r < 2; r++) {
      if (r === 0) row.set([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
      else row.set([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
      for (let p = 0; p < 9; p++) {
        const rp = row[p]! * w;
        if (rp === 0) continue;
        for (let q = p; q < 9; q++) ata[p * 9 + q]! += rp * row[q]!;
      }
    }
  }
  for (let p = 0; p < 9; p++) for (let q = 0; q < p; q++) ata[p * 9 + q] = ata[q * 9 + p]!;
  return denormalize(smallestEigenvector(ata, 9), ta, ib);
}

const scratchA = new Float64Array(64);
const scratchB = new Float64Array(8);

/** Exact homography through four correspondences (normalised 8×8 solve); null for degenerate samples. */
export function solve4(target: Float64Array, image: Float64Array, idx: ArrayLike<number>): Float64Array | null {
  const ta = normalization(target, idx, 4);
  const ib = normalization(image, idx, 4);
  if (!ta || !ib) return null;
  scratchA.fill(0);
  for (let k = 0; k < 4; k++) {
    const i = idx[k]!;
    const x = ta[0] * (target[2 * i]! - ta[1]);
    const y = ta[0] * (target[2 * i + 1]! - ta[2]);
    const u = ib[0] * (image[2 * i]! - ib[1]);
    const v = ib[0] * (image[2 * i + 1]! - ib[2]);
    scratchA.set([x, y, 1, 0, 0, 0, -u * x, -u * y], 16 * k);
    scratchA.set([0, 0, 0, x, y, 1, -v * x, -v * y], 16 * k + 8);
    scratchB[2 * k] = u;
    scratchB[2 * k + 1] = v;
  }
  if (!solveInPlace(scratchA, scratchB, 8)) return null;
  return denormalize([...scratchB, 1], ta, ib);
}

/** Projects target point (x, y); writes into `out` and returns false at or behind the horizon. */
export function projectInto(h: ArrayLike<number>, x: number, y: number, out: Float64Array): boolean {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  if (!(w > 1e-12)) return false;
  out[0] = (h[0]! * x + h[1]! * y + h[2]!) / w;
  out[1] = (h[3]! * x + h[4]! * y + h[5]!) / w;
  return true;
}

const cornerScratch = new Float64Array(8);
const p2 = new Float64Array(2);

/**
 * True when the target rectangle maps in front of the camera to a convex, orientation-preserving quadrilateral of
 * at least `minAreaPx` and edges no more than `maxEdgeRatio` apart in length.
 */
export function isPlausible(
  h: ArrayLike<number>,
  width: number,
  height: number,
  minAreaPx = 64,
  maxEdgeRatio = 30,
): boolean {
  const xs = [0, width, width, 0];
  const ys = [0, 0, height, height];
  for (let k = 0; k < 4; k++) {
    if (!projectInto(h, xs[k]!, ys[k]!, p2)) return false;
    cornerScratch[2 * k] = p2[0]!;
    cornerScratch[2 * k + 1] = p2[1]!;
  }
  let area = 0;
  let minEdge = Infinity;
  let maxEdge = 0;
  for (let k = 0; k < 4; k++) {
    const ax = cornerScratch[2 * k]!;
    const ay = cornerScratch[2 * k + 1]!;
    const bx = cornerScratch[(2 * k + 2) % 8]!;
    const by = cornerScratch[(2 * k + 3) % 8]!;
    const cx = cornerScratch[(2 * k + 4) % 8]!;
    const cy = cornerScratch[(2 * k + 5) % 8]!;
    if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return false;
    area += ax * by - bx * ay;
    const edge = Math.hypot(bx - ax, by - ay);
    minEdge = Math.min(minEdge, edge);
    maxEdge = Math.max(maxEdge, edge);
  }
  return area / 2 >= minAreaPx && maxEdge <= maxEdgeRatio * Math.max(minEdge, 1e-9);
}

/** Convex hull area (monotone chain) of the points selected by `mask`, from interleaved xy. */
export function hullArea(xy: Float64Array, mask: Uint8Array | null, count: number): number {
  const pts: [number, number][] = [];
  for (let i = 0; i < count; i++) if (!mask || mask[i]) pts.push([xy[2 * i]!, xy[2 * i + 1]!]);
  if (pts.length < 3) return 0;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]): number =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  let area = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}
