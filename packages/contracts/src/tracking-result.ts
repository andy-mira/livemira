/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Corners, Mat3, Point2 } from './math.ts';

export type TrackingState = 'SEARCHING' | 'ACQUIRING' | 'TRACKING' | 'LIMITED' | 'LOST';

/** Why a result has its state. The values are kept from earlier releases so diagnostic logs stay comparable. */
export type TrackingReason =
  | 'original-target-measured'
  | 'confirming-original-match'
  | 'no-valid-original-match'
  | 'duplicate-image'
  | 'prediction-expired';

export interface TrackingQuality {
  readonly inlierCount: number;
  readonly inlierRatio: number;
  readonly reprojectionErrorPx: number | null;
  /** Convex hull area of the inlier target points divided by the target area. */
  readonly spatialCoverage: number;
  readonly isDegenerate: boolean;
  /** True for a result measured in its own frame; false for a prediction or a result without a target. */
  readonly isMeasured: boolean;
}

export interface PredictionInfo {
  /** 0 for a measured result; time since the last measurement for a prediction. */
  readonly ageUs: number;
  /** Observation time of the last measurement this result is based on. */
  readonly lastMeasuredTimeUs: number | null;
  /** Time after which the last measurement may no longer be extrapolated. */
  readonly expiresAtUs: number | null;
}

/** Most matched points a result can carry: feature extraction keeps at most 512 features per frame. */
export const MAX_MATCHED_POINTS = 512;

export interface MatchedPoints {
  readonly sessionId: string;
  readonly frameId: number;
  readonly targetId: string;
  /** Inlier image points of the observation accepted for exactly this frame, in standard-image pixels. */
  readonly pointsPx: readonly Point2[];
}

/** The tracker's verdict for one frame. Pixel quantities are in standard-image pixels. */
export interface TrackingResult {
  readonly sessionId: string;
  readonly frameId: number;
  readonly observationTimeUs: number;
  readonly state: TrackingState;
  readonly reason: TrackingReason;
  readonly targetId: string | null;
  readonly H_imageFromTarget: Mat3 | null;
  /** Target corners (pixel edges) top-left, top-right, bottom-right, bottom-left. */
  readonly cornersPx: Corners | null;
  readonly quality: TrackingQuality;
  readonly prediction: PredictionInfo;
  /** Present only when matched-point collection was requested and this result was measured. */
  readonly matchedPoints?: MatchedPoints;
}
