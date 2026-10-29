/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Bounded numeric facts of one recognition for optional diagnostics: no point coordinates, pixels or URLs. A trace
// crosses the Worker boundary only when requested, and only for exactly the frame of the accompanying result.

import type { FrameIdentity } from '@livemira/contracts';

import type { RecognitionBatch, TargetRejection } from './recognition-types.ts';

export const MAX_TRACE_REJECTIONS = 32;
export const MAX_TRACE_TEXT = 64;
export const MAX_TRACE_PASSES = 2;
export const MAX_TRACE_MS = 600_000;

export interface RecognitionTraceStageMs {
  readonly featureMs: number;
  readonly retrievalMs: number;
  readonly matchMs: number;
  readonly geometryMs: number;
  readonly totalMs: number;
}

export interface RecognitionTracePass extends RecognitionTraceStageMs {
  /** 1 for the standard image, less than 1 for the half-octave retry. */
  readonly scale: number;
  /** Resampling time of the retry (0 for the first pass); included in the summed `stageMs.featureMs`. */
  readonly prepareMs: number;
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly observationCount: number;
  readonly isAmbiguous: boolean;
  readonly isBudgetExhausted: boolean;
  readonly rejected: readonly TargetRejection[];
}

export interface RecognitionTrace extends FrameIdentity {
  readonly algorithmVersion: string;
  /** Feature count of the last pass, not a sum. */
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly scalePasses: number;
  readonly observationCount: number;
  readonly isAmbiguous: boolean;
  readonly isBudgetExhausted: boolean;
  readonly rejected: readonly TargetRejection[];
  /** Stage times summed over the passes; present only when passes were captured. */
  readonly stageMs?: RecognitionTraceStageMs;
  /** One record per pass, snapshotted before accumulation; present only when passes were captured. */
  readonly passes?: readonly RecognitionTracePass[];
}

const boundRejections = (rejected: readonly TargetRejection[]): TargetRejection[] =>
  rejected
    .slice(0, MAX_TRACE_REJECTIONS)
    .map((r) => ({ targetId: r.targetId, reason: r.reason.slice(0, MAX_TRACE_TEXT) }));

/** Plain projection of what the recognizer already computed. */
export function traceOf(batch: RecognitionBatch, frame: FrameIdentity): RecognitionTrace {
  const d = batch.facts;
  // Stage times and per-pass facts exist only when the recognizer captured them; passes were snapshotted before
  // accumulation, so none is counted twice.
  const optional = d.passes
    ? {
        stageMs: {
          featureMs: d.featureMs,
          retrievalMs: d.retrievalMs,
          matchMs: d.matchMs,
          geometryMs: d.geometryMs,
          totalMs: d.totalMs,
        },
        passes: d.passes.slice(0, MAX_TRACE_PASSES).map((p) => ({
          scale: p.scale,
          prepareMs: p.prepareMs,
          featureMs: p.featureMs,
          retrievalMs: p.retrievalMs,
          matchMs: p.matchMs,
          geometryMs: p.geometryMs,
          totalMs: p.totalMs,
          featureCount: p.featureCount,
          candidateCount: p.candidateCount,
          observationCount: p.observationCount,
          isAmbiguous: p.isAmbiguous,
          isBudgetExhausted: p.isBudgetExhausted,
          rejected: boundRejections(p.rejected),
        })),
      }
    : {};
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    algorithmVersion: d.algorithmVersion,
    featureCount: d.featureCount,
    candidateCount: d.candidateCount,
    scalePasses: d.scalePasses,
    observationCount: batch.observations.length,
    isAmbiguous: batch.isAmbiguous,
    isBudgetExhausted: d.isBudgetExhausted,
    rejected: boundRejections(batch.rejected),
    ...optional,
  };
}

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;
const isCount = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
/** Durations are floating point: finite, non-negative and bounded. */
const isMs = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TRACE_MS;
const areRejections = (v: unknown): v is TargetRejection[] =>
  Array.isArray(v) &&
  v.length <= MAX_TRACE_REJECTIONS &&
  v.every(
    (r: Partial<TargetRejection> | null) =>
      r && typeof r === 'object' && isText(r.targetId, 256) && isText(r.reason, MAX_TRACE_TEXT),
  );
const copyRejections = (rejected: readonly TargetRejection[]): TargetRejection[] =>
  rejected.map((r) => ({ targetId: r.targetId, reason: r.reason }));

function copyStageMs(v: unknown): RecognitionTraceStageMs | null {
  const s = v as Partial<RecognitionTraceStageMs> | null;
  if (
    !s ||
    typeof s !== 'object' ||
    ![s.featureMs, s.retrievalMs, s.matchMs, s.geometryMs, s.totalMs].every(isMs)
  ) {
    return null;
  }
  return {
    featureMs: s.featureMs!,
    retrievalMs: s.retrievalMs!,
    matchMs: s.matchMs!,
    geometryMs: s.geometryMs!,
    totalMs: s.totalMs!,
  };
}

function copyPass(v: unknown): RecognitionTracePass | null {
  const p = v as Partial<RecognitionTracePass> | null;
  const stage = copyStageMs(p);
  if (
    !p ||
    !stage ||
    typeof p.scale !== 'number' ||
    !Number.isFinite(p.scale) ||
    p.scale <= 0 ||
    p.scale > 1 ||
    !isMs(p.prepareMs) ||
    ![p.featureCount, p.candidateCount, p.observationCount].every(isCount) ||
    typeof p.isAmbiguous !== 'boolean' ||
    typeof p.isBudgetExhausted !== 'boolean' ||
    !areRejections(p.rejected)
  ) {
    return null;
  }
  return {
    scale: p.scale,
    prepareMs: p.prepareMs,
    ...stage,
    featureCount: p.featureCount!,
    candidateCount: p.candidateCount!,
    observationCount: p.observationCount!,
    isAmbiguous: p.isAmbiguous,
    isBudgetExhausted: p.isBudgetExhausted,
    rejected: copyRejections(p.rejected),
  };
}

/**
 * A fresh, bounded copy of `trace` when it is well formed and belongs to exactly this session and frame; otherwise
 * null. Never throws and never truncates silently; unknown fields are dropped.
 */
export function traceForFrame(trace: unknown, identity: FrameIdentity): RecognitionTrace | null {
  const t = trace as Partial<RecognitionTrace> | null;
  if (
    !t ||
    typeof t !== 'object' ||
    t.sessionId !== identity.sessionId ||
    t.frameId !== identity.frameId ||
    !isText(t.algorithmVersion, MAX_TRACE_TEXT) ||
    ![t.featureCount, t.candidateCount, t.scalePasses, t.observationCount].every(isCount) ||
    typeof t.isAmbiguous !== 'boolean' ||
    typeof t.isBudgetExhausted !== 'boolean' ||
    !areRejections(t.rejected)
  ) {
    return null;
  }
  const out: {
    -readonly [K in keyof RecognitionTrace]: RecognitionTrace[K];
  } = {
    sessionId: t.sessionId,
    frameId: t.frameId,
    algorithmVersion: t.algorithmVersion,
    featureCount: t.featureCount!,
    candidateCount: t.candidateCount!,
    scalePasses: t.scalePasses!,
    observationCount: t.observationCount!,
    isAmbiguous: t.isAmbiguous,
    isBudgetExhausted: t.isBudgetExhausted,
    rejected: copyRejections(t.rejected),
  };
  if (t.stageMs !== undefined) {
    const stage = copyStageMs(t.stageMs);
    if (!stage) return null;
    out.stageMs = stage;
  }
  if (t.passes !== undefined) {
    if (
      !Array.isArray(t.passes) ||
      t.passes.length < 1 ||
      t.passes.length > MAX_TRACE_PASSES ||
      t.passes.length !== t.scalePasses
    ) {
      return null;
    }
    const passes: RecognitionTracePass[] = [];
    for (const p of t.passes) {
      const copy = copyPass(p);
      if (!copy) return null;
      passes.push(copy);
    }
    out.passes = passes;
  }
  return out;
}
