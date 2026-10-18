/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// One-shot readiness of the current media request: calls back once when a decoded picture is actually presentable,
// never for loadedmetadata/canplay alone. The element must report readyState >= HAVE_CURRENT_DATA, a non-zero
// intrinsic size and no error.
//  - With requestVideoFrameCallback: the first presented-frame callback that also passes those checks.
//  - Otherwise a conservative fallback ('time-progress'): polled every 100 ms, it needs the same checks, an unpaused
//    element, currentTime strictly increasing across 2 consecutive polls beyond its value when watching began, and
//    (when getVideoPlaybackQuality reports a finite count) a higher decoded-frame count than at the start. It can fire
//    up to ~2 polls after the real first frame, never before.

import type { PresentableFrame, PresentableSignal } from './media-types.ts';

const POLL_MS = 100;
const HAVE_CURRENT_DATA = 2;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(
    callback: (now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
};

// A pending poll must not keep a Node host (tests, tooling) alive; browsers return a number and ignore this.
const unrefTimer = <T>(timer: T): T => {
  (timer as { unref?: () => void } | null)?.unref?.();
  return timer;
};

export class PresentableFrameWatch {
  private epoch = 0;
  private handle: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly video: FrameCallbackVideo;
  private readonly isDisposed: () => boolean;

  constructor(video: HTMLVideoElement, isDisposed: () => boolean) {
    this.video = video;
    this.isDisposed = isDisposed;
  }

  /** Replaces any earlier watch. Returns the signal in use. A cancelled watch never calls back. */
  await(callback: (frame: PresentableFrame) => void): PresentableSignal {
    this.cancel();
    const video = this.video;
    const epoch = this.epoch;
    const owns = (): boolean => !this.isDisposed() && epoch === this.epoch;
    const decoded = (): number | null => {
      const n = video.getVideoPlaybackQuality?.()?.totalVideoFrames;
      return Number.isFinite(n) ? n! : null;
    };
    const hasPicture = (): boolean =>
      video.readyState >= HAVE_CURRENT_DATA &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      !video.error;
    const finish = (
      signal: PresentableSignal,
      mediaTime: number | null,
      presentedFrames: number | null,
    ): void => {
      if (!owns()) return;
      this.cancel();
      callback({ signal, mediaTime, presentedFrames, decodedFrames: decoded() });
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (
        _now: number,
        metadata: { mediaTime?: number; presentedFrames?: number },
      ): void => {
        if (!owns()) return;
        this.handle = null;
        if (hasPicture()) {
          finish(
            'video-frame-callback',
            Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime! : null,
            Number.isFinite(metadata?.presentedFrames) ? metadata.presentedFrames! : null,
          );
        } else if (owns()) this.handle = video.requestVideoFrameCallback!(tick);
      };
      this.handle = video.requestVideoFrameCallback(tick);
      return 'video-frame-callback';
    }
    const baseTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const baseFrames = decoded();
    let previous = baseTime;
    let streak = 0;
    const poll = (): void => {
      if (!owns()) return;
      this.timer = null;
      const t = video.currentTime;
      const hasAdvanced = Number.isFinite(t) && t > previous && t > baseTime;
      if (Number.isFinite(t)) previous = Math.max(previous, t);
      streak = hasPicture() && !video.paused && hasAdvanced ? streak + 1 : 0;
      const frames = decoded();
      if (streak >= 2 && (baseFrames === null || (frames !== null && frames > baseFrames))) {
        finish('time-progress', Number.isFinite(t) ? t : null, null);
        return;
      }
      if (owns()) this.timer = unrefTimer(globalThis.setTimeout(poll, POLL_MS));
    };
    this.timer = unrefTimer(globalThis.setTimeout(poll, POLL_MS));
    return 'time-progress';
  }

  cancel(): void {
    this.epoch++;
    const handle = this.handle;
    const timer = this.timer;
    this.handle = null;
    this.timer = null;
    if (handle !== null) {
      try {
        this.video.cancelVideoFrameCallback?.(handle);
      } catch {
        // A stale epoch already ignores the callback.
      }
    }
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}
