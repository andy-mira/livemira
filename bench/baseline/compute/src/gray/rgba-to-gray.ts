/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

/** Largest image the CPU kernels accept: 4096 × 4096 pixels. */
export const MAX_GRAY_PIXELS = 4096 * 4096;

/** Gray8 pixels with tight rows. */
export interface GrayPixels {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly data: Uint8Array;
}

function checkLayout(
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
  strideBytes: number,
  channels: number,
): void {
  if (
    !(data instanceof Uint8Array) ||
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1 ||
    widthPx * heightPx > MAX_GRAY_PIXELS ||
    !Number.isSafeInteger(strideBytes) ||
    strideBytes < widthPx * channels ||
    (heightPx - 1) * strideBytes + widthPx * channels > data.length
  ) {
    throw new EngineError('FRAME_FAILED', 'Invalid or oversized image layout', {
      isRecoverable: false,
    });
  }
}

/**
 * Converts encoded (non-linear) RGBA to gray8 with the integer luma approximation (77 R + 150 G + 29 B + 128) >> 8.
 * Alpha is ignored; no linearization or premultiplication. The layout is checked before anything is allocated.
 */
export function rgbaToGray(
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
  strideBytes: number = widthPx * 4,
): GrayPixels {
  checkLayout(data, widthPx, heightPx, strideBytes, 4);
  const output = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const i = y * strideBytes + x * 4;
      output[y * widthPx + x] =
        (77 * data[i]! + 150 * data[i + 1]! + 29 * data[i + 2]! + 128) >>> 8;
    }
  }
  return { data: output, widthPx, heightPx };
}
