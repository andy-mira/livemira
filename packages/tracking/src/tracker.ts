/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Tracking state machine. Every frame is recognized against the original targets ("absolute" tracking); the tracker
// confirms a new target over three observations, reports measured poses, extrapolates the last measurement for at
// most 100 ms when a frame brings no valid match, and then declares the target lost.

import {
  EngineError,
  MAX_MATCHED_POINTS,
  validateTargetBundle,
  type FrameIdentity,
  type Point2,
  type TargetBundle,
  type TrackingReason,
  type TrackingResult,
  type TrackingState,
} from '@livemira/contracts';
import type { GrayImage, RecognitionObservation } from '@livemira/recognition';

import { checkObservation, type CheckedObservation } from './observation-check.ts';

/** How long the last measurement may be extrapolated. */
export const PREDICTION_LIMIT_US = 100_000;

/** A standard gray frame as the tracker sees it. */
export interface GrayFrame extends FrameIdentity {
  /** Identity of the picture; a repeated key is treated as the same picture and not recognized again. */
  readonly pictureKey: string;
  /** Session clock time of the observation; must increase strictly. */
  readonly observationTimeUs: number | null;
  readonly image: GrayImage;
}

export type RecognizeFrame = (
  frame: GrayFrame,
  targets: readonly TargetBundle[],
  signal: AbortSignal,
) => Promise<readonly RecognitionObservation[]>;

export interface TrackerOptions {
  /** Recognizes one frame; borrows the frame and settles only when all work on it is done. */
  readonly recognize: RecognizeFrame;
  /** Default false: when true, each measured TRACKING result carries the inlier image points of its own observation. */
  readonly collectMatchedPoints?: boolean;
  /** Longest gap between confirming observations; default 1 s, 0.125..2 s. */
  readonly maxObservationGapUs?: number;
}

type MissReason = Extract<TrackingReason, 'duplicate-image' | 'no-valid-original-match'>;

/** Inlier image points of an accepted observation; null when there are none or more than the contract allows. */
function inlierImagePoints(o: RecognitionObservation): Point2[] | null {
  const points: Point2[] = [];
  for (let i = 0; i < o.imagePoints.length; i++) {
    if (o.inliers[i] === true) points.push([o.imagePoints[i]![0], o.imagePoints[i]![1]]);
  }
  return points.length >= 1 && points.length <= MAX_MATCHED_POINTS ? points : null;
}

/** One tracking pipeline over up to ten targets. One frame at a time. */
export class Tracker {
  private targets: readonly TargetBundle[] = [];
  private session: string | null = null;
  private state: TrackingState = 'SEARCHING';
  /** The last measured result: the source of every prediction. It never carries matched points. */
  private last: TrackingResult | null = null;
  private candidate: string | null = null;
  private count = 0;
  private firstTime = 0;
  private candidateTime = 0;
  private frameId = -1;
  private time = -Infinity;
  private readonly seen = new Set<string>();
  private generation = 0;
  private isDisposed = false;
  private pending: Promise<TrackingResult> | null = null;
  private job: AbortController | null = null;
  private readonly recognize: RecognizeFrame;
  private readonly acquisitionGapUs: number;
  private readonly collectPoints: boolean;

  constructor(options: TrackerOptions) {
    this.recognize = options.recognize;
    this.acquisitionGapUs = options.maxObservationGapUs ?? 1000000;
    if (
      options.collectMatchedPoints !== undefined &&
      typeof options.collectMatchedPoints !== 'boolean'
    ) {
      throw new EngineError('INVALID_CONFIG', 'collectMatchedPoints must be a boolean', {
        isRecoverable: false,
      });
    }
    this.collectPoints = options.collectMatchedPoints === true;
    if (
      !Number.isFinite(this.acquisitionGapUs) ||
      this.acquisitionGapUs < 125000 ||
      this.acquisitionGapUs > 2000000
    ) {
      throw new EngineError(
        'INVALID_CONFIG',
        'Acquisition observation gap must be within 125000..2000000 us',
        {
          isRecoverable: false,
        },
      );
    }
  }

  private assertUsable(): void {
    if (this.isDisposed)
      throw new EngineError('DISPOSED', 'Tracking pipeline disposed', { isRecoverable: false });
  }

  /** Replaces the targets (1..10, unique ids) and forgets the session; only while no frame is processed. */
  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.assertUsable();
    if (this.pending) {
      throw new EngineError('INVALID_CONFIG', 'Cannot replace targets during processing', {
        isRecoverable: true,
      });
    }
    if (
      targets.length < 1 ||
      targets.length > 10 ||
      new Set(targets.map((t) => t.targetId)).size !== targets.length
    ) {
      throw new EngineError('INVALID_TARGET', 'Require 1..10 unique targets', {
        isRecoverable: false,
      });
    }
    targets.forEach(validateTargetBundle);
    this.targets = structuredClone(targets);
    this.clear();
    this.session = null;
  }

  private clear(): void {
    this.state = 'SEARCHING';
    this.last = null;
    this.candidate = null;
    this.count = 0;
    this.frameId = -1;
    this.time = -Infinity;
    this.seen.clear();
  }

  /** Starts a new session: cancels and awaits the frame in progress, then clears all tracking state. */
  async reset(sessionId: string): Promise<void> {
    this.assertUsable();
    if (!sessionId)
      throw new EngineError('INVALID_CONFIG', 'Session required', { isRecoverable: false });
    const generation = ++this.generation;
    this.job?.abort();
    await this.pending?.catch(() => {});
    this.assertUsable();
    if (generation !== this.generation)
      throw new EngineError('ABORTED', 'Reset superseded', { isRecoverable: true });
    this.clear();
    this.session = sessionId;
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    ++this.generation;
    this.job?.abort();
    await this.pending?.catch(() => {});
    this.clear();
    this.targets = [];
    this.session = null;
  }

  /** Tracks one frame. Rejects a second frame while one is in progress. */
  process(frame: GrayFrame, signal: AbortSignal): Promise<TrackingResult> {
    this.assertUsable();
    if (this.pending) {
      return Promise.reject(
        new EngineError('INVALID_CONFIG', 'Only one tracking frame may be in flight', {
          isRecoverable: true,
        }),
      );
    }
    const controller = new AbortController();
    this.job = controller;
    const abort = (): void => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    this.pending = this.run(frame, controller.signal, this.generation).finally(() => {
      signal.removeEventListener('abort', abort);
      this.pending = null;
      this.job = null;
    });
    return this.pending;
  }

  private empty(frame: GrayFrame, time: number, reason: TrackingReason): TrackingResult {
    return {
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      observationTimeUs: time,
      targetId: null,
      state: this.state,
      reason,
      H_imageFromTarget: null,
      cornersPx: null,
      quality: {
        inlierCount: 0,
        inlierRatio: 0,
        reprojectionErrorPx: null,
        spatialCoverage: 0,
        isDegenerate: false,
        isMeasured: false,
      },
      prediction: { ageUs: 0, lastMeasuredTimeUs: null, expiresAtUs: null },
    };
  }

  /** No valid match in this frame: predict from the last measurement, or lose it once it is too old. */
  private miss(frame: GrayFrame, time: number, reason: MissReason): TrackingResult {
    if (this.last) {
      const age = time - this.last.observationTimeUs;
      if (age >= PREDICTION_LIMIT_US) {
        this.state = 'LOST';
        this.last = null;
        this.candidate = null;
        this.count = 0;
        return this.empty(frame, time, 'prediction-expired');
      }
      this.state = 'LIMITED';
      return structuredClone({
        ...this.last,
        frameId: frame.frameId,
        observationTimeUs: time,
        state: this.state,
        quality: { ...this.last.quality, isMeasured: false },
        prediction: { ...this.last.prediction, ageUs: age },
        reason,
      });
    }
    if (reason !== 'duplicate-image') {
      this.candidate = null;
      this.count = 0;
      this.state = 'SEARCHING';
    }
    return this.empty(frame, time, reason);
  }

  private checkFrame(frame: GrayFrame): number {
    const time = frame.observationTimeUs;
    if (
      frame.sessionId !== this.session ||
      !Number.isInteger(frame.frameId) ||
      frame.frameId <= this.frameId
    ) {
      throw new EngineError('FRAME_FAILED', 'Stale session or frame', { isRecoverable: true });
    }
    if (time == null || !Number.isFinite(time) || time < 0 || time <= this.time) {
      throw new EngineError('FRAME_FAILED', 'Require strictly increasing observation time', {
        isRecoverable: true,
      });
    }
    if (!frame.pictureKey)
      throw new EngineError('FRAME_FAILED', 'Require a picture key', { isRecoverable: true });
    return time;
  }

  private async run(
    frame: GrayFrame,
    signal: AbortSignal,
    generation: number,
  ): Promise<TrackingResult> {
    const check = (): void => {
      if (signal.aborted || generation !== this.generation || this.isDisposed) {
        throw new EngineError('ABORTED', 'Tracking job cancelled or superseded', {
          isRecoverable: true,
        });
      }
    };
    check();
    const time = this.checkFrame(frame);
    const duplicate = this.seen.has(frame.pictureKey);
    let observations: readonly RecognitionObservation[];
    try {
      observations = duplicate ? [] : await this.recognize(frame, this.targets, signal);
    } catch (error) {
      if (generation === this.generation && !this.last) {
        this.candidate = null;
        this.count = 0;
        this.state = 'SEARCHING';
      }
      throw error;
    }
    check();
    this.frameId = frame.frameId;
    this.time = time;
    this.seen.add(frame.pictureKey);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value!);
    if (this.state === 'LOST') this.state = 'SEARCHING';
    if (duplicate) return this.miss(frame, time, 'duplicate-image');
    const match = this.selectObservation(frame, observations);
    if (!match) return this.miss(frame, time, 'no-valid-original-match');
    return this.measure(frame, time, match);
  }

  /** The best valid observation: the tracked target's own when one is tracked, otherwise the one with most inliers. */
  private selectObservation(
    frame: GrayFrame,
    observations: readonly RecognitionObservation[],
  ): { observation: RecognitionObservation; checked: CheckedObservation } | undefined {
    const accepted: { observation: RecognitionObservation; checked: CheckedObservation }[] = [];
    for (const observation of observations) {
      if (observation.sessionId !== frame.sessionId || observation.frameId !== frame.frameId)
        continue;
      const target = this.targets.find((t) => t.targetId === observation.targetId);
      if (!target) continue;
      try {
        accepted.push({ observation, checked: checkObservation(observation, target) });
      } catch {
        // An invalid candidate is not evidence of tracking.
      }
    }
    accepted.sort(
      (a, b) =>
        b.checked.quality.inlierCount - a.checked.quality.inlierCount ||
        a.observation.targetId.localeCompare(b.observation.targetId),
    );
    return this.last
      ? accepted.find((x) => x.observation.targetId === this.last!.targetId)
      : accepted[0];
  }

  private measure(
    frame: GrayFrame,
    time: number,
    {
      observation: o,
      checked: c,
    }: { observation: RecognitionObservation; checked: CheckedObservation },
  ): TrackingResult {
    if (!this.last) {
      // Three observations span two inter-observation gaps. Bound both, rather than making a fixed 250 ms window
      // impossible below 8 processed frames per second.
      if (
        this.candidate !== o.targetId ||
        time - this.candidateTime > this.acquisitionGapUs ||
        time - this.firstTime > 2 * this.acquisitionGapUs
      ) {
        this.candidate = o.targetId;
        this.count = 0;
        this.firstTime = time;
      }
      this.candidateTime = time;
      this.count++;
      this.state = 'ACQUIRING';
      if (this.count < 3 || time - this.firstTime < 50000)
        return this.empty(frame, time, 'confirming-original-match');
    }
    this.state = 'TRACKING';
    this.last = {
      ...this.empty(frame, time, 'original-target-measured'),
      targetId: o.targetId,
      H_imageFromTarget: c.h,
      cornersPx: c.corners,
      quality: c.quality,
      prediction: { ageUs: 0, lastMeasuredTimeUs: time, expiresAtUs: time + PREDICTION_LIMIT_US },
    };
    const result = structuredClone(this.last);
    const pointsPx = this.collectPoints ? inlierImagePoints(o) : null;
    if (!pointsPx) return result;
    return {
      ...result,
      matchedPoints: {
        sessionId: frame.sessionId,
        frameId: frame.frameId,
        targetId: o.targetId,
        pointsPx,
      },
    };
  }
}
