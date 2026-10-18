/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Allowlists: the log keeps numbers and closed enums only. Retry functions, native errors, frame handles, pixels,
// URLs and free text from outside the engine are never retained.

import type { DiagnosticEventRecord, MetadataValue } from './diagnostic-types.ts';

const PHASES: readonly string[] = ['loading', 'revealing', 'revealed', 'failed', 'cancelled'];
const SIGNALS: readonly string[] = ['video-frame-callback', 'time-progress'];
const FAILURES: readonly string[] = ['media-error', 'playback-blocked', 'loading-timeout'];

/** Payload fields an event record keeps (deep-copied). */
const EVENT_FIELDS = [
  'reason',
  'code',
  'detail',
  'config',
  'state',
  'media',
  'attemptTimeUs',
  'stage',
  'durationUs',
  'status',
  'visibility',
  'phase',
  'epoch',
  'permission',
  'lossContext',
  'capability',
  'widthPx',
  'heightPx',
] as const;

/** Host metadata keys that describe the product run (test-flow keys belong to the lab's own sections). */
export const METADATA_KEYS: ReadonlySet<string> = new Set([
  'deviceLabel',
  'browserVersion',
  'userAgent',
  'notes',
  'secureContext',
  'crossOriginIsolated',
  'devicePixelRatio',
  'cameraFacingMode',
  'requestedLongEdge',
  'maxPredictionMs',
  'lossDisplayGraceMs',
  'engineFormat',
  'engineVariant',
  'engineBuildId',
]);

export const MAX_METADATA_STRING = 1024;

const boundedNumber = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null;

/** Closed-set copy of media presentation telemetry; null when it is not well formed. */
export function sanitizePresentation(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const generation = boundedNumber(v.requestGeneration, 1e9);
  const elapsed = boundedNumber(v.elapsedMs, 3.6e6);
  const duration = boundedNumber(v.revealDurationMs, 1e4);
  if (
    generation === null ||
    !Number.isInteger(generation) ||
    elapsed === null ||
    duration === null ||
    !PHASES.includes(v.phase as string)
  )
    return null;
  const out: Record<string, unknown> = {
    requestGeneration: generation,
    phase: v.phase,
    readySignal: SIGNALS.includes(v.readySignal as string) ? v.readySignal : null,
    elapsedMs: elapsed,
    firstFrameMs: boundedNumber(v.firstFrameMs, 3.6e6),
    revealElapsedMs: boundedNumber(v.revealElapsedMs, 1e4),
    revealDurationMs: duration,
    isReducedMotion: v.isReducedMotion === true,
  };
  if (FAILURES.includes(v.failureReason as string)) out.failureReason = v.failureReason;
  return out;
}

const asContextValue = <T>(value: unknown, check: (v: unknown) => boolean): T | null =>
  check(value) ? (value as T) : null;

/** An event record: the context fields and an allowlisted deep copy of the payload. */
export function eventRecord(type: string, payload: unknown): DiagnosticEventRecord {
  const value = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const record: Record<string, unknown> = {
    type,
    sessionId: asContextValue<string>(value.sessionId, (v) => typeof v === 'string'),
    targetId: asContextValue<string>(value.targetId, (v) => typeof v === 'string'),
    timestampUs: asContextValue<number>(value.timestampUs, (v) => typeof v === 'number'),
    timestampDomain: asContextValue<string>(value.timestampDomain, (v) => typeof v === 'string'),
  };
  const fields: Record<string, unknown> = { ...value };
  const media = fields.media as Record<string, unknown> | undefined;
  if (media && typeof media === 'object' && media.presentation !== undefined) {
    const { presentation, ...rest } = media;
    const clean = sanitizePresentation(presentation);
    fields.media = clean ? { ...rest, presentation: clean } : rest;
  }
  for (const key of EVENT_FIELDS) {
    if (fields[key] !== undefined) {
      try {
        record[key] = structuredClone(fields[key]);
      } catch {
        // Not cloneable (a function or a host object): not retained.
      }
    }
  }
  const error = value.error as { code?: unknown; isRecoverable?: unknown } | undefined;
  if (type === 'error' && error && typeof error === 'object') {
    record.code = typeof error.code === 'string' ? error.code : null;
    record.isRecoverable = error.isRecoverable === true;
  }
  return record as DiagnosticEventRecord;
}

/** Allowlisted metadata values: primitives only, strings cut to 1024 characters. */
export function sanitizeMetadata(
  values: Readonly<Record<string, unknown>>,
): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const [key, item] of Object.entries(values)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof item === 'string') out[key] = item.slice(0, MAX_METADATA_STRING);
    else if (typeof item === 'number' || typeof item === 'boolean' || item === null)
      out[key] = item;
  }
  return out;
}
