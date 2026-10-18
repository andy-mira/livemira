/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic synthetic gray8 images. Generated, not photographs; no files are read.

import type { GrayImage } from '@livemira/recognition';

/** Random filled rectangles over a flat background (integer xorshift). */
export function texture(seed = 1234, widthPx = 320, heightPx = 240): GrayImage {
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const data = new Uint8Array(widthPx * heightPx).fill(80);
  for (let i = 0; i < 900; i++) {
    const x = random() % widthPx;
    const y = random() % heightPx;
    const w = 3 + (random() % 20);
    const h = 3 + (random() % 20);
    const color = random() % 256;
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = color;
    }
  }
  return { widthPx, heightPx, data };
}

/** Floating xorshift in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Random filled rectangles; denser than `texture`. */
export function rects(seed: number, widthPx = 512, heightPx = 384, count = 900): GrayImage {
  const random = rng(seed);
  const data = new Uint8Array(widthPx * heightPx).fill(80);
  for (let i = 0; i < count; i++) {
    const x = Math.floor(random() * widthPx);
    const y = Math.floor(random() * heightPx);
    const w = 3 + Math.floor(random() * 20);
    const h = 3 + Math.floor(random() * 20);
    const c = Math.floor(random() * 255);
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = c;
    }
  }
  return { widthPx, heightPx, data };
}

/** One random tile repeated over the whole image: textured everywhere, but every patch has identical twins. */
export function tiled(seed: number, tile = 32, widthPx = 512, heightPx = 384): GrayImage {
  const t = rects(seed, tile, tile, 40).data;
  const data = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++)
    for (let x = 0; x < widthPx; x++) data[y * widthPx + x] = t[(y % tile) * tile + (x % tile)]!;
  return { widthPx, heightPx, data };
}

/** Multi-octave value noise stretched to 0..255: smooth, photograph-like gradients with texture at several scales. */
export function natural(seed: number, widthPx = 512, heightPx = 384): GrayImage {
  const random = rng(seed);
  const acc = new Float64Array(widthPx * heightPx);
  for (const [cell, amp] of [
    [64, 70],
    [32, 50],
    [16, 35],
    [8, 25],
  ] as const) {
    const gw = Math.ceil(widthPx / cell) + 2;
    const gh = Math.ceil(heightPx / cell) + 2;
    const g = Array.from({ length: gw * gh }, () => random());
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const fx = x / cell;
        const fy = y / cell;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = fx - ix;
        const ty = fy - iy;
        acc[y * widthPx + x]! +=
          amp *
          ((g[iy * gw + ix]! * (1 - tx) + g[iy * gw + ix + 1]! * tx) * (1 - ty) +
            (g[(iy + 1) * gw + ix]! * (1 - tx) + g[(iy + 1) * gw + ix + 1]! * tx) * ty);
      }
    }
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of acc) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return {
    widthPx,
    heightPx,
    data: Uint8Array.from(acc, (v) => Math.round((255 * (v - lo)) / (hi - lo))),
  };
}

function invert(h: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, i, j] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const cof = [
    e * j - f * i,
    c * i - b * j,
    b * f - c * e,
    f * g - d * j,
    a * j - c * g,
    c * d - a * f,
    d * i - e * g,
    b * g - a * i,
    a * e - b * d,
  ];
  const det = a * cof[0]! + b * cof[3]! + c * cof[6]!;
  return cof.map((v) => v / det);
}

/** Renders `image` through homography `h` (image from target) with bilinear sampling on a dark background. */
export function warp(
  image: GrayImage,
  h: readonly number[],
  widthPx = image.widthPx,
  heightPx = image.heightPx,
): GrayImage {
  const data = new Uint8Array(widthPx * heightPx).fill(30);
  const inv = invert(h);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const z = inv[6]! * x + inv[7]! * y + inv[8]!;
      const sx = (inv[0]! * x + inv[1]! * y + inv[2]!) / z;
      const sy = (inv[3]! * x + inv[4]! * y + inv[5]!) / z;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix >= 0 && iy >= 0 && ix + 1 < image.widthPx && iy + 1 < image.heightPx) {
        const fx = sx - ix;
        const fy = sy - iy;
        const p = iy * image.widthPx + ix;
        const d = image.data;
        data[y * widthPx + x] = Math.round(
          (1 - fy) * ((1 - fx) * d[p]! + fx * d[p + 1]!) +
            fy * ((1 - fx) * d[p + image.widthPx]! + fx * d[p + image.widthPx + 1]!),
        );
      }
    }
  }
  return { widthPx, heightPx, data };
}

/** Centred similarity placing `target` at `scale` of the frame, shifted by `dx`. */
export function similarity(
  target: GrayImage,
  widthPx: number,
  heightPx: number,
  scale: number,
  dx = 0,
): number[] {
  const s = scale * Math.min(widthPx / target.widthPx, heightPx / target.heightPx);
  return [
    s,
    0,
    widthPx / 2 - (s * target.widthPx) / 2 + dx,
    0,
    s,
    heightPx / 2 - (s * target.heightPx) / 2,
    0,
    0,
    1,
  ];
}
