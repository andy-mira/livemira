/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from './errors.ts';

/**
 * 3×3 matrix, row-major, acting on column vectors: p' = H · p with p = (x, y, 1)ᵀ.
 * Named H_<to>From<from>, e.g. H_imageFromTarget maps target pixels to standard-image pixels.
 */
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

export type Point2 = readonly [number, number];

/** Four corners in the order top-left, top-right, bottom-right, bottom-left. */
export type Corners = readonly [Point2, Point2, Point2, Point2];

export const IDENTITY_3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Scales a homography so its last element is 1 (or, when that element is near zero, by its largest magnitude).
 * Throws `INVALID_TARGET` for non-finite, zero or singular input.
 */
export function normalizeHomography(h: readonly number[]): Mat3 {
  if (h.length !== 9 || !h.every(Number.isFinite)) {
    throw new EngineError('INVALID_TARGET', 'Homography requires nine finite elements', {
      isRecoverable: false,
    });
  }
  const scale = Math.abs(h[8]!) > 1e-12 ? h[8]! : Math.max(...h.map(Math.abs));
  if (!scale) throw new EngineError('INVALID_TARGET', 'Zero homography', { isRecoverable: false });
  const m = h.map((x) => x / scale);
  const det =
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
  if (Math.abs(det) < 1e-12)
    throw new EngineError('INVALID_TARGET', 'Singular homography', { isRecoverable: false });
  return m as unknown as Mat3;
}
