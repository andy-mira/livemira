/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The local diagnostic log: an engine observer that keeps bounded, sanitized, numeric records until the user exports
// them. Key records are always on; full records (per-frame scheduling, results, Worker timings, every media time
// update and target update) only for sessions started at the full level.

import { EngineError, type TrackingResult } from '@livemira/contracts';

import type {
  DiagnosticEventRecord,
  DiagnosticExport,
  DiagnosticLevel,
  DiagnosticTargetRecord,
  EngineIdentity,
  FrameRecord,
  MetadataValue,
  ResultRecord,
  TelemetrySink,
  WorkerTimingRecord,
} from './diagnostic-types.ts';
import { Ring } from './ring.ts';
import { eventRecord, sanitizeMetadata } from './sanitize.ts';

export const DEFAULT_CAPACITY = 10000;
const MAX_CAPACITY = 100000;
const MAX_SECTIONS = 16;

export interface DiagnosticLogOptions {
  /** Default 'key'. */
  readonly level?: DiagnosticLevel;
  /** Records kept per kind, 1..100000; default 10000. */
  readonly capacity?: number;
}

const invalid = (message: string): EngineError =>
  new EngineError('INVALID_CONFIG', message, { isRecoverable: false });

function validLevel(level: unknown): DiagnosticLevel {
  if (level !== 'key' && level !== 'full')
    throw invalid("Diagnostic level must be 'key' or 'full'");
  return level;
}

/** Full-level events: per-frame target updates and media time updates. */
function isFullOnly(type: string, payload: unknown): boolean {
  return (
    type === 'targetUpdated' ||
    (type === 'mediaState' && (payload as { state?: unknown } | null)?.state === 'timeupdate')
  );
}

export class DiagnosticLog implements TelemetrySink {
  private requestedLevel: DiagnosticLevel;
  private sessionLevel: DiagnosticLevel;
  private hasFullSession = false;
  private readonly capacity: number;
  private readonly events: Ring<DiagnosticEventRecord>;
  private readonly frames: Ring<FrameRecord>;
  private readonly results: Ring<ResultRecord>;
  private readonly timings: Ring<WorkerTimingRecord>;
  private metadata: Record<string, MetadataValue> = {};
  private targets: readonly DiagnosticTargetRecord[] = [];
  private engine: EngineIdentity | null = null;
  private sections = new Map<string, unknown>();
  private runId: string;
  private createdAt: string;

  constructor(options: DiagnosticLogOptions = {}) {
    this.requestedLevel = validLevel(options.level ?? 'key');
    this.sessionLevel = this.requestedLevel;
    this.hasFullSession = this.sessionLevel === 'full';
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
      throw invalid('Diagnostic capacity must be an integer in 1..100000');
    this.capacity = capacity;
    this.events = new Ring(capacity);
    this.frames = new Ring(capacity);
    this.results = new Ring(capacity);
    this.timings = new Ring(capacity);
    this.runId = crypto.randomUUID();
    this.createdAt = new Date().toISOString();
  }

  /** The requested level; it applies from the next session start. */
  get level(): DiagnosticLevel {
    return this.requestedLevel;
  }

  /** The level of the current (or last) session. */
  get activeLevel(): DiagnosticLevel {
    return this.sessionLevel;
  }

  get wantsFrameDetail(): boolean {
    return this.sessionLevel === 'full';
  }

  setLevel(level: DiagnosticLevel): void {
    this.requestedLevel = validLevel(level);
  }

  /** Host context (device label, notes, …); only allowlisted keys and primitive values are kept. */
  setMetadata(values: Readonly<Record<string, MetadataValue>>): void {
    Object.assign(this.metadata, sanitizeMetadata(values));
  }

  /** Adds or replaces a host-owned export section (deep-copied); null removes it. */
  setSection(name: string, value: unknown): void {
    if (typeof name !== 'string' || !name || name.length > 64)
      throw invalid('Invalid section name');
    if (value === null) {
      this.sections.delete(name);
      return;
    }
    if (!this.sections.has(name) && this.sections.size >= MAX_SECTIONS)
      throw invalid('Too many sections');
    this.sections.set(name, structuredClone(value));
  }

  event(type: string, payload: unknown): void {
    try {
      if (type === 'attemptStart') {
        this.sessionLevel = this.requestedLevel;
        if (this.sessionLevel === 'full') this.hasFullSession = true;
      }
      if (this.sessionLevel === 'key' && isFullOnly(type, payload)) return;
      const record = eventRecord(type, payload);
      if (type === 'attemptStart') (record as Record<string, unknown>).level = this.sessionLevel;
      this.observe(type, payload);
      this.events.push(record);
    } catch {
      // The log is an observer: it never fails the engine.
    }
  }

  frame(record: FrameRecord): void {
    if (this.sessionLevel !== 'full') return;
    const {
      sessionId,
      frameId,
      targetId,
      pictureKey,
      arrivalTimeUs,
      submitTimeUs,
      resultAvailableTimeUs,
      renderSubmitTimeUs,
      queueWaitDurationUs,
      dropReason,
    } = record;
    this.frames.push({
      sessionId,
      frameId,
      targetId,
      pictureKey,
      arrivalTimeUs,
      submitTimeUs,
      resultAvailableTimeUs,
      renderSubmitTimeUs,
      queueWaitDurationUs,
      dropReason,
    });
  }

  workerTiming(record: WorkerTimingRecord): void {
    if (this.sessionLevel !== 'full') return;
    try {
      this.timings.push(structuredClone(record));
    } catch {
      // Not cloneable: not retained.
    }
  }

  /** Matched points are display data and never retained. */
  result(result: TrackingResult): void {
    if (this.sessionLevel !== 'full') return;
    const { matchedPoints: _displayOnly, ...numeric } = result;
    this.results.push(structuredClone(numeric));
  }

  /** Session configuration and capability events identify the targets and the engine build. */
  private observe(type: string, payload: unknown): void {
    const value = payload as Record<string, unknown> | null;
    if ((type === 'sessionConfig' || type === 'sessionConfigUpdated') && value) {
      const targets = (value.config as { targets?: unknown } | undefined)?.targets;
      if (Array.isArray(targets)) {
        this.targets = targets.map((t: Record<string, unknown>) => ({
          targetId: String(t.targetId),
          imageHash: String(t.imageHash),
          algorithmVersion: String(t.algorithmVersion),
          compilerVersion: String(t.compilerVersion),
          widthPx: Number(t.widthPx),
          heightPx: Number(t.heightPx),
        }));
      }
    }
    if (type === 'capabilityChanged' && value) {
      const engine = (value.capability as { engine?: Record<string, unknown> } | undefined)?.engine;
      if (engine && typeof engine === 'object') {
        this.engine = {
          version: String(engine.version),
          buildId: typeof engine.buildId === 'string' ? engine.buildId : null,
          format: String(engine.format),
          variant: typeof engine.variant === 'string' ? engine.variant : null,
        };
      }
    }
  }

  private get droppedRecords(): number {
    return this.events.dropped + this.frames.dropped + this.results.dropped + this.timings.dropped;
  }

  getCapacity(): { capacity: number; records: number; dropped: number } {
    return {
      capacity: this.capacity,
      records: this.events.size + this.frames.size + this.results.size + this.timings.size,
      dropped: this.droppedRecords,
    };
  }

  export(): DiagnosticExport {
    const isFull = this.hasFullSession;
    const droppedRecords = this.droppedRecords;
    return {
      schema: 'livemira-diagnostics/2',
      engine: this.engine,
      runId: this.runId,
      createdAt: this.createdAt,
      level: isFull ? 'full' : 'key',
      metadata: { ...this.metadata },
      targets: this.targets.map((t) => ({ ...t })),
      events: this.events.values(),
      ...(isFull
        ? {
            frames: this.frames.values(),
            results: this.results.values(),
            workerTimings: this.timings.values(),
          }
        : {}),
      isComplete: droppedRecords === 0,
      droppedRecords,
      ...(this.sections.size ? { sections: Object.fromEntries(this.sections) } : {}),
    };
  }

  /** Starts a new run: all records, sections and the run id are replaced; metadata and the level are kept. */
  clear(): void {
    this.events.clear();
    this.frames.clear();
    this.results.clear();
    this.timings.clear();
    this.sections.clear();
    this.targets = [];
    this.engine = null;
    this.hasFullSession = this.sessionLevel === 'full';
    this.runId = crypto.randomUUID();
    this.createdAt = new Date().toISOString();
  }
}
