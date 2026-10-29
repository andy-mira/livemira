// SPDX-License-Identifier: Apache-2.0
// Sampling in pixel-edge coordinates: pixel (i, j) covers [i, i+1) × [j, j+1) and its centre is (i + 0.5, j + 0.5).

import type { GrayImage } from '@livemira-next/contracts';

/** Scharr gradients of a level, in gray levels per pixel (Float32), zero on the one-pixel border. */
export interface Gradients {
  readonly width: number;
  readonly height: number;
  readonly gx: Float32Array;
  readonly gy: Float32Array;
}

export function scharr(image: GrayImage, out?: Gradients): Gradients {
  const { width: w, height: h, stride, data: d } = image;
  const gx = out && out.gx.length === w * h ? out.gx : new Float32Array(w * h);
  const gy = out && out.gy.length === w * h ? out.gy : new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const a = (y - 1) * stride;
    const b = y * stride;
    const c = (y + 1) * stride;
    for (let x = 1; x < w - 1; x++) {
      gx[y * w + x] =
        (3 * (d[a + x + 1]! - d[a + x - 1]!) +
          10 * (d[b + x + 1]! - d[b + x - 1]!) +
          3 * (d[c + x + 1]! - d[c + x - 1]!)) /
        32;
      gy[y * w + x] =
        (3 * (d[c + x - 1]! - d[a + x - 1]!) + 10 * (d[c + x]! - d[a + x]!) + 3 * (d[c + x + 1]! - d[a + x + 1]!)) / 32;
    }
  }
  return { width: w, height: h, gx, gy };
}

/** Bilinear value at edge coordinates (x, y); NaN outside the area where all four neighbours exist. */
export function sample(image: GrayImage, x: number, y: number): number {
  const u = x - 0.5;
  const v = y - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  if (i < 0 || j < 0 || i + 1 >= image.width || j + 1 >= image.height) return NaN;
  const fx = u - i;
  const fy = v - j;
  const d = image.data;
  const o = j * image.stride + i;
  const top = d[o]! + fx * (d[o + 1]! - d[o]!);
  const bottom = d[o + image.stride]! + fx * (d[o + image.stride + 1]! - d[o + image.stride]!);
  return top + fy * (bottom - top);
}

/**
 * Bilinear value and bilinearly interpolated Scharr gradients at edge coordinates (x, y), from the 4×4 pixel block
 * around the point: identical to sampling `scharr(image)` there, without computing whole gradient images. Writes
 * [value, gx, gy] into `out`; the caller guarantees `inside(width, height, x, y, 1.5)`.
 */
export function sampleGradient(image: GrayImage, x: number, y: number, out: Float64Array): void {
  const u = x - 0.5;
  const v = y - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fx = u - i;
  const fy = v - j;
  const d = image.data;
  const s = image.stride;
  const r0 = (j - 1) * s + i - 1;
  const r1 = r0 + s;
  const r2 = r1 + s;
  const r3 = r2 + s;
  const a0 = d[r0]!,
    a1 = d[r0 + 1]!,
    a2 = d[r0 + 2]!,
    a3 = d[r0 + 3]!;
  const b0 = d[r1]!,
    b1 = d[r1 + 1]!,
    b2 = d[r1 + 2]!,
    b3 = d[r1 + 3]!;
  const c0 = d[r2]!,
    c1 = d[r2 + 1]!,
    c2 = d[r2 + 2]!,
    c3 = d[r2 + 3]!;
  const e0 = d[r3]!,
    e1 = d[r3 + 1]!,
    e2 = d[r3 + 2]!,
    e3 = d[r3 + 3]!;
  // Scharr at the four pixels (i, j), (i+1, j), (i, j+1), (i+1, j+1); rows a..e are j-1..j+2, columns 0..3 are i-1..i+2.
  const gx00 = 3 * (a2 - a0) + 10 * (b2 - b0) + 3 * (c2 - c0);
  const gx10 = 3 * (a3 - a1) + 10 * (b3 - b1) + 3 * (c3 - c1);
  const gx01 = 3 * (b2 - b0) + 10 * (c2 - c0) + 3 * (e2 - e0);
  const gx11 = 3 * (b3 - b1) + 10 * (c3 - c1) + 3 * (e3 - e1);
  const gy00 = 3 * (c0 - a0) + 10 * (c1 - a1) + 3 * (c2 - a2);
  const gy10 = 3 * (c1 - a1) + 10 * (c2 - a2) + 3 * (c3 - a3);
  const gy01 = 3 * (e0 - b0) + 10 * (e1 - b1) + 3 * (e2 - b2);
  const gy11 = 3 * (e1 - b1) + 10 * (e2 - b2) + 3 * (e3 - b3);
  const top = b1 + fx * (b2 - b1);
  const bottom = c1 + fx * (c2 - c1);
  out[0] = top + fy * (bottom - top);
  const gxt = gx00 + fx * (gx10 - gx00);
  const gxb = gx01 + fx * (gx11 - gx01);
  out[1] = (gxt + fy * (gxb - gxt)) / 32;
  const gyt = gy00 + fx * (gy10 - gy00);
  const gyb = gy01 + fx * (gy11 - gy01);
  out[2] = (gyt + fy * (gyb - gyt)) / 32;
}

/** Bilinear value of a float field (width × height, tight rows) at edge coordinates; caller guarantees bounds. */
export function sampleField(field: Float32Array, width: number, x: number, y: number): number {
  const u = x - 0.5;
  const v = y - 0.5;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fx = u - i;
  const fy = v - j;
  const o = j * width + i;
  const top = field[o]! + fx * (field[o + 1]! - field[o]!);
  const bottom = field[o + width]! + fx * (field[o + width + 1]! - field[o + width]!);
  return top + fy * (bottom - top);
}

/** True when bilinear sampling at edge coordinates (x, y) stays at least `margin` pixels inside the image. */
export function inside(width: number, height: number, x: number, y: number, margin = 1): boolean {
  return x >= 0.5 + margin && y >= 0.5 + margin && x < width - 0.5 - margin && y < height - 0.5 - margin;
}
