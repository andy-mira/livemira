/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** Closed set of engine error codes. Callers branch on `code`, never on the message. */
export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_TARGET'
  | 'DISPOSED'
  | 'ABORTED'
  | 'START_FAILED'
  | 'FRAME_FAILED'
  | 'RESOURCE_FAILED'
  | 'UNSUPPORTED'
  | 'CAMERA_UNAVAILABLE'
  | 'CAMERA_PERMISSION_DENIED'
  | 'CAMERA_START_FAILED'
  | 'CAMERA_TRACK_ENDED'
  | 'CAMERA_FRAME_STALLED'
  | 'CAMERA_CAPTURE_FAILED'
  | 'CAMERA_CLOCK_RESET'
  | 'CAMERA_SUSPENDED'
  | 'MEDIA_FAILED'
  | 'PLAYBACK_BLOCKED';

export interface EngineErrorOptions {
  /** True when the same operation may succeed later (for example after a restart or a user gesture). */
  readonly isRecoverable: boolean;
  readonly cause?: unknown;
}

/** The only error type the engine throws or reports. */
export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly isRecoverable: boolean;

  constructor(code: ErrorCode, message: string, options: EngineErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'EngineError';
    this.code = code;
    this.isRecoverable = options.isRecoverable;
  }
}
