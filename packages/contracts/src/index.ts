/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const CONTRACT_VERSION = '0.1.0' as const;
export * from './worker.js';
export const TARGET_SCHEMA_VERSION = 1 as const;
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number];
export type Mat4 = readonly [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
export type Point2 = readonly [number, number];
export type Corners = readonly [Point2, Point2, Point2, Point2];
export type SessionId = string;
export type PixelFormat = 'rgba8' | 'bgra8' | 'gray8' | 'video-frame' | 'image-bitmap';
export interface ImageHandle { readonly kind: PixelFormat; readonly data: unknown; readonly released: boolean; release(): void }
export interface CpuImagePayload { data: Uint8Array; strideBytes: number; byteOffset: number; byteLength: number; colorEncoding: 'srgb' | 'linear' | 'gray'; alphaPremultiplied: boolean; coordinateSpace: 'input' | 'standard' }
export interface FramePacket {
  sessionId: SessionId; frameId: number; sourceTimestampUs: number;
  timestampSource: 'media-time' | 'video-frame' | 'replay' | 'callback';
  captureTimeUs: number | null; captureTimeUncertaintyUs: number | null; arrivalTimeUs: number;
  mappedObservationTimeUs?: number | null; clockMappingUncertaintyUs?: number | null; imageIdentity?: string;
  width: number; height: number; pixelFormat: PixelFormat; rotation: 0 | 90 | 180 | 270;
  mirrored: boolean; calibrationId: string | null; imageHandle: ImageHandle;
}
export interface FrameGeometry {
  H_standardFromInput: Mat3; H_viewportFromStandard: Mat3;
  crop: { x: number; y: number; width: number; height: number };
  rotation: 0 | 90 | 180 | 270; mirrored: boolean; objectFit: 'contain' | 'cover';
  standardWidth: number; standardHeight: number; cssWidth: number; cssHeight: number; devicePixelRatio: number;
}
export interface Calibration { id: string; K_standard: Mat3; distortion: { model: 'none' | 'brown-conrady'; coefficients: readonly number[] }; width: number; height: number }
export interface ClockMapping { sessionId: string; source: FramePacket['timestampSource']; scale: number; offsetUs: number; uncertaintyUs: number | null }
export interface QualityDiagnostic { code: string; severity: 'info' | 'warning' | 'error'; message: string }
export interface FeatureSet { points: readonly Point2[]; descriptorType: string; descriptorLength: number; descriptors: readonly number[] }
export interface TargetBundle {
  schemaVersion: 1; compilerVersion: string; algorithmVersion: string; targetId: string; imageHash: string;
  widthPx: number; heightPx: number; physicalWidthMeters: number | null; orientation: 'top-left';
  imageHashDomain?: 'encoded-image' | 'canonical-gray8';
  pyramid: readonly { width: number; height: number; scale: number; pixels: readonly number[] }[];
  features: FeatureSet; preprocessing: Readonly<Record<string, string | number | boolean>>; diagnostics: readonly QualityDiagnostic[];
}
export interface RecognitionObservation {
  sessionId: string; frameId: number; targetId: string; H_imageFromTarget: Mat3;
  targetPoints: readonly Point2[]; imagePoints: readonly Point2[]; inliers: readonly boolean[];
  reprojectionErrorPx: number; spatialCoverage: number; degenerate: boolean;
  correspondenceOrigin?: 'original-target' | 'previous-frame'; sourceFrameId?: number; algorithmVersion?: string; rejectionReasons?: readonly string[];
}
export type TrackingState = 'SEARCHING' | 'ACQUIRING' | 'TRACKING' | 'LIMITED' | 'LOST';
export interface TrackingQuality { inlierCount: number; inlierRatio: number; reprojectionErrorPx: number | null; spatialCoverage: number; degenerate: boolean; measured: boolean }
/**
 * Optional auxiliary geometry of ONE measured result (present only when the pipeline was created with collectMatchedPoints).
 * pointsPx are the ACTUAL inlier correspondences of the accepted RecognitionObservation for exactly this session/frame/target,
 * in the same standard-image coordinate space as cornersPx. They are never taken from compiled target features and never carried into a prediction.
 */
export interface TrackingMatchedPoints { sessionId: string; frameId: number; targetId: string; origin: 'original-target' | 'previous-frame'; pointsPx: readonly Point2[] }
export interface TrackingResult {
  sessionId: string; frameId: number; observationTimeUs: number; targetId: string | null; state: TrackingState;
  H_imageFromTarget: Mat3 | null; cornersPx: Corners | null; T_cameraFromTarget: Mat4 | null;
  poseMetricValid: boolean; quality: TrackingQuality; predictionAgeUs: number; reason: string;
  lastReliableObservationTimeUs?: number | null; predictionExpiresAtUs?: number | null; absoluteCorrectionAgeUs?: number | null;
  /** Absent by default. Diagnostics must not retain it (DiagnosticRecorder strips it). */
  matchedPoints?: TrackingMatchedPoints;
}
/** Bound of matchedPoints.pointsPx: the shared extractors keep at most 512 features per frame (LIMITS.features), so inlier pairs cannot exceed it; larger payloads are invalid, not truncated. */
export const MAX_MATCHED_POINTS = 512 as const;
/**
 * Returns the current measured inlier points of this result, or null. Valid only for a measured, non-degenerate TRACKING/LIMITED result whose
 * matchedPoints carry the same session, frame and target, at most MAX_MATCHED_POINTS finite pairs.
 */
export function matchedPointsForResult(result: TrackingResult): readonly Point2[] | null {
  const m = result?.matchedPoints;
  if (!m || typeof m !== 'object' || (result.state !== 'TRACKING' && result.state !== 'LIMITED') || !result.quality?.measured || result.quality.degenerate) return null;
  if (!result.targetId || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId || (m.origin !== 'original-target' && m.origin !== 'previous-frame')) return null;
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p) if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
  return p;
}
/** Removes matchedPoints in place unless collection was requested and the payload is valid for this result. Returns the same object. */
export function sanitizeMatchedPoints<T extends TrackingResult>(result: T, allowed: boolean): T {
  if (result.matchedPoints !== undefined && (!allowed || !matchedPointsForResult(result))) delete result.matchedPoints;
  return result;
}
export type BackendKind = 'cpu' | 'wasm' | 'webgpu';
export interface ComputeStamp { sessionId: string; frameId: number; backend: BackendKind; algorithmVersion: string; precision: 'u8-exact' | 'f32' | 'f64' }
export interface PreparedFrame extends ComputeStamp { resourceId: string; width: number; height: number; generation?: number; level?: number; scale?: number; storageFormat?: 'gray8' | 'rgba8' | 'f32'; preprocessingId?: string; release(): void }
export interface ComputeResult<T> extends ComputeStamp { value: T }
export interface ComputeBackend {
  readonly kind: BackendKind; readonly algorithmVersion: string;
  init(signal?: AbortSignal): Promise<void>;
  prepareFrame(frame: FramePacket, signal?: AbortSignal): Promise<PreparedFrame>;
  buildPyramid(frame: PreparedFrame, levels: number, signal?: AbortSignal): Promise<ComputeResult<readonly PreparedFrame[]>>;
  detectFeatures(frame: PreparedFrame, signal?: AbortSignal): Promise<ComputeResult<readonly Point2[]>>;
  describeAndMatch(frame: PreparedFrame, target: TargetBundle, signal?: AbortSignal): Promise<ComputeResult<RecognitionObservation>>;
  trackPoints(previous: PreparedFrame, current: PreparedFrame, points: readonly Point2[], signal?: AbortSignal): Promise<ComputeResult<{ points: readonly Point2[]; valid: readonly boolean[]; residualsPx?: readonly (number | null)[]; reasons?: readonly string[] }>>;
  dispose(): Promise<void>;
}
export interface DeviceService { readonly generation: number; onLost(listener: (reason: string) => void): () => void; whenIdle(): Promise<void> }
export const ERROR_CODES = ['INVALID_CONFIG', 'INVALID_TARGET', 'DISPOSED', 'START_FAILED', 'FRAME_FAILED', 'RESOURCE_FAILED', 'UNSUPPORTED', 'DEVICE_LOST', 'PLAYBACK_BLOCKED', 'ABORTED'] as const;
export type ErrorCode = typeof ERROR_CODES[number];
export class EngineError extends Error {
  constructor(public readonly code: ErrorCode, public readonly recoverable: boolean, public readonly reason: string) { super(reason); this.name = 'EngineError'; }
}
export interface MediaConfig { url: string; muted?: boolean; loop?: boolean; fit?: 'contain' | 'cover'; lostBehavior?: 'pause-and-hide' | 'hide'; resumeBehavior?: 'resume' | 'restart'; crossOrigin?: 'anonymous' | 'use-credentials' | null; /** iOS WeChat only; default 'auto'. 'off' never uses the WeixinJSBridge fallback after a native NotAllowedError. */ wechatPlaybackRecovery?: 'auto' | 'off' }
export interface EventContext { sessionId: string | null; targetId: string | null; timestampUs: number; timestampDomain?: 'attempt' | 'source-session' | 'engine-session' }
/** Configuration captured at an attempt/session boundary, never inferred from recognition. */
export interface SessionConfigSnapshot {
  targets: readonly { targetId: string; imageHash: string; algorithmVersion: string; compilerVersion?: string; widthPx?: number; heightPx?: number }[];
  trackingMode: string | null;
  backendRequested: BackendKind | null;
  backendActual: BackendKind | null;
  maxPredictionMs: number | null;
  /** Visual-only hold after targetLost; not tracking validity and never part of maxPredictionMs. Absent/0 = hide immediately. */
  lossDisplayGraceMs?: number | null;
  media: readonly { targetId: string; identityHash: string | null; identityKind: 'url-sha256' | 'file-sha256' | null; fit: string | null }[];
  inputWidth: number | null; inputHeight: number | null;
  processingLongEdge: number | null;
  requestedResolution?: number | 'native' | null;
  previewWidth: number | null; previewHeight: number | null;
  dpr: number | null;
  clockDomain: string | null;
  geometry?: FrameGeometry | null;
  cameraSettings?: Readonly<Record<string, string | number | boolean>>;
  timestampSource?: string | null;
  cameraClockMapping?: { sourceToSessionOffsetUs: number; approximate: boolean; uncertaintyUs: number | null } | null;
  operators?: Readonly<Record<string, string>>;
  fallbackReason?: string | null;
  presetId?: string | null;
  protocolVersion?: string | null;
  targetAssets?: readonly { targetId: string; encodedImageHash: string }[];
  candidate?: { candidateId: string; sourceRevision: string | null; runtimeSha256: string | null; sourceSha256: string | null; frozen: boolean };
  captureMode?: 'numeric-only' | 'external-screen-recording';
}
export const MAX_LOSS_DISPLAY_GRACE_MS = 1000 as const;
/**
 * 'loading' … 'loading-failed' are the loading/reveal presentation transitions (see MediaPresentationTelemetry); older consumers may ignore them.
 * 'loading' a media request/attempt began; 'first-frame' its actual current frame became presentable; 'reveal-start'/'reveal-end' the circular reveal ran
 * (reveal-end without reveal-start = completed without animation: first frame arrived while hidden, or reveal duration 0; a hide during a reveal also ends it early with reveal-end);
 * 'reveal-cancel' the request was released (target switch, source replacement, stop, dispose) before it finished; 'loading-failed' it ended in
 * failure (media error, blocked playback, loading timeout) and the spinner was cleared.
 */
export type MediaState = 'shown' | 'hidden' | 'held' | 'hold-recovered' | 'play' | 'pause' | 'waiting' | 'playing' | 'timeupdate' | 'ended' | 'error' | 'loading' | 'first-frame' | 'reveal-start' | 'reveal-end' | 'reveal-cancel' | 'loading-failed';
/** Closed set of loading failure reasons; never free text or URLs. */
export const PRESENTATION_FAILURE_REASONS = ['media-error', 'playback-blocked', 'loading-timeout'] as const;
export type PresentationFailureReason = typeof PRESENTATION_FAILURE_REASONS[number];
/**
 * Optional, bounded numbers/enums describing ONE media request's loading → first frame → reveal progress (never URLs, pixels or per-frame data).
 * Only transition events carry it. Times are milliseconds on the renderer clock, relative to this request's loading start.
 */
export interface MediaPresentationTelemetry {
  /** Renderer-wide counter, +1 for every media request/attempt (new media element, gesture retry, blocked-playback retry). Starts at 1. */
  requestGeneration: number;
  phase: 'loading' | 'revealing' | 'revealed' | 'failed' | 'cancelled';
  /** Readiness evidence of the first frame; null before it. 'time-progress' is the conservative fallback without requestVideoFrameCallback. */
  readySignal: 'video-frame-callback' | 'time-progress' | null;
  /** Time since this request's loading began, at this event. */
  elapsedMs: number;
  /** Loading start → first presentable frame; null until then. */
  firstFrameMs: number | null;
  /** Reveal progress at this event (0 at reveal-start); on reveal-end the actual duration. Null before the reveal. */
  revealElapsedMs: number | null;
  /** Configured reveal duration (0 = none); a reduced-motion cross-fade is reported as its own shorter value. */
  revealDurationMs: number;
  reducedMotion: boolean;
  /** Present only on 'loading-failed'. */
  failureReason?: PresentationFailureReason;
}
export interface MediaTelemetry { currentTime: number | null; decodedFrames: number | null; droppedFrames: number | null; readyState: number | null; paused: boolean; errorCode: number | null; /** Optional loop diagnostics; absent in older logs. */ loop?: boolean; duration?: number | null; ended?: boolean; loopRecoveries?: number; /** Optional; the last issued play attempt, not proof of playback. */ playbackPath?: 'native' | 'wechat-bridge' | null; wechatRecoveryAttempts?: number; /** Optional; loading/reveal progress of the current media request. Absent in older logs and when presentation is disabled. */ presentation?: MediaPresentationTelemetry }
export interface AlignmentMarker { text: string; pageTimeUs: number; displaySubmittedAtUs: number; visibleTimeUs: null; mappingUncertaintyUs: null }
export interface TrialStep { name: string; index: number; phase: 'start' | 'end'; plannedDurationMs: number; actualStartUs: number; actualEndUs: number | null; outcome: 'running' | 'completed' | 'interrupted' }
export interface OperatorFeedback { correctTarget: 'yes' | 'no' | 'uncertain'; videoExperience: 'normal' | 'frozen' | 'flicker' | 'absent' | 'uncertain'; actionsCompleted: 'yes' | 'no' | 'uncertain' }
/** Engine estimates in captured-input pixel coordinates; never independent image truth. */
export interface TargetFrameExtent {
  sessionId: string; frameId: number; sourceObservationId: string | null;
  observationTimeUs: number; arrivalTimeUs: number; targetId: string | null;
  state: TrackingState; measured: boolean; predictionAgeUs: number;
  inputWidth: number; inputHeight: number; geometry: FrameGeometry | null;
  cornersStandardPx: Corners | null; cornersInputPx: Corners | null;
  boundingBoxInputPx: { x: number; y: number; width: number; height: number } | null;
  edgeWidthInputPx: number | null; edgeHeightInputPx: number | null;
  widthFraction: number | null; heightFraction: number | null; areaFraction: number | null;
  fullyInsideInput: boolean | null;
  unavailableReason: 'no-target-corners' | 'frame-geometry-unavailable' | 'invalid-frame-geometry' | null;
}
export interface TargetLossContext {
  triggerFrame: TargetFrameExtent | null;
  precedingFrame: TargetFrameExtent | null;
  lastReliableFrame: TargetFrameExtent | null;
  /** Null for timer/lifecycle loss; false if an input frame before the trigger was skipped. */
  precedingInputFrameRecorded: boolean | null;
}
export interface EngineEvents {
  ready: EventContext;
  attemptStart: EventContext;
  sessionConfig: EventContext & { config: SessionConfigSnapshot };
  sessionConfigUpdated: EventContext & { config: SessionConfigSnapshot };
  sessionEnded: EventContext & { reason: string };
  sessionStartFailed: EventContext & { code: ErrorCode; attemptTimeUs: number };
  stageTiming: EventContext & { stage: 'pipeline-init' | 'renderer-init' | 'camera-init' | 'target-download' | 'target-compile'; durationUs: number; status: 'completed' | 'failed' | 'cancelled'; attemptTimeUs?: number; originRunId?: string };
  pageVisibility: EventContext & { visibility: 'hidden' | 'visible' | 'pagehide' | 'pageshow' };
  cameraPermission: EventContext & { phase: 'request' | 'result'; permission: 'pending' | 'granted' | 'denied' | 'failed' };
  cameraStatus: EventContext & { code: string };
  mediaState: EventContext & { state: MediaState; media: MediaTelemetry };
  alignStart: EventContext & { alignment: AlignmentMarker };
  alignEnd: EventContext & { alignment: AlignmentMarker };
  trialStep: EventContext & { step: TrialStep };
  operatorFeedback: EventContext & { feedback: OperatorFeedback };
  startCheck: EventContext & { checks: readonly { name: string; passed: boolean; reason: string }[]; presetId: string };
  targetFound: EventContext & { result: TrackingResult };
  targetUpdated: EventContext & { result: TrackingResult };
  targetLost: EventContext & { reason: string; lossContext?: TargetLossContext };
  playbackBlocked: EventContext & { retry: () => Promise<void> };
  error: EventContext & { error: EngineError };
  capabilityChanged: EventContext & { backend: BackendKind; reason: string };
}
export interface FrameSource { start(sessionId: string, onFrame: (frame: FramePacket) => void, signal: AbortSignal): Promise<void>; stop(): Promise<void>; dispose(): Promise<void>; nowSessionUs?(): number | null; /** Optional: synchronous begin/end of an orientation/viewport transition. Between begin and end the source delivers no frames; the engine hides output, drops older in-flight results and resets tracker state at end. Returns unsubscribe. */ onViewportTransition?(listener: (event: ViewportTransitionEvent) => void): () => void }
export interface ViewportTransitionEvent { phase: 'begin' | 'end'; epoch: number; reason?: string | null }
export interface RendererEventSink { playbackBlocked(event: EngineEvents['playbackBlocked']): void; error(event: EngineEvents['error']): void; sessionEvent?<K extends 'mediaState'>(type: K, event: EngineEvents[K]): void }
export interface VisionPipeline { loadTargets(targets: readonly TargetBundle[]): Promise<void>; reset(sessionId: string): Promise<void>; process(frame: FramePacket, signal: AbortSignal): Promise<TrackingResult>; dispose(): Promise<void> }
export interface RenderSink { start(container: HTMLElement | null, sessionId: string): Promise<void>; update(result: TrackingResult): Promise<void>; hide(): void; /** Optional soft hide after targetLost: keep last overlay and playback for graceMs, then hide and pause. Returns false when nothing could be held (SDK then hides). Idempotent while holding (no re-timing); hide()/stop()/target switch cancel it. */ holdAfterLoss?(graceMs: number): boolean; setTargets?(targets: readonly TargetBundle[]): void; connectEvents?(sink: RendererEventSink): () => void; setTargetMedia(targetId: string, config: MediaConfig): void; stop(): Promise<void>; dispose(): Promise<void> }
export interface FrameDiagnostics { sessionId: string; frameId: number; targetId: string | null; cpuSubmitTimeUs: number | null; gpuCompleteTimeUs: number | null; resultAvailableTimeUs: number | null; renderSubmitTimeUs: number | null; visibleTimeUs: number | null; arrivalTimeUs?: number; sourceObservationId?: string; dropReason?: string | null; backend?: BackendKind; queueWaitDurationUs?: number | null }
export const IDENTITY_3: Mat3 = [1,0,0,0,1,0,0,0,1];
export function normalizeHomography(h: readonly number[]): Mat3 {
  if (h.length !== 9 || !h.every(Number.isFinite)) throw new EngineError('INVALID_TARGET', false, 'Homography requires nine finite elements');
  const scale = Math.abs(h[8]) > 1e-12 ? h[8] : Math.max(...h.map(Math.abs));
  if (!scale) throw new EngineError('INVALID_TARGET', false, 'Zero homography');
  const m = h.map(x => x / scale);
  const det = m[0]*(m[4]*m[8]-m[5]*m[7])-m[1]*(m[3]*m[8]-m[5]*m[6])+m[2]*(m[3]*m[7]-m[4]*m[6]);
  if (Math.abs(det) < 1e-12) throw new EngineError('INVALID_TARGET', false, 'Singular homography');
  return m as unknown as Mat3;
}
export function validateTargetBundle(value: unknown): asserts value is TargetBundle {
  const t = value as TargetBundle;
  const fail = () => { throw new EngineError('INVALID_TARGET', false, 'Malformed, incompatible or oversized target bundle'); };
  if (!t || t.schemaVersion !== 1 || !t.targetId || typeof t.targetId !== 'string' || t.targetId.length > 256 || !t.compilerVersion || !t.algorithmVersion || !/^[a-f0-9]{64}$/i.test(t.imageHash ?? '') || t.orientation !== 'top-left') fail();
  if (![t.widthPx,t.heightPx].every(n => Number.isInteger(n) && n > 0 && n <= 16384) || (t.physicalWidthMeters !== null && !(Number.isFinite(t.physicalWidthMeters) && t.physicalWidthMeters > 0))) fail();
  const f = t.features;
  if (!f || !Array.isArray(f.points) || f.points.length > 100000 || !Number.isInteger(f.descriptorLength) || f.descriptorLength < 1 || f.descriptorLength > 512 || !f.descriptorType || !Array.isArray(f.descriptors) || f.descriptors.length !== f.points.length*f.descriptorLength || !f.descriptors.every(Number.isFinite)) fail();
  if (!f.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))) fail();
  if (!Array.isArray(t.pyramid) || t.pyramid.length > 16 || !t.preprocessing || !Array.isArray(t.diagnostics)) fail();
  let bytes = 0;
  for (const level of t.pyramid) {
    if (![level.width,level.height].every(n => Number.isInteger(n) && n > 0 && n <= 16384) || !Number.isFinite(level.scale) || level.scale <= 0 || !Array.isArray(level.pixels) || level.pixels.length !== level.width*level.height) fail();
    bytes += level.pixels.length;
    if (bytes > 16777216 || !level.pixels.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) fail();
  }
}
