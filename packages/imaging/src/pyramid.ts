// SPDX-License-Identifier: Apache-2.0
// Gaussian pyramid: each level is the previous one blurred with the separable binomial [1 3 3 1]/8 and
// decimated by 2. Integer arithmetic with one rounding per level, so results are identical on every engine.
// A level-l pixel (i, j) covers level-0 pixel edges [2^l·i, 2^l·(i+1)) — coordinates scale by exactly 2^l.

import type { GrayImage, ImagePyramid, PyramidLevel } from '@livemira-next/contracts';

/** Reusable buffers for repeated pyramid builds of one frame size. */
export class PyramidWorkspace {
  private rows = new Int32Array(0);
  private readonly levels: Uint8Array[] = [];

  /** Builds up to `levels` levels (stopping before a side drops below `minSize`); level 0 is the input itself. */
  build(image: GrayImage, levels: number, minSize = 24): ImagePyramid {
    const out: PyramidLevel[] = [{ ...image, scale: 1 }];
    for (let l = 1; l < levels; l++) {
      const prev = out[l - 1]!;
      const w = prev.width >> 1;
      const h = prev.height >> 1;
      if (w < minSize || h < minSize) break;
      if (this.rows.length < prev.width * h) this.rows = new Int32Array(prev.width * h);
      const buf = (this.levels[l] =
        this.levels[l] && this.levels[l]!.length === w * h ? this.levels[l]! : new Uint8Array(w * h));
      downsample(prev, w, h, this.rows, buf);
      out.push({ width: w, height: h, stride: w, data: buf, scale: prev.scale * 2 });
    }
    return { levels: out };
  }
}

function downsample(src: GrayImage, w: number, h: number, rows: Int32Array, dst: Uint8Array): void {
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const stride = src.stride;
  // Even binomial [1 3 3 1] centred between source pixels 2y and 2y+1, so a level-l pixel's centre is exactly the
  // centre of the 2×2 block it replaces and edge coordinates scale by exactly 2 per level.
  for (let y = 0; y < h; y++) {
    const c = 2 * y;
    const r0 = Math.max(0, c - 1) * stride;
    const r1 = c * stride;
    const r2 = Math.min(sh - 1, c + 1) * stride;
    const r3 = Math.min(sh - 1, c + 2) * stride;
    const o = y * sw;
    for (let x = 0; x < sw; x++) rows[o + x] = s[r0 + x]! + 3 * s[r1 + x]! + 3 * s[r2 + x]! + s[r3 + x]!;
  }
  // Horizontal pass at the decimated columns, then one rounding (weights sum to 64).
  for (let y = 0; y < h; y++) {
    const o = y * sw;
    for (let x = 0; x < w; x++) {
      const c = 2 * x;
      const a = rows[o + Math.max(0, c - 1)]!;
      const b = rows[o + c]!;
      const d = rows[o + Math.min(sw - 1, c + 1)]!;
      const e = rows[o + Math.min(sw - 1, c + 2)]!;
      dst[y * w + x] = (a + 3 * b + 3 * d + e + 32) >> 6;
    }
  }
}

/** One-off pyramid (allocates); prefer a PyramidWorkspace per stream. */
export function buildPyramid(image: GrayImage, levels: number, minSize = 24): ImagePyramid {
  return new PyramidWorkspace().build(image, levels, minSize);
}
