// SPDX-License-Identifier: Apache-2.0
// Target compiler with view synthesis (ASIFT-style feature training): the target is warped under a set of affine
// tilts, features are detected in every view and mapped back to target coordinates, and points that many views
// detect are kept, each with up to three distinct descriptors. Rotation needs no views (descriptors are oriented);
// scale is covered by the half-octave pyramids on both sides.

import type { GrayImage, TargetImage, TargetInfo } from '@livemira-next/contracts';

import { extractOrb, type OrbOptions } from './orb.ts';

export interface CompiledTarget {
  readonly info: TargetInfo;
  /** Point positions in target edge coordinates, interleaved. */
  readonly points: Float32Array;
  /** Views that detected each point. */
  readonly repeatability: Uint8Array;
  /** Descriptors (32 bytes each) and the point each one belongs to. */
  readonly descriptors: Uint8Array;
  readonly descriptorPoint: Uint32Array;
}

export interface CompileOptions {
  /** Points kept. */
  readonly maxPoints?: number;
  /** Descriptors kept per point (distinct by Hamming distance). */
  readonly descriptorsPerPoint?: number;
  /** Affine tilts (1 / cos of the viewing angle) and the longitudes they are applied at, degrees. */
  readonly tilts?: readonly number[];
  readonly longitudes?: readonly number[];
  /** Extra frontal views blurred by these Gaussian σ, px (defocus and motion blur). */
  readonly blurs?: readonly number[];
  readonly orb?: OrbOptions;
}

interface View {
  readonly image: GrayImage;
  /** View-from-target affine (2×3, row-major). */
  readonly A: readonly number[];
}

/** The target seen with tilt `t` along longitude `phi`: compression by 1/t along the direction phi, after a blur. */
function tiltView(src: GrayImage, t: number, phiDeg: number): View {
  const phi = (phiDeg * Math.PI) / 180;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // S = Rᵀ · diag(1/t, 1) · R
  const a = (c * c) / t + s * s;
  const b = (c * s) / t - c * s;
  const d = (s * s) / t + c * c;
  const corners = [
    [0, 0],
    [src.width, 0],
    [src.width, src.height],
    [0, src.height],
  ].map(([x, y]) => [a * x! + b * y!, b * x! + d * y!]);
  const minX = Math.min(...corners.map((p) => p[0]!));
  const minY = Math.min(...corners.map((p) => p[1]!));
  const w = Math.ceil(Math.max(...corners.map((p) => p[0]!)) - minX);
  const h = Math.ceil(Math.max(...corners.map((p) => p[1]!)) - minY);
  const A = [a, b, -minX, b, d, -minY];
  // Pre-blur against aliasing along the compressed direction (isotropic approximation, σ = 0.8·√(t² − 1)).
  const sigma = 0.8 * Math.sqrt(Math.max(0, t * t - 1));
  const blurred = sigma > 0.3 ? gaussian(src, sigma) : src;
  const det = a * d - b * b;
  const ia = d / det;
  const ib = -b / det;
  const id = a / det;
  const data = new Uint8Array(w * h).fill(128);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const vx = x + 0.5 - A[2]!;
      const vy = y + 0.5 - A[5]!;
      const u = ia * vx + ib * vy - 0.5;
      const v = ib * vx + id * vy - 0.5;
      const i = Math.floor(u);
      const j = Math.floor(v);
      if (i < 0 || j < 0 || i + 1 >= src.width || j + 1 >= src.height) continue;
      const fx = u - i;
      const fy = v - j;
      const o = j * blurred.stride + i;
      const p = blurred.data;
      const top = p[o]! + fx * (p[o + 1]! - p[o]!);
      const bottom = p[o + blurred.stride]! + fx * (p[o + blurred.stride + 1]! - p[o + blurred.stride]!);
      data[y * w + x] = Math.round(top + fy * (bottom - top));
    }
  return { image: { width: w, height: h, stride: w, data }, A };
}

function gaussian(src: GrayImage, sigma: number): GrayImage {
  const r = Math.ceil(3 * sigma);
  const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  const kn = k.map((v) => v / sum);
  const tmp = new Float32Array(src.width * src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++)
        v += kn[i + r]! * src.data[y * src.stride + Math.min(src.width - 1, Math.max(0, x + i))]!;
      tmp[y * src.width + x] = v;
    }
  const out = new Uint8Array(src.width * src.height);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++)
        v += kn[i + r]! * tmp[Math.min(src.height - 1, Math.max(0, y + i)) * src.width + x]!;
      out[y * src.width + x] = Math.round(v);
    }
  return { width: src.width, height: src.height, stride: src.width, data: out };
}

function hamming(a: Uint8Array, ai: number, b: Uint8Array, bi: number): number {
  let d = 0;
  for (let k = 0; k < 32; k++) {
    let v = a[ai + k]! ^ b[bi + k]!;
    while (v) {
      v &= v - 1;
      d++;
    }
  }
  return d;
}

export function compileTarget(target: TargetImage, options: CompileOptions = {}): CompiledTarget {
  // Defaults from the single-frame detection sweeps (bench/src/tune-detector.ts): a third tilt and one blurred view lift recall at 60° tilt, 16 px
  // blur and 128 px long edge (by 13–38 points) at no false-detection cost.
  const tilts = options.tilts ?? [1.4, 2, 2.8];
  const longitudes = options.longitudes ?? [0, 45, 90, 135];
  const views: View[] = [{ image: target.image, A: [1, 0, 0, 0, 1, 0] }];
  for (const t of tilts) for (const phi of longitudes) views.push(tiltView(target.image, t, phi));
  for (const sigma of options.blurs ?? [2.5])
    views.push({ image: gaussian(target.image, sigma), A: [1, 0, 0, 0, 1, 0] });
  interface Group {
    x: number;
    y: number;
    n: number;
    views: Set<number>;
    score: number;
    desc: Uint8Array[];
  }
  const groups: Group[] = [];
  const grid = new Map<number, number[]>();
  const cell = 4;
  const key = (x: number, y: number): number => Math.floor(y / cell) * 65536 + Math.floor(x / cell);
  views.forEach((view, vi) => {
    const k = extractOrb(view.image, { budget: 900, ...options.orb });
    const [a, b, tx, c, d, ty] = view.A as [number, number, number, number, number, number];
    const det = a * d - b * c;
    for (let i = 0; i < k.count; i++) {
      // Back to target coordinates.
      const vx = k.x[i]! - tx;
      const vy = k.y[i]! - ty;
      const x = (d * vx - b * vy) / det;
      const y = (-c * vx + a * vy) / det;
      if (x < 0 || y < 0 || x >= target.info.width || y >= target.info.height) continue;
      const radius = 2 + 1.5 * (2 ** (k.level[i]! / 2) - 1);
      let found = -1;
      for (let gy = -1; gy <= 1 && found < 0; gy++)
        for (let gx = -1; gx <= 1 && found < 0; gx++)
          for (const gi of grid.get(key(x + gx * cell, y + gy * cell)) ?? []) {
            const g = groups[gi]!;
            if (Math.hypot(g.x - x, g.y - y) <= radius) {
              found = gi;
              break;
            }
          }
      const desc = k.descriptors.slice(32 * i, 32 * i + 32);
      if (found < 0) {
        groups.push({ x, y, n: 1, views: new Set([vi]), score: k.score[i]!, desc: [desc] });
        const kk = key(x, y);
        grid.set(kk, [...(grid.get(kk) ?? []), groups.length - 1]);
      } else {
        const g = groups[found]!;
        g.views.add(vi);
        g.n++;
        g.score = Math.max(g.score, k.score[i]!);
        g.desc.push(desc);
      }
    }
  });
  const maxPoints = options.maxPoints ?? 700;
  const perPoint = options.descriptorsPerPoint ?? 3;
  const kept = groups
    .map((g, i) => ({ g, i }))
    .sort((p, q) => q.g.views.size - p.g.views.size || q.g.score - p.g.score || p.i - q.i)
    .slice(0, maxPoints)
    .map((p) => p.g);
  const points = new Float32Array(2 * kept.length);
  const repeatability = new Uint8Array(kept.length);
  const descs: Uint8Array[] = [];
  const owner: number[] = [];
  kept.forEach((g, pi) => {
    points[2 * pi] = g.x;
    points[2 * pi + 1] = g.y;
    repeatability[pi] = g.views.size;
    const chosen: Uint8Array[] = [];
    for (const d of g.desc) {
      if (chosen.length >= perPoint) break;
      if (chosen.every((c) => hamming(c, 0, d, 0) > 24)) chosen.push(d);
    }
    for (const d of chosen) {
      descs.push(d);
      owner.push(pi);
    }
  });
  const descriptors = new Uint8Array(32 * descs.length);
  descs.forEach((d, i) => descriptors.set(d, 32 * i));
  return { info: target.info, points, repeatability, descriptors, descriptorPoint: Uint32Array.from(owner) };
}
