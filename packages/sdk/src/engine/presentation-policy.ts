/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Whether and until when a result is shown: a measured result, or a prediction younger than maxPredictionMs, is shown
// until its display deadline; a timer reports 'prediction-expired' when no newer valid result arrives in time. A
// tracking-validity loss may keep the overlay for the visual grace period; every other loss hides at once. Each
// measurement sets an absolute time after which nothing from it stays visible: later notices and late timers only use
// up what is left, they never start a full grace again.
//
// PresentationModes controls this behavior. Motion-adaptive hold keeps a lost overlay in place only as long as
// the target's last motion allows: a fast target is hidden at the first frame without a measurement, a still one may
// stay for the grace. Reconfirmation shows a target again after its overlay was hidden only once it was measured three
// times over at least 50 ms, unless the tracker confirmed it anew itself.
//
// KNOWN-ISSUE: at a transition begin the overlay may stay on top of the mask for about one more frame, until
// the hide reaches the compositor.

import { EngineError, type FrameGeometry, type TrackingResult } from '@livemira/contracts';

import type { EngineEvents, OverlaySink } from './engine-types.ts';
import type { CapturedTargetFrame, LossContextTracker } from './loss-context.ts';
import { MotionModel } from './motion-model.ts';

/** Optional loss-presentation modes; omitted flags are disabled at this layer. */
export interface PresentationModes {
  readonly isMotionAdaptive?: boolean;
  /** With motion-adaptive hold: how long a target of unknown motion (one measurement) may be held; default 0. */
  readonly unknownMotionHoldMs?: number;
  readonly isReconfirmAfterHide?: boolean;
}

/** A still target may stay in place until it could have moved this far (in target diagonals) at its last speed. */
const MOTION_BUDGET_DIAGONALS = 0.05;
/** Reconfirmation after a hide: measurements and the time they must span. */
const RECONFIRM_COUNT = 3;
const RECONFIRM_SPAN_US = 50_000;
/** Longest gap between two measurements that still count as consecutive in a reconfirmation. */
const RECONFIRM_GAP_US = 100_000;

/** What the policy needs from the engine that owns it. */
export interface PresentationHost {
  readonly overlay: OverlaySink;
  readonly clock: () => number;
  readonly losses: LossContextTracker;
  readonly sessionId: string | null;
  readonly isRunning: boolean;
  readonly isAborted: boolean;
  readonly stopGeneration: number;
  readonly transitionEpoch: number;
  sourceNowUs(): number | null;
  context(targetId?: string | null): EngineEvents['ready'];
  emit<K extends keyof EngineEvents>(name: K, event: EngineEvents[K]): void;
}

export class PresentationPolicy {
  activeTarget: string | null = null;
  private visibilityDeadlineUs = -Infinity;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private expiryEpoch = 0;
  private readonly host: PresentationHost;
  private readonly predictionUs: number;
  private readonly graceUs: number;
  private readonly isMotionAdaptive: boolean;
  private readonly unknownHoldUs: number;
  private readonly isReconfirmAfterHide: boolean;
  /** Engine-clock base of the last measurement shown: min(its mapped observation time, its receipt). */
  private measuredBaseUs = -Infinity;
  /** Until when the overlay is held after the last loss; recovery before then needs no reconfirmation. */
  private holdEndUs = -Infinity;
  private readonly motion = new MotionModel();
  private motionTarget: string | null = null;
  /** An overlay was hidden since a target was last shown. */
  private hasHidden = false;
  /** The tracker confirmed a target anew since the hide (it reported ACQUIRING). */
  private isTrackerConfirming = false;
  private confirm: { targetId: string; firstUs: number; lastUs: number; count: number } | null =
    null;

  constructor(
    host: PresentationHost,
    policy: { maxPredictionMs: number; lossDisplayGraceMs: number },
    modes: PresentationModes = {},
  ) {
    this.host = host;
    this.predictionUs = policy.maxPredictionMs * 1000;
    this.graceUs = policy.lossDisplayGraceMs * 1000;
    this.isMotionAdaptive = modes.isMotionAdaptive === true;
    this.unknownHoldUs = (modes.unknownMotionHoldMs ?? 0) * 1000;
    this.isReconfirmAfterHide = modes.isReconfirmAfterHide === true;
  }

  /** Motion of the shown target at its last measurement, for diagnostics. */
  get motionMode(): string {
    return this.motion.mode;
  }

  /** Engine-clock time after which nothing from the last measurement may stay visible. */
  private hideAtUs(): number {
    let budgetUs = this.predictionUs + this.graceUs;
    if (this.isMotionAdaptive) {
      const speed = this.motion.speed;
      if (this.motion.mode === 'fast') budgetUs = Math.min(budgetUs, this.predictionUs);
      else if (this.motion.mode === 'unknown' || speed === null)
        budgetUs = Math.min(budgetUs, this.predictionUs + this.unknownHoldUs);
      else if (speed > 0) budgetUs = Math.min(budgetUs, (MOTION_BUDGET_DIAGONALS / speed) * 1e6);
    }
    return this.measuredBaseUs + budgetUs;
  }

  /** True while a measured result must not be shown yet: a reconfirmation after a hide is still running. */
  private isReconfirming(result: TrackingResult): boolean {
    if (!this.isReconfirmAfterHide || !this.hasHidden || this.isTrackerConfirming) return false;
    if (this.host.clock() < this.holdEndUs) return false;
    const timeUs = result.observationTimeUs;
    const confirm = this.confirm;
    if (
      !confirm ||
      confirm.targetId !== result.targetId ||
      timeUs - confirm.lastUs > RECONFIRM_GAP_US
    ) {
      this.confirm = { targetId: result.targetId!, firstUs: timeUs, lastUs: timeUs, count: 1 };
      return true;
    }
    confirm.count++;
    confirm.lastUs = timeUs;
    if (confirm.count < RECONFIRM_COUNT || timeUs - confirm.firstUs < RECONFIRM_SPAN_US)
      return true;
    this.confirm = null;
    return false;
  }

  /**
   * Shows a valid result (or runs the loss path for an invalid one). `onRenderSubmit` is called right before the
   * overlay update; `onReliable` after a measured result was shown.
   */
  async present(
    result: TrackingResult,
    geometry: FrameGeometry,
    receiptUs: number,
    sample: CapturedTargetFrame,
    onRenderSubmit: () => void,
  ): Promise<void> {
    const host = this.host;
    // Identity is captured before any observer-producing loss, so a stop issued from that observer cancels this.
    const session = host.sessionId;
    const generation = host.stopGeneration;
    const transitionEpoch = host.transitionEpoch;
    const isCancelled = (): boolean =>
      host.isAborted ||
      transitionEpoch !== host.transitionEpoch ||
      host.stopGeneration !== generation ||
      session !== host.sessionId ||
      !host.isRunning;
    const isMeasured = result.quality.isMeasured;
    const ageUs = result.prediction.ageUs;
    const isVisible =
      result.targetId !== null &&
      result.H_imageFromTarget !== null &&
      (result.state === 'TRACKING' || result.state === 'LIMITED') &&
      (isMeasured || (ageUs >= 0 && ageUs < this.predictionUs));
    // Degenerate geometry is already hidden by the overlay; with a display hold it must not look like a live pose.
    if (!isVisible || (this.graceUs > 0 && result.quality.isDegenerate)) {
      if (result.state === 'ACQUIRING' && this.hasHidden) this.isTrackerConfirming = true;
      else this.confirm = null;
      this.lose(result.reason, sample, true);
      return;
    }
    // A fast target is not where it was measured: a pose that is no new measurement is not shown.
    if (
      this.isMotionAdaptive &&
      !isMeasured &&
      this.motion.mode === 'fast' &&
      this.activeTarget === result.targetId
    ) {
      this.lose(result.reason, sample);
      return;
    }
    if (this.activeTarget !== result.targetId) {
      // With no active target, a grace hold may be showing the lost target; the overlay replaces it for a valid new
      // target, so only hard-hide here when a different target is active or grace is off.
      if (this.activeTarget !== null || this.graceUs === 0) this.lose('target-changed', sample);
      if (isCancelled()) return;
      if (result.state !== 'TRACKING' || !isMeasured) {
        this.confirm = null;
        return;
      }
    }
    let deadline = isMeasured
      ? receiptUs + this.predictionUs
      : Math.min(this.visibilityDeadlineUs, receiptUs + this.predictionUs - ageUs);
    if (result.prediction.expiresAtUs != null) {
      const sessionNow = host.sourceNowUs();
      if (sessionNow != null)
        deadline = Math.min(deadline, host.clock() + result.prediction.expiresAtUs - sessionNow);
    }
    if (host.clock() >= deadline) {
      this.confirm = null;
      this.lose('prediction-expired', sample, true);
      return;
    }
    // Only fresh measurements count toward a reconfirmation.
    if (this.activeTarget !== result.targetId && this.isReconfirming(result)) return;
    onRenderSubmit();
    await host.overlay.update(result, geometry);
    if (isCancelled()) return;
    // A result that was rendered but never announced (no active target) must not be held visually.
    if (host.clock() >= deadline) {
      this.lose('prediction-expired', sample, this.activeTarget !== null);
      return;
    }
    if (sample.isMeasured) host.losses.reliable(sample);
    if (isMeasured) {
      this.measuredBaseUs = deadline - this.predictionUs;
      // Motion belongs to one target, and to one showing: shown anew after a hold ended, the old motion is gone.
      const isShownAnew = this.activeTarget !== result.targetId && host.clock() >= this.holdEndUs;
      if (this.motionTarget !== result.targetId || isShownAnew) this.motion.reset();
      this.motionTarget = result.targetId;
      if (result.cornersPx) this.motion.add(result.observationTimeUs, result.cornersPx);
    }
    if (!this.activeTarget) {
      // Shown again: any hold of the previous loss is over (the overlay replaced it).
      this.holdEndUs = -Infinity;
      this.hasHidden = false;
      this.isTrackerConfirming = false;
      this.confirm = null;
      this.activeTarget = result.targetId;
      host.emit('targetFound', { ...host.context(this.activeTarget), result });
      if (isCancelled()) return;
    }
    host.emit('targetUpdated', { ...host.context(this.activeTarget), result });
    if (isCancelled()) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.visibilityDeadlineUs = deadline;
    const remainingUs = Math.max(0, deadline - host.clock());
    const epoch = ++this.expiryEpoch;
    const target = result.targetId;
    // Stale callbacks (cleared too late, or invoked by hand) must not touch a newer session, target or timer.
    this.expiry = setTimeout(() => {
      if (
        epoch !== this.expiryEpoch ||
        session !== host.sessionId ||
        !host.isRunning ||
        this.activeTarget !== target
      )
        return;
      this.lose('prediction-expired', null, true);
    }, remainingUs / 1000);
  }

  private clearExpiry(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    ++this.expiryEpoch;
  }

  /** Synchronous hard clear for stop, dispose and cleanup; never waits and never uses the grace hold. */
  hideNow(): void {
    this.clearExpiry();
    this.holdEndUs = this.host.clock();
    this.motion.reset();
    try {
      this.host.overlay.hide();
    } catch {
      // lose() reports hide failures once the lifecycle reaches it.
    }
  }

  /** `isSoft`: a tracking-validity loss that may use the visual grace hold. Everything else hides at once. */
  lose(reason: string, trigger: CapturedTargetFrame | null = null, isSoft = false): void {
    const host = this.host;
    this.clearExpiry();
    this.visibilityDeadlineUs = -Infinity;
    let isHeld = false;
    const nowUs = host.clock();
    // Only what is left of the last measurement's time; a fast target is not held at all.
    const holdUs =
      this.isMotionAdaptive && this.motion.mode === 'fast'
        ? 0
        : Math.min(this.graceUs, this.hideAtUs() - nowUs);
    if (isSoft && holdUs > 0 && host.isRunning && !host.isAborted && host.overlay.holdAfterLoss) {
      try {
        isHeld = host.overlay.holdAfterLoss(holdUs / 1000) === true;
      } catch {
        isHeld = false;
      }
    }
    // A hold already running keeps its own end; anything not held is hidden now and starts over.
    if (!isHeld) {
      this.holdEndUs = nowUs;
      this.motion.reset();
    } else if (nowUs >= this.holdEndUs) this.holdEndUs = nowUs + holdUs;
    if (this.activeTarget) this.hasHidden = true;
    if (!isHeld) {
      try {
        host.overlay.hide();
      } catch {
        host.emit('error', {
          ...host.context(this.activeTarget),
          error: new EngineError('RESOURCE_FAILED', 'Renderer failed to hide', {
            isRecoverable: true,
          }),
        });
      }
    }
    if (this.activeTarget) {
      const context = host.context(this.activeTarget);
      this.activeTarget = null;
      host.emit('targetLost', {
        ...context,
        reason,
        lossContext: host.losses.describe(host.sessionId, context.targetId, trigger),
      });
    }
    host.losses.forgetReliable();
  }
}
