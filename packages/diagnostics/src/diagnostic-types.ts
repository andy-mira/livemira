/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrackingResult } from '@livemira/contracts';

/** 'key': session, error, permission, visibility, transition, recognition, media and capability events. 'full': also per-frame records. */
export type DiagnosticLevel = 'key' | 'full';

/** Scheduling record of one camera frame (numbers and enums only). */
export interface FrameRecord {
  readonly sessionId: string;
  readonly frameId: number;
  readonly targetId: string | null;
  /** Picture identity of the camera frame. */
  readonly pictureKey: string | null;
  readonly arrivalTimeUs: number | null;
  /** Hand-off to the vision pipeline, on the event clock. */
  readonly submitTimeUs: number | null;
  readonly resultAvailableTimeUs: number | null;
  readonly renderSubmitTimeUs: number | null;
  /** Engine-clock time from acceptance to hand-off. */
  readonly queueWaitDurationUs: number | null;
  /** Why the frame produced no presentation, or null. */
  readonly dropReason: string | null;
}

export interface WorkerTimingRecord {
  readonly sessionId: string;
  readonly frameId: number;
  /** Worker generation; +1 for every Worker created. */
  readonly generation: number;
  /** Durations in µs and copied byte counts; numbers only. */
  readonly timing: Readonly<Record<string, number | null | Readonly<Record<string, number>>>>;
}

/** A tracking result without its matched points (display data, never logged). */
export type ResultRecord = Omit<TrackingResult, 'matchedPoints'>;

/** One engine event: its context and an allowlisted copy of its payload. */
export interface DiagnosticEventRecord {
  readonly type: string;
  readonly sessionId: string | null;
  readonly targetId: string | null;
  readonly timestampUs: number | null;
  readonly timestampDomain: string | null;
  readonly [field: string]: unknown;
}

/**
 * What the engine reports to a diagnostic observer. All methods are optional and synchronous; the engine isolates
 * them, but a sink must never throw.
 */
export interface TelemetrySink {
  /** True when the engine should build per-frame records for this session (read after each `attemptStart`). */
  readonly wantsFrameDetail: boolean;
  event?(type: string, payload: unknown): void;
  frame?(record: FrameRecord): void;
  workerTiming?(record: WorkerTimingRecord): void;
  result?(result: TrackingResult): void;
}

export interface EngineIdentity {
  readonly version: string;
  readonly buildId: string | null;
  readonly format: string;
  readonly variant: string | null;
}

export interface DiagnosticTargetRecord {
  readonly targetId: string;
  readonly imageHash: string;
  readonly algorithmVersion: string;
  readonly compilerVersion: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export type MetadataValue = string | number | boolean | null;

export interface DiagnosticExport {
  readonly schema: 'livemira-diagnostics/2';
  readonly engine: EngineIdentity | null;
  readonly runId: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** 'full' when any recorded session ran at the full level (each attemptStart record carries its level). */
  readonly level: DiagnosticLevel;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
  readonly targets: readonly DiagnosticTargetRecord[];
  readonly events: readonly DiagnosticEventRecord[];
  readonly frames?: readonly FrameRecord[];
  readonly results?: readonly ResultRecord[];
  readonly workerTimings?: readonly WorkerTimingRecord[];
  readonly isComplete: boolean;
  readonly droppedRecords: number;
  /** Host-owned sections (e.g. a test suite's results or an extension snapshot). */
  readonly sections?: Readonly<Record<string, unknown>>;
}
