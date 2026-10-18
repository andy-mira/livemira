/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Plane projection: row-major homographies, target corners TL/TR/BR/BL, CSS pixel viewport.

import type { Point2 } from '@livemira/contracts';

/** Projects a target point; throws RangeError at the projective horizon. */
export function project(h: readonly number[], x: number, y: number): Point2 {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10)
    throw new RangeError('Point at projective horizon');
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

export function multiply(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[c + 3]! + a[r * 3 + 2]! * b[c + 6]!;
  });
}

/** The homography mapping a target of this size onto the quadrilateral `corners`; throws RangeError when degenerate. */
export function homographyFromCorners(
  widthPx: number,
  heightPx: number,
  corners: readonly (readonly number[])[],
): number[] {
  if (!(widthPx > 0 && heightPx > 0) || !Number.isFinite(widthPx + heightPx))
    throw new RangeError('Invalid target size');
  if (corners.length !== 4 || corners.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
    throw new RangeError('Invalid corners');
  // Solve in normalized target coordinates to avoid target-size conditioning.
  const source = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ] as const;
  const rows = source.flatMap(([x, y], i) => {
    const [u, v] = corners[i] as [number, number];
    return [
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v],
    ];
  });
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(rows[r]![c]!) > Math.abs(rows[pivot]![c]!)) pivot = r;
    if (Math.abs(rows[pivot]![c]!) < 1e-10) throw new RangeError('Degenerate quadrilateral');
    [rows[c], rows[pivot]] = [rows[pivot]!, rows[c]!];
    const row = rows[c]!;
    const scale = row[c]!;
    for (let j = c; j <= 8; j++) row[j]! /= scale;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const other = rows[r]!;
      const factor = other[c]!;
      for (let j = c; j <= 8; j++) other[j]! -= factor * row[j]!;
    }
  }
  const n = rows.map((row) => row[8]!);
  const h = [
    n[0]! / widthPx,
    n[1]! / heightPx,
    n[2]!,
    n[3]! / widthPx,
    n[4]! / heightPx,
    n[5]!,
    n[6]! / widthPx,
    n[7]! / heightPx,
    1,
  ];
  validatePlane(h, widthPx, heightPx);
  return h;
}

/** Throws RangeError unless `h` is finite, non-singular and keeps the whole plane in front of the horizon. */
export function validatePlane(h: readonly number[], widthPx: number, heightPx: number): void {
  if (h.length !== 9 || !h.every(Number.isFinite)) throw new RangeError('Invalid homography');
  const [a, b, c, d, e, f, g, k, m] = h as [
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
  const determinant = a * (e * m - f * k) - b * (d * m - f * g) + c * (d * k - e * g);
  if (Math.abs(determinant) < 1e-12) throw new RangeError('Singular homography');
  const ws = [
    [0, 0],
    [widthPx, 0],
    [widthPx, heightPx],
    [0, heightPx],
  ].map(([x, y]) => g * x! + k * y! + m);
  if (
    ws.some((w) => !Number.isFinite(w) || Math.abs(w) < 1e-10 || Math.sign(w) !== Math.sign(ws[0]!))
  )
    throw new RangeError('Plane crosses projective horizon');
}

/** CSS matrix3d of a homography: column-major, keeping the projective w (no affine triangle seam). */
export function cssMatrix(h: readonly number[]): string {
  const k = h[8]!;
  if (!Number.isFinite(k) || Math.abs(k) < 1e-10) throw new RangeError('Invalid homogeneous scale');
  const a = h.map((v) => v / k);
  return `matrix3d(${[a[0], a[3], 0, a[6], a[1], a[4], 0, a[7], 0, 0, 1, 0, a[2], a[5], 0, 1].join(',')})`;
}

/** Where a video of this size sits inside the target plane for the fit. */
export function mediaRect(
  targetWidth: number,
  targetHeight: number,
  videoWidth: number,
  videoHeight: number,
  fit: 'contain' | 'cover' = 'contain',
): { x: number; y: number; width: number; height: number } {
  if (
    ![targetWidth, targetHeight, videoWidth, videoHeight].every((v) => Number.isFinite(v) && v > 0)
  )
    throw new RangeError('Invalid media dimensions');
  if (fit !== 'contain' && fit !== 'cover') throw new RangeError('Unknown fit');
  const scale = (fit === 'contain' ? Math.min : Math.max)(
    targetWidth / videoWidth,
    targetHeight / videoHeight,
  );
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}
