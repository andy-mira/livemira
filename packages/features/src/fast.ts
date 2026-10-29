// SPDX-License-Identifier: Apache-2.0
// FAST-9 corner scoring of image rectangles: the JavaScript reference and the WASM SIMD kernel (kernels/vision
// `fast9`, 16 pixels per step), which must give identical integer scores; a self-test decides whether the kernel is
// used. The score map holds non-zero values only at the corners of the latest `score` calls: callers zero those
// entries again before the next rectangle.

import type { GrayImage } from '@livemira-next/contracts';

import { instantiateKernels, type KernelExports } from './kernels.ts';

const CIRCLE: readonly (readonly [number, number])[] = [
  [0, -3],
  [1, -3],
  [2, -2],
  [3, -1],
  [3, 0],
  [3, 1],
  [2, 2],
  [1, 3],
  [0, 3],
  [-1, 3],
  [-2, 2],
  [-3, 1],
  [-3, 0],
  [-3, -1],
  [-2, -2],
  [-1, -3],
];

/** FAST-9 test at pixel offset `o`; returns a corner score (1 + the arc side's summed excess beyond t) or 0. */
export function fastScore(d: Uint8Array, o: number, offsets: Int32Array, t: number): number {
  const c = d[o]!;
  const hi = c + t;
  const lo = c - t;
  // Any 9 contiguous circle pixels include pixel 0 or 8, and pixel 4 or 12.
  const p0 = d[o + offsets[0]!]!;
  const p8 = d[o + offsets[8]!]!;
  if (p0 <= hi && p0 >= lo && p8 <= hi && p8 >= lo) return 0;
  const p4 = d[o + offsets[4]!]!;
  const p12 = d[o + offsets[12]!]!;
  if (p4 <= hi && p4 >= lo && p12 <= hi && p12 >= lo) return 0;
  let bright = 0;
  let dark = 0;
  let sb = 0;
  let sd = 0;
  for (let i = 0; i < 16; i++) {
    const p = d[o + offsets[i]!]!;
    if (p > hi) {
      bright |= 1 << i;
      sb += p - hi;
    } else if (p < lo) {
      dark |= 1 << i;
      sd += lo - p;
    }
  }
  if (arc9(bright)) return sb + 1;
  if (arc9(dark)) return sd + 1;
  return 0;
}

/** True when the 16-bit circle mask has 9 contiguous set bits (cyclically). */
function arc9(mask: number): boolean {
  if (!mask) return false;
  const m = (mask | (mask << 16)) >>> 0;
  let acc = m;
  for (let s = 1; s < 9; s++) acc &= m >>> s;
  return acc !== 0;
}

/** Scores rectangles of one image at a time. */
export interface FastScorer {
  readonly backend: 'wasm-simd' | 'js';
  /**
   * Makes `image` current and returns its score map (row length `image.width`, all zero). The image needs a
   * border of 3 pixels around scored pixels, plus 15 columns to the right of them for the kernel.
   */
  begin(image: GrayImage): Uint16Array;
  /** Scores x0 ≤ x < x1, y0 ≤ y < y1 with threshold t; appends corner indices y·width + x in raster order. */
  score(x0: number, y0: number, x1: number, y1: number, t: number, found: number[]): void;
}

class JsFastScorer implements FastScorer {
  readonly backend = 'js';
  private map = new Uint16Array(0);
  private image: GrayImage | null = null;
  private offsets = new Int32Array(16);

  begin(image: GrayImage): Uint16Array {
    if (this.map.length < image.width * image.height) this.map = new Uint16Array(image.width * image.height);
    this.image = image;
    this.offsets = Int32Array.from(CIRCLE.map(([dx, dy]) => dy * image.stride + dx));
    return this.map;
  }

  score(x0: number, y0: number, x1: number, y1: number, t: number, found: number[]): void {
    const { width: w, stride, data: d } = this.image!;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = fastScore(d, y * stride + x, this.offsets, t);
        if (s > 0) {
          this.map[y * w + x] = s;
          found.push(y * w + x);
        }
      }
  }
}

class WasmFastScorer implements FastScorer {
  readonly backend = 'wasm-simd';
  private readonly k: KernelExports;
  private capacity = 0;
  private img = 0;
  private scores = 0;
  private found = 0;
  private map = new Uint16Array(0);
  private image: GrayImage | null = null;

  constructor(kernel: KernelExports) {
    this.k = kernel;
  }

  begin(image: GrayImage): Uint16Array {
    const bytes = image.stride * image.height;
    if (bytes > this.capacity) {
      const k = this.k;
      k.reset_heap();
      // Image plus 16 bytes of read slack, the u16 score map, and corner indices (at most one per pixel).
      this.img = k.reserve(bytes + 16);
      this.scores = k.reserve(2 * bytes);
      this.found = k.reserve(4 * bytes);
      if (!this.img || !this.scores || !this.found) throw new Error('fast9: out of memory');
      this.capacity = bytes;
      new Uint16Array(k.memory.buffer, this.scores, bytes).fill(0);
    }
    new Uint8Array(this.k.memory.buffer, this.img, bytes).set(image.data.subarray(0, bytes));
    this.map = new Uint16Array(this.k.memory.buffer, this.scores, image.width * image.height);
    this.image = image;
    return this.map;
  }

  score(x0: number, y0: number, x1: number, y1: number, t: number, found: number[]): void {
    const image = this.image!;
    const n = this.k.fast9(this.img, image.stride, x0, y0, x1, y1, t, this.scores, image.width, this.found);
    const indices = new Uint32Array(this.k.memory.buffer, this.found, n);
    for (let i = 0; i < n; i++) found.push(indices[i]!);
  }
}

/** Kernel and reference on a seeded random image with flat, noisy and edge regions: identical scores and order. */
function selfTest(kernel: FastScorer): boolean {
  const width = 61;
  const height = 47;
  const data = new Uint8Array(width * height);
  let s = 0x9e3779b9;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      const noise = (s >>> 0) % 64;
      data[y * width + x] = x < 20 ? 128 : x < 40 ? (((x >> 2) + (y >> 2)) % 2 ? 230 - noise : 20 + noise) : noise * 4;
    }
  const image = { width, height, stride: width, data };
  const reference = new JsFastScorer();
  for (const t of [4, 16, 40]) {
    const a: number[] = [];
    const b: number[] = [];
    const ma = reference.begin(image);
    const mb = kernel.begin(image);
    reference.score(3, 3, width - 18, height - 3, t, a);
    kernel.score(3, 3, width - 18, height - 3, t, b);
    if (a.length !== b.length || a.some((v, i) => v !== b[i] || ma[v] !== mb[v])) return false;
    for (const i of a) ma[i] = 0;
    for (const i of b) mb[i] = 0;
    if (t === 16 && a.length < 10) return false;
  }
  return true;
}

let shared: { wasm: FastScorer | null; js: FastScorer } | null = null;

/** The module's scorer: the self-tested WASM SIMD kernel unless `allowWasm` is false or it is unavailable. */
export function fastScorer(allowWasm = true): FastScorer {
  if (!shared) {
    const kernel = instantiateKernels();
    let wasm: FastScorer | null = null;
    try {
      wasm = kernel ? new WasmFastScorer(kernel) : null;
      if (wasm && !selfTest(wasm)) wasm = null;
    } catch {
      wasm = null;
    }
    shared = { wasm, js: new JsFastScorer() };
  }
  return (allowWasm && shared.wasm) || shared.js;
}
