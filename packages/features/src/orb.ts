// SPDX-License-Identifier: Apache-2.0
// Features: FAST-9 corners with a per-cell adaptive threshold (low-contrast regions still yield corners), Harris
// ranking and 3×3 non-maximum suppression, grid-spread selection, intensity-centroid orientation (360°) and a steered
// 256-bit BRIEF descriptor sampled as 5×5 box means. Scales come in half-octave steps (1, √2, 2, 2√2, …).
// Coordinates are level-0 pixel-edge coordinates. Deterministic: integer image arithmetic and fixed orders.

import type { GrayImage, Keypoints } from '@livemira-next/contracts';
import { PyramidWorkspace } from '@livemira-next/imaging';

import { fastScorer, type FastScorer } from './fast.ts';

export interface OrbOptions {
  /** Features over all levels. */
  readonly budget?: number;
  /** Half-octave levels (1, √2, 2, …). */
  readonly levels?: number;
  readonly fastThreshold?: number;
  /** Lowest threshold a sparse cell may fall back to. */
  readonly minFastThreshold?: number;
  /** Selection cell, level pixels. */
  readonly cell?: number;
  /** Only keypoints inside this level-0 rectangle (frame ROI). */
  readonly roi?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
  /** FAST scoring by the WASM SIMD kernel when available (default); false forces the JavaScript reference. */
  readonly wasm?: boolean;
  /** BRIEF tests, 256 × (ax, ay, bx, by) box-centre offsets within 15 px; default `GAUSSIAN_PATTERN`. */
  readonly pattern?: Int8Array;
}

const PATCH = 15;
const BORDER = PATCH + 3;
const ANGLE_BINS = 32;

/**
 * 256 tests (ax, ay, bx, by) drawn from a seeded isotropic Gaussian (σ 8.5 px, box centres within 15 px, pairs at
 * least 2 px apart). The wide support tells apart look-alike corners (text, flat shapes) by their surroundings: in
 * the single-frame detection sweeps it raised the blur limit from 8 to 12 px over σ 5.5 within 9 px (bench/src/tune-detector.ts). A pattern learned
 * for stability and decorrelation (bench/src/learn-pattern.ts) did worse than both.
 */
export const GAUSSIAN_PATTERN: Int8Array = (() => {
  let s = 0x2545f491;
  const uniform = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  const gauss = (): number => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const out = new Int8Array(1024);
  for (let i = 0; i < 256;) {
    const p = [0, 1, 2, 3].map(() => Math.round(gauss() * 8.5)) as [number, number, number, number];
    if (Math.hypot(p[0], p[1]) > 15 || Math.hypot(p[2], p[3]) > 15 || Math.hypot(p[0] - p[2], p[1] - p[3]) < 2)
      continue;
    out.set(p, 4 * i);
    i++;
  }
  return out;
})();

/** Version of the default pattern, stored in target assets: descriptors of different patterns never match. */
export const PATTERN_VERSION = 2;

/** Rotated pattern offsets per angle bin (rounded), as dx, dy pairs. */
function steer(pattern: Int8Array): Int8Array[] {
  return Array.from({ length: ANGLE_BINS }, (_, b) => {
    const a = (2 * Math.PI * b) / ANGLE_BINS;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const out = new Int8Array(1024);
    for (let i = 0; i < 512; i++) {
      const x = pattern[2 * i]!;
      const y = pattern[2 * i + 1]!;
      out[2 * i] = Math.round(c * x - sn * y);
      out[2 * i + 1] = Math.round(sn * x + c * y);
    }
    return out;
  });
}

const STEERED = new WeakMap<Int8Array, Int8Array[]>();

function steered(pattern: Int8Array): Int8Array[] {
  let s = STEERED.get(pattern);
  if (!s) {
    // Box centres within 15 px keep every steered 5×5 box inside the keypoint border.
    let ok = pattern.length === 1024;
    for (let i = 0; i < 512 && ok; i++) ok = Math.hypot(pattern[2 * i]!, pattern[2 * i + 1]!) <= 15;
    if (!ok) throw new Error('BRIEF pattern: 256 tests with box centres within 15 px');
    s = steer(pattern);
    STEERED.set(pattern, s);
  }
  return s;
}

/** Half-widths of the circular orientation patch per row. */
const UMAX: Int32Array = (() => {
  const u = new Int32Array(PATCH + 1);
  for (let v = 0; v <= PATCH; v++) u[v] = Math.floor(Math.sqrt(PATCH * PATCH - v * v) + 0.5);
  return u;
})();

interface Level {
  readonly image: GrayImage;
  readonly scale: number;
}

/** Buffers reused across extractions (the vision Worker extracts every relocalisation); results never alias them. */
class OrbWorkspace {
  readonly octaves = new PyramidWorkspace();
  readonly halfOctaves = new PyramidWorkspace();
  horizontal = new Uint16Array(0);
  blur = new Uint8Array(0);
  half = new Uint8Array(0);
  integral = new Int32Array(0);
}

const WORKSPACE = new OrbWorkspace();

/** Bilinear 1/√2 resample after a separable [1 2 1] pre-blur; edge coordinates scale exactly (x' = x / √2). */
function halfOctave(src: GrayImage, ws: OrbWorkspace): GrayImage {
  const sw = src.width;
  const sh = src.height;
  const w = Math.floor(sw / Math.SQRT2);
  const h = Math.floor(sh / Math.SQRT2);
  const d = src.data;
  if (ws.horizontal.length < sw * sh) {
    ws.horizontal = new Uint16Array(sw * sh);
    ws.blur = new Uint8Array(sw * sh);
  }
  if (ws.half.length !== w * h) ws.half = new Uint8Array(w * h);
  const horizontal = ws.horizontal;
  for (let y = 0; y < sh; y++) {
    const o = y * src.stride;
    const r = y * sw;
    horizontal[r] = 3 * d[o]! + d[o + 1]!;
    for (let x = 1; x < sw - 1; x++) horizontal[r + x] = d[o + x - 1]! + 2 * d[o + x]! + d[o + x + 1]!;
    horizontal[r + sw - 1] = d[o + sw - 2]! + 3 * d[o + sw - 1]!;
  }
  const blur = ws.blur;
  for (let y = 0; y < sh; y++) {
    const a = Math.max(0, y - 1) * sw;
    const b = y * sw;
    const c = Math.min(sh - 1, y + 1) * sw;
    for (let x = 0; x < sw; x++)
      blur[b + x] = (horizontal[a + x]! + 2 * horizontal[b + x]! + horizontal[c + x]! + 8) >> 4;
  }
  const xi = new Int32Array(w);
  const xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const sx = (x + 0.5) * Math.SQRT2 - 0.5;
    xi[x] = Math.min(sw - 2, Math.max(0, Math.floor(sx)));
    xf[x] = sx - xi[x]!;
  }
  const out = ws.half;
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) * Math.SQRT2 - 0.5;
    const j = Math.min(sh - 2, Math.max(0, Math.floor(sy)));
    const fy = sy - j;
    const r0 = j * sw;
    const r1 = r0 + sw;
    for (let x = 0; x < w; x++) {
      const i = xi[x]!;
      const fx = xf[x]!;
      const top = blur[r0 + i]! + fx * (blur[r0 + i + 1]! - blur[r0 + i]!);
      const bottom = blur[r1 + i]! + fx * (blur[r1 + i + 1]! - blur[r1 + i]!);
      out[y * w + x] = (top + fy * (bottom - top) + 0.5) | 0;
    }
  }
  return { width: w, height: h, stride: w, data: out };
}

/**
 * Half-octave pyramid: interleaves the 2× pyramids of the image and of its 1/√2 resample. With the internal
 * workspace the levels are only valid until the next call.
 */
export function halfOctavePyramid(image: GrayImage, levels: number, ws: OrbWorkspace = new OrbWorkspace()): Level[] {
  const octaves = Math.ceil(levels / 2);
  const a = ws.octaves.build(image, octaves, 24).levels;
  const b = ws.halfOctaves.build(halfOctave(image, ws), octaves, 24).levels;
  const out: Level[] = [];
  for (let o = 0; o < octaves; o++) {
    if (a[o]) out.push({ image: a[o]!, scale: 2 ** o });
    if (b[o]) out.push({ image: b[o]!, scale: Math.SQRT2 * 2 ** o });
  }
  return out.slice(0, levels);
}

/** Harris response over a 7×7 window of central-difference gradients. */
function harris(d: Uint8Array, stride: number, x: number, y: number): number {
  let xx = 0;
  let yy = 0;
  let xy = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const o = (y + dy) * stride + x + dx;
      const gx = d[o + 1]! - d[o - 1]!;
      const gy = d[o + stride]! - d[o - stride]!;
      xx += gx * gx;
      yy += gy * gy;
      xy += gx * gy;
    }
  return xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
}

function integral(image: GrayImage, ws: OrbWorkspace): Int32Array {
  const w = image.width + 1;
  if (ws.integral.length < w * (image.height + 1)) ws.integral = new Int32Array(w * (image.height + 1));
  const out = ws.integral;
  out.fill(0, 0, w);
  for (let y = 0; y < image.height; y++) {
    out[(y + 1) * w] = 0;
    let row = 0;
    for (let x = 0; x < image.width; x++) {
      row += image.data[y * image.stride + x]!;
      out[(y + 1) * w + x + 1] = out[y * w + x + 1]! + row;
    }
  }
  return out;
}

interface Candidate {
  x: number;
  y: number;
  score: number;
}

/** Corners of one level: adaptive FAST with 3×3 suppression on the FAST score, Harris ranking of each cell's best. */
function levelCorners(
  image: GrayImage,
  quota: number,
  options: Required<Omit<OrbOptions, 'roi' | 'budget' | 'levels' | 'wasm' | 'pattern'>>,
  roi: { x0: number; y0: number; x1: number; y1: number },
  fast: FastScorer,
): Candidate[] {
  const { width: w, height: h, stride, data: d } = image;
  const cell = options.cell;
  const picked: Candidate[] = [];
  const x0 = Math.max(BORDER, Math.floor(roi.x0));
  const y0 = Math.max(BORDER, Math.floor(roi.y0));
  const x1 = Math.min(w - BORDER, Math.ceil(roi.x1));
  const y1 = Math.min(h - BORDER, Math.ceil(roi.y1));
  if (x1 <= x0 || y1 <= y0) return picked;
  const scoreMap = fast.begin(image);
  const found: number[] = [];
  for (let cy = y0; cy < y1; cy += cell)
    for (let cx = x0; cx < x1; cx += cell) {
      const ey = Math.min(y1, cy + cell);
      const ex = Math.min(x1, cx + cell);
      found.length = 0;
      // A cell whose contrast cannot reach the lowest threshold has no corners.
      let min = 255;
      let max = 0;
      for (let y = cy; y < ey; y += 2)
        for (let x = cx; x < ex; x += 2) {
          const v = d[y * stride + x]!;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      if (max - min < 2 * options.minFastThreshold) continue;
      // The normal threshold, then one retry at the lowest for a sparse (dim, low-contrast) cell.
      for (let t = options.fastThreshold; ; t = options.minFastThreshold) {
        fast.score(cx, cy, ex, ey, t, found);
        if (found.length >= 2 || t === options.minFastThreshold) break;
        for (const i of found) scoreMap[i] = 0;
        found.length = 0;
      }
      // 3×3 non-maximum suppression on the FAST score (ties: earlier pixel wins), Harris for the eight strongest.
      const peaks: { i: number; s: number }[] = [];
      for (const i of found) {
        const s0 = scoreMap[i]!;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const o = scoreMap[i + dy * w + dx]!;
            if (o > s0 || (o === s0 && (dy < 0 || (dy === 0 && dx < 0)))) {
              peak = false;
              break;
            }
          }
        if (peak) peaks.push({ i, s: s0 });
      }
      for (const i of found) scoreMap[i] = 0;
      peaks.sort((a, b) => b.s - a.s || a.i - b.i);
      const ranked: Candidate[] = [];
      for (const p of peaks.slice(0, 8)) {
        const x = p.i % w;
        const y = (p.i - x) / w;
        const score = harris(d, stride, x, y);
        if (score > 0) ranked.push({ x, y, score });
      }
      ranked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
      picked.push(...ranked.slice(0, 2));
    }
  picked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return picked.slice(0, quota);
}

function orientation(image: GrayImage, x: number, y: number): number {
  const d = image.data;
  const s = image.stride;
  let m01 = 0;
  let m10 = 0;
  const c = y * s + x;
  for (let u = -PATCH; u <= PATCH; u++) m10 += u * d[c + u]!;
  for (let v = 1; v <= PATCH; v++) {
    let sum = 0;
    const umax = UMAX[v]!;
    for (let u = -umax; u <= umax; u++) {
      const top = d[c - v * s + u]!;
      const bottom = d[c + v * s + u]!;
      sum += bottom - top;
      m10 += u * (top + bottom);
    }
    m01 += v * sum;
  }
  return Math.atan2(m01, m10);
}

/** Steering bin of an orientation, radians. */
export function angleBin(angle: number): number {
  return ((Math.round((angle * ANGLE_BINS) / (2 * Math.PI)) % ANGLE_BINS) + ANGLE_BINS) % ANGLE_BINS;
}

/** Steered BRIEF from 5×5 box means of the integral image (`w` is the integral image's row length). */
function describe(
  ii: Int32Array,
  w: number,
  x: number,
  y: number,
  angle: number,
  pattern: readonly Int8Array[],
  out: Uint8Array,
  at: number,
): void {
  const p = pattern[angleBin(angle)]!;
  // Integral index of the box's top-left corner for offset (0, 0); a box at (dx, dy) adds dy·w + dx.
  const base = (y - 2) * w + (x - 2);
  const w5 = 5 * w;
  for (let byte = 0; byte < 32; byte++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++) {
      const i = 4 * (8 * byte + bit);
      const a = base + p[i + 1]! * w + p[i]!;
      const b = base + p[i + 3]! * w + p[i + 2]!;
      const sa = ii[a + w5 + 5]! - ii[a + 5]! - ii[a + w5]! + ii[a]!;
      const sb = ii[b + w5 + 5]! - ii[b + 5]! - ii[b + w5]! + ii[b]!;
      if (sa < sb) v |= 1 << bit;
    }
    out[at + byte] = v;
  }
}

/** Oriented multi-scale binary features of `image` (level-0 edge coordinates). */
export function extractOrb(image: GrayImage, options: OrbOptions = {}): Keypoints {
  const budget = options.budget ?? 700;
  const levels = halfOctavePyramid(image, options.levels ?? 6, WORKSPACE);
  const params = {
    fastThreshold: options.fastThreshold ?? 16,
    minFastThreshold: options.minFastThreshold ?? 4,
    cell: options.cell ?? 24,
  };
  const fast = fastScorer(options.wasm !== false);
  const pattern = steered(options.pattern ?? GAUSSIAN_PATTERN);
  const area = levels.reduce((s, l) => s + l.image.width * l.image.height, 0);
  const roi = options.roi ?? { x: 0, y: 0, width: image.width, height: image.height };
  const xs: number[] = [];
  const ys: number[] = [];
  const lv: number[] = [];
  const angles: number[] = [];
  const scores: number[] = [];
  const descriptors: Uint8Array[] = [];
  levels.forEach((level, index) => {
    const quota = Math.max(16, Math.round((budget * level.image.width * level.image.height) / area));
    const s = level.scale;
    const corners = levelCorners(
      level.image,
      quota,
      params,
      { x0: roi.x / s, y0: roi.y / s, x1: (roi.x + roi.width) / s, y1: (roi.y + roi.height) / s },
      fast,
    );
    if (!corners.length) return;
    const ii = integral(level.image, WORKSPACE);
    const desc = new Uint8Array(32 * corners.length);
    corners.forEach((c, k) => {
      const a = orientation(level.image, c.x, c.y);
      describe(ii, level.image.width + 1, c.x, c.y, a, pattern, desc, 32 * k);
      xs.push((c.x + 0.5) * s);
      ys.push((c.y + 0.5) * s);
      lv.push(index);
      angles.push(a);
      scores.push(c.score);
    });
    descriptors.push(desc);
  });
  const all = new Uint8Array(32 * xs.length);
  let o = 0;
  for (const d of descriptors) {
    all.set(d, o);
    o += d.length;
  }
  return {
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    level: Uint8Array.from(lv),
    angle: Float32Array.from(angles),
    score: Float32Array.from(scores),
    descriptors: all,
    descriptorBytes: 32,
  };
}
