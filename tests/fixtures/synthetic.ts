/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic synthetic pictures and camera frames for the regression snapshots: generated patterns, never
// photographs. Integer xorshift and explicit corner placements (no trigonometry) keep every byte identical on every
// platform.

export interface Gray8 {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly data: Uint8Array;
}

export type Mat3 = readonly [
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
export type Point = readonly [number, number];
/** Corners of a placed picture in frame pixels: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

export function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

/** A target picture: filled rectangles of random gray over a flat background. */
export function pattern(seed: number, widthPx: number, heightPx: number): Gray8 {
  const random = xorshift32(seed);
  const data = new Uint8Array(widthPx * heightPx).fill(80);
  const count = Math.round((widthPx * heightPx) / 85);
  for (let i = 0; i < count; i++) {
    const x = random() % widthPx;
    const y = random() % heightPx;
    const w = 3 + (random() % 20);
    const h = 3 + (random() % 20);
    const value = random() % 256;
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = value;
    }
  }
  return { widthPx, heightPx, data };
}

/** RGBA bytes with `strideBytes` per row (padding bytes are random too). */
export function rgba(
  seed: number,
  widthPx: number,
  heightPx: number,
  strideBytes: number,
): Uint8Array {
  const random = xorshift32(seed);
  return Uint8Array.from({ length: strideBytes * heightPx }, () => random() & 0xff);
}

/** Homography mapping the four `from` points onto the four `to` points (direct linear solve, h8 = 1). */
export function homographyFromPoints(from: readonly Point[], to: readonly Point[]): Mat3 {
  const rows: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!;
    const [u, v] = to[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-12) throw new Error('degenerate placement');
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const scale = rows[column]![column]!;
    for (let k = column; k < 9; k++) rows[column]![k]! /= scale;
    for (let row = 0; row < 8; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      for (let k = column; k < 9; k++) rows[row]![k]! -= factor * rows[column]![k]!;
    }
  }
  const h = rows.map((row) => row[8]!);
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
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
  return cof.map((value) => value / det) as unknown as Mat3;
}

/** The frame-from-picture homography that puts the picture's pixel edges on `quad`. */
export function place(picture: Gray8, quad: Quad): Mat3 {
  const { widthPx: w, heightPx: h } = picture;
  return homographyFromPoints(
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
    quad,
  );
}

function bilinear(image: Gray8, x: number, y: number): number | null {
  // Pixel centres: picture pixel (i, j) covers [i, i+1) × [j, j+1).
  const sx = x - 0.5;
  const sy = y - 0.5;
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  if (ix < 0 || iy < 0 || ix + 1 >= image.widthPx || iy + 1 >= image.heightPx) return null;
  const fx = sx - ix;
  const fy = sy - iy;
  const p = iy * image.widthPx + ix;
  const d = image.data;
  return (
    (1 - fy) * ((1 - fx) * d[p]! + fx * d[p + 1]!) +
    fy * ((1 - fx) * d[p + image.widthPx]! + fx * d[p + image.widthPx + 1]!)
  );
}

export interface FrameSpec {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly seed: number;
  readonly pictures: readonly { readonly picture: Gray8; readonly quad: Quad }[];
  /** Uniform noise amplitude in gray levels (0 = none). */
  readonly noise?: number;
}

/** A camera frame: a seeded cluttered background with the pictures warped onto their quads, then noise. */
export function renderFrame(spec: FrameSpec): Gray8 {
  const { widthPx, heightPx } = spec;
  const random = xorshift32(spec.seed);
  const data = new Uint8Array(widthPx * heightPx).fill(96);
  for (let i = 0, count = Math.round((widthPx * heightPx) / 900); i < count; i++) {
    const x = random() % widthPx;
    const y = random() % heightPx;
    const w = 2 + (random() % 14);
    const h = 2 + (random() % 14);
    const value = 64 + (random() % 64);
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = value;
    }
  }
  for (const { picture, quad } of spec.pictures) {
    const m = invert(place(picture, quad));
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const px = x + 0.5;
        const py = y + 0.5;
        const w = m[6] * px + m[7] * py + m[8];
        const value = bilinear(
          picture,
          (m[0] * px + m[1] * py + m[2]) / w,
          (m[3] * px + m[4] * py + m[5]) / w,
        );
        if (value !== null) data[y * widthPx + x] = Math.round(value);
      }
    }
  }
  const noise = spec.noise ?? 0;
  if (noise > 0) {
    for (let i = 0; i < data.length; i++) {
      const offset = (random() % (2 * noise + 1)) - noise;
      data[i] = Math.min(255, Math.max(0, data[i]! + offset));
    }
  }
  return { widthPx, heightPx, data };
}
