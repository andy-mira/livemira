/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

/** Gray8 image with tight rows. */
export interface GrayImage {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly data: Uint8Array;
}

/** Work bounds of CPU recognition. */
export const RECOGNITION_LIMITS = Object.freeze({
  /** Most pixels of one image. */
  pixels: 4_194_304,
  /** Longest image edge. */
  dimension: 4096,
  /** Most features per image (target or frame). */
  features: 512,
  /** Most pyramid levels. */
  levels: 4,
  /** Most loaded targets. */
  targets: 10,
});

/** Throws `INVALID_CONFIG` unless the image is gray8 of 32..4096 pixels per edge and at most 4,194,304 pixels. */
export function validateGray(image: GrayImage): void {
  const { widthPx, heightPx, data } = image ?? ({} as Partial<GrayImage>);
  if (
    !Number.isInteger(widthPx) ||
    !Number.isInteger(heightPx) ||
    widthPx! < 32 ||
    heightPx! < 32 ||
    widthPx! > RECOGNITION_LIMITS.dimension ||
    heightPx! > RECOGNITION_LIMITS.dimension ||
    widthPx! * heightPx! > RECOGNITION_LIMITS.pixels ||
    !(data instanceof Uint8Array) ||
    data.length !== widthPx! * heightPx!
  ) {
    throw new EngineError('INVALID_CONFIG', 'INVALID_GRAY8', { isRecoverable: false });
  }
}
