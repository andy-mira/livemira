/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Pictures and geometries for the Worker frame tests.

import type { TransferredImage } from '@livemira/compute';
import type { FrameGeometry, Mat3 } from '@livemira/contracts';

export const IDENT: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const HALF: Mat3 = [0.5, 0, 0, 0, 0.5, 0, 0, 0, 1];

export const handGeometry = (
  standardWidthPx: number,
  standardHeightPx: number,
  H: Mat3 | null,
): FrameGeometry =>
  ({
    H_standardFromInput: H,
    H_viewportFromStandard: IDENT,
    crop: { x: 0, y: 0, width: 1, height: 1 },
    rotationDeg: 0,
    isMirrored: false,
    fit: 'contain',
    standardWidthPx,
    standardHeightPx,
    viewportWidthCss: standardWidthPx,
    viewportHeightCss: standardHeightPx,
    devicePixelRatio: 1,
  }) as unknown as FrameGeometry;

export const rgbaPattern = (w: number, h: number, seed = 0): Uint8Array => {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      d[i] = (x * 7 + y * 3 + seed) & 255;
      d[i + 1] = (x * 5 + y * 11 + 40 + seed) & 255;
      d[i + 2] = (x * 13 + y * 2 + 90) & 255;
      d[i + 3] = 255;
    }
  }
  return d;
};

export function raw(
  pixels: Uint8Array,
  width: number,
  height: number,
  options: { kind?: 'gray8' | 'rgba8'; strideBytes?: number } = {},
): TransferredImage {
  const kind = options.kind ?? 'rgba8';
  return {
    kind,
    buffer: pixels.buffer.slice(
      pixels.byteOffset,
      pixels.byteOffset + pixels.byteLength,
    ) as ArrayBuffer,
    width,
    height,
    strideBytes: options.strideBytes ?? width * (kind === 'gray8' ? 1 : 4),
  };
}
