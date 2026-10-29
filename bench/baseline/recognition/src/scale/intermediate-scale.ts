/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateGray, type GrayImage } from '../image/gray-image.ts';

/** Half-octave scale of the retry after a global miss; the stored target descriptors are not changed. */
export const INTERMEDIATE_SCALE = Math.SQRT1_2;

/** Bilinear resampling of the frame to INTERMEDIATE_SCALE; null when the result would be smaller than 32 pixels. */
export function intermediateScaleImage(image: GrayImage): GrayImage | null {
  validateGray(image);
  const scale = INTERMEDIATE_SCALE;
  const widthPx = Math.floor(image.widthPx * scale);
  const heightPx = Math.floor(image.heightPx * scale);
  if (widthPx < 32 || heightPx < 32) return null;
  const source = image.data;
  const data = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const i = iy * image.widthPx + ix;
      data[y * widthPx + x] = Math.round(
        (1 - fy) * ((1 - fx) * source[i]! + fx * source[i + 1]!) +
          fy * ((1 - fx) * source[i + image.widthPx]! + fx * source[i + image.widthPx + 1]!),
      );
    }
  }
  return { widthPx, heightPx, data };
}
