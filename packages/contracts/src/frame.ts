// SPDX-License-Identifier: Apache-2.0

import type { GrayImage } from './image.ts';

/** Times of one frame on the session clock, in microseconds. */
export interface FrameTime {
  /** Exposure-aligned capture time when the platform reports one, otherwise the best available estimate. */
  readonly captureUs: number;
  /** When the frame reached the processing side. */
  readonly receiveUs: number;
  /** When the platform expects this frame to be displayed (rVFC), if known. */
  readonly expectedDisplayUs?: number;
  readonly source: 'capture-time' | 'videoframe-timestamp' | 'callback' | 'replay';
}

/** Where the frame's picture lives. Crossing residencies always goes through an explicit adapter. */
export type ImageResidency =
  | { readonly kind: 'cpu-gray'; readonly image: GrayImage }
  | { readonly kind: 'video-frame'; readonly frame: VideoFrame }
  | { readonly kind: 'gpu-texture'; readonly texture: unknown; readonly width: number; readonly height: number };

/** One captured frame in standard-image orientation and size. */
export interface FrameHandle {
  readonly sessionId: string;
  /** Strictly increasing per session. */
  readonly frameId: number;
  readonly time: FrameTime;
  readonly image: ImageResidency;
}
