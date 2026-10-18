/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Optional recognition diagnostics: bounded counters of WHY targets were rejected and statistics of WHERE the
// measured matched points lie. As an engine extension it needs the recognition trace and the matched points from the
// Worker, and reads target sizes from the host. Output is numeric and bounded (no pixels, URLs or point arrays) and
// is safe to put in a diagnostic log section. Nothing in the engine imports this module.

import { EngineError, type Point2, type TrackingResult } from '@livemira/contracts';
import type {
  EngineExtension,
  ExtensionHandle,
  ExtensionHost,
  RecognitionTrace,
} from '@livemira/engine';

import { pointDistribution } from './point-distribution.ts';

export const DIAGNOSTICS_SCHEMA = 'livemira-recognition-diagnostics/2';

export interface DiagnosticsTarget {
  readonly targetId: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface RecognitionDiagnosticsOptions {
  /** Sessions kept at once; the oldest is evicted. 1..16, default 4. */
  readonly maxSessions?: number;
  /** Targets per session. 1..32, default 16. Further targets are counted in dropped.targets. */
  readonly maxTargets?: number;
  /** Distinct rejection reason codes per target. 1..64, default 24. Further codes are counted as OTHER. */
  readonly maxReasons?: number;
  /** Minimum time between point-distribution computations (ms). 0..60000, default 200. */
  readonly minDispersionIntervalMs?: number;
  /** Clock in ms; default performance.now. */
  readonly nowMs?: () => number;
}

export type RejectionStage =
  'target-diagnostics' | 'retrieval' | 'matching' | 'geometry' | 'boundary' | 'ambiguity' | 'other';

export interface RunningStat {
  readonly n: number;
  readonly mean: number;
  readonly min: number;
  readonly max: number;
}

export interface PassRejections {
  readonly total: number;
  readonly byReason: Readonly<Record<string, number>>;
}

export interface TargetDiagnostics {
  readonly targetId: string;
  /** Final-pass rejections: one entry per trace rejection record. */
  readonly rejections: {
    readonly total: number;
    readonly byStage: Readonly<Partial<Record<RejectionStage, number>>>;
    readonly byReason: Readonly<Record<string, number>>;
  };
  /** Separate counts by pass from traces that carry passes; never added into `rejections`. */
  readonly passRejections: { readonly first: PassRejections; readonly second: PassRejections };
  readonly measured: {
    readonly results: number;
    readonly hullCoverage: RunningStat;
    readonly dispersion: RunningStat;
    readonly isotropy: RunningStat;
    readonly pointCount: RunningStat;
  };
}

/** Statistics of one pass position (times in ms) over traces that carry passes. */
export interface PassStats {
  readonly n: number;
  readonly prepareMs: RunningStat;
  readonly featureMs: RunningStat;
  readonly retrievalMs: RunningStat;
  readonly matchMs: RunningStat;
  readonly geometryMs: RunningStat;
  readonly totalMs: RunningStat;
  readonly featureCount: RunningStat;
  readonly candidateCount: RunningStat;
  readonly ambiguous: number;
  readonly budgetExhausted: number;
  readonly accepted: number;
}

export interface SessionDiagnostics {
  readonly sessionId: string;
  readonly recognition: {
    readonly passes: number;
    readonly ambiguous: number;
    readonly budgetExhausted: number;
    readonly twoScalePasses: number;
    readonly accepted: number;
    readonly featureCount: RunningStat;
  };
  /** Stage times (ms, summed over the passes of a trace) over traces that carry them. */
  readonly stageTiming: {
    readonly traces: number;
    readonly featureMs: RunningStat;
    readonly retrievalMs: RunningStat;
    readonly matchMs: RunningStat;
    readonly geometryMs: RunningStat;
    readonly totalMs: RunningStat;
  };
  readonly passStats: { readonly first: PassStats; readonly second: PassStats };
  readonly results: {
    readonly observed: number;
    readonly measured: number;
    readonly predictedOrLost: number;
  };
  readonly dispersion: {
    readonly computed: number;
    readonly skippedByRate: number;
    readonly skippedNoTargetSize: number;
    readonly skippedInvalid: number;
  };
  readonly targets: readonly TargetDiagnostics[];
}

export interface DiagnosticsSnapshot {
  readonly schema: typeof DIAGNOSTICS_SCHEMA;
  readonly isDisposed: boolean;
  readonly sessions: readonly SessionDiagnostics[];
  readonly dropped: {
    readonly stale: number;
    readonly malformed: number;
    readonly closedSession: number;
    readonly sessions: number;
    readonly targets: number;
  };
}

export interface RecognitionDiagnostics extends EngineExtension {
  /** Target sizes in target pixels (max 32), for hosts that feed traces and results themselves. */
  setTargets(targets: readonly DiagnosticsTarget[]): void;
  observeRecognition(trace: RecognitionTrace): void;
  observeResult(result: TrackingResult): void;
  snapshot(): DiagnosticsSnapshot;
  /** Forgets one session (or all); late events of a forgotten session are dropped, not re-counted. */
  reset(sessionId?: string): void;
  /** Releases everything; later calls do nothing and snapshot() reports an empty, disposed state. */
  dispose(): void;
}

const MAX_MS = 600_000;
const MAX_TEXT = 64;
const MAX_ID = 256;
const MAX_CLOSED = 32;
const MAX_POINTS = 512;
const STAGES: Readonly<Record<string, RejectionStage>> = Object.freeze({
  LOW_TEXTURE: 'target-diagnostics',
  LOW_COVERAGE: 'target-diagnostics',
  REPETITIVE_TEXTURE: 'target-diagnostics',
  NOT_SHORTLISTED: 'retrieval',
  RETRIEVAL_AMBIGUITY: 'retrieval',
  INSUFFICIENT_MATCHES: 'matching',
  DEGENERATE_MODEL: 'geometry',
  DEGENERATE_REFINEMENT: 'geometry',
  NO_ROBUST_MODEL: 'geometry',
  LOW_INLIER_SUPPORT: 'geometry',
  LOW_SPATIAL_COVERAGE: 'geometry',
  INVALID_BOUNDARY: 'boundary',
  AMBIGUOUS_TARGETS: 'ambiguity',
});
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;

type Rejection = { targetId: string; reason: string };
type StageMs = NonNullable<RecognitionTrace['stageMs']>;
type Pass = NonNullable<RecognitionTrace['passes']>[number];

const isText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= max;
const isCount = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
/** Durations are floats: finite, non-negative, bounded. */
const isMillis = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS;
const isStageMs = (s: unknown): s is StageMs => {
  const m = s as StageMs | null;
  return (
    !!m &&
    typeof m === 'object' &&
    [m.featureMs, m.retrievalMs, m.matchMs, m.geometryMs, m.totalMs].every(isMillis)
  );
};
const areRejections = (r: unknown): r is Rejection[] =>
  Array.isArray(r) &&
  r.length <= 32 &&
  r.every((x: Rejection) => x && isText(x.targetId, MAX_ID) && isText(x.reason, MAX_TEXT));
const isPass = (p: unknown): p is Pass => {
  const q = p as Pass;
  return (
    isStageMs(q) &&
    typeof q.scale === 'number' &&
    Number.isFinite(q.scale) &&
    q.scale > 0 &&
    q.scale <= 1 &&
    isMillis(q.prepareMs) &&
    [q.featureCount, q.candidateCount, q.observationCount].every(isCount) &&
    typeof q.isAmbiguous === 'boolean' &&
    typeof q.isBudgetExhausted === 'boolean' &&
    areRejections(q.rejected)
  );
};

interface Stat {
  n: number;
  mean: number;
  min: number;
  max: number;
}
const newStat = (): Stat => ({ n: 0, mean: 0, min: 0, max: 0 });
function addStat(stat: Stat, value: number): void {
  stat.n++;
  if (stat.n === 1) {
    stat.mean = value;
    stat.min = value;
    stat.max = value;
    return;
  }
  stat.mean += (value - stat.mean) / stat.n;
  if (value < stat.min) stat.min = value;
  if (value > stat.max) stat.max = value;
}
const copyStat = (s: Stat): RunningStat => ({ n: s.n, mean: s.mean, min: s.min, max: s.max });

function invert(h: readonly number[] | null): number[] | null {
  if (!Array.isArray(h) || h.length !== 9 || !h.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, i, j] = h as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const A = e * j - f * i;
  const B = -(d * j - f * g);
  const C = d * i - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    A / det,
    -(b * j - c * i) / det,
    (b * f - c * e) / det,
    B / det,
    (a * j - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * i - b * g) / det,
    (a * e - b * d) / det,
  ];
}

interface PassState {
  n: number;
  prepare: Stat;
  feature: Stat;
  retrieval: Stat;
  match: Stat;
  geometry: Stat;
  total: Stat;
  features: Stat;
  candidates: Stat;
  ambiguous: number;
  exhausted: number;
  accepted: number;
}
const newPass = (): PassState => ({
  n: 0,
  prepare: newStat(),
  feature: newStat(),
  retrieval: newStat(),
  match: newStat(),
  geometry: newStat(),
  total: newStat(),
  features: newStat(),
  candidates: newStat(),
  ambiguous: 0,
  exhausted: 0,
  accepted: 0,
});
const copyPass = (p: PassState): PassStats => ({
  n: p.n,
  prepareMs: copyStat(p.prepare),
  featureMs: copyStat(p.feature),
  retrievalMs: copyStat(p.retrieval),
  matchMs: copyStat(p.match),
  geometryMs: copyStat(p.geometry),
  totalMs: copyStat(p.total),
  featureCount: copyStat(p.features),
  candidateCount: copyStat(p.candidates),
  ambiguous: p.ambiguous,
  budgetExhausted: p.exhausted,
  accepted: p.accepted,
});

interface PassRejectionState {
  total: number;
  byReason: Map<string, number>;
}
interface TargetState {
  targetId: string;
  /** Created only by optional pass facts; evicted first when a final-pass fact needs the slot. */
  isPassOnly: boolean;
  total: number;
  byStage: Map<string, number>;
  byReason: Map<string, number>;
  passRejections: [PassRejectionState, PassRejectionState];
  results: number;
  hull: Stat;
  dispersion: Stat;
  isotropy: Stat;
  points: Stat;
}
interface SessionState {
  sessionId: string;
  lastTrace: number;
  lastResult: number;
  passes: number;
  ambiguous: number;
  exhausted: number;
  twoScale: number;
  accepted: number;
  features: Stat;
  timing: {
    traces: number;
    feature: Stat;
    retrieval: Stat;
    match: Stat;
    geometry: Stat;
    total: Stat;
  };
  passStats: [PassState, PassState];
  observed: number;
  measured: number;
  other: number;
  computed: number;
  skippedRate: number;
  skippedSize: number;
  skippedInvalid: number;
  lastComputeAt: number;
  targets: Map<string, TargetState>;
}

const invalidConfig = (message: string): EngineError =>
  new EngineError('INVALID_CONFIG', message, { isRecoverable: false });

function intOption(
  value: unknown,
  name: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw invalidConfig(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function createRecognitionDiagnostics(
  options: RecognitionDiagnosticsOptions = {},
): RecognitionDiagnostics {
  if (options === null || typeof options !== 'object')
    throw invalidConfig('options must be an object');
  const maxSessions = intOption(options.maxSessions, 'maxSessions', 1, 16, 4);
  const maxTargets = intOption(options.maxTargets, 'maxTargets', 1, 32, 16);
  const maxReasons = intOption(options.maxReasons, 'maxReasons', 1, 64, 24);
  const interval = intOption(
    options.minDispersionIntervalMs,
    'minDispersionIntervalMs',
    0,
    60000,
    200,
  );
  if (options.nowMs !== undefined && typeof options.nowMs !== 'function')
    throw invalidConfig('nowMs must be a function');
  const nowMs = options.nowMs ?? (() => performance.now());
  let isDisposed = false;
  let sizes = new Map<string, DiagnosticsTarget>();
  let host: ExtensionHost | null = null;
  const sessions = new Map<string, SessionState>();
  const closed: string[] = [];
  const dropped = { stale: 0, malformed: 0, closedSession: 0, sessions: 0, targets: 0 };

  function session(sessionId: unknown): SessionState | null {
    if (!isText(sessionId, MAX_ID)) {
      dropped.malformed++;
      return null;
    }
    if (closed.includes(sessionId)) {
      dropped.closedSession++;
      return null;
    }
    let state = sessions.get(sessionId);
    if (!state) {
      if (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next().value as string;
        sessions.delete(oldest);
        dropped.sessions++;
      }
      state = {
        sessionId,
        lastTrace: -1,
        lastResult: -1,
        passes: 0,
        ambiguous: 0,
        exhausted: 0,
        twoScale: 0,
        accepted: 0,
        features: newStat(),
        timing: {
          traces: 0,
          feature: newStat(),
          retrieval: newStat(),
          match: newStat(),
          geometry: newStat(),
          total: newStat(),
        },
        passStats: [newPass(), newPass()],
        observed: 0,
        measured: 0,
        other: 0,
        computed: 0,
        skippedRate: 0,
        skippedSize: 0,
        skippedInvalid: 0,
        lastComputeAt: -Infinity,
        targets: new Map(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  }

  function target(state: SessionState, targetId: string, isPassOnly = false): TargetState | null {
    let t = state.targets.get(targetId);
    if (t) {
      if (!isPassOnly) t.isPassOnly = false;
      return t;
    }
    if (state.targets.size >= maxTargets) {
      // Final-pass facts always win capacity over optional pass facts: a pass-only target is evicted for them, and
      // pass-only facts never count as dropped.
      const spare = isPassOnly ? undefined : [...state.targets.values()].find((x) => x.isPassOnly);
      if (!spare) {
        if (!isPassOnly) dropped.targets++;
        return null;
      }
      state.targets.delete(spare.targetId);
    }
    t = {
      targetId,
      isPassOnly,
      total: 0,
      byStage: new Map(),
      byReason: new Map(),
      passRejections: [
        { total: 0, byReason: new Map() },
        { total: 0, byReason: new Map() },
      ],
      results: 0,
      hull: newStat(),
      dispersion: newStat(),
      isotropy: newStat(),
      points: newStat(),
    };
    state.targets.set(targetId, t);
    return t;
  }

  const bump = (map: Map<string, number>, key: string, limit: number): void => {
    if (!map.has(key) && map.size >= limit) key = 'OTHER';
    map.set(key, (map.get(key) ?? 0) + 1);
  };

  const sizeOf = (targetId: string): DiagnosticsTarget | undefined =>
    sizes.get(targetId) ?? host?.getTargets().find((t) => t.targetId === targetId);

  const diagnostics: RecognitionDiagnostics = {
    name: 'recognition-diagnostics',
    needs: { matchedPoints: true, recognitionTrace: true },
    attach(next: ExtensionHost): ExtensionHandle {
      host = next;
      const offTrace = next.onRecognitionTrace((trace) => diagnostics.observeRecognition(trace));
      const offResult = next.onResult((result) => diagnostics.observeResult(result));
      return {
        detach() {
          offTrace();
          offResult();
          host = null;
        },
      };
    },
    setTargets(targets) {
      if (isDisposed) return;
      if (
        !Array.isArray(targets) ||
        targets.length > 32 ||
        !targets.every(
          (t) =>
            t &&
            isText(t.targetId, MAX_ID) &&
            Number.isFinite(t.widthPx) &&
            t.widthPx > 0 &&
            Number.isFinite(t.heightPx) &&
            t.heightPx > 0,
        )
      )
        throw invalidConfig('targets must be at most 32 {targetId, widthPx > 0, heightPx > 0}');
      sizes = new Map(
        targets.map((t) => [
          t.targetId,
          { targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx },
        ]),
      );
    },
    observeRecognition(trace) {
      if (isDisposed) return;
      if (
        !trace ||
        !isText(trace.algorithmVersion, MAX_TEXT) ||
        !isCount(trace.frameId) ||
        ![
          trace.featureCount,
          trace.candidateCount,
          trace.scalePasses,
          trace.observationCount,
        ].every(isCount) ||
        typeof trace.isAmbiguous !== 'boolean' ||
        typeof trace.isBudgetExhausted !== 'boolean' ||
        !Array.isArray(trace.rejected) ||
        trace.rejected.length > 32 ||
        !trace.rejected.every((r) => r && isText(r.targetId, MAX_ID) && isText(r.reason, MAX_TEXT))
      ) {
        dropped.malformed++;
        return;
      }
      // Optional fields are validated on their own terms; any violation drops the whole trace as malformed.
      if (trace.stageMs !== undefined && !isStageMs(trace.stageMs)) {
        dropped.malformed++;
        return;
      }
      if (
        trace.passes !== undefined &&
        (!Array.isArray(trace.passes) ||
          trace.passes.length < 1 ||
          trace.passes.length > 2 ||
          trace.passes.length !== trace.scalePasses ||
          !trace.passes.every(isPass))
      ) {
        dropped.malformed++;
        return;
      }
      const state = session(trace.sessionId);
      if (!state) return;
      if (trace.frameId <= state.lastTrace) {
        dropped.stale++;
        return;
      }
      state.lastTrace = trace.frameId;
      state.passes++;
      state.accepted += trace.observationCount > 0 ? 1 : 0;
      state.ambiguous += trace.isAmbiguous ? 1 : 0;
      state.exhausted += trace.isBudgetExhausted ? 1 : 0;
      state.twoScale += trace.scalePasses > 1 ? 1 : 0;
      addStat(state.features, trace.featureCount);
      if (trace.stageMs) {
        const m = trace.stageMs;
        const g = state.timing;
        g.traces++;
        addStat(g.feature, m.featureMs);
        addStat(g.retrieval, m.retrievalMs);
        addStat(g.match, m.matchMs);
        addStat(g.geometry, m.geometryMs);
        addStat(g.total, m.totalMs);
      }
      for (const rejection of trace.rejected) {
        const t = target(state, rejection.targetId);
        if (!t) continue;
        // A reason may be a comma-joined list of compile diagnostics; each code is a separate fact, the target is
        // counted once per pass.
        t.total++;
        for (const code of rejection.reason.split(',')) {
          const clean = REASON_CODE.test(code) ? code : 'OTHER';
          bump(t.byReason, clean, maxReasons);
          bump(t.byStage, STAGES[clean] ?? 'other', 8);
        }
      }
      // Optional pass facts come last: final-pass statistics and target capacity are settled first.
      trace.passes?.forEach((p, i) => {
        const ps = state.passStats[i]!;
        ps.n++;
        ps.ambiguous += p.isAmbiguous ? 1 : 0;
        ps.exhausted += p.isBudgetExhausted ? 1 : 0;
        ps.accepted += p.observationCount > 0 ? 1 : 0;
        addStat(ps.prepare, p.prepareMs);
        addStat(ps.feature, p.featureMs);
        addStat(ps.retrieval, p.retrievalMs);
        addStat(ps.match, p.matchMs);
        addStat(ps.geometry, p.geometryMs);
        addStat(ps.total, p.totalMs);
        addStat(ps.features, p.featureCount);
        addStat(ps.candidates, p.candidateCount);
        for (const rejection of p.rejected) {
          const t = target(state, rejection.targetId, true);
          if (!t) continue;
          const pr = t.passRejections[i as 0 | 1];
          pr.total++;
          for (const code of rejection.reason.split(','))
            bump(pr.byReason, REASON_CODE.test(code) ? code : 'OTHER', maxReasons);
        }
      });
    },
    observeResult(result) {
      if (isDisposed) return;
      if (
        !result ||
        !isCount(result.frameId) ||
        typeof result.state !== 'string' ||
        !result.quality ||
        typeof result.quality.isMeasured !== 'boolean'
      ) {
        dropped.malformed++;
        return;
      }
      const state = session(result.sessionId);
      if (!state) return;
      if (result.frameId <= state.lastResult) {
        dropped.stale++;
        return;
      }
      state.lastResult = result.frameId;
      state.observed++;
      // Only a genuinely measured TRACKING result counts; predictions never enter the distribution.
      const m = result.matchedPoints;
      if (
        result.state !== 'TRACKING' ||
        result.quality.isMeasured !== true ||
        result.prediction?.ageUs !== 0 ||
        !isText(result.targetId, MAX_ID)
      ) {
        state.other++;
        return;
      }
      state.measured++;
      if (
        !m ||
        m.sessionId !== result.sessionId ||
        m.frameId !== result.frameId ||
        m.targetId !== result.targetId ||
        !Array.isArray(m.pointsPx) ||
        m.pointsPx.length < 1 ||
        m.pointsPx.length > MAX_POINTS
      ) {
        state.skippedInvalid++;
        return;
      }
      const size = sizeOf(result.targetId);
      if (!size) {
        state.skippedSize++;
        return;
      }
      const at = nowMs();
      if (at - state.lastComputeAt < interval) {
        state.skippedRate++;
        return;
      }
      const inverse = invert(result.H_imageFromTarget);
      if (!inverse) {
        state.skippedInvalid++;
        return;
      }
      const points: Point2[] = [];
      for (const p of m.pointsPx) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const w = inverse[6]! * p[0] + inverse[7]! * p[1] + inverse[8]!;
        if (!Number.isFinite(w) || Math.abs(w) < 1e-12) continue;
        const x = (inverse[0]! * p[0] + inverse[1]! * p[1] + inverse[2]!) / w;
        const y = (inverse[3]! * p[0] + inverse[4]! * p[1] + inverse[5]!) / w;
        if (Number.isFinite(x) && Number.isFinite(y))
          points.push([
            Math.min(size.widthPx, Math.max(0, x)),
            Math.min(size.heightPx, Math.max(0, y)),
          ]);
      }
      if (!points.length) {
        state.skippedInvalid++;
        return;
      }
      const t = target(state, result.targetId);
      if (!t) return;
      const d = pointDistribution(points, size.widthPx, size.heightPx);
      state.lastComputeAt = at;
      state.computed++;
      t.results++;
      addStat(t.hull, d.hullCoverage);
      addStat(t.dispersion, d.dispersion);
      addStat(t.isotropy, d.isotropy);
      addStat(t.points, d.count);
    },
    snapshot() {
      const out: SessionDiagnostics[] = [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        recognition: {
          passes: s.passes,
          ambiguous: s.ambiguous,
          budgetExhausted: s.exhausted,
          twoScalePasses: s.twoScale,
          accepted: s.accepted,
          featureCount: copyStat(s.features),
        },
        results: { observed: s.observed, measured: s.measured, predictedOrLost: s.other },
        dispersion: {
          computed: s.computed,
          skippedByRate: s.skippedRate,
          skippedNoTargetSize: s.skippedSize,
          skippedInvalid: s.skippedInvalid,
        },
        stageTiming: {
          traces: s.timing.traces,
          featureMs: copyStat(s.timing.feature),
          retrievalMs: copyStat(s.timing.retrieval),
          matchMs: copyStat(s.timing.match),
          geometryMs: copyStat(s.timing.geometry),
          totalMs: copyStat(s.timing.total),
        },
        passStats: { first: copyPass(s.passStats[0]), second: copyPass(s.passStats[1]) },
        targets: [...s.targets.values()].map((t) => ({
          targetId: t.targetId,
          rejections: {
            total: t.total,
            byStage: Object.fromEntries(t.byStage),
            byReason: Object.fromEntries(t.byReason),
          },
          passRejections: {
            first: {
              total: t.passRejections[0].total,
              byReason: Object.fromEntries(t.passRejections[0].byReason),
            },
            second: {
              total: t.passRejections[1].total,
              byReason: Object.fromEntries(t.passRejections[1].byReason),
            },
          },
          measured: {
            results: t.results,
            hullCoverage: copyStat(t.hull),
            dispersion: copyStat(t.dispersion),
            isotropy: copyStat(t.isotropy),
            pointCount: copyStat(t.points),
          },
        })),
      }));
      return { schema: DIAGNOSTICS_SCHEMA, isDisposed, sessions: out, dropped: { ...dropped } };
    },
    reset(sessionId) {
      if (isDisposed) return;
      if (sessionId === undefined) {
        for (const id of sessions.keys()) closed.push(id);
        sessions.clear();
      } else if (isText(sessionId, MAX_ID)) {
        sessions.delete(sessionId);
        if (!closed.includes(sessionId)) closed.push(sessionId);
      }
      while (closed.length > MAX_CLOSED) closed.shift();
    },
    dispose() {
      isDisposed = true;
      sessions.clear();
      sizes = new Map();
      closed.length = 0;
    },
  };
  return diagnostics;
}
