/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EngineError } from '@livemira/contracts';

/** How one target's video plays. */
export interface MediaConfig {
  readonly url: string;
  /** Default true. */
  readonly isMuted?: boolean;
  /** Default true. */
  readonly isLooping?: boolean;
  /** How the video fits the target plane; default 'contain'. */
  readonly fit?: 'contain' | 'cover';
  /** On target loss: pause and hide (default), or only hide while playback continues. */
  readonly onLost?: 'pause-and-hide' | 'hide';
  /** When shown again after a pause: continue (default), or restart from the beginning. */
  readonly onResume?: 'resume' | 'restart';
  /** Default 'anonymous'. */
  readonly crossOrigin?: 'anonymous' | 'use-credentials' | null;
  /** 'auto' (default): after a blocked native play(), try the first applicable playback recovery once. */
  readonly playbackRecovery?: 'auto' | 'off';
}

/**
 * Media state transitions. 'loading' … 'loading-failed' describe one media request's loading → first frame → reveal:
 * 'loading' the request began; 'first-frame' its current frame became presentable; 'reveal-start'/'reveal-end' the
 * circular reveal ran ('reveal-end' without 'reveal-start' = completed without animation: the first frame arrived
 * while hidden, or the reveal duration is 0; a hide during a reveal also ends it early with 'reveal-end');
 * 'reveal-cancel' the request was released before it finished; 'loading-failed' it ended in failure and the spinner
 * was cleared.
 */
export type MediaState =
  | 'shown'
  | 'hidden'
  | 'held'
  | 'hold-recovered'
  | 'play'
  | 'pause'
  | 'waiting'
  | 'playing'
  | 'timeupdate'
  | 'ended'
  | 'error'
  | 'loading'
  | 'first-frame'
  | 'reveal-start'
  | 'reveal-end'
  | 'reveal-cancel'
  | 'loading-failed';

/** Closed set of loading failure reasons; never free text or URLs. */
export const PRESENTATION_FAILURE_REASONS = Object.freeze([
  'media-error',
  'playback-blocked',
  'loading-timeout',
] as const);
export type PresentationFailureReason = (typeof PRESENTATION_FAILURE_REASONS)[number];

/**
 * Bounded numbers describing ONE media request's loading → first frame → reveal progress (never URLs or pixels). Only
 * transition events carry it. Times are milliseconds on the renderer clock, relative to this request's loading start.
 */
export interface MediaPresentationTelemetry {
  /** Renderer-wide counter, +1 for every media request (new media element, gesture retry, blocked-playback retry). */
  readonly requestGeneration: number;
  readonly phase: 'loading' | 'revealing' | 'revealed' | 'failed' | 'cancelled';
  /** Readiness evidence of the first frame; null before it. */
  readonly readySignal: PresentableSignal | null;
  readonly elapsedMs: number;
  /** Loading start → first presentable frame; null until then. */
  readonly firstFrameMs: number | null;
  /** Reveal progress at this event (0 at reveal-start); on reveal-end the actual duration. Null before the reveal. */
  readonly revealElapsedMs: number | null;
  /** Configured reveal duration (0 = none); a reduced-motion cross-fade reports its own shorter value. */
  readonly revealDurationMs: number;
  readonly isReducedMotion: boolean;
  /** Only on 'loading-failed'. */
  readonly failureReason?: PresentationFailureReason;
}

/** The media facts carried by each media state event. */
export interface MediaSnapshot {
  readonly currentTime: number | null;
  readonly decodedFrames: number | null;
  readonly droppedFrames: number | null;
  readonly readyState: number | null;
  readonly isPaused: boolean;
  readonly errorCode: number | null;
  readonly isLooping: boolean;
  readonly duration: number | null;
  readonly isEnded: boolean;
  readonly loopRecoveries: number;
  /** The last issued play attempt ('native' or a playback recovery id), not proof of playback. */
  readonly playbackPath: string | null;
  readonly recoveryAttempts: number;
  /** Loading and reveal progress of the current request; absent when the presentation is disabled. */
  readonly presentation?: MediaPresentationTelemetry;
}

/** What a video session reports about its element. */
export interface VideoSnapshot {
  readonly isPaused: boolean;
  readonly isMuted: boolean;
  readonly isPlaysInline: boolean;
  readonly currentTime: number | null;
  readonly duration: number | null;
  readonly readyState: number;
  readonly networkState: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly errorCode: number | null;
  readonly decodedFrames: number | null;
  readonly droppedFrames: number | null;
  readonly isLooping: boolean;
  readonly isEnded: boolean;
  readonly loopRecoveries: number;
  readonly playbackPath: string | null;
  readonly recoveryAttempts: number;
}

/** How a presentable first frame was recognised. */
export type PresentableSignal = 'video-frame-callback' | 'time-progress';

export interface PresentableFrame {
  readonly signal: PresentableSignal;
  readonly mediaTime: number | null;
  readonly presentedFrames: number | null;
  readonly decodedFrames: number | null;
}

/** A failure of the media (load, decode or play) or a play() the browser blocked until a user gesture. */
export type VideoSessionEvent =
  | { readonly type: 'playbackBlocked'; readonly reason: 'playback-gesture-required' }
  | {
      readonly type: 'failure';
      /** `MEDIA_FAILED`; its message is the reason, e.g. 'media-decode-error'. */
      readonly error: EngineError;
      /** The original fine-grained code: 'MEDIA_LOAD_OR_DECODE' or 'MEDIA_PLAY_FAILED'. */
      readonly detail: 'MEDIA_LOAD_OR_DECODE' | 'MEDIA_PLAY_FAILED';
    };
