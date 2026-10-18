/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/camera. Only re-exports belong here.
export {
  createGeometry,
  multiply3,
  transformPoint,
  type GeometryParams,
  type LongEdge,
} from './geometry/frame-geometry.ts';
export { createOwnedImage } from './owned-image.ts';
export { FrameClock, type FrameClockReading } from './capture/frame-clock.ts';
export {
  DEFAULT_VIEWPORT_STABILIZATION,
  ViewportGate,
  type GateStages,
  type GateToken,
  type ViewportGateOptions,
  type ViewportGateStats,
  type ViewportStabilization,
} from './viewport/viewport-gate.ts';
export {
  containerGeometry,
  hasLayoutTurned,
  layoutSize,
  measureView,
  type MeasuredElement,
  type ViewportEnvironment,
} from './viewport/viewport-measure.ts';
export { CameraSource, type CameraSourceOptions } from './camera-source.ts';
export { DEFAULT_CAPTURE, DEFAULT_TIMESTAMPS } from './camera-types.ts';
export type {
  CameraEnvironment,
  CameraEvent,
  CameraRecovery,
  CameraRequest,
  CameraSettingsSnapshot,
  GeometryOptions,
} from './camera-types.ts';
export {
  CameraRuntime,
  type CameraRuntimeOptions,
  type CameraRuntimeState,
} from './capture/camera-runtime.ts';
export {
  imageBitmapSnapshot,
  SNAPSHOT_STRATEGIES,
  videoFrameSnapshot,
  type SnapshotEnvironment,
  type SnapshotStrategy,
} from './capture/snapshot.ts';
export { mountPreviewLayer, type PreviewLayer } from './preview/preview-layer.ts';
export { previewStyle, type PreviewStyle } from './preview/preview-style.ts';
export {
  canvasPreviewSurface,
  videoPreviewSurface,
  type PreviewDocument,
  type PreviewElement,
  type PreviewSurface,
  type PreviewSurfaceFactory,
  type PreviewVideo,
} from './preview/preview-surface.ts';
