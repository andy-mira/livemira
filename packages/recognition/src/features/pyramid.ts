/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

import { RECOGNITION_LIMITS, validateGray, type GrayImage } from '../image/gray-image.ts';

/** One pyramid level; `scale` maps its pixels back to the base image (1, 2, 4, …). */
export interface PyramidLevel extends GrayImage {
  readonly scale: number;
}

/**
 * Box-2 pyramid: each level halves the previous one (floor) by averaging 2×2 blocks with rounding; it stops early
 * when a level would be shorter than 32 pixels.
 */
export function buildPyramid(image: GrayImage, levels = 3): PyramidLevel[] {
  validateGray(image);
  if (!Number.isInteger(levels) || levels < 1 || levels > RECOGNITION_LIMITS.levels) {
    throw new EngineError('INVALID_CONFIG', 'INVALID_LEVELS', { isRecoverable: false });
  }
  const result: PyramidLevel[] = [{ ...image, scale: 1 }];
  while (result.length < levels) {
    const prev = result.at(-1)!;
    const widthPx = Math.floor(prev.widthPx / 2);
    const heightPx = Math.floor(prev.heightPx / 2);
    if (Math.min(widthPx, heightPx) < 32) break;
    const data = new Uint8Array(widthPx * heightPx);
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const i = 2 * y * prev.widthPx + 2 * x;
        data[y * widthPx + x] = Math.round(
          (prev.data[i]! +
            prev.data[i + 1]! +
            prev.data[i + prev.widthPx]! +
            prev.data[i + prev.widthPx + 1]!) /
            4,
        );
      }
    }
    result.push({ widthPx, heightPx, data, scale: prev.scale * 2 });
  }
  return result;
}

/**
 * 3×3 box smoothing of the interior (the one-pixel border is copied). Row sums are exact integers (at most 765, and
 * 2295 for the 3×3 sum), so the single final Math.round(sum / 9) equals smoothing the nine pixels directly. The
 * scratch is three rows per call.
 */
export function smoothBox3(level: GrayImage): Uint8Array {
  const { widthPx: w, heightPx: h, data } = level;
  const out = new Uint8Array(data);
  const rowSums = new Uint16Array(w * 3);
  const fillRow = (y: number): void => {
    const base = y * w;
    const slot = (y % 3) * w;
    let a = data[base]!;
    let b = data[base + 1]!;
    for (let x = 1; x < w - 1; x++) {
      const c = data[base + x + 1]!;
      rowSums[slot + x] = a + b + c;
      a = b;
      b = c;
    }
  };
  fillRow(0);
  fillRow(1);
  for (let y = 1; y < h - 1; y++) {
    fillRow(y + 1);
    const r0 = ((y - 1) % 3) * w;
    const r1 = (y % 3) * w;
    const r2 = ((y + 1) % 3) * w;
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      const sum = rowSums[r0 + x]! + rowSums[r1 + x]! + rowSums[r2 + x]!;
      out[base + x] = Math.round(sum / 9);
    }
  }
  return out;
}
