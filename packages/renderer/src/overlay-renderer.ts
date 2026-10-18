/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The overlay renderer: draws each valid tracking result as a perspective video plane over the camera picture, owns
// the active target's media session, the loading and reveal presentation and the visual hold after a loss. It reads
// only result metadata (no camera pixels) and shares no GPU device.
//
// Observers run inside every event and may stop, switch, hide or update the renderer re-entrantly. Every continuation
// after an event therefore re-checks that the state it acts on is still current.

import { EngineError, type FrameGeometry, type TrackingResult } from '@livemira/contracts';
import {
  validateMediaConfig,
  VideoSession,
  type MediaConfig,
  type MediaPresentationTelemetry,
  type MediaState,
  type PlaybackRecovery,
  type PresentableSignal,
  type PresentationFailureReason,
} from '@livemira/media';

import { clearHoldTimer, isValidGrace, type LossHold } from './loss-hold.ts';
import { MediaBindings } from './media-binding.ts';
import { project } from './plane/perspective.ts';
import { VideoPlane } from './plane/video-plane.ts';
import {
  PlanePresentation,
  REDUCED_REVEAL_MS,
  resolveRevealOptions,
  type ResolvedRevealOptions,
  type RevealOptions,
} from './reveal/plane-presentation.ts';
import {
  pauseBudget,
  presentationTelemetry,
  startBudget,
  type PresentationRequest,
} from './reveal/presentation-state.ts';
import type {
  MediaOptions,
  RendererEvent,
  RendererEventContext,
  TargetMediaSource,
  TargetSize,
} from './renderer-types.ts';

/** A prediction older than this is never shown (the tracker's own prediction limit). */
const MAX_PRESENTABLE_PREDICTION_US = 100_000;
/** `timeupdate` media states are reported at most once per second. */
const TIME_UPDATE_INTERVAL_US = 1_000_000;
const MEDIA_STATES = ['play', 'pause', 'waiting', 'playing', 'timeupdate', 'ended'] as const;

export interface OverlayRendererOptions {
  /** Loading mask and circular reveal on the video plane; default on. `false`: the video simply appears. */
  readonly presentation?: RevealOptions | false;
  readonly recoveries?: readonly PlaybackRecovery[];
  readonly nowUs?: () => number;
}

export interface RendererDiagnostics {
  readonly sessionId: string | null;
  readonly targetId: string | null;
  readonly isVisible: boolean;
  readonly isHolding: boolean;
  readonly isFailed: boolean;
  readonly ownedFileUrls: number;
  readonly media: ReturnType<VideoSession['getSnapshot']> | null;
  readonly presentation: MediaPresentationTelemetry | null;
}

interface MediaContext {
  readonly sessionId: string;
  readonly targetId: string | null;
  readonly media: VideoSession;
}

export class OverlayRenderer {
  private targets = new Map<string, { widthPx: number; heightPx: number }>();
  private readonly bindings = new MediaBindings();
  private container: HTMLElement | null = null;
  private sessionId: string | null = null;
  private activeTarget: string | null = null;
  private plane: VideoPlane | null = null;
  private media: VideoSession | null = null;
  private isVisible = false;
  private isMediaFailed = false;
  private isPresentationAllowed = false;
  private isDisposed = false;
  private lastFrame = -1;
  /** Bumped by every stop(); an update that observes a change during an observer callback has been cancelled. */
  private epoch = 0;
  /** Depth of stop() teardowns in progress; update() refuses new work meanwhile. */
  private stopping = 0;
  private removeMediaListeners: (() => void) | null = null;
  private hold: LossHold | null = null;
  /** The media whose play was blocked; a gesture may resume it while it is still current. */
  private blockedMedia: VideoSession | null = null;
  private readonly listeners = new Set<(event: RendererEvent) => void>();
  private readonly reveal: ResolvedRevealOptions | null;
  private presentation: PresentationRequest | null = null;
  /** +1 for every media request; reported as requestGeneration. */
  private requestSeq = 0;
  /** The request being released: hide() must not snap-complete it (it is reported as cancelled instead). */
  private releasingPresentation: PresentationRequest | null = null;
  private readonly now: () => number;
  private readonly recoveries: readonly PlaybackRecovery[] | undefined;

  constructor(options: OverlayRendererOptions = {}) {
    this.now = options.nowUs ?? (() => performance.now() * 1000);
    this.recoveries = options.recoveries;
    this.reveal = resolveRevealOptions(options.presentation);
  }

  onEvent(listener: (event: RendererEvent) => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private emit(event: RendererEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // Observers cannot interrupt media cleanup or other observers.
      }
    }
  }

  /** Target plane sizes; only while stopped. */
  setTargets(targets: readonly TargetSize[]): void {
    this.assertUsable();
    if (this.sessionId)
      throw new EngineError('INVALID_CONFIG', 'Stop renderer before replacing target dimensions', {
        isRecoverable: true,
      });
    for (const t of targets) {
      if (!t.targetId || ![t.widthPx, t.heightPx].every((v) => Number.isFinite(v) && v > 0))
        throw new EngineError('INVALID_TARGET', 'Invalid target dimensions', {
          isRecoverable: false,
        });
    }
    this.targets = new Map(
      targets.map((t) => [t.targetId, { widthPx: t.widthPx, heightPx: t.heightPx }]),
    );
  }

  async start(container: HTMLElement, sessionId: string): Promise<void> {
    this.assertUsable();
    await this.stop();
    if (!container)
      throw new EngineError(
        'INVALID_CONFIG',
        'The renderer requires a positioned overlay container',
        {
          isRecoverable: false,
        },
      );
    this.container = container;
    this.sessionId = sessionId;
    this.lastFrame = -1;
    container.ownerDocument.addEventListener('visibilitychange', this.onVisibility);
    container.ownerDocument.defaultView?.addEventListener('pagehide', this.onPageHide);
  }

  private readonly onPageHide = (): void => {
    this.hide();
    this.media?.pause();
  };

  private readonly onVisibility = (): void => {
    if (this.container?.ownerDocument.hidden) this.onPageHide();
  };

  private emitMediaState(state: MediaState, presentation?: MediaPresentationTelemetry): void {
    if (!this.sessionId || !this.media) return;
    this.emitMediaStateFor(
      { sessionId: this.sessionId, targetId: this.activeTarget, media: this.media },
      state,
      presentation,
    );
  }

  /** Explicit context, so a release can report the request it just ended after this.media was cleared. */
  private emitMediaStateFor(
    context: MediaContext,
    state: MediaState,
    presentation?: MediaPresentationTelemetry,
  ): void {
    const d = context.media.getSnapshot();
    this.emit({
      type: 'mediaState',
      sessionId: context.sessionId,
      targetId: context.targetId,
      timestampUs: this.now(),
      state,
      media: {
        currentTime: d.currentTime,
        decodedFrames: d.decodedFrames,
        droppedFrames: d.droppedFrames,
        readyState: Number.isFinite(d.readyState) ? d.readyState : null,
        isPaused: Boolean(d.isPaused),
        errorCode: d.errorCode,
        isLooping: d.isLooping,
        duration: d.duration,
        isEnded: d.isEnded,
        loopRecoveries: d.loopRecoveries,
        playbackPath: d.playbackPath,
        recoveryAttempts: d.recoveryAttempts,
        ...(presentation ? { presentation } : {}),
      },
    });
  }

  // ---- Loading and reveal: one presentation request per media request ----

  private ownsPresentation(request: PresentationRequest): boolean {
    return (
      !this.isDisposed &&
      this.presentation === request &&
      this.media === request.media &&
      this.sessionId === request.sessionId &&
      this.activeTarget === request.targetId
    );
  }

  private telemetry(
    request: PresentationRequest,
    failureReason?: PresentationFailureReason,
  ): MediaPresentationTelemetry {
    return presentationTelemetry(request, this.now(), failureReason);
  }

  /** Dim layer, spinner and a readiness watch on the current media; announcing 'loading' is left to the caller. */
  private startPresentation(
    media: VideoSession,
    overlay: PlanePresentation,
    sessionId: string,
    targetId: string,
  ): PresentationRequest {
    const isReduced = overlay.isReducedMotion;
    const revealMs = this.reveal!.revealMs;
    const request: PresentationRequest = {
      generation: ++this.requestSeq,
      media,
      overlay,
      sessionId,
      targetId,
      phase: 'loading',
      signal: null,
      startUs: this.now(),
      firstFrameUs: null,
      revealStartUs: null,
      revealEndUs: null,
      isReduced,
      revealDurationMs: isReduced ? Math.min(revealMs, REDUCED_REVEAL_MS) : revealMs,
      isAnnounced: false,
      budgetMs: this.reveal!.loadingTimeoutMs,
      clockStartUs: null,
      timer: null,
    };
    this.presentation = request;
    overlay.showLoading(isReduced);
    try {
      media.awaitPresentableFrame((frame) => this.onFirstFrame(request, frame.signal));
    } catch {
      // A disposed media session can never become ready.
    }
    return request;
  }

  private announceLoading(request: PresentationRequest): void {
    if (request.isAnnounced || request.phase !== 'loading' || !this.ownsPresentation(request))
      return;
    request.isAnnounced = true;
    this.emitMediaState('loading', this.telemetry(request));
  }

  private startClock(request: PresentationRequest | null): void {
    startBudget(request, this.now, (r) => this.onLoadingTimeout(r));
  }

  private pauseClock(request: PresentationRequest | null): void {
    pauseBudget(request, this.now);
  }

  private onLoadingTimeout(request: PresentationRequest): void {
    request.timer = null;
    if (!this.ownsPresentation(request) || request.phase !== 'loading') return;
    this.failMedia(
      request.media,
      request,
      { sessionId: request.sessionId, targetId: request.targetId, timestampUs: this.now() },
      'media-loading-timeout',
      'loading-timeout',
    );
  }

  /** Only the readiness watch of the current request gets past the ownership check. */
  private onFirstFrame(request: PresentationRequest, signal: PresentableSignal): void {
    if (!this.ownsPresentation(request) || request.phase !== 'loading') return;
    this.pauseClock(request);
    const revealMs = this.reveal!.revealMs;
    request.firstFrameUs = this.now();
    request.signal = signal;
    request.phase = 'revealing';
    request.isReduced = request.overlay.isReducedMotion;
    request.revealDurationMs = request.isReduced ? Math.min(revealMs, REDUCED_REVEAL_MS) : revealMs;
    this.emitMediaState('first-frame', this.telemetry(request));
    if (!this.ownsPresentation(request) || request.phase !== 'revealing') return;
    // Hidden at the first frame: nothing to animate, the finished video is simply there when the plane shows again.
    const duration =
      this.isVisible && !this.container?.ownerDocument.hidden ? request.revealDurationMs : 0;
    if (duration > 0) {
      request.revealStartUs = this.now();
      this.emitMediaState('reveal-start', this.telemetry(request));
      if (!this.ownsPresentation(request) || request.phase !== 'revealing') return;
    }
    request.overlay.reveal({
      durationMs: duration,
      isReduced: request.isReduced,
      onEnd: () => this.onRevealEnd(request),
    });
  }

  private onRevealEnd(request: PresentationRequest): void {
    if (!this.ownsPresentation(request) || request.phase !== 'revealing') return;
    request.phase = 'revealed';
    request.revealEndUs = this.now();
    if (request.revealStartUs === null) request.revealStartUs = request.revealEndUs;
    this.emitMediaState('reveal-end', this.telemetry(request));
  }

  /** Clears spinner and mask of a request that can no longer finish loading; one already revealing completes. */
  private failPresentation(
    request: PresentationRequest | null,
    reason: PresentationFailureReason,
  ): void {
    if (!request || !this.ownsPresentation(request)) return;
    if (request.phase === 'revealing') {
      request.overlay.finish();
      return;
    }
    if (request.phase !== 'loading') return;
    // A failed request must not keep a hidden readiness watch alive; a retry arms a new one.
    this.pauseClock(request);
    request.phase = 'failed';
    request.media.cancelPresentable();
    request.overlay.cancel();
    this.emitMediaState('loading-failed', this.telemetry(request, reason));
  }

  /** Media failure: clear the loading visuals, report 'error', latch, hide, pause, and report MEDIA_FAILED. */
  private failMedia(
    media: VideoSession,
    request: PresentationRequest | null,
    context: RendererEventContext,
    reason: string,
    presentationReason: PresentationFailureReason,
  ): void {
    this.failPresentation(request, presentationReason);
    // Observers may replace the active target. Only state still owned by `media` is changed; once replaced, the
    // failure is still reported with the old context, but nothing of the newer target is latched, hidden or paused.
    if (this.media === media) {
      this.emitMediaState('error');
      if (this.media === media) {
        this.isMediaFailed = true;
        this.hide();
      }
    }
    media.pause();
    this.emit({
      type: 'error',
      ...context,
      error: new EngineError('MEDIA_FAILED', reason, { isRecoverable: true }),
    });
  }

  /**
   * A new request on the same media element: a gesture reload (`isForced`) or a retry after blocked playback (only
   * when that request had failed). An unfinished previous request is reported cancelled.
   */
  private restartPresentation(media: VideoSession, isForced: boolean): void {
    const old = this.presentation;
    if (
      !this.reveal ||
      !old ||
      old.media !== media ||
      !this.ownsPresentation(old) ||
      (!isForced && old.phase !== 'failed')
    )
      return;
    let cancelled: MediaPresentationTelemetry | null = null;
    if (old.phase === 'loading' || old.phase === 'revealing') {
      this.pauseClock(old);
      old.phase = 'cancelled';
      old.overlay.cancel();
      cancelled = this.telemetry(old);
    }
    const request = this.startPresentation(media, old.overlay, old.sessionId, old.targetId);
    if (this.isVisible && !this.container?.ownerDocument.hidden) this.startClock(request);
    if (cancelled)
      this.emitMediaStateFor(
        { sessionId: old.sessionId, targetId: old.targetId, media },
        'reveal-cancel',
        cancelled,
      );
    this.announceLoading(request);
  }

  private isPresentable(result: TrackingResult): boolean {
    const ageUs = result.prediction.ageUs;
    return (
      Boolean(result.targetId) &&
      (result.state === 'TRACKING' || result.state === 'LIMITED') &&
      !result.quality.isDegenerate &&
      (result.quality.isMeasured ||
        (Number.isFinite(ageUs) && ageUs >= 0 && ageUs < MAX_PRESENTABLE_PREDICTION_US))
    );
  }

  /** Creates the media element, session, plane and presentation of a newly active target. */
  private activate(target: { widthPx: number; heightPx: number }, config: MediaConfig): void {
    const container = this.container!;
    const video = container.ownerDocument.createElement('video');
    const sessionId = this.sessionId!;
    const targetId = this.activeTarget!;
    const media: VideoSession = new VideoSession(video, {
      ...(this.recoveries ? { recoveries: this.recoveries } : {}),
      onEvent: (event) => {
        if (this.media !== media) return;
        const context = { sessionId, targetId, timestampUs: this.now() };
        if (event.type === 'playbackBlocked') {
          this.failPresentation(this.presentation, 'playback-blocked');
          if (this.media !== media) return;
          this.blockedMedia = media;
          this.emit({ type: 'playbackBlocked', ...context });
        } else
          this.failMedia(media, this.presentation, context, event.error.message, 'media-error');
      },
    });
    this.media = media;
    let lastTimeUpdate = -Infinity;
    const handlers = new Map<string, () => void>();
    for (const state of MEDIA_STATES) {
      const listener = (): void => {
        if (this.media !== media) return;
        if (state === 'timeupdate') {
          const now = this.now();
          if (now - lastTimeUpdate < TIME_UPDATE_INTERVAL_US) return;
          lastTimeUpdate = now;
        }
        this.emitMediaState(state);
      };
      handlers.set(state, listener);
      video.addEventListener(state, listener);
    }
    this.removeMediaListeners = () => {
      for (const [name, listener] of handlers) video.removeEventListener(name, listener);
    };
    media.configure(config);
    this.isPresentationAllowed = true;
    this.plane = new VideoPlane(container, video, {
      widthPx: target.widthPx,
      heightPx: target.heightPx,
      ...(config.fit ? { fit: config.fit } : {}),
    });
    if (this.reveal) {
      // Decoration must never cost the video: if it cannot be set up, play without it.
      const overlay = new PlanePresentation(this.plane.element, video, {
        widthPx: target.widthPx,
        heightPx: target.heightPx,
        overlayOpacity: this.reveal.overlayOpacity,
        nowMs: () => this.now() / 1000,
        document: container.ownerDocument,
      });
      try {
        this.startPresentation(media, overlay, sessionId, targetId);
      } catch {
        this.presentation = null;
        try {
          overlay.cancel();
          overlay.restoreVideo();
        } catch {
          // Nothing more to undo.
        }
      }
    }
  }

  /**
   * Shows `result` with the geometry of the frame it was computed from. Invalid results hide the overlay (but leave a
   * loss hold running). Throws FRAME_FAILED when the plane cannot be placed.
   */
  async update(result: TrackingResult, geometry: FrameGeometry): Promise<void> {
    this.assertUsable();
    if (
      this.stopping > 0 ||
      !this.container ||
      result.sessionId !== this.sessionId ||
      result.frameId <= this.lastFrame
    )
      return;
    this.lastFrame = result.frameId;
    const epoch = this.epoch;
    if (this.container.ownerDocument.hidden || !this.isPresentable(result)) {
      // An invalid result during a hold neither cancels nor extends it; the timer or a hard clear ends it.
      if (this.hold && !this.container.ownerDocument.hidden) return;
      this.hide();
      return;
    }
    const targetId = result.targetId!;
    const target = this.targets.get(targetId);
    const config = this.bindings.get(targetId);
    if (!target || !config) {
      this.releaseActive(result.frameId);
      return;
    }
    this.isPresentationAllowed = true;
    if (this.activeTarget !== targetId) {
      this.releaseActive(result.frameId);
      // Cancelled by stop/dispose, or superseded by a newer frame submitted from an observer.
      if (this.epoch !== epoch || !this.container || this.lastFrame !== result.frameId) return;
      this.activeTarget = targetId;
      this.activate(target, config);
    }
    try {
      const corners =
        result.cornersPx ??
        (result.H_imageFromTarget
          ? (
              [
                [0, 0],
                [target.widthPx, 0],
                [target.widthPx, target.heightPx],
                [0, target.heightPx],
              ] as const
            ).map(([x, y]) => project(result.H_imageFromTarget!, x, y))
          : null);
      if (!corners) {
        this.hide();
        return;
      }
      this.plane!.place(corners, geometry.H_viewportFromStandard);
      if (this.hold) {
        this.cancelHold();
        this.emitMediaState('hold-recovered');
        if (this.epoch !== epoch || this.lastFrame !== result.frameId) return;
      }
      if (!this.isPresentationAllowed || this.isDisposed || !this.sessionId || this.isMediaFailed) {
        this.plane?.hide();
        return;
      }
      if (!this.isVisible) this.show();
    } catch (error) {
      this.hide();
      throw new EngineError('FRAME_FAILED', String(error), { isRecoverable: true, cause: error });
    }
  }

  /** First visible frame of the plane: start the loading budget, report 'shown', announce loading, play. */
  private show(): void {
    const media = this.media;
    const session = this.sessionId;
    const target = this.activeTarget;
    this.isVisible = true;
    this.startClock(this.presentation);
    this.emitMediaState('shown');
    const isUnchanged = (): boolean =>
      this.isVisible &&
      this.isPresentationAllowed &&
      !this.isDisposed &&
      this.sessionId === session &&
      this.activeTarget === target &&
      this.media === media &&
      media !== null &&
      !this.isMediaFailed &&
      !this.container?.ownerDocument.hidden;
    if (isUnchanged()) {
      if (this.presentation) this.announceLoading(this.presentation);
      if (isUnchanged()) void media!.play();
    }
  }

  private cancelHold(): void {
    const hold = this.hold;
    this.hold = null;
    clearHoldTimer(hold);
  }

  /**
   * Soft hide after a target loss: the last overlay pose and playback stay for `graceMs`, then hide and pause. Idempotent
   * while holding, so repeated loss notifications never re-time it. Returns false when there is nothing to hold.
   */
  holdAfterLoss(graceMs: number): boolean {
    if (this.isDisposed || !this.sessionId || !isValidGrace(graceMs)) return false;
    if (this.hold) return true;
    if (
      !this.isVisible ||
      !this.media ||
      !this.activeTarget ||
      this.isMediaFailed ||
      !this.isPresentationAllowed ||
      this.container?.ownerDocument.hidden
    )
      return false;
    const hold: LossHold = {
      media: this.media,
      sessionId: this.sessionId,
      targetId: this.activeTarget,
      timer: null,
    };
    this.hold = hold;
    hold.timer = setTimeout(() => this.expireHold(hold), graceMs);
    this.emitMediaState('held');
    return true;
  }

  private expireHold(hold: LossHold): void {
    // A cleared hold, switched media, new session or new target makes a late callback a no-op.
    if (
      this.hold !== hold ||
      this.media !== hold.media ||
      this.sessionId !== hold.sessionId ||
      this.activeTarget !== hold.targetId
    )
      return;
    this.hideInternal(true);
  }

  hide(): void {
    this.hideInternal(false);
  }

  private hideInternal(isPauseForced: boolean): void {
    const wasVisible = this.isVisible;
    const wasHolding = this.hold !== null;
    const request = this.presentation;
    this.cancelHold();
    this.isPresentationAllowed = false;
    this.plane?.hide();
    this.pauseClock(request);
    // Ending a hold (timer, or any hard clear during it) always pauses, so hide-only media never keeps playing unseen.
    if (
      this.activeTarget &&
      (isPauseForced || wasHolding || this.bindings.get(this.activeTarget)?.onLost !== 'hide')
    )
      this.media?.pause();
    this.isVisible = false;
    if (wasVisible) this.emitMediaState('hidden');
    // A reveal in progress completes at once while hidden: reacquisition shows the finished video, not a replay. Last
    // on purpose: observers of 'hidden' may already have released or replaced this request.
    if (
      request &&
      request.phase === 'revealing' &&
      this.presentation === request &&
      this.releasingPresentation !== request
    )
      request.overlay.finish();
  }

  /** Sets or replaces one target's media (a URL, or a file the renderer owns an object URL for). */
  setTargetMedia(targetId: string, source: TargetMediaSource, options: MediaOptions = {}): void {
    this.assertUsable();
    if (typeof source === 'object' && source !== null) {
      const url = URL.createObjectURL(source);
      try {
        this.setMediaConfig(targetId, { ...options, url });
        this.bindings.own(targetId, url);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      return;
    }
    this.setMediaConfig(targetId, { ...options, url: source as string });
  }

  private setMediaConfig(targetId: string, config: MediaConfig): void {
    if (!targetId)
      throw new EngineError('INVALID_CONFIG', 'Target and media URL required', {
        isRecoverable: false,
      });
    validateMediaConfig(config);
    if (this.activeTarget === targetId) this.releaseActive();
    this.bindings.set(targetId, config);
  }

  clearTargetMedia(targetId: string): void {
    this.assertUsable();
    if (this.activeTarget === targetId) this.releaseActive();
    this.bindings.delete(targetId);
  }

  /** From a user gesture. Resolves true when playback continued with the new muted state. */
  async setMutedFromGesture(isMuted: boolean): Promise<boolean> {
    this.assertUsable();
    if (!this.media || !this.activeTarget) return false;
    this.bindings.update(this.activeTarget, { isMuted });
    this.media.setMuted(isMuted);
    if (isMuted) return true;
    if (!this.isPresentationAllowed || this.isMediaFailed || this.container?.ownerDocument.hidden)
      return false;
    // The same rule as a retry after blocked playback: a request that failed as blocked starts a new one. The
    // 'loading' observer may stop, switch or hide; resume only the request captured here, if it is still current.
    const media = this.media;
    const session = this.sessionId;
    const target = this.activeTarget;
    const epoch = this.epoch;
    this.restartPresentation(media, false);
    if (
      !this.isStillCurrent(media, session, target, epoch) ||
      !this.isPresentationAllowed ||
      this.isMediaFailed ||
      this.container?.ownerDocument.hidden
    )
      return false;
    return media.resumeFromGesture();
  }

  /** From a user gesture after playbackBlocked: resumes the blocked media while it is current and visible. */
  async resumeBlockedFromGesture(): Promise<boolean> {
    const media = this.blockedMedia;
    if (!media) return false;
    const session = this.sessionId;
    const target = this.activeTarget;
    const epoch = this.epoch;
    if (this.media !== media || !this.isVisible) return false;
    this.restartPresentation(media, false);
    // An observer of the new 'loading' may have stopped or switched: the retry is then inert.
    if (!this.isStillCurrent(media, session, target, epoch) || !this.isVisible) return false;
    return media.resumeFromGesture();
  }

  /** From a user gesture after a media failure: reloads the active media and plays it again. */
  async retryFromGesture(): Promise<boolean> {
    this.assertUsable();
    if (!this.media || !this.isPresentationAllowed || this.container?.ownerDocument.hidden)
      return false;
    this.isMediaFailed = false;
    this.plane?.show();
    this.isVisible = true;
    const media = this.media;
    const retried = media.retryFromGesture();
    // The element was reloaded: a new request, so the old picture is not presentable until a new first frame.
    this.restartPresentation(media, true);
    return retried;
  }

  private isStillCurrent(
    media: VideoSession,
    session: string | null,
    target: string | null,
    epoch: number,
  ): boolean {
    return (
      !this.isDisposed &&
      this.media === media &&
      this.sessionId === session &&
      this.activeTarget === target &&
      this.epoch === epoch
    );
  }

  getDiagnostics(): RendererDiagnostics {
    return {
      sessionId: this.sessionId,
      targetId: this.activeTarget,
      isVisible: this.isVisible,
      isHolding: this.hold !== null,
      isFailed: this.isMediaFailed,
      ownedFileUrls: this.bindings.ownedUrlCount,
      media: this.media?.getSnapshot() ?? null,
      presentation: this.presentation ? this.telemetry(this.presentation) : null,
    };
  }

  /**
   * hide() notifies observers with the old target still active, and they may re-enter stop(), update() or
   * releaseActive(). Ownership is claimed before hide(); if the resources changed meanwhile, the re-entrant call
   * already released them (exactly once) and whatever is current now belongs to a newer operation.
   */
  private releaseActive(frameId?: number): void {
    const removeListeners = this.removeMediaListeners;
    const media = this.media;
    const plane = this.plane;
    const request = this.presentation;
    const context: MediaContext | null =
      media && this.sessionId
        ? { sessionId: this.sessionId, targetId: this.activeTarget, media }
        : null;
    this.releasingPresentation = request;
    try {
      this.hide();
    } finally {
      this.releasingPresentation = null;
    }
    if (
      this.media !== media ||
      this.plane !== plane ||
      this.removeMediaListeners !== removeListeners
    )
      return;
    // An update-initiated release is superseded when an observer accepted a newer frame meanwhile: that frame may
    // reuse these very resources (same target). Unconditional callers (stop, media replacement) pass no frame.
    if (frameId !== undefined && this.lastFrame !== frameId) return;
    this.removeMediaListeners = null;
    this.media = null;
    this.plane = null;
    this.activeTarget = null;
    this.isVisible = false;
    this.isMediaFailed = false;
    this.isPresentationAllowed = false;
    this.presentation = null;
    // An unfinished request is reported as cancelled with its own ids: its callbacks already fail the ownership check.
    let cancelled: MediaPresentationTelemetry | null = null;
    if (request) {
      this.pauseClock(request);
      if (request.phase === 'loading' || request.phase === 'revealing') {
        request.phase = 'cancelled';
        cancelled = this.telemetry(request);
      }
      request.overlay.dispose();
    }
    removeListeners?.();
    media?.dispose();
    plane?.dispose();
    if (cancelled && context) this.emitMediaStateFor(context, 'reveal-cancel', cancelled);
  }

  async stop(): Promise<void> {
    ++this.epoch;
    // Cancellation is effective before any observer runs: updates submitted during this teardown are refused.
    this.stopping++;
    try {
      this.container?.ownerDocument.removeEventListener('visibilitychange', this.onVisibility);
      this.container?.ownerDocument.defaultView?.removeEventListener('pagehide', this.onPageHide);
      this.releaseActive();
    } finally {
      this.stopping--;
      this.container = null;
      this.sessionId = null;
      this.lastFrame = -1;
    }
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    await this.stop();
    this.bindings.dispose();
    this.listeners.clear();
    this.targets.clear();
    this.isDisposed = true;
  }

  private assertUsable(): void {
    if (this.isDisposed)
      throw new EngineError('DISPOSED', 'Renderer disposed', { isRecoverable: false });
  }
}
