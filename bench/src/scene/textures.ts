// SPDX-License-Identifier: Apache-2.0
// Procedural target pictures and the table texture they lie on, with float mip pyramids for anti-aliased sampling.
// Generated, not photographs: each kind stresses a different property (photo-like gradients, dense graphics, text,
// weak texture, repetition).

import { uniform, xorshift32 } from '../rng.ts';

export interface Texture {
  readonly width: number;
  readonly height: number;
  /** Gray values 0..255. */
  readonly data: Float32Array;
}

export interface MipTexture {
  readonly levels: readonly Texture[];
}

export type TargetKind = 'photo' | 'poster' | 'graphic' | 'lowtex' | 'repetitive';

function blank(width: number, height: number, value: number): Texture {
  return { width, height, data: new Float32Array(width * height).fill(value) };
}

function valueNoise(t: Texture, seed: number, octaves: readonly (readonly [number, number])[]): void {
  const random = uniform(seed);
  for (const [cell, amp] of octaves) {
    const gw = Math.ceil(t.width / cell) + 2;
    const gh = Math.ceil(t.height / cell) + 2;
    const g = Float32Array.from({ length: gw * gh }, () => random() - 0.5);
    for (let y = 0; y < t.height; y++) {
      const fy = y / cell;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < t.width; x++) {
        const fx = x / cell;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const a = g[iy * gw + ix]! * (1 - sx) + g[iy * gw + ix + 1]! * sx;
        const b = g[(iy + 1) * gw + ix]! * (1 - sx) + g[(iy + 1) * gw + ix + 1]! * sx;
        t.data[y * t.width + x]! += amp * (a * (1 - sy) + b * sy);
      }
    }
  }
}

function stretch(t: Texture, lo: number, hi: number): void {
  let min = Infinity;
  let max = -Infinity;
  for (const v of t.data) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const k = (hi - lo) / Math.max(1e-6, max - min);
  for (let i = 0; i < t.data.length; i++) t.data[i] = lo + (t.data[i]! - min) * k;
}

function fillRect(t: Texture, x0: number, y0: number, w: number, h: number, value: number): void {
  for (let y = Math.max(0, y0); y < Math.min(t.height, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(t.width, x0 + w); x++) t.data[y * t.width + x] = value;
}

function fillDisk(t: Texture, cx: number, cy: number, r: number, value: number, ring = 0): void {
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(t.height, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(t.width, Math.ceil(cx + r)); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r && (!ring || d >= r - ring)) t.data[y * t.width + x] = value;
    }
}

/** Lines of glyph-like strokes: short bars and blocks of varying width, like small text. */
function textBlock(
  t: Texture,
  seed: number,
  x0: number,
  y0: number,
  w: number,
  lines: number,
  size: number,
  ink: number,
): void {
  const random = xorshift32(seed);
  for (let line = 0; line < lines; line++) {
    let x = x0;
    const y = y0 + line * Math.round(size * 1.6);
    while (x < x0 + w - size) {
      const glyph = 1 + (random() % Math.max(2, Math.round(size * 0.8)));
      if (random() % 7 === 0) x += size; // word gap
      const strokes = 1 + (random() % 3);
      for (let s = 0; s < strokes; s++) {
        const sx = x + (random() % Math.max(1, glyph));
        const sh = Math.round(size * (0.5 + (random() % 50) / 100));
        fillRect(t, sx, y + size - sh, Math.max(1, Math.round(size / 6)), sh, ink);
      }
      if (random() % 3 === 0) fillRect(t, x, y + Math.round(size / 2), glyph, Math.max(1, Math.round(size / 7)), ink);
      x += glyph + Math.max(1, Math.round(size / 4));
    }
  }
}

/** A target picture of the given kind, gray 0..255. */
export function targetPicture(kind: TargetKind, seed: number, width = 640, height = 480): Texture {
  const t = blank(width, height, 0);
  const random = xorshift32(seed);
  switch (kind) {
    case 'photo': {
      valueNoise(t, seed, [
        [96, 80],
        [48, 55],
        [24, 35],
        [12, 22],
        [6, 12],
        [3, 6],
      ]);
      stretch(t, 15, 240);
      // Objects with hard silhouettes over the soft gradients, blended like shapes in a natural photograph.
      for (let i = 0; i < 24; i++) {
        const shape = blank(width, height, -1);
        const v = 20 + (random() % 215);
        if (random() % 2) fillDisk(shape, random() % width, random() % height, 10 + (random() % 45), v);
        else fillRect(shape, random() % width, random() % height, 12 + (random() % 80), 12 + (random() % 60), v);
        for (let k = 0; k < t.data.length; k++)
          if (shape.data[k]! >= 0) t.data[k] = 0.45 * t.data[k]! + 0.55 * shape.data[k]!;
      }
      break;
    }
    case 'poster': {
      valueNoise(t, seed, [
        [160, 60],
        [80, 30],
      ]);
      stretch(t, 120, 220);
      for (let i = 0; i < 14; i++) {
        const v = 20 + (random() % 220);
        if (random() % 2)
          fillDisk(t, random() % width, random() % height, 12 + (random() % 60), v, random() % 3 ? 0 : 6);
        else fillRect(t, random() % width, random() % height, 20 + (random() % 140), 14 + (random() % 90), v);
      }
      for (let b = 0; b < 4; b++)
        textBlock(
          t,
          seed + b,
          20 + (random() % (width / 2)),
          20 + (random() % (height - 120)),
          width / 2 - 20,
          3 + (random() % 3),
          10 + (random() % 10),
          random() % 2 ? 25 : 235,
        );
      break;
    }
    case 'graphic': {
      t.data.fill(80);
      const count = Math.round((width * height) / 128);
      for (let i = 0; i < count; i++)
        fillRect(t, random() % width, random() % height, 3 + (random() % 20), 3 + (random() % 20), random() % 256);
      break;
    }
    case 'lowtex': {
      valueNoise(t, seed, [
        [256, 70],
        [128, 30],
      ]);
      stretch(t, 70, 190);
      for (let i = 0; i < 5; i++)
        fillDisk(t, random() % width, random() % height, 20 + (random() % 50), 40 + (random() % 180));
      textBlock(t, seed, width / 4, height / 2, width / 2, 2, 22, 30);
      break;
    }
    case 'repetitive': {
      const tile = 48;
      const cell = blank(tile, tile, 90);
      for (let i = 0; i < 12; i++)
        fillRect(cell, random() % tile, random() % tile, 3 + (random() % 12), 3 + (random() % 12), random() % 256);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) t.data[y * width + x] = cell.data[(y % tile) * tile + (x % tile)]!;
      break;
    }
  }
  return t;
}

/** Cluttered table: wood-like grain, scattered objects and paper with print. Large and non-repeating. */
export function tableTexture(seed: number, size = 1024): Texture {
  const t = blank(size, size, 0);
  valueNoise(t, seed, [
    [128, 40],
    [32, 18],
    [8, 10],
    [2, 5],
  ]);
  stretch(t, 70, 150);
  const random = xorshift32(seed ^ 0x5bd1e995);
  for (let i = 0; i < 70; i++) {
    const v = 30 + (random() % 200);
    const x = random() % size;
    const y = random() % size;
    if (random() % 3 === 0) fillDisk(t, x, y, 8 + (random() % 40), v);
    else fillRect(t, x, y, 10 + (random() % 90), 10 + (random() % 70), v);
  }
  for (let i = 0; i < 10; i++) {
    const x = random() % (size - 220);
    const y = random() % (size - 160);
    fillRect(t, x, y, 200, 140, 210 + (random() % 30));
    textBlock(t, seed + 100 + i, x + 10, y + 10, 180, 5, 9 + (random() % 6), 40);
  }
  return t;
}

/** Box-filtered mip chain down to 8 px. */
export function mipmap(base: Texture): MipTexture {
  const levels: Texture[] = [base];
  while (Math.min(levels.at(-1)!.width, levels.at(-1)!.height) >= 16) {
    const p = levels.at(-1)!;
    const w = p.width >> 1;
    const h = p.height >> 1;
    const data = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = 2 * y * p.width + 2 * x;
        data[y * w + x] = (p.data[i]! + p.data[i + 1]! + p.data[i + p.width]! + p.data[i + p.width + 1]!) / 4;
      }
    levels.push({ width: w, height: h, data });
  }
  return { levels };
}

/** Bilinear sample at pixel-edge coordinates (u, v) of a level; clamps to the border. */
export function sampleLevel(t: Texture, u: number, v: number): number {
  const x = Math.min(t.width - 1, Math.max(0, u - 0.5));
  const y = Math.min(t.height - 1, Math.max(0, v - 0.5));
  const ix = Math.min(t.width - 2, Math.floor(x));
  const iy = Math.min(t.height - 2, Math.floor(y));
  const fx = x - ix;
  const fy = y - iy;
  const i = iy * t.width + ix;
  const d = t.data;
  return (1 - fy) * ((1 - fx) * d[i]! + fx * d[i + 1]!) + fy * ((1 - fx) * d[i + t.width]! + fx * d[i + t.width + 1]!);
}

/** Trilinear sample: `footprint` is texels per output pixel at level 0. */
export function sampleMip(m: MipTexture, u: number, v: number, footprint: number): number {
  const lod = Math.max(0, Math.min(m.levels.length - 1, Math.log2(Math.max(1, footprint))));
  const l0 = Math.floor(lod);
  const f = lod - l0;
  const a = sampleLevel(m.levels[l0]!, u / 2 ** l0, v / 2 ** l0);
  if (f < 1e-3 || l0 + 1 >= m.levels.length) return a;
  const b = sampleLevel(m.levels[l0 + 1]!, u / 2 ** (l0 + 1), v / 2 ** (l0 + 1));
  return a * (1 - f) + b * f;
}

/** Gray8 copy of a texture (rounded, clamped). */
export function toGray8(t: Texture): Uint8Array {
  return Uint8Array.from(t.data, (v) => Math.max(0, Math.min(255, Math.round(v))));
}
