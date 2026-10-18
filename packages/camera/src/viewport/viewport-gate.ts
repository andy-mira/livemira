/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Orientation and viewport stabilization. Any trigger (orientation, container or viewport resize, intrinsic video
// resize, geometry change, or a frame whose measured view or geometry differs from the open one) immediately masks the
// camera region and increases the epoch; capture work begun under an older epoch is dropped. The gate reopens only on
// fresh frames, in two steps:
//   1. settle: N consecutive frames captured under the current epoch with identical geometry, the measured view equal
//      to the view at capture, a quiet period since the last trigger, and (after an orientation change) an intrinsic
//      size swap or a bounded wait. The last of them prepares the new preview geometry while the mask is still up;
//      then the gate waits for the browser to paint it (two animation frames, skipped where they do not exist).
//   2. confirm: a frame whose capture began after that paint is re-validated against the prepared state (epoch, view,
//      intrinsic size, signature, stability). Only then is its geometry applied and the mask removed, in that order,
//      followed by the end notification.
// A paint on its own never reopens the gate and no frame means no reopening. Timers are never used.

import {
  EngineError,
  type ViewportTransition,
  type ViewportTransitionReason,
} from '@livemira/contracts';

import {
  containerGeometry,
  hasLayoutTurned,
  layoutSize,
  measureView,
  type MeasuredElement,
  type ViewportEnvironment,
} from './viewport-measure.ts';

export interface ViewportStabilization {
  /** Consecutive frames with identical geometry before the gate settles; default 2. */
  readonly stableFrames: number;
  /** Quiet period after the last trigger; default 100 ms. */
  readonly quietMs: number;
  /** After a turn, how long to wait for the camera to swap its intrinsic size; default 400 ms. */
  readonly orientationIntrinsicWaitMs: number;
}

export const DEFAULT_VIEWPORT_STABILIZATION: ViewportStabilization = Object.freeze({
  stableFrames: 2,
  quietMs: 100,
  orientationIntrinsicWaitMs: 400,
});

/** Taken when a capture starts; valid only while the epoch and view stay unchanged. */
export interface GateToken {
  readonly epoch: number;
  readonly view: string;
  /** The prepared state that was already painted when the capture started, if any. */
  readonly prepared: PreparedState | null;
}

interface PreparedState {
  readonly epoch: number;
  readonly sig: string;
  readonly dims: string;
  isPainted: boolean;
}

export interface GateStages {
  /** Applies the frame's preview geometry while the mask is still up. */
  readonly prepare?: () => void;
  /** Applies everything the frame's geometry owns (preview and published geometry) right before unmasking. */
  readonly commit?: () => void;
}

export interface ViewportGateStats {
  transitions: number;
  triggers: number;
  preparedGeometries: number;
  droppedFrames: number;
  staleEpochDrops: number;
  lastReason: ViewportTransitionReason | null;
  lastOpenedEpoch: number | null;
}

export interface ViewportGateOptions {
  readonly env: ViewportEnvironment;
  readonly container?: MeasuredElement | null;
  readonly nowUs: () => number;
  readonly onTransition?: (transition: ViewportTransition) => void;
  readonly setMask?: (isMasked: boolean) => void;
  readonly stabilization?: Partial<ViewportStabilization>;
}

export class ViewportGate {
  epoch = 0;
  isGated = false;
  private isDisposed = false;
  private stable = 0;
  private lastSig: string | null = null;
  private openSig: string | null = null;
  private openDims: string | null = null;
  private stableSinceUs = 0;
  private lastTriggerUs = 0;
  private intrinsicWaitUntilUs = 0;
  private preDims: string | null = null;
  private prepared: PreparedState | null = null;
  private paintRequest: number | null = null;
  private isTurnWait = false;
  private view: string;
  private openLayout: readonly [number, number] | null;
  private readonly stableFrames: number;
  private readonly quietUs: number;
  private readonly intrinsicWaitUs: number;
  private readonly cleanups: (() => void)[] = [];
  private readonly env: ViewportEnvironment;
  private readonly container: MeasuredElement | null;
  private readonly nowUs: () => number;
  private readonly onTransition: (transition: ViewportTransition) => void;
  private readonly setMask: (isMasked: boolean) => void;
  readonly stats: ViewportGateStats = {
    transitions: 0,
    triggers: 0,
    preparedGeometries: 0,
    droppedFrames: 0,
    staleEpochDrops: 0,
    lastReason: null,
    lastOpenedEpoch: null,
  };

  constructor(options: ViewportGateOptions) {
    const o = { ...DEFAULT_VIEWPORT_STABILIZATION, ...options.stabilization };
    if (
      !Number.isSafeInteger(o.stableFrames) ||
      o.stableFrames < 1 ||
      !Number.isFinite(o.quietMs) ||
      o.quietMs < 0 ||
      !Number.isFinite(o.orientationIntrinsicWaitMs) ||
      o.orientationIntrinsicWaitMs < 0
    ) {
      throw new EngineError('INVALID_CONFIG', 'Invalid viewport stabilization options', {
        isRecoverable: false,
      });
    }
    this.env = options.env;
    this.container = options.container ?? null;
    this.nowUs = options.nowUs;
    this.onTransition = options.onTransition ?? (() => {});
    this.setMask = options.setMask ?? (() => {});
    this.stableFrames = o.stableFrames;
    this.quietUs = o.quietMs * 1000;
    this.intrinsicWaitUs = o.orientationIntrinsicWaitMs * 1000;
    this.view = this.measure();
    this.openLayout = layoutSize(this.env);
    this.listen();
  }

  private listen(): void {
    const env = this.env;
    const on = (
      target: Partial<EventTarget> | undefined | null,
      name: string,
      fn: () => void,
    ): void => {
      if (typeof target?.addEventListener !== 'function') return;
      target.addEventListener(name, fn);
      this.cleanups.push(() => target.removeEventListener?.(name, fn));
    };
    on(env.screen?.orientation, 'change', () => this.trigger('orientation', true));
    on(env as Partial<EventTarget>, 'orientationchange', () => this.trigger('orientation', true));
    on(env as Partial<EventTarget>, 'resize', () => this.check('resize'));
    on(env.visualViewport, 'resize', () => this.check('visual-viewport'));
    if (this.container && typeof env.ResizeObserver === 'function') {
      const observer = new env.ResizeObserver(() => this.check('container'));
      observer.observe(this.container as unknown as Element);
      this.cleanups.push(() => observer.disconnect());
    }
  }

  /** Watches the camera video for intrinsic size changes. */
  attachVideo(video: Partial<EventTarget>): void {
    if (this.isDisposed || typeof video?.addEventListener !== 'function') return;
    const fn = (): void => this.trigger('intrinsic', false);
    video.addEventListener('resize', fn);
    this.cleanups.push(() => video.removeEventListener?.('resize', fn));
  }

  /** The container's current CSS size and pixel ratio, or null without a usable container. */
  viewportGeometry(): ReturnType<typeof containerGeometry> {
    return containerGeometry(this.container, this.env);
  }

  private measure(): string {
    return measureView(this.container, this.env);
  }

  /** Resize-class events trigger only when the measured view really changed. */
  private check(reason: ViewportTransitionReason): void {
    if (this.isDisposed) return;
    if (this.measure() !== this.view) this.trigger(reason, false);
  }

  /** Masks immediately and starts a new epoch. */
  trigger(reason: ViewportTransitionReason, isOrientation: boolean): void {
    if (this.isDisposed) return;
    this.view = this.measure();
    const now = this.nowUs();
    this.epoch++;
    this.stable = 0;
    this.lastSig = null;
    this.lastTriggerUs = now;
    this.stableSinceUs = now;
    this.discardPrepared();
    // Whatever fired first, a turned layout means the camera may still swap. An inferred turn starts its wait once per
    // closed gate, until the next end: later resizes never re-arm or extend the bound.
    const isInferred =
      !isOrientation && hasLayoutTurned(this.openLayout, layoutSize(this.env)) && !this.isTurnWait;
    if (isInferred) isOrientation = true;
    this.stats.triggers++;
    this.stats.lastReason = reason;
    if (isOrientation) {
      this.isTurnWait = true;
      this.preDims ??= this.openDims;
      this.intrinsicWaitUntilUs = now + this.intrinsicWaitUs;
    }
    if (!this.isGated) {
      this.isGated = true;
      this.stats.transitions++;
    }
    this.setMask(true);
    this.onTransition({ phase: 'begin', epoch: this.epoch, reason });
  }

  /** Taken when a capture starts. It can confirm only if the prepared geometry was already painted at this moment. */
  begin(): GateToken {
    return {
      epoch: this.epoch,
      view: this.measure(),
      prepared: this.prepared?.isPainted ? this.prepared : null,
    };
  }

  /**
   * Called with a fully captured frame; true means the frame may be delivered. `sig` identifies the frame's geometry
   * inputs and `dims` its intrinsic size. The stages may re-enter the gate.
   */
  admit(token: GateToken, sig: string, dims: string, stages: GateStages = {}): boolean {
    if (this.isDisposed) return false;
    if (token.epoch !== this.epoch) {
      this.stats.staleEpochDrops++;
      this.stats.droppedFrames++;
      return false;
    }
    if (this.container && !this.viewportGeometry()) {
      if (!this.isGated) this.trigger('empty-container', false);
      this.stats.droppedFrames++;
      return false;
    }
    const view = this.measure();
    if (view !== token.view || view !== this.view) {
      this.trigger('frame-view', false);
      this.stats.droppedFrames++;
      return false;
    }
    if (!this.isGated) {
      if (this.openSig !== null && sig !== this.openSig) {
        this.trigger('frame-geometry', false);
        this.stats.droppedFrames++;
        return false;
      }
      this.openSig = sig;
      this.openDims = dims;
      return true;
    }
    return this.admitWhileGated(token, sig, dims, stages);
  }

  private admitWhileGated(
    token: GateToken,
    sig: string,
    dims: string,
    { prepare = () => {}, commit = () => {} }: GateStages,
  ): boolean {
    const now = this.nowUs();
    if (sig !== this.lastSig) {
      this.stable = 1;
      this.stableSinceUs = now;
      this.discardPrepared();
    } else this.stable++;
    this.lastSig = sig;
    const isIntrinsicReady =
      now >= this.intrinsicWaitUntilUs || !this.preDims || dims !== this.preDims;
    if (
      this.stable < this.stableFrames ||
      now - this.stableSinceUs < this.quietUs ||
      !isIntrinsicReady
    ) {
      this.discardPrepared();
      this.stats.droppedFrames++;
      return false;
    }
    if (!this.prepared) {
      // Settled. Put the new geometry under the mask and let the browser paint it; this frame is never shown.
      const prepared: PreparedState = { epoch: this.epoch, sig, dims, isPainted: false };
      this.prepared = prepared;
      prepare();
      if (!this.holds(prepared) || !this.viewUnchanged(token)) {
        this.stats.droppedFrames++;
        return false;
      }
      this.stats.preparedGeometries++;
      this.awaitPaint(prepared);
      this.stats.droppedFrames++;
      return false;
    }
    // Paint alone is not enough: the confirming frame must have been captured after the paint, for this prepared state.
    if (
      token.prepared !== this.prepared ||
      !this.prepared.isPainted ||
      this.prepared.sig !== sig ||
      this.prepared.dims !== dims
    ) {
      this.stats.droppedFrames++;
      return false;
    }
    const prepared = this.prepared;
    commit();
    // Applying the geometry can force layout or re-enter: the actual view is measured again right before unmasking.
    if (!this.holds(prepared) || !this.viewUnchanged(token)) {
      this.stats.droppedFrames++;
      return false;
    }
    this.isGated = false;
    this.openSig = sig;
    this.openDims = dims;
    this.preDims = null;
    this.isTurnWait = false;
    this.openLayout = layoutSize(this.env);
    this.stats.lastOpenedEpoch = this.epoch;
    this.discardPrepared();
    this.setMask(false);
    this.onTransition({ phase: 'end', epoch: this.epoch, reason: this.stats.lastReason! });
    return !this.isDisposed && !this.isGated && token.epoch === this.epoch;
  }

  /** Silent view changes (no event delivered) re-arm the gate; false means the frame must not be shown. */
  private viewUnchanged(token: GateToken): boolean {
    if (this.isDisposed) return false;
    const isValid =
      (!this.container || this.viewportGeometry()) &&
      this.measure() === token.view &&
      token.view === this.view;
    if (!isValid) this.trigger('frame-view', false);
    return Boolean(isValid) && !this.isDisposed;
  }

  /** True while the prepared state is still current (a re-entrant trigger, stop or dispose invalidates it). */
  private holds(prepared: PreparedState): boolean {
    return !this.isDisposed && this.prepared === prepared && prepared.epoch === this.epoch;
  }

  /** Two animation frames: the first runs before the next paint, the second after that paint. Without rAF there is nothing to wait for. */
  private awaitPaint(prepared: PreparedState): void {
    const raf = this.env.requestAnimationFrame;
    if (typeof raf !== 'function') {
      prepared.isPainted = true;
      return;
    }
    const request = (fn: () => void): number => raf.call(this.env, fn);
    // A late callback of a discarded wait must not touch the request id of the current one.
    const done = (): void => {
      if (!this.holds(prepared)) return;
      this.paintRequest = null;
      prepared.isPainted = true;
    };
    try {
      this.paintRequest = request(() => {
        if (!this.holds(prepared)) return;
        this.paintRequest = null;
        try {
          this.paintRequest = request(done);
        } catch {
          done();
        }
      });
    } catch {
      this.paintRequest = null;
      prepared.isPainted = true;
    }
  }

  private discardPrepared(): void {
    this.prepared = null;
    const id = this.paintRequest;
    this.paintRequest = null;
    if (id != null) {
      try {
        this.env.cancelAnimationFrame?.(id);
      } catch {
        // Callbacks are also guarded by identity.
      }
    }
  }

  getDiagnostics(): ViewportGateStats & {
    state: 'gated' | 'open';
    phase: 'open' | 'confirming' | 'painting' | 'settling';
    epoch: number;
    stableFrames: number;
    requiredStableFrames: number;
  } {
    return {
      state: this.isGated ? 'gated' : 'open',
      phase: !this.isGated
        ? 'open'
        : this.prepared
          ? this.prepared.isPainted
            ? 'confirming'
            : 'painting'
          : 'settling',
      epoch: this.epoch,
      stableFrames: this.stable,
      requiredStableFrames: this.stableFrames,
      ...this.stats,
    };
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.discardPrepared();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
        // Teardown continues.
      }
    }
    this.setMask(false);
  }
}
