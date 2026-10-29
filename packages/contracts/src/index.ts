// SPDX-License-Identifier: Apache-2.0
// Public entry of @livemira-next/contracts. Only re-exports belong here.

export type { FrameHandle, FrameTime, ImageResidency } from './frame.ts';
export {
  cornersOf,
  identity3,
  mat3,
  project,
  type Corners,
  type Intrinsics,
  type Mat3,
  type Point2,
  type RectPx,
} from './geometry.ts';
export { grayImage, type GrayImage, type ImagePyramid, type PyramidLevel } from './image.ts';
export type {
  Correspondences,
  Detector,
  FeatureExtractor,
  FrameTracker,
  GeometryVerifier,
  Keypoints,
  LoadReport,
  TargetImage,
  PoseFilter,
  PyramidBuilder,
  Rejection,
  TargetAsset,
  TargetIndex,
  TargetInfo,
  TrackInput,
  VisionPipeline,
} from './layers.ts';
export {
  probeRequirements,
  type Capability,
  type Determinism,
  type Layer,
  type Module,
  type ModuleContext,
  type ModuleInfo,
  type ProbeResult,
  type Route,
  type TelemetrySink,
} from './module.ts';
export type { FrameOutput, PoseEstimate, PoseOrigin, PoseQuality, StageTimings, TrackState } from './pose.ts';
