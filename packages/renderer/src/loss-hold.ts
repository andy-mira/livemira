/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The visual hold after a target loss: the last overlay pose and playback stay for a grace period, then the overlay
// hides and the media pauses (even media that only hides on loss). It is never a tracking state.

import type { VideoSession } from '@livemira/media';

/** Longest allowed loss display grace. */
export const MAX_LOSS_DISPLAY_GRACE_MS = 1000;

export interface LossHold {
  readonly media: VideoSession;
  readonly sessionId: string;
  readonly targetId: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export function isValidGrace(graceMs: unknown): graceMs is number {
  return (
    typeof graceMs === 'number' &&
    Number.isFinite(graceMs) &&
    graceMs > 0 &&
    graceMs <= MAX_LOSS_DISPLAY_GRACE_MS
  );
}

export function clearHoldTimer(hold: LossHold | null): void {
  if (hold?.timer != null) clearTimeout(hold.timer);
}
