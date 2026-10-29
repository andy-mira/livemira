/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/recognition. Only re-exports belong here.
export {
  ANMS_POOL_LIMIT,
  ANMS_ROBUSTNESS,
  ANMS_SELECTION_ID,
  anmsRadiiSquared,
  selectAnms,
} from './features/anms.ts';
export { BRIEF_PATTERN } from './features/brief.ts';
export {
  extractFeatures,
  type ExtractOptions,
  type FeatureExtraction,
  type LocalFeature,
} from './features/extract.ts';
export type { CornerCandidate, Roi } from './features/harris.ts';
export { buildPyramid, type PyramidLevel } from './features/pyramid.ts';
export { fitHomography, hullArea, project, validateHomography } from './geometry/homography.ts';
export { verifyGeometry, type GeometryOptions, type GeometryResult } from './geometry/ransac.ts';
export { RECOGNITION_LIMITS, validateGray, type GrayImage } from './image/gray-image.ts';
export {
  hamming,
  matchPacked,
  packDescriptors,
  type DescribedPoint,
  type PointPair,
} from './matching/packed-matcher.ts';
export type {
  ExactMatcher,
  ExactMatchRequest,
  RecognitionBatch,
  RecognitionFacts,
  RecognitionObservation,
  RecognitionPassFacts,
  TargetRejection,
} from './recognition-types.ts';
export { Recognizer, type RecognizeOptions, type RecognizerOptions } from './recognizer.ts';
export { INTERMEDIATE_SCALE, intermediateScaleImage } from './scale/intermediate-scale.ts';
export {
  pointDistribution,
  UNIFORM_AXIS_VARIANCE,
  type PointDistribution,
} from './stats/point-distribution.ts';
export {
  ALGORITHM_VERSION,
  COMPILER_VERSION,
  diagnoseFeatures,
  featuresFromTarget,
  preflightTarget,
  preprocessingRecord,
  sha256Hex,
  TARGET_LEVELS,
  TARGET_MAX_FEATURES,
  validateTarget,
} from './targets/target-validation.ts';
export {
  MAX_TRACE_MS,
  MAX_TRACE_PASSES,
  MAX_TRACE_REJECTIONS,
  MAX_TRACE_TEXT,
  traceForFrame,
  traceOf,
  type RecognitionTrace,
  type RecognitionTracePass,
  type RecognitionTraceStageMs,
} from './trace.ts';
