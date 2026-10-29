// SPDX-License-Identifier: Apache-2.0
// A picture file becomes a target: decoding (with the picture's own orientation), scaling to the long edge, gray
// conversion and compilation. Shared by the engine's compiler Worker and the target rating module, so a rating is
// made on exactly the target the engine would track.

import type { GrayImage } from '@livemira-next/contracts';
import { compileTarget, encodeTarget } from '@livemira-next/features';

/** Fewer recognition points than this and a picture is not worth tracking. */
export const MIN_POINTS = 48;
/** Shorter edges than this (after scaling) cannot be recognised at a usable distance. */
export const MIN_EDGE_PX = 64;

export type PictureErrorCode = 'DECODE_FAILED' | 'UNSUITABLE_TARGET';

export class PictureError extends Error {
  readonly code: PictureErrorCode;
  constructor(code: PictureErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PictureError';
    this.code = code;
  }
}

/** Scaled size: the long edge at most `maxEdge`, never enlarged. */
export function scaledSize(width: number, height: number, maxEdge: number): [number, number] {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

/** Rec. 601 luma of RGBA pixels. */
export function grayFromRgba(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = (77 * rgba[4 * i]! + 150 * rgba[4 * i + 1]! + 29 * rgba[4 * i + 2]! + 128) >> 8;
  return gray;
}

/** Whether this scope (a Worker) can draw pictures; without it the page decodes ({@link decodePictureOnPage}). */
export function canDrawPictures(): boolean {
  try {
    return typeof OffscreenCanvas === 'function' && !!new OffscreenCanvas(1, 1).getContext('2d');
  } catch {
    return false;
  }
}

/** Decodes a picture file to gray pixels, its long edge at most `maxEdge` (in a Worker with OffscreenCanvas). */
export async function decodePicture(blob: Blob, maxEdge: number): Promise<GrayImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try {
      bitmap = await createImageBitmap(blob);
    } catch (cause) {
      throw new PictureError('DECODE_FAILED', `The picture cannot be decoded: ${String(cause)}`, { cause });
    }
  }
  try {
    const [width, height] = scaledSize(bitmap.width, bitmap.height, maxEdge);
    // Halving steps first: one large reduction in a single draw aliases fine detail into false features.
    let source: ImageBitmap | OffscreenCanvas = bitmap;
    let sw = bitmap.width;
    let sh = bitmap.height;
    while (sw > 2 * width && sh > 2 * height) {
      const half = new OffscreenCanvas(Math.ceil(sw / 2), Math.ceil(sh / 2));
      const c = half.getContext('2d')!;
      c.imageSmoothingQuality = 'high';
      c.drawImage(source, 0, 0, half.width, half.height);
      source = half;
      sw = half.width;
      sh = half.height;
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    return { width, height, stride: width, data: grayFromRgba(rgba, width, height) };
  } finally {
    bitmap.close();
  }
}

/** The same on the page, for Workers that cannot draw; the pixels come back as a transferable buffer. */
export async function decodePictureOnPage(
  blob: Blob,
  maxEdge: number,
): Promise<{ width: number; height: number; data: ArrayBuffer }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (cause) {
    throw new PictureError('DECODE_FAILED', 'The picture cannot be decoded', { cause });
  }
  const [width, height] = scaledSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const gray = grayFromRgba(context.getImageData(0, 0, width, height).data, width, height);
  return { width, height, data: gray.buffer as ArrayBuffer };
}

/** Compiles one gray picture into target bytes; refuses pictures that cannot be recognised reliably. */
export async function compilePicture(
  targetId: string,
  image: GrayImage,
): Promise<{ bytes: Uint8Array; pointCount: number }> {
  if (Math.min(image.width, image.height) < MIN_EDGE_PX)
    throw new PictureError('UNSUITABLE_TARGET', `The picture is too small (${image.width}×${image.height} px)`);
  const compiled = compileTarget({
    info: { id: targetId, width: image.width, height: image.height, physicalWidthMeters: null },
    image,
  });
  const pointCount = compiled.points.length / 2;
  if (pointCount < MIN_POINTS)
    throw new PictureError('UNSUITABLE_TARGET', `The picture has too little detail (${pointCount} recognition points)`);
  return { bytes: await encodeTarget(compiled, image), pointCount };
}
