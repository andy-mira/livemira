/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { AlignmentMarker, EventContext, MediaState, MediaTelemetry, OperatorFeedback, TrialStep, BackendKind, EngineEvents, ErrorCode, FrameDiagnostics, FrameGeometry, FramePacket, SessionConfigSnapshot, TargetBundle, TargetLossContext, TrackingResult } from './index.js';
export const WORKER_PROTOCOL_VERSION = 1 as const;
export type WorkerFrameMetadata = Omit<FramePacket, 'imageHandle'>;
export type WorkerImage = { kind: 'gray8' | 'rgba8'; buffer: ArrayBuffer; width: number; height: number; strideBytes: number } | { kind: 'video-frame'; image: VideoFrame } | { kind: 'image-bitmap'; image: ImageBitmap };
export interface WorkerFrame { metadata: WorkerFrameMetadata; image: WorkerImage; geometry: FrameGeometry | null }
/** Main-side owned COPY only. After successful postMessage, call markTransferred; release closes only untransferred copies. */
export interface WorkerFrameLease { frame: WorkerFrame; transfer: Transferable[]; copiedBytes: number | null; preparationDurationUs: number; markTransferred(): void; release(): void }
export type WorkerTrackingMode = 'absolute' | 'hybrid-experimental' | 'subpixel-experimental';
export interface WorkerPipelineOptions { trackingMode: WorkerTrackingMode; backendPreference: BackendKind; algorithmVersion?: string; /** Default false. When true, measured TRACKING results carry matchedPoints (the accepted observation's inlier image points; no extra feature extraction). Fixed for the lifetime of the Worker. */ collectMatchedPoints?: boolean;
  /** Default false: nothing is copied, posted or retained. When true, each result message may carry the bounded RecognitionTrace of the recognition pass that produced that exact frame's result. Fixed for the lifetime of the Worker. A transport seam only: all interpretation belongs to optional companions. */
  observeRecognition?: boolean;
  /** Default true. false skips the half-octave scale retry of the legacy-family algorithms after a global miss. Intended for diagnostic comparison only; do not disable in normal use. Ignored by the v2 algorithm (it never retries). Fixed for the lifetime of the Worker. */
  legacyScaleSearch?: boolean }
/**
 * Plain numeric/enumerated facts of ONE recognition pass, as the recognizer already computed them (no point coordinates, no pixels, no URLs).
 * Bounded: at most MAX_TRACE_REJECTIONS entries, reasons of at most 64 characters. Identity (sessionId/frameId) must equal the accompanying result.
 * Optional `stageMs` (stage times summed over the passes, as the recognizer reports them) and `passes` (1..MAX_TRACE_PASSES, one per recognition pass, each snapshotted before accumulation) exist only when observed;
 * `passes.length` equals `legacyScalePasses`. Times are finite milliseconds in [0, MAX_TRACE_MS].
 */
export interface RecognitionTraceStageMs { featureMs: number; retrievalMs: number; matchMs: number; geometryMs: number; totalMs: number }
export interface RecognitionTracePass extends RecognitionTraceStageMs {
  /** Image scale this pass searched at: 1 for the standard image, less than 1 for the half-octave retry. */
  scale: number;
  /** Time spent preparing this pass's input (the resampling of the retry); 0 for the first pass. Not included in this pass's featureMs, but included in the summed `stageMs.featureMs`. */
  prepareMs: number;
  featureCount: number; candidateCount: number; observationCount: number; ambiguous: boolean; budgetExhausted: boolean;
  rejected: readonly { targetId: string; reason: string }[];
}
export interface RecognitionTrace {
  sessionId: string; frameId: number; algorithmVersion: string;
  featureCount: number; candidateCount: number; legacyScalePasses: number; observationCount: number; ambiguous: boolean; budgetExhausted: boolean;
  rejected: readonly { targetId: string; reason: string }[];
  stageMs?: RecognitionTraceStageMs;
  passes?: readonly RecognitionTracePass[];
}
export const MAX_TRACE_REJECTIONS = 32;
export const MAX_TRACE_TEXT = 64;
export const MAX_TRACE_PASSES = 2;
export const MAX_TRACE_MS = 600_000;
const traceText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const traceCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
/** Durations are floating point: finite, non-negative and bounded (an integer-only check would reject real timings). */
const traceMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TRACE_MS;
const traceRejections = (v: unknown): v is { targetId: string; reason: string }[] => Array.isArray(v) && v.length <= MAX_TRACE_REJECTIONS && v.every(r => r && typeof r === 'object' && traceText(r.targetId, 256) && traceText(r.reason, MAX_TRACE_TEXT));
const copyRejections = (rejected: readonly { targetId: string; reason: string }[]): { targetId: string; reason: string }[] => rejected.map(r => ({ targetId: r.targetId, reason: r.reason }));
function copyStageMs(v: unknown): RecognitionTraceStageMs | null {
  const s = v as Partial<RecognitionTraceStageMs> | null;
  if (!s || typeof s !== 'object' || ![s.featureMs, s.retrievalMs, s.matchMs, s.geometryMs, s.totalMs].every(traceMs)) return null;
  return { featureMs: s.featureMs!, retrievalMs: s.retrievalMs!, matchMs: s.matchMs!, geometryMs: s.geometryMs!, totalMs: s.totalMs! };
}
function copyPass(v: unknown): RecognitionTracePass | null {
  const p = v as Partial<RecognitionTracePass> | null, stage = copyStageMs(p);
  if (!p || !stage || typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0 || p.scale > 1 || !traceMs(p.prepareMs) || ![p.featureCount, p.candidateCount, p.observationCount].every(traceCount) ||
      typeof p.ambiguous !== 'boolean' || typeof p.budgetExhausted !== 'boolean' || !traceRejections(p.rejected)) return null;
  return { scale: p.scale, prepareMs: p.prepareMs, ...stage, featureCount: p.featureCount!, candidateCount: p.candidateCount!, observationCount: p.observationCount!, ambiguous: p.ambiguous, budgetExhausted: p.budgetExhausted, rejected: copyRejections(p.rejected) };
}
/** Returns the trace as a fresh bounded object when it is well formed and belongs to exactly this session/frame; otherwise null (never throws, never truncates silently). Unknown fields are dropped; a trace without the optional fields (older producer) stays valid. */
export function recognitionTraceForResult(trace: unknown, identity: { sessionId: string; frameId: number }): RecognitionTrace | null {
  const t = trace as Partial<RecognitionTrace> | null;
  if (!t || typeof t !== 'object' || t.sessionId !== identity.sessionId || t.frameId !== identity.frameId || !traceText(t.algorithmVersion, MAX_TRACE_TEXT) ||
      ![t.featureCount, t.candidateCount, t.legacyScalePasses, t.observationCount].every(traceCount) || typeof t.ambiguous !== 'boolean' || typeof t.budgetExhausted !== 'boolean' ||
      !traceRejections(t.rejected)) return null;
  const out: RecognitionTrace = { sessionId: t.sessionId, frameId: t.frameId, algorithmVersion: t.algorithmVersion, featureCount: t.featureCount!, candidateCount: t.candidateCount!, legacyScalePasses: t.legacyScalePasses!, observationCount: t.observationCount!,
    ambiguous: t.ambiguous, budgetExhausted: t.budgetExhausted, rejected: copyRejections(t.rejected) };
  if (t.stageMs !== undefined) { const stage = copyStageMs(t.stageMs); if (!stage) return null; out.stageMs = stage; }
  if (t.passes !== undefined) {
    if (!Array.isArray(t.passes) || t.passes.length < 1 || t.passes.length > MAX_TRACE_PASSES || t.passes.length !== t.legacyScalePasses) return null;
    const passes: RecognitionTracePass[] = [];
    for (const p of t.passes) { const copy = copyPass(p); if (!copy) return null; passes.push(copy); }
    out.passes = passes;
  }
  return out;
}
export interface WorkerCapability { execution: 'worker'; backend: BackendKind; algorithmVersion: string; trackingMode: WorkerTrackingMode; generation: number; fallbackReason: string | null; operators: Readonly<Record<string,string>> }
/** Fixed, input-independent size-limit messages that may cross the Worker boundary and reach SDK errors. Anything else is reported generically. */
export const WORKER_SAFE_REASONS: readonly string[] = Object.freeze([
  'Worker source frame exceeds supported size',
  'Standard image exceeds processing limit; frames are never silently resized',
]);
export const WORKER_GENERIC_REASON = 'Worker operation failed';
export function safeWorkerReason(reason: unknown): string { return typeof reason === 'string' && WORKER_SAFE_REASONS.includes(reason) ? reason : WORKER_GENERIC_REASON; }
/** copiedBytes is null when the total browser-internal copy volume is unobservable (legacy field; no longer width*height). */
export interface WorkerTiming { prepareDurationUs: number; computeDurationUs: number; totalDurationUs: number; copiedBytes: number | null; inputPreparationDurationUs?: number; inputCopiedBytes?: number | null }
interface RequestEnvelope { protocol: 1; requestId: number; generation: number }
export type VisionWorkerRequest = RequestEnvelope & (
  { type: 'init'; options: WorkerPipelineOptions } |
  { type: 'load-targets'; targets: readonly TargetBundle[] } |
  { type: 'reset'; sessionId: string } |
  { type: 'frame'; frame: WorkerFrame } |
  { type: 'compile'; encodedImage: ArrayBuffer; targetId: string; maxEdge: number; algorithmVersion?: string } |
  { type: 'dispose' }
);
export type VisionWorkerResponse = RequestEnvelope & (
  { type: 'ready'; capability: WorkerCapability } |
  { type: 'ack' } |
  { type: 'result'; result: TrackingResult; timing: WorkerTiming; capability?: WorkerCapability; trace?: RecognitionTrace } |
  { type: 'compiled'; target: TargetBundle } |
  { type: 'error'; code: ErrorCode; recoverable: boolean; reason: string }
);
export interface DiagnosticEvent extends EventContext {
  type: keyof EngineEvents;
  reason?: string; code?: string; config?: SessionConfigSnapshot;
  lossContext?: TargetLossContext;
  state?: MediaState; media?: MediaTelemetry;
  attemptTimeUs?: number; originRunId?: string; stage?: string; durationUs?: number; status?: string;
  visibility?: string; phase?: string; permission?: string;
  alignment?: AlignmentMarker; step?: TrialStep; feedback?: OperatorFeedback;
  checks?: readonly { name: string; passed: boolean; reason: string }[]; presetId?: string;
}
export interface DiagnosticExport {
  schemaVersion: 1; candidateId: string; runId: string; createdAt: string;
  execution: 'worker' | 'main'; capabilities: readonly WorkerCapability[];
  targets: readonly { targetId: string; imageHash: string; algorithmVersion: string; compilerVersion: string; widthPx: number; heightPx: number }[];
  frames: readonly FrameDiagnostics[]; results: readonly TrackingResult[];
  events: readonly DiagnosticEvent[];
  workerTimings: readonly { sessionId: string; frameId: number; generation: number; timing: WorkerTiming }[];
  eventLogComplete: boolean; truncated: boolean; droppedRecords: number;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
}
