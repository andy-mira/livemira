/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The owner of one media element: configuration, play and pause, muting, gesture retry, loop recovery, presentable
// first-frame detection and playback recovery. No tracking-state inference and no automatic network retries.
//
// Every play request has a generation. Host property reads, setters and callbacks can cancel a request synchronously,
// so state is written only while the request still owns the session.

import { EngineError } from '@livemira/contracts';

import { DEFAULT_PLAYBACK_RECOVERIES } from './adapters/wechat-ios-bridge.ts';
import { LoopWatch } from './loop-watch.ts';
import type {
  MediaConfig,
  PresentableFrame,
  PresentableSignal,
  VideoSessionEvent,
  VideoSnapshot,
} from './media-types.ts';
import { findRecovery, type PlaybackRecovery, type RecoveryAttempt } from './playback-recovery.ts';
import { PresentableFrameWatch } from './presentable-frame.ts';

const CANCELLED: unique symbol = Symbol('cancelled');

const MEDIA_ERROR_REASONS: Readonly<Record<number, string>> = Object.freeze({
  1: 'media-aborted',
  2: 'media-network-error',
  3: 'media-decode-error',
  4: 'media-source-not-supported',
});

// Reading the play property may run host code that cancels this request; ownership is checked again before calling it.
const callPlay = (video: HTMLVideoElement, owns: () => boolean): Promise<unknown> => {
  try {
    const play = video.play;
    if (!owns()) return Promise.resolve(CANCELLED);
    return Promise.resolve(play.call(video));
  } catch (error) {
    return Promise.reject(error);
  }
};

interface PlayRequest {
  recovery: RecoveryAttempt | null;
  readonly cancelled: Promise<typeof CANCELLED>;
  abort(): void;
}

export interface VideoSessionOptions {
  readonly onEvent?: (event: VideoSessionEvent) => void;
  /** Tried in order after a blocked native play(); default: the WeChat bridge on iOS WeChat. */
  readonly recoveries?: readonly PlaybackRecovery[];
}

const disposedError = (): EngineError =>
  new EngineError('DISPOSED', 'Media session disposed', { isRecoverable: false });

/** Validates a media configuration; throws INVALID_CONFIG. */
export function validateMediaConfig(config: MediaConfig): void {
  const isOneOf = (value: unknown, allowed: readonly unknown[]): boolean =>
    value === undefined || allowed.includes(value);
  if (
    !config ||
    !config.url ||
    !isOneOf(config.fit, ['contain', 'cover']) ||
    !isOneOf(config.onLost, ['pause-and-hide', 'hide']) ||
    !isOneOf(config.onResume, ['resume', 'restart']) ||
    !isOneOf(config.playbackRecovery, ['auto', 'off']) ||
    !isOneOf(config.crossOrigin, ['anonymous', 'use-credentials', null])
  ) {
    throw new EngineError('INVALID_CONFIG', 'Invalid media configuration', {
      isRecoverable: false,
    });
  }
}

export class VideoSession {
  private generation = 0;
  private isDisposed = false;
  private isActive = false;
  private restoreTime: number | null = null;
  private onResume: 'resume' | 'restart' = 'resume';
  private playbackRecovery: 'auto' | 'off' = 'auto';
  private isLooping = true;
  private request: PlayRequest | null = null;
  private playbackPath: string | null = null;
  private recoveryAttempts = 0;
  private readonly video: HTMLVideoElement;
  private readonly onEvent: (event: VideoSessionEvent) => void;
  private readonly recoveries: readonly PlaybackRecovery[];
  private readonly loop: LoopWatch;
  private readonly presentable: PresentableFrameWatch;
  private readonly onError: () => void;
  private readonly onMetadata: () => void;
  private readonly onEnded: () => void;

  constructor(video: HTMLVideoElement, options: VideoSessionOptions = {}) {
    this.video = video;
    this.onEvent = options.onEvent ?? (() => {});
    this.recoveries = options.recoveries ?? DEFAULT_PLAYBACK_RECOVERIES;
    this.loop = new LoopWatch({
      video,
      isPlaying: () => !this.isDisposed && this.isActive,
      isLooping: () => this.isLooping,
      generation: () => this.generation,
      replay: () => void this.play(false),
    });
    this.presentable = new PresentableFrameWatch(video, () => this.isDisposed);
    this.onEnded = () => {
      if (this.isActive && this.isLooping && video.ended && this.loop.isNearEnd())
        this.loop.recover();
    };
    this.onMetadata = () => {
      if (this.isActive && this.isLooping && !this.loop.isArmed) this.loop.arm();
      if (this.restoreTime === null) return;
      const time = this.restoreTime;
      this.restoreTime = null;
      try {
        video.currentTime = Number.isFinite(video.duration)
          ? Math.min(time, Math.max(0, video.duration - 0.001))
          : time;
      } catch {
        // A non-seekable stream cannot restore its time.
      }
    };
    this.onError = () => {
      this.isActive = false;
      this.generation++;
      this.cancelRequest();
      this.loop.cancel();
      this.presentable.cancel();
      const reason = MEDIA_ERROR_REASONS[video.error?.code ?? 0] ?? 'media-error';
      this.onEvent({
        type: 'failure',
        error: new EngineError('MEDIA_FAILED', reason, { isRecoverable: true }),
        detail: 'MEDIA_LOAD_OR_DECODE',
      });
    };
    video.addEventListener('error', this.onError);
    video.addEventListener('loadedmetadata', this.onMetadata);
    video.addEventListener('ended', this.onEnded);
  }

  /** Stops any playback and loads the configured media. */
  configure(config: MediaConfig): void {
    if (this.isDisposed) throw disposedError();
    validateMediaConfig(config);
    const isMuted = config.isMuted ?? true;
    const isLooping = config.isLooping ?? true;
    this.stop();
    this.onResume = config.onResume ?? 'resume';
    this.playbackRecovery = config.playbackRecovery ?? 'auto';
    this.playbackPath = null;
    this.recoveryAttempts = 0;
    this.isLooping = Boolean(isLooping);
    this.loop.reset();
    const video = this.video;
    video.muted = isMuted;
    video.loop = isLooping;
    video.playsInline = true;
    video.defaultMuted = isMuted;
    video.preload = 'metadata';
    video.crossOrigin = config.crossOrigin === undefined ? 'anonymous' : config.crossOrigin;
    video.src = config.url;
    video.load();
  }

  /**
   * Plays the configured media; `isRestart` rewinds first when the media restarts on resume. Resolves true once
   * playback started, false when it failed (reported through the event) or a newer request replaced this one.
   */
  async play(isRestart = true): Promise<boolean> {
    if (this.isDisposed) throw disposedError();
    this.cancelRequest();
    const generation = ++this.generation;
    this.isActive = true;
    let abort: () => void = () => {};
    const cancelled = new Promise<typeof CANCELLED>((resolve) => {
      abort = () => resolve(CANCELLED);
    });
    const request: PlayRequest = { recovery: null, cancelled, abort: () => abort() };
    this.request = request;
    const owns = (): boolean =>
      this.request === request && generation === this.generation && !this.isDisposed;
    try {
      let isFailed = false;
      let error: unknown;
      try {
        if (isRestart && this.onResume === 'restart') this.video.currentTime = 0;
        if (!owns()) return false;
        this.playbackPath = 'native';
        // Native play() is issued first, in the caller's stack. Cancellation settles this wait; a late rejection is
        // still consumed by the race.
        if ((await Promise.race([callPlay(this.video, owns), cancelled])) === CANCELLED)
          return false;
      } catch (e) {
        isFailed = true;
        error = e;
      }
      if (isFailed) {
        if (!owns()) return false;
        const recovery =
          (error as { name?: string } | null)?.name === 'NotAllowedError' &&
          this.playbackRecovery === 'auto'
            ? findRecovery(this.recoveries, this.video)
            : null;
        // The applicability checks can run host code; a cancelled request must not continue to either path.
        if (!owns()) return false;
        if (recovery) {
          const attempt = recovery.prepare(this.video, () => owns() && this.isActive);
          // Register for cancellation and count the attempt before any host code runs.
          request.recovery = attempt;
          this.recoveryAttempts++;
          this.playbackPath = recovery.id;
          attempt.start();
          const outcome = await attempt.result;
          if (outcome.status === 'cancelled') return false;
          if (outcome.status === 'played') isFailed = false;
          else if (outcome.error !== undefined) error = outcome.error;
          if (generation !== this.generation || this.isDisposed) return false;
        }
      }
      if (!isFailed) {
        // stop() and configure() already paused the old request; never pause a newer play.
        if (generation !== this.generation || !this.isActive) return false;
        this.loop.arm();
        return true;
      }
      if (!owns()) return false;
      this.isActive = false;
      const name = (error as { name?: string } | null)?.name;
      if (name === 'NotAllowedError') {
        this.onEvent({ type: 'playbackBlocked', reason: 'playback-gesture-required' });
      } else {
        const reason =
          name === 'NotSupportedError' ? 'media-source-not-supported' : 'media-play-failed';
        this.onEvent({
          type: 'failure',
          error: new EngineError('MEDIA_FAILED', reason, { isRecoverable: true, cause: error }),
          detail: 'MEDIA_PLAY_FAILED',
        });
      }
      return false;
    } finally {
      // Only clear this request; a newer play owns the slot.
      if (this.request === request) this.request = null;
    }
  }

  private cancelRequest(): void {
    const request = this.request;
    if (!request) return;
    this.request = null;
    request.recovery?.cancel();
    request.abort();
  }

  /** Call directly within a user gesture after playbackBlocked. */
  resumeFromGesture(): Promise<boolean> {
    return this.play(false);
  }

  setMuted(isMuted: boolean): void {
    if (this.isDisposed) throw disposedError();
    this.video.muted = Boolean(isMuted);
    this.video.defaultMuted = Boolean(isMuted);
  }

  /** Reloads the element and plays again (keeping the position unless the media restarts on resume). */
  retryFromGesture(): Promise<boolean> {
    if (this.isDisposed) throw disposedError();
    const time = this.video.currentTime;
    this.pause();
    this.restoreTime =
      this.onResume !== 'restart' && Number.isFinite(time) && time > 0 ? time : null;
    this.video.load();
    return this.play();
  }

  getSnapshot(): VideoSnapshot {
    const video = this.video;
    const quality = video.getVideoPlaybackQuality?.();
    return {
      isPaused: video.paused,
      isMuted: video.muted,
      isPlaysInline: video.playsInline,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      readyState: video.readyState,
      networkState: video.networkState,
      widthPx: video.videoWidth,
      heightPx: video.videoHeight,
      errorCode: video.error?.code ?? null,
      decodedFrames: quality?.totalVideoFrames ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
      isLooping: Boolean(video.loop),
      isEnded: Boolean(video.ended),
      loopRecoveries: this.loop.loopRecoveries,
      playbackPath: this.playbackPath,
      recoveryAttempts: this.recoveryAttempts,
    };
  }

  pause(): void {
    this.generation++;
    this.isActive = false;
    this.cancelRequest();
    this.loop.cancel();
    this.video.pause();
  }

  /**
   * Calls back once when the current request has a presentable picture. A newer call, stop(), configure(), a media
   * error and dispose() cancel it; pause() does not (a hidden, paused element resumes the same request).
   */
  awaitPresentableFrame(callback: (frame: PresentableFrame) => void): PresentableSignal {
    if (this.isDisposed) throw disposedError();
    return this.presentable.await(callback);
  }

  cancelPresentable(): void {
    this.presentable.cancel();
  }

  stop(): void {
    this.restoreTime = null;
    this.pause();
    this.presentable.cancel();
    this.video.removeAttribute('src');
    this.video.srcObject = null;
    this.video.load();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stop();
    this.video.removeEventListener('error', this.onError);
    this.video.removeEventListener('loadedmetadata', this.onMetadata);
    this.video.removeEventListener('ended', this.onEnded);
  }
}
