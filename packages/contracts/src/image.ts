// SPDX-License-Identifier: Apache-2.0

/** Gray8 image; `stride` is bytes per row (≥ width). */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly data: Uint8Array;
}

/** One pyramid level; `scale` maps its pixels to level-0 pixels (level-0 = scale 1). */
export interface PyramidLevel extends GrayImage {
  readonly scale: number;
}

/** A gray pyramid of one frame, level 0 first. */
export interface ImagePyramid {
  readonly levels: readonly PyramidLevel[];
}

export function grayImage(width: number, height: number, data?: Uint8Array): GrayImage {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new RangeError('Invalid image size');
  const pixels = data ?? new Uint8Array(width * height);
  if (pixels.length < width * height) throw new RangeError('Image data too short');
  return { width, height, stride: width, data: pixels };
}
