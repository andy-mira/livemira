/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Produces the standard gray image of one captured picture inside the vision Worker: the picture is drawn into a
// canvas of the standard size with the frame's own transform (crop, mirror, rotation, scale), read back and converted
// to gray. Pixels that are already standard (no geometry) are converted directly.

import { EngineError, type FrameGeometry } from '@livemira/contracts';

import { rgbaToGray, type GrayPixels } from '../gray/rgba-to-gray.ts';
import type { StandardImageWorkspace } from './workspace.ts';

/** Largest standard (processing) image: 4096 pixels per edge and 4,194,304 pixels. */
export const STANDARD_MAX_EDGE = 4096;
export const STANDARD_MAX_PIXELS = 4194304;

/** Raw pictures may be larger than the standard image because the geometry scales them down. */
const RAW_MAX_EDGE = 16384;
const RAW_MAX_PIXELS = 16777216;

/** Message for frames above the raw picture limit; safe to show outside the Worker. */
export const SOURCE_TOO_LARGE = 'Worker source frame exceeds supported size';
/** Message for standard images above the processing limit; safe to show outside the Worker. */
export const STANDARD_TOO_LARGE =
  'Standard image exceeds processing limit; frames are never silently resized';

/** A picture handed to the Worker: CPU pixels (tight or padded rows) or a native image the Worker owns. */
export type TransferredImage =
  | {
      readonly kind: 'gray8' | 'rgba8';
      readonly buffer: ArrayBuffer;
      readonly width: number;
      readonly height: number;
      readonly strideBytes: number;
    }
  | { readonly kind: 'video-frame'; readonly image: VideoFrame }
  | { readonly kind: 'image-bitmap'; readonly image: ImageBitmap };

export interface StandardizeInput {
  readonly image: TransferredImage;
  /** The frame's geometry; null only for CPU pixels that are already in standard orientation and size. */
  readonly geometry: FrameGeometry | null;
}

/** Optional timing breakdown in microseconds, collected only when requested. */
export interface PrepareStages {
  inputPackingDurationUs: number;
  inputUploadDurationUs: number;
  standardDrawDurationUs: number;
  readbackDurationUs: number;
  grayscaleDurationUs: number;
}

export type GrayConversion = (
  data: Uint8Array,
  widthPx: number,
  heightPx: number,
  strideBytes?: number,
) => GrayPixels;

function checkRawLayout(image: Extract<TransferredImage, { buffer: ArrayBuffer }>): number {
  const { width, height, strideBytes: stride } = image;
  const channels = image.kind === 'gray8' ? 1 : image.kind === 'rgba8' ? 4 : 0;
  if (
    !channels ||
    !(image.buffer instanceof ArrayBuffer) ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(stride) ||
    stride < width * channels ||
    !Number.isSafeInteger((height - 1) * stride + width * channels) ||
    (height - 1) * stride + width * channels > image.buffer.byteLength
  ) {
    throw new EngineError('FRAME_FAILED', 'Invalid worker CPU layout', { isRecoverable: false });
  }
  if (width > RAW_MAX_EDGE || height > RAW_MAX_EDGE || width * height > RAW_MAX_PIXELS) {
    throw new EngineError('UNSUPPORTED', SOURCE_TOO_LARGE, { isRecoverable: false });
  }
  return channels;
}

function checkStandardSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new EngineError('FRAME_FAILED', 'Invalid standard image dimensions', {
      isRecoverable: false,
    });
  }
  if (
    width > STANDARD_MAX_EDGE ||
    height > STANDARD_MAX_EDGE ||
    width * height > STANDARD_MAX_PIXELS
  ) {
    throw new EngineError('UNSUPPORTED', STANDARD_TOO_LARGE, { isRecoverable: false });
  }
}

function checkGeometry(geometry: FrameGeometry): void {
  checkStandardSize(geometry.standardWidthPx, geometry.standardHeightPx);
  const h = geometry.H_standardFromInput;
  const invalid = (): never => {
    throw new EngineError('FRAME_FAILED', 'Invalid frame transform', { isRecoverable: false });
  };
  if (!h || h.length !== 9) invalid();
  for (let i = 0; i < 9; i++) if (typeof h[i] !== 'number' || !Number.isFinite(h[i])) invalid();
  if (h[6] !== 0 || h[7] !== 0 || h[8] !== 1) invalid();
}

const now = (): number => performance.now();

/** Draws into the cached output canvas (cleared first, so transparent pixels never keep an earlier frame) and reads its RGBA back. */
function drawStandard(
  workspace: StandardImageWorkspace,
  source: CanvasImageSource,
  geometry: FrameGeometry,
  stages?: PrepareStages,
): Uint8Array {
  const began = stages ? now() : 0;
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const h = geometry.H_standardFromInput;
  const out = workspace.outputSurface(width, height).context;
  try {
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, width, height);
    out.setTransform(h[0], h[3], h[1], h[4], h[2], h[5]);
    out.drawImage(source, 0, 0);
  } finally {
    out.setTransform(1, 0, 0, 1, 0, 0);
  }
  const drawn = stages ? now() : 0;
  const pixels = out.getImageData(0, 0, width, height).data;
  if (stages) {
    stages.standardDrawDurationUs += (drawn - began) * 1000;
    stages.readbackDurationUs += (now() - drawn) * 1000;
  }
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

/** CPU pixels with a geometry: packed into RGBA if needed, uploaded, drawn with the frame's transform, converted. */
function standardizeCpuPixels(
  image: Extract<TransferredImage, { buffer: ArrayBuffer }>,
  channels: number,
  geometry: FrameGeometry,
  workspace: StandardImageWorkspace,
  convert: GrayConversion,
  stages?: PrepareStages,
): GrayPixels {
  checkGeometry(geometry);
  if (typeof OffscreenCanvas === 'undefined' || typeof ImageData === 'undefined') {
    throw new EngineError('UNSUPPORTED', 'Input pixels require Worker canvas', {
      isRecoverable: true,
    });
  }
  const stride = image.strideBytes;
  const rowBytes = image.width * channels;
  // The transferred buffer belongs to this Worker: tight RGBA is viewed in place, other layouts are packed once.
  const packingStarted = stages ? now() : 0;
  let rgba: Uint8ClampedArray<ArrayBuffer>;
  if (channels === 4 && stride === rowBytes)
    rgba = new Uint8ClampedArray(image.buffer, 0, rowBytes * image.height);
  else {
    rgba = workspace.bytes(image.width * image.height * 4);
    const source = new Uint8Array(image.buffer);
    if (channels === 4) {
      for (let y = 0; y < image.height; y++)
        rgba.set(source.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    } else {
      for (let y = 0; y < image.height; y++) {
        let from = y * stride;
        let to = y * rowBytes * 4;
        for (let x = 0; x < image.width; x++, from++, to += 4) {
          rgba[to] = rgba[to + 1] = rgba[to + 2] = source[from]!;
          rgba[to + 3] = 255;
        }
      }
    }
  }
  const packed = stages ? now() : 0;
  const input = workspace.inputSurface(image.width, image.height);
  input.context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  if (stages) {
    stages.inputPackingDurationUs += (packed - packingStarted) * 1000;
    stages.inputUploadDurationUs += (now() - packed) * 1000;
  }
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const pixels = drawStandard(workspace, input.canvas, geometry, stages);
  const grayStarted = stages ? now() : 0;
  const data = convert(pixels, width, height).data;
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1000;
  return { widthPx: width, heightPx: height, data };
}

/** CPU pixels already in standard orientation and size: converted or copied without a canvas. */
function standardizeStandardPixels(
  image: Extract<TransferredImage, { buffer: ArrayBuffer }>,
  channels: number,
  convert: GrayConversion,
  stages?: PrepareStages,
): GrayPixels {
  checkStandardSize(image.width, image.height);
  const width = image.width;
  const height = image.height;
  const stride = image.strideBytes;
  const rowBytes = width * channels;
  const grayStarted = stages ? now() : 0;
  let data: Uint8Array;
  if (channels === 4)
    data = convert(
      new Uint8Array(image.buffer, 0, (height - 1) * stride + rowBytes),
      width,
      height,
      stride,
    ).data;
  else if (stride === rowBytes) data = new Uint8Array(image.buffer, 0, width * height);
  else {
    data = new Uint8Array(width * height);
    const source = new Uint8Array(image.buffer);
    for (let y = 0; y < height; y++)
      data.set(source.subarray(y * stride, y * stride + width), y * width);
  }
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1000;
  return { widthPx: width, heightPx: height, data };
}

/**
 * The standard gray image of one transferred picture. Throws `FRAME_FAILED` for malformed input, and `UNSUPPORTED`
 * for pictures or standard images above the limits (never silently resized) or a missing Worker canvas.
 */
export function standardize(
  input: StandardizeInput,
  workspace: StandardImageWorkspace,
  convert: GrayConversion = rgbaToGray,
  stages?: PrepareStages,
): GrayPixels {
  const { image, geometry } = input;
  if ('buffer' in image) {
    const channels = checkRawLayout(image);
    return geometry
      ? standardizeCpuPixels(image, channels, geometry, workspace, convert, stages)
      : standardizeStandardPixels(image, channels, convert, stages);
  }
  if (!geometry || typeof OffscreenCanvas === 'undefined') {
    throw new EngineError(
      'UNSUPPORTED',
      'Native frame conversion needs Worker OffscreenCanvas and geometry',
      {
        isRecoverable: true,
      },
    );
  }
  const source = image.image as VideoFrame & ImageBitmap;
  const sourceWidth = (source as VideoFrame).displayWidth ?? source.width;
  const sourceHeight = (source as VideoFrame).displayHeight ?? source.height;
  if (
    !Number.isSafeInteger(sourceWidth) ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1 ||
    sourceWidth > RAW_MAX_EDGE ||
    sourceHeight > RAW_MAX_EDGE ||
    sourceWidth * sourceHeight > RAW_MAX_PIXELS
  ) {
    throw new EngineError('UNSUPPORTED', SOURCE_TOO_LARGE, { isRecoverable: false });
  }
  checkGeometry(geometry);
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const pixels = drawStandard(workspace, image.image, geometry, stages);
  const grayStarted = stages ? now() : 0;
  const data = convert(pixels, width, height).data;
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1000;
  return { widthPx: width, heightPx: height, data };
}
