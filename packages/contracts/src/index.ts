/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/contracts. Only re-exports belong here.
export { EngineError, type EngineErrorOptions, type ErrorCode } from './errors.ts';
export type {
  CoreEvents,
  EventContext,
  ViewportTransition,
  ViewportTransitionReason,
} from './events.ts';
export type { Frame, FrameIdentity, FrameImage, FrameTiming, OwnedImage } from './frame.ts';
export type { FrameGeometry, RectPx } from './geometry.ts';
export { IDENTITY_3, normalizeHomography, type Corners, type Mat3, type Point2 } from './math.ts';
export {
  validateTargetBundle,
  type TargetBundle,
  type TargetDiagnostic,
  type TargetFeatures,
  type TargetPyramidLevel,
} from './target.ts';
export {
  MAX_MATCHED_POINTS,
  type MatchedPoints,
  type PredictionInfo,
  type TrackingQuality,
  type TrackingReason,
  type TrackingResult,
  type TrackingState,
} from './tracking-result.ts';
