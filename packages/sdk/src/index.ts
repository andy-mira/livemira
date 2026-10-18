/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/engine. Only re-exports belong here.
export { ENGINE_VERSION, engineBuildInfo, type EngineBuildInfo } from './build-info.ts';
export {
  createEngine,
  type CameraChange,
  type Engine,
  type EngineOptions,
  type ProcessingLongEdge,
} from './engine/create-engine.ts';
export type { EngineState } from './engine/engine-core.ts';
export type {
  EngineCapability,
  EngineEvents,
  SessionConfig,
  StartupStage,
  TargetFrameExtent,
  TargetLossContext,
  TargetMedia,
} from './engine/engine-types.ts';
export type { WorkerEndpoint } from './worker/vision-client.ts';
export type {
  ClearReason,
  EngineExtension,
  ExtensionHandle,
  ExtensionHost,
} from './engine/extension-host.ts';
export { compileTargetImage, type CompileImageOptions } from './engine/targets.ts';
export {
  compileGrayTarget,
  parseTarget,
  serializeTarget,
  type CompileOptions,
} from '@livemira/target-compiler';
export {
  EngineError,
  type CoreEvents,
  type Corners,
  type EngineErrorOptions,
  type ErrorCode,
  type EventContext,
  type FrameGeometry,
  type FrameIdentity,
  type Mat3,
  type MatchedPoints,
  type Point2,
  type PredictionInfo,
  type RectPx,
  type TargetBundle,
  type TargetDiagnostic,
  type TargetFeatures,
  type TargetPyramidLevel,
  type TrackingQuality,
  type TrackingReason,
  type TrackingResult,
  type TrackingState,
  type ViewportTransition,
  type ViewportTransitionReason,
} from '@livemira/contracts';
export type {
  MediaConfig,
  MediaPresentationTelemetry,
  MediaSnapshot,
  MediaState,
  PresentableSignal,
  PresentationFailureReason,
} from '@livemira/media';
export {
  PRESENTATION_FAILURE_REASONS,
  wechatIosBridgeRecovery,
  type PlaybackRecovery,
  type RecoveryAttempt,
  type RecoveryOutcome,
} from '@livemira/media';
export type { RevealOptions, TargetSize } from '@livemira/renderer';
export {
  canvasPreviewSurface,
  videoPreviewSurface,
  type PreviewDocument,
  type PreviewElement,
  type PreviewStyle,
  type PreviewSurface,
  type PreviewSurfaceFactory,
  type PreviewVideo,
  type SnapshotEnvironment,
  type SnapshotStrategy,
} from '@livemira/camera';
export {
  DiagnosticLog,
  type DiagnosticEventRecord,
  type DiagnosticExport,
  type DiagnosticLevel,
  type DiagnosticLogOptions,
  type DiagnosticTargetRecord,
  type EngineIdentity,
  type FrameRecord,
  type MetadataValue,
  type ResultRecord,
  type TelemetrySink,
  type WorkerTimingRecord,
} from '@livemira/diagnostics';
export type {
  GrayImage,
  RecognitionTrace,
  RecognitionTracePass,
  RecognitionTraceStageMs,
  TargetRejection,
} from '@livemira/recognition';
