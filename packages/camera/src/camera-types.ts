/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EngineError, FrameGeometry, RectPx } from '@livemira/contracts';

import type { LongEdge } from './geometry/frame-geometry.ts';
import type { SnapshotEnvironment } from './capture/snapshot.ts';
import type { ViewportEnvironment } from './viewport/viewport-measure.ts';

/** The parts of a window the camera uses; injectable for tests. */
export interface CameraEnvironment extends ViewportEnvironment, SnapshotEnvironment {
  readonly isSecureContext?: boolean;
  readonly navigator?: {
    readonly mediaDevices?: {
      getUserMedia?(constraints: MediaStreamConstraints): Promise<MediaStream>;
      enumerateDevices?(): Promise<MediaDeviceInfo[]>;
    };
  };
  readonly document?: Document;
  readonly performance?: { now(): number };
  setInterval?(handler: () => void, timeoutMs: number): number;
  clearInterval?(handle: number): void;
}

/** Which camera to open. */
export interface CameraRequest {
  /** Default 'environment'; ignored when `deviceId` is set. */
  readonly facingMode?: 'environment' | 'user';
  readonly deviceId?: string;
  /** Ideal capture size; default 1280 × 720. */
  readonly idealWidthPx?: number;
  readonly idealHeightPx?: number;
  /** 'canvas' (default): canvas readback only; 'auto': native pictures with canvas fallback. */
  readonly capture?: 'auto' | 'canvas';
  /** 'callback' (default): the arrival time of the frame callback; 'media-time': the video's media time. */
  readonly timestamps?: 'media-time' | 'callback';
}

/** Default camera settings: canvas capture with callback timestamps. */
export const DEFAULT_CAPTURE = 'canvas';
export const DEFAULT_TIMESTAMPS = 'callback';

/** How captured pictures map to the processing image and the preview. */
export interface GeometryOptions {
  /** 480, 640 (default), 960 or 'native'. */
  readonly longEdge?: LongEdge;
  /** Default 'cover'. */
  readonly fit?: 'contain' | 'cover';
  readonly crop?: RectPx;
  readonly rotationDeg?: 0 | 90 | 180 | 270;
  readonly isMirrored?: boolean;
  readonly isViewportMirrored?: boolean;
}

export interface CameraSettingsSnapshot {
  readonly [key: string]: string | number | boolean | undefined;
}

/** A recommended camera configuration after a stall. */
export interface CameraRecovery {
  readonly capture: 'canvas';
  readonly timestamps: 'callback';
}

export type CameraEvent =
  | {
      readonly type: 'permission';
      readonly phase: 'request' | 'result';
      readonly permission: 'pending' | 'granted' | 'denied' | 'failed';
    }
  | {
      readonly type: 'ready';
      readonly settings: CameraSettingsSnapshot;
      readonly capturePath: 'video-frame-callback' | 'decoded-frame-count';
    }
  | {
      readonly type: 'capturePathChanged';
      readonly capturePath: 'decoded-frame-count';
      readonly reason: string;
    }
  /** New pictures kept the media time of the previous one: the rest of the run uses callback timestamps. */
  | {
      readonly type: 'timestampsChanged';
      readonly timestamps: 'callback';
      readonly reason: 'MEDIA_TIME_FROZEN';
    }
  /** The camera picture's intrinsic size, announced while the preview is still hidden; a host may relayout now. */
  | { readonly type: 'pictureSize'; readonly widthPx: number; readonly heightPx: number }
  | { readonly type: 'geometryChanged'; readonly geometry: FrameGeometry }
  | { readonly type: 'clockMapping'; readonly sourceToSessionOffsetUs: number }
  | {
      readonly type: 'failure';
      readonly error: EngineError;
      /** The original fine-grained reason, e.g. 'TRACK_ENDED' or 'NO_VIDEO_CALLBACK'. */
      readonly detail: string;
      readonly recommended?: CameraRecovery | null;
    }
  /** The page was hidden; the camera has stopped. */
  | { readonly type: 'suspended' };
