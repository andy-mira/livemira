// SPDX-License-Identifier: Apache-2.0
// What the fast-loop trackers precompute per target: the template pyramid, per level a spatially spread set of
// high-gradient template pixels with their ESM Jacobian terms, and target-anchored corner points for KLT.

import type { ImagePyramid, TargetImage, TargetInfo } from '@livemira-next/contracts';
import { buildPyramid, scharr } from '@livemira-next/imaging';

/** Template pixels of one pyramid level, in normalised coordinates p_n = (p − c) / s (p in level edge coords). */
export interface EsmLevel {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  /** Normalisation: centre (cx, cy) and scale s, in this level's pixels. */
  readonly cx: number;
  readonly cy: number;
  readonly s: number;
  readonly count: number;
  /** Interleaved normalised coordinates. */
  readonly pn: Float32Array;
  readonly value: Float32Array;
  /** Template gradient in normalised coordinates (gray levels per normalised unit). */
  readonly gu: Float32Array;
  readonly gv: Float32Array;
  /** Per pixel the 2×8 product of the warp Jacobian at identity and the sl(3) generators, row-major (16 floats). */
  readonly jwjg: Float32Array;
}

export interface TargetModel {
  readonly info: TargetInfo;
  readonly pyramid: ImagePyramid;
  readonly esm: readonly EsmLevel[];
  /** Corner-like anchor points in target level-0 edge coordinates, interleaved. */
  readonly anchors: Float64Array;
}

export interface TargetModelOptions {
  readonly levels?: number;
  /** ESM pixels per level, at most. */
  readonly esmPixels?: number;
  /** Grid cell (level pixels) inside which the strongest gradients are kept, for spatial spread. */
  readonly esmCell?: number;
  readonly anchors?: number;
}

function esmLevel(
  image: { width: number; height: number; stride: number; data: Uint8Array },
  level: number,
  maxPixels: number,
  cell: number,
): EsmLevel {
  const { width: w, height: h } = image;
  const g = scharr(image);
  const margin = 4;
  const candidates: { i: number; m: number }[] = [];
  for (let cy = margin; cy < h - margin; cy += cell)
    for (let cx = margin; cx < w - margin; cx += cell) {
      let best: { i: number; m: number }[] = [];
      for (let y = cy; y < Math.min(h - margin, cy + cell); y++)
        for (let x = cx; x < Math.min(w - margin, cx + cell); x++) {
          const i = y * w + x;
          const m = Math.hypot(g.gx[i]!, g.gy[i]!);
          if (m < 6) continue;
          best.push({ i, m });
        }
      best.sort((a, b) => b.m - a.m || a.i - b.i);
      best = best.slice(0, 3);
      candidates.push(...best);
    }
  candidates.sort((a, b) => b.m - a.m || a.i - b.i);
  const chosen = candidates.slice(0, maxPixels).sort((a, b) => a.i - b.i);
  const n = chosen.length;
  const cxn = w / 2;
  const cyn = h / 2;
  const s = Math.max(w, h) / 2;
  const pn = new Float32Array(2 * n);
  const value = new Float32Array(n);
  const gu = new Float32Array(n);
  const gv = new Float32Array(n);
  const jwjg = new Float32Array(16 * n);
  chosen.forEach(({ i }, k) => {
    const x = i % w;
    const y = (i - x) / w;
    const u = (x + 0.5 - cxn) / s;
    const v = (y + 0.5 - cyn) / s;
    pn[2 * k] = u;
    pn[2 * k + 1] = v;
    value[k] = image.data[y * image.stride + x]!;
    gu[k] = g.gx[i]! * s;
    gv[k] = g.gy[i]! * s;
    // Rows ∂x/∂g·A_i and ∂y/∂g·A_i for the generators A1..A8 (translation x/y, shear, rotation-like, scale, aniso, projective).
    jwjg.set([1, 0, v, 0, u, -u, -u * u, -u * v, 0, 1, 0, u, -v, -2 * v, -u * v, -v * v], 16 * k);
  });
  return { level, width: w, height: h, cx: cxn, cy: cyn, s, count: n, pn, value, gu, gv, jwjg };
}

function anchorPoints(
  image: { width: number; height: number; stride: number; data: Uint8Array },
  count: number,
): Float64Array {
  const { width: w, height: h } = image;
  const g = scharr(image);
  // Shi–Tomasi response over 5×5 windows.
  const response = new Float32Array(w * h);
  for (let y = 4; y < h - 4; y++)
    for (let x = 4; x < w - 4; x++) {
      let xx = 0;
      let yy = 0;
      let xy = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i = (y + dy) * w + x + dx;
          xx += g.gx[i]! ** 2;
          yy += g.gy[i]! ** 2;
          xy += g.gx[i]! * g.gy[i]!;
        }
      const tr = (xx + yy) / 2;
      response[y * w + x] = tr - Math.sqrt(Math.max(0, tr * tr - (xx * yy - xy * xy)));
    }
  // Strongest point per grid cell, then the strongest cells.
  const cell = Math.max(12, Math.round(Math.sqrt((w * h) / (count * 1.5))));
  const points: { x: number; y: number; r: number }[] = [];
  for (let cy = 8; cy < h - 8; cy += cell)
    for (let cx = 8; cx < w - 8; cx += cell) {
      let best = { x: 0, y: 0, r: 0 };
      for (let y = cy; y < Math.min(h - 8, cy + cell); y++)
        for (let x = cx; x < Math.min(w - 8, cx + cell); x++) {
          const r = response[y * w + x]!;
          if (r > best.r) best = { x, y, r };
        }
      if (best.r > 50) points.push(best);
    }
  points.sort((a, b) => b.r - a.r || a.y - b.y || a.x - b.x);
  const kept = points.slice(0, count);
  return Float64Array.from(kept.flatMap((p) => [p.x + 0.5, p.y + 0.5]));
}

export function buildTargetModel(target: TargetImage, options: TargetModelOptions = {}): TargetModel {
  const pyramid = buildPyramid(target.image, options.levels ?? 5, 16);
  const esm = pyramid.levels.map((level, l) => esmLevel(level, l, options.esmPixels ?? 3000, options.esmCell ?? 8));
  return { info: target.info, pyramid, esm, anchors: anchorPoints(target.image, options.anchors ?? 160) };
}
