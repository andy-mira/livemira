/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Checks the probe harness itself: the synthetic camera delivers new frames through a <video>, its pixels carry the
// frame number, and a size change reaches the video as a new intrinsic size.

import type { SyntheticCameraControl } from '../harness/synthetic-camera.ts';

export interface SyntheticCameraReport {
  readonly initialSize: readonly [number, number];
  readonly presentedFramesAdvanced: boolean;
  readonly decodedFrameNumber: number;
  readonly frameNumberAtDecode: number;
  readonly resizedSize: readonly [number, number];
}

const camera = (window as unknown as { __syntheticCamera: SyntheticCameraControl })
  .__syntheticCamera;

const nextVideoFrame = (video: HTMLVideoElement): Promise<VideoFrameCallbackMetadata> =>
  new Promise((resolve) => video.requestVideoFrameCallback((_now, metadata) => resolve(metadata)));

/** Reads the 16-cell frame number from the top row of the current picture. */
function decodeFrameNumber(video: HTMLVideoElement): number {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No 2D context');
  context.drawImage(video, 0, 0);
  const cell = canvas.width / 16;
  let value = 0;
  for (let bit = 0; bit < 16; bit++) {
    const [red] = context.getImageData(
      Math.floor(bit * cell + cell / 2),
      Math.floor(cell / 2),
      1,
      1,
    ).data;
    if ((red ?? 0) > 127) value |= 1 << bit;
  }
  return value;
}

async function run(): Promise<SyntheticCameraReport> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  document.body.append(video);
  await video.play();
  const first = await nextVideoFrame(video);
  let later = first;
  for (let i = 0; i < 3; i++) later = await nextVideoFrame(video);
  const initialSize = [video.videoWidth, video.videoHeight] as const;
  const frameNumberAtDecode = camera.frameNumber;
  const decodedFrameNumber = decodeFrameNumber(video);
  const resized = new Promise<void>((resolve) =>
    video.addEventListener('resize', () => resolve(), { once: true }),
  );
  camera.setSize(initialSize[1], initialSize[0]);
  await resized;
  return {
    initialSize,
    presentedFramesAdvanced: later.presentedFrames > first.presentedFrames,
    decodedFrameNumber,
    frameNumberAtDecode,
    resizedSize: [video.videoWidth, video.videoHeight],
  };
}

Object.defineProperty(window, '__probe', { value: run() });
