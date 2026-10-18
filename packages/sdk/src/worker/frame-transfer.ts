/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Main-thread side of a frame's trip to the Worker: an owned copy that can be transferred, so the engine's original
// picture stays borrowed and untouched until the engine releases it.

import type { TransferredImage } from '@livemira/compute';
import { EngineError, type Frame, type FrameGeometry } from '@livemira/contracts';

import type { WorkerFrame } from './protocol.ts';

/** An owned copy of one frame. After a successful postMessage call markTransferred; release closes only an untransferred copy. */
export interface FrameLease {
  readonly frame: WorkerFrame;
  readonly transfer: Transferable[];
  /** Bytes copied on the main thread; null when the browser copies internally (native pictures). */
  readonly copiedBytes: number | null;
  readonly preparationDurationUs: number;
  markTransferred(): void;
  release(): void;
}

const aborted = (): EngineError =>
  new EngineError('ABORTED', 'Frame preparation aborted', { isRecoverable: true });
const failed = (message: string): EngineError =>
  new EngineError('FRAME_FAILED', message, { isRecoverable: true });

function copyGeometry(geometry: FrameGeometry): FrameGeometry {
  return {
    ...geometry,
    crop: { ...geometry.crop },
    H_standardFromInput: [
      ...geometry.H_standardFromInput,
    ] as unknown as FrameGeometry['H_standardFromInput'],
    H_viewportFromStandard: [
      ...geometry.H_viewportFromStandard,
    ] as unknown as FrameGeometry['H_viewportFromStandard'],
  };
}

/** Native pictures are cloned (VideoFrame) or copied (ImageBitmap); the clone is owned by the lease. */
async function copyNative(frame: Frame): Promise<VideoFrame | ImageBitmap> {
  const image = frame.image;
  const source = image.data() as VideoFrame | ImageBitmap;
  const width = (source as VideoFrame).displayWidth ?? (source as ImageBitmap).width;
  const height = (source as VideoFrame).displayHeight ?? (source as ImageBitmap).height;
  if (width !== frame.widthPx || height !== frame.heightPx)
    throw failed('Native Worker image dimensions do not match frame metadata');
  return image.format === 'video-frame'
    ? (source as VideoFrame).clone()
    : createImageBitmap(source as ImageBitmap);
}

/**
 * CPU pixels are copied row by row into a fresh tight buffer that the Worker receives. The camera's canvas readback is
 * already the standard image (a quarter of a 720×1280 picture at the 640 long edge); full pictures come only from
 * replay and test sources.
 */
function copyPixels(frame: Frame): { image: TransferredImage; copiedBytes: number } {
  const image = frame.image;
  if (image.format !== 'gray8' && image.format !== 'rgba8' && image.format !== 'standard-rgba8')
    throw failed('Unsupported Worker image format');
  const channels = image.format === 'gray8' ? 1 : 4;
  const data = image.data();
  const isStandard = image.format === 'standard-rgba8';
  const width = isStandard ? frame.geometry.standardWidthPx : frame.widthPx;
  const height = isStandard ? frame.geometry.standardHeightPx : frame.heightPx;
  const rowBytes = width * channels;
  if (!(data instanceof Uint8Array) || (height - 1) * rowBytes + rowBytes > data.byteLength)
    throw failed('Invalid CPU image layout');
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++)
    pixels.set(data.subarray(y * rowBytes, y * rowBytes + rowBytes), y * rowBytes);
  return {
    image: {
      kind: channels === 1 ? 'gray8' : 'rgba8',
      buffer: pixels.buffer,
      width,
      height,
      strideBytes: rowBytes,
    },
    copiedBytes: pixels.byteLength,
  };
}

/**
 * Prepares a transferable copy of `frame`. `geometry` defaults to the frame's own; null is accepted only for CPU
 * pixels that are already in standard orientation and size (test and replay sources). Native pictures need a geometry.
 */
export async function prepareTransfer(
  frame: Frame,
  signal: AbortSignal,
  geometry: FrameGeometry | null = frame.geometry,
): Promise<FrameLease> {
  const started = performance.now();
  if (signal.aborted) throw aborted();
  const { widthPx: width, heightPx: height } = frame;
  if (
    ![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16384) ||
    width * height > 16777216
  ) {
    throw failed('Worker frame dimensions exceed limit');
  }
  if (frame.image.isReleased) throw failed('Frame already released');
  let copy: VideoFrame | ImageBitmap | null = null;
  try {
    let image: TransferredImage;
    let copiedBytes: number | null = null;
    if (frame.image.format === 'video-frame' || frame.image.format === 'image-bitmap') {
      if (!geometry) throw failed('Native Worker frame requires captured geometry');
      copy = await copyNative(frame);
      image =
        frame.image.format === 'video-frame'
          ? { kind: 'video-frame', image: copy as VideoFrame }
          : { kind: 'image-bitmap', image: copy as ImageBitmap };
    } else {
      ({ image, copiedBytes } = copyPixels(frame));
    }
    if (signal.aborted) throw aborted();
    // A standard image needs no transform in the Worker, only the conversion to gray.
    if (frame.image.format === 'standard-rgba8') geometry = null;
    const metadata = {
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      pictureKey: frame.pictureKey,
      observationTimeUs: frame.timing.observationTimeUs,
    };
    const transferable: Transferable = copy ?? (image as { buffer: ArrayBuffer }).buffer;
    let state: 'owned' | 'transferred' | 'released' = 'owned';
    const owned = copy;
    return {
      frame: { metadata, image, geometry: geometry ? copyGeometry(geometry) : null },
      transfer: [transferable],
      copiedBytes,
      preparationDurationUs: (performance.now() - started) * 1000,
      markTransferred() {
        if (state === 'released')
          throw new EngineError('RESOURCE_FAILED', 'Frame copy already released', {
            isRecoverable: false,
          });
        state = 'transferred';
      },
      release() {
        if (state !== 'owned') return;
        state = 'released';
        owned?.close();
      },
    };
  } catch (error) {
    copy?.close();
    throw error;
  }
}
