// SPDX-License-Identifier: Apache-2.0

import type { EngineErrorShape, ErrorCode } from './api.ts';

const RECOVERABLE: ReadonlySet<ErrorCode> = new Set([
  'CAMERA_PERMISSION_DENIED',
  'CAMERA_START_FAILED',
  'CAMERA_ENDED',
  'WORKER_FAILED',
  'MEDIA_FAILED',
  'ABORTED',
  'UNSUITABLE_TARGET',
  'DECODE_FAILED',
]);

export class EngineError extends Error implements EngineErrorShape {
  override readonly name = 'EngineError';
  readonly code: ErrorCode;
  readonly isRecoverable: boolean;
  readonly missing?: readonly string[];

  constructor(code: ErrorCode, message: string, options: { cause?: unknown; missing?: readonly string[] } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.isRecoverable = RECOVERABLE.has(code);
    if (options.missing) this.missing = options.missing;
  }
}

/** The engine error for `cause`: itself when it already is one, else `fallback` carrying it. */
export function asEngineError(cause: unknown, fallback: ErrorCode, message: string): EngineError {
  if (cause instanceof EngineError) return cause;
  return new EngineError(fallback, `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}
