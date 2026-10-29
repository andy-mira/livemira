/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameGeometry } from './geometry.ts';

/** Session and sequence number of one frame; every asynchronous result is matched against it. */
export interface FrameIdentity {
  readonly sessionId: string;
  /** Per-session sequence, strictly increasing from 0. */
  readonly frameId: number;
}

export interface FrameTiming {
  readonly sourceTimestampUs: number;
  readonly timestampSource: 'media-time' | 'callback' | 'replay';
  /** Session clock when the capture callback ran. */
  readonly arrivalTimeUs: number;
  /** Source timestamp mapped onto the session clock; arrival-aligned and approximate, not the exposure time. */
  readonly observationTimeUs: number;
}

/** An owned picture. Whoever holds it releases it exactly once; `release` is idempotent. */
export interface OwnedImage<F extends string, T> {
  readonly format: F;
  readonly isReleased: boolean;
  /** Throws `EngineError('RESOURCE_FAILED')` after release. */
  data(): T;
  release(): void;
}

export type FrameImage =
  | OwnedImage<'video-frame', VideoFrame>
  | OwnedImage<'image-bitmap', ImageBitmap>
  /** Tight rows, straight alpha, sRGB. */
  | OwnedImage<'rgba8', Uint8Array>
  /** Tight rows. */
  | OwnedImage<'gray8', Uint8Array>
  /**
   * Tight rows, straight alpha, sRGB, already the standard image of the frame's geometry (standardWidthPx ×
   * standardHeightPx): crop, mirror, rotation and scale applied on capture.
   */
  | OwnedImage<'standard-rgba8', Uint8Array>;

/** One captured camera frame with the geometry measured for exactly this capture. */
export interface Frame extends FrameIdentity {
  /** Identity of the captured picture; equal keys mean the same picture. */
  readonly pictureKey: string;
  readonly timing: FrameTiming;
  /** Intrinsic size of the captured picture. */
  readonly widthPx: number;
  readonly heightPx: number;
  readonly geometry: FrameGeometry;
  readonly image: FrameImage;
}
