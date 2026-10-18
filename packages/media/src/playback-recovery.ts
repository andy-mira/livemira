/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Playback recovery adapters: environment-specific ways to start playback after a native play() was rejected with
// NotAllowedError. The video session tries the first applicable one, once per play request.

export type RecoveryOutcome =
  | { readonly status: 'played' }
  /** `error` is the error of the recovery's own play(), when it got that far. */
  | { readonly status: 'failed'; readonly error?: unknown }
  | { readonly status: 'cancelled' };

export interface RecoveryAttempt {
  /** Never rejects. 'played' means play() resolved, not that frames are decoding. */
  readonly result: Promise<RecoveryOutcome>;
  /** Runs host code; it may call back synchronously, including cancelling this attempt. */
  start(): void;
  cancel(): void;
}

export interface PlaybackRecovery {
  /** Reported as the playback path. */
  readonly id: string;
  /** Environment check for this element; must not touch playback. */
  isApplicable(video: HTMLVideoElement): boolean;
  /**
   * Creates the attempt without touching any host object, so the caller can register it (and so make it
   * cancellable) before start(). `isLive` returns false once the attempt is no longer current.
   */
  prepare(video: HTMLVideoElement, isLive: () => boolean): RecoveryAttempt;
}

/** The first recovery that applies to this element; a failing check counts as not applicable. */
export function findRecovery(
  recoveries: readonly PlaybackRecovery[],
  video: HTMLVideoElement,
): PlaybackRecovery | null {
  for (const recovery of recoveries) {
    try {
      if (recovery.isApplicable(video)) return recovery;
    } catch {
      // Not applicable.
    }
  }
  return null;
}
