/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The frame slot: one in-flight frame and one latest candidate. A newer candidate replaces the older one; frames of
// another session, older or repeated frames and repeated pictures are dropped. Every frame is released exactly once.

import type { Frame } from '@livemira/contracts';

export type DropReason =
  | 'viewport-transition'
  | 'inactive-stale-or-duplicate'
  | 'candidate-replaced'
  | 'stopped-before-processing'
  | 'cancelled-or-stale-result';

export class FrameScheduler {
  pending: Frame | null = null;
  processing: Promise<void> | null = null;
  private lastFrameId = -1;
  private lastSourceTimeUs = -Infinity;
  private lastPictureKey: string | undefined;
  private readonly receipts = new WeakMap<Frame, number>();
  private readonly released = new WeakSet<object>();
  private readonly onReleaseFailure: () => void;

  constructor(onReleaseFailure: () => void) {
    this.onReleaseFailure = onReleaseFailure;
  }

  /** A new session: identity checks start over. */
  reset(): void {
    this.lastFrameId = -1;
    this.lastSourceTimeUs = -Infinity;
    this.lastPictureKey = undefined;
  }

  /** True when the frame is newer than every frame accepted so far (and not a repeated picture). */
  isFresh(frame: Frame): boolean {
    return (
      Number.isSafeInteger(frame.frameId) &&
      Number.isFinite(frame.timing.sourceTimestampUs) &&
      frame.frameId > this.lastFrameId &&
      frame.timing.sourceTimestampUs > this.lastSourceTimeUs &&
      !(frame.pictureKey !== undefined && frame.pictureKey === this.lastPictureKey)
    );
  }

  /** Records the frame as the latest accepted one and returns the candidate it replaced, if any. */
  offer(frame: Frame, receiptUs: number): Frame | null {
    this.lastFrameId = frame.frameId;
    this.lastSourceTimeUs = frame.timing.sourceTimestampUs;
    this.lastPictureKey = frame.pictureKey;
    this.receipts.set(frame, receiptUs);
    const replaced = this.pending;
    this.pending = frame;
    return replaced;
  }

  take(): Frame | null {
    const frame = this.pending;
    this.pending = null;
    return frame;
  }

  receiptUs(frame: Frame): number | undefined {
    return this.receipts.get(frame);
  }

  /** Releases the frame's picture once; a failing release is reported through the callback. */
  release(frame: Frame): void {
    if (this.released.has(frame.image)) return;
    this.released.add(frame.image);
    try {
      frame.image.release();
    } catch {
      this.onReleaseFailure();
    }
  }
}
