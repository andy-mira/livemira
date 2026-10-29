// SPDX-License-Identifier: Apache-2.0

import type { Corners, Mat3 } from './geometry.ts';

export type PoseOrigin = 'detector' | 'tracker' | 'filter' | 'predicted' | 'imu-coasted';

export interface PoseQuality {
  /** Correspondences (or valid template pixels) supporting the pose. */
  readonly support: number;
  /** Fraction of the candidate evidence that agreed, 0..1. */
  readonly ratio: number;
  /** RMS residual in standard-image pixels (geometric) or gray levels (photometric), per `residualKind`. */
  readonly residual: number;
  readonly residualKind: 'px' | 'gray';
  /** Convex hull of the supporting target points over the target area, 0..1. */
  readonly coverage: number;
}

/** A target pose valid at `timeUs`, measured in (or predicted for) frame `frameId`. */
export interface PoseEstimate {
  readonly targetId: string;
  readonly frameId: number;
  readonly timeUs: number;
  readonly H_imageFromTarget: Mat3;
  readonly corners: Corners;
  /** Covariance of the 8 corner coordinates (x0, y0, …, y3), row-major 8×8, or null when unknown. */
  readonly covariance: Float64Array | null;
  readonly quality: PoseQuality;
  readonly origin: PoseOrigin;
}

export type TrackState = 'SEARCHING' | 'CANDIDATE' | 'TRACKING' | 'DEGRADED' | 'COASTING' | 'RELOCALIZING' | 'LOST';

/** Per-stage wall time of one frame, in microseconds, keyed by stage name. */
export type StageTimings = Readonly<Record<string, number>>;

/** What a vision pipeline reports for one frame. */
export interface FrameOutput {
  readonly frameId: number;
  readonly timeUs: number;
  readonly state: TrackState;
  /** Raw measured or tracked poses of this frame (no display filtering). */
  readonly poses: readonly PoseEstimate[];
  /** Poses meant for display (filtered/predicted); equals `poses` without a filter. */
  readonly display: readonly PoseEstimate[];
  /**
   * Display poses extrapolated to `timeUs` from the state after this frame; a snapshot that later frames do not
   * change. Absent when the pipeline cannot predict (the display poses are then held as they are).
   */
  readonly predict?: (timeUs: number) => readonly PoseEstimate[];
  readonly timings: StageTimings;
}
