/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Optional recognition diagnostics: bounded counters of WHY targets were rejected and statistics of WHERE the measured matched points lie. NOT part of the engine
// runtime: nothing in the engine closures imports it (the engine builder gates that) and it imports nothing from the engine, so it ships as its own standalone module.
//
// Inputs are the two generic, disabled-by-default seams of the engine, both plain data:
//   * WorkerPipelineOptions.observeRecognition + WorkerPipelineConfig.onRecognitionTrace -> observeRecognition(trace)   (bounded numeric trace of one recognition pass)
//   * WorkerPipelineOptions.collectMatchedPoints + onResult                              -> observeResult(result)        (measured results carry inlier image points)
// Nothing is computed unless a host creates this object, enables those options and forwards the callbacks; the engine never calls into this module.
// Output is numeric and bounded (no image pixels, URLs or point arrays) and is safe to put in a log. The engine's own recorder does not include it.
//
// Types below are structural copies of the few engine shapes read; the engine's own types are assignable to them.
import { pointDistribution } from '../../recognition/src/point-stats.mjs';

export const DIAGNOSTICS_SCHEMA = 'webar-recognition-diagnostics/1';
export type Point2 = readonly [number, number];
/** Subset of the engine's RecognitionTrace that is read. */
export interface TraceInput {
  sessionId: string; frameId: number; algorithmVersion: string; featureCount: number; candidateCount: number; legacyScalePasses: number; observationCount: number;
  ambiguous: boolean; budgetExhausted: boolean; rejected: readonly { targetId: string; reason: string }[];
  /** Optional (newer engines, only when observed): stage times summed over the passes, in milliseconds. */
  stageMs?: StageMsInput;
  /** Optional: one record per recognition pass, 1..2, `passes.length === legacyScalePasses`. */
  passes?: readonly PassInput[];
}
export interface StageMsInput { featureMs: number; retrievalMs: number; matchMs: number; geometryMs: number; totalMs: number }
export interface PassInput extends StageMsInput {
  scale: number; prepareMs: number; featureCount: number; candidateCount: number; observationCount: number; ambiguous: boolean; budgetExhausted: boolean; rejected: readonly { targetId: string; reason: string }[];
}
/** Subset of the engine's TrackingResult that is read. */
export interface ResultInput {
  sessionId: string; frameId: number; targetId: string | null; state: string; H_imageFromTarget: readonly number[] | null;
  quality: { measured: boolean; degenerate: boolean }; predictionAgeUs: number;
  matchedPoints?: { sessionId: string; frameId: number; targetId: string; origin: string; pointsPx: readonly Point2[] };
}
export interface DiagnosticsTarget { targetId: string; widthPx: number; heightPx: number }
export interface RecognitionDiagnosticsOptions {
  /** Sessions kept at once; the oldest is evicted. 1..16, default 4. */
  maxSessions?: number;
  /** Targets per session. 1..32, default 16. Further targets are counted in dropped.targets. */
  maxTargets?: number;
  /** Distinct rejection reason codes per target. 1..64, default 24. Further codes are counted as OTHER. */
  maxReasons?: number;
  /** Minimum time between point-distribution computations (ms). 0..60000, default 200: at most ~5 per second whatever the frame rate. */
  minDispersionIntervalMs?: number;
  /** Clock in ms; default performance.now. For tests and hosts without it. */
  now?: () => number;
}
export type RejectionStage = 'target-diagnostics' | 'retrieval' | 'matching' | 'geometry' | 'boundary' | 'ambiguity' | 'other';
export interface RunningStat { n: number; mean: number; min: number; max: number }
export interface PassRejections { total: number; byReason: Record<string, number> }
export interface TargetDiagnostics {
  targetId: string;
  /** Final-pass rejections of each recognition pass (unchanged semantics: one entry per trace.rejected record). */
  rejections: { total: number; byStage: Partial<Record<RejectionStage, number>>; byReason: Record<string, number> };
  /** Additional, separate counts by pass from traces that carry `passes`; never added into `rejections`. */
  passRejections: { first: PassRejections; second: PassRejections };
  measured: { results: number; originalTarget: number; previousFrame: number; hullCoverage: RunningStat; dispersion: RunningStat; isotropy: RunningStat; pointCount: RunningStat };
}
/** Statistics of one pass position over traces that carry `passes` (the first pass of every such trace, the second only after a scale retry). Times in ms; separate from `recognition`, which keeps its original meaning. */
export interface PassStats { n: number; prepareMs: RunningStat; featureMs: RunningStat; retrievalMs: RunningStat; matchMs: RunningStat; geometryMs: RunningStat; totalMs: RunningStat; featureCount: RunningStat; candidateCount: RunningStat; ambiguous: number; budgetExhausted: number; accepted: number }
export interface SessionDiagnostics {
  sessionId: string;
  recognition: { passes: number; ambiguous: number; budgetExhausted: number; twoScalePasses: number; accepted: number; featureCount: RunningStat };
  /** Stage times (ms, summed over the passes of a trace) over traces that carry `stageMs`. */
  stageTiming: { traces: number; featureMs: RunningStat; retrievalMs: RunningStat; matchMs: RunningStat; geometryMs: RunningStat; totalMs: RunningStat };
  passStats: { first: PassStats; second: PassStats };
  results: { observed: number; measured: number; predictedOrLost: number };
  dispersion: { computed: number; skippedByRate: number; skippedNoTargetSize: number; skippedInvalid: number };
  targets: TargetDiagnostics[];
}
export interface DiagnosticsSnapshot {
  schema: typeof DIAGNOSTICS_SCHEMA; disposed: boolean; sessions: SessionDiagnostics[];
  dropped: { stale: number; malformed: number; closedSession: number; sessions: number; targets: number };
}
export type RecognitionDiagnosticsErrorCode = 'INVALID_CONFIG';
export class RecognitionDiagnosticsError extends Error {
  readonly code: RecognitionDiagnosticsErrorCode;
  constructor(code: RecognitionDiagnosticsErrorCode, message: string) { super(message); this.name = 'RecognitionDiagnosticsError'; this.code = code; }
}
export interface RecognitionDiagnostics {
  /** Target sizes in target pixels, needed to normalize point positions. Replaces the previous list (max 32). */
  setTargets(targets: readonly DiagnosticsTarget[]): void;
  observeRecognition(trace: TraceInput): void;
  observeResult(result: ResultInput): void;
  snapshot(): DiagnosticsSnapshot;
  /** Forgets one session (or all when omitted). Late events of a forgotten session are dropped, not re-counted. */
  reset(sessionId?: string): void;
  /** Releases everything; later calls are no-ops and snapshot() reports an empty, disposed state. */
  dispose(): void;
}

const MAX_MS = 600_000;
const MAX_TEXT = 64, MAX_ID = 256, MAX_CLOSED = 32, MAX_POINTS = 512;
const STAGES: Readonly<Record<string, RejectionStage>> = Object.freeze({
  LOW_TEXTURE: 'target-diagnostics', LOW_COVERAGE: 'target-diagnostics', REPETITIVE_TEXTURE: 'target-diagnostics',
  NOT_SHORTLISTED: 'retrieval', RETRIEVAL_AMBIGUITY: 'retrieval', INSUFFICIENT_MATCHES: 'matching',
  DEGENERATE_MODEL: 'geometry', DEGENERATE_REFINEMENT: 'geometry', NO_ROBUST_MODEL: 'geometry', LOW_INLIER_SUPPORT: 'geometry', LOW_SPATIAL_COVERAGE: 'geometry',
  INVALID_BOUNDARY: 'boundary', AMBIGUOUS_TARGETS: 'ambiguity',
});
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
/** Durations are floats: finite, non-negative, bounded. Deliberately not the integer-only `count`. */
const millis = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_MS;
const stageOk = (s: unknown): s is StageMsInput => !!s && typeof s === 'object' && [(s as StageMsInput).featureMs, (s as StageMsInput).retrievalMs, (s as StageMsInput).matchMs, (s as StageMsInput).geometryMs, (s as StageMsInput).totalMs].every(millis);
const rejectionsOk = (r: unknown): r is { targetId: string; reason: string }[] => Array.isArray(r) && r.length <= 32 && r.every(x => x && text(x.targetId, MAX_ID) && text(x.reason, MAX_TEXT));
const passOk = (p: unknown): p is PassInput => stageOk(p) && typeof (p as PassInput).scale === 'number' && Number.isFinite((p as PassInput).scale) && (p as PassInput).scale > 0 && (p as PassInput).scale <= 1 && millis((p as PassInput).prepareMs) &&
  [(p as PassInput).featureCount, (p as PassInput).candidateCount, (p as PassInput).observationCount].every(count) && typeof (p as PassInput).ambiguous === 'boolean' && typeof (p as PassInput).budgetExhausted === 'boolean' && rejectionsOk((p as PassInput).rejected);
const newStat = (): RunningStat => ({ n: 0, mean: 0, min: 0, max: 0 });
function addStat(stat: RunningStat, value: number): void {
  stat.n++;
  if (stat.n === 1) { stat.mean = value; stat.min = value; stat.max = value; return; }
  stat.mean += (value - stat.mean) / stat.n;
  if (value < stat.min) stat.min = value;
  if (value > stat.max) stat.max = value;
}
const copyStat = (s: RunningStat): RunningStat => ({ n: s.n, mean: s.mean, min: s.min, max: s.max });
function invert(h: readonly number[]): number[] | null {
  if (!Array.isArray(h) || h.length !== 9 || !h.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, i, j] = h as number[];
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g, det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [A / det, -(b * j - c * i) / det, (b * f - c * e) / det, B / det, (a * j - c * g) / det, -(a * f - c * d) / det, C / det, -(a * i - b * g) / det, (a * e - b * d) / det];
}
interface PassState { n: number; prepare: RunningStat; feature: RunningStat; retrieval: RunningStat; match: RunningStat; geometry: RunningStat; total: RunningStat; features: RunningStat; candidates: RunningStat; ambiguous: number; exhausted: number; accepted: number }
const newPass = (): PassState => ({ n: 0, prepare: newStat(), feature: newStat(), retrieval: newStat(), match: newStat(), geometry: newStat(), total: newStat(), features: newStat(), candidates: newStat(), ambiguous: 0, exhausted: 0, accepted: 0 });
const copyPass = (p: PassState): PassStats => ({ n: p.n, prepareMs: copyStat(p.prepare), featureMs: copyStat(p.feature), retrievalMs: copyStat(p.retrieval), matchMs: copyStat(p.match), geometryMs: copyStat(p.geometry), totalMs: copyStat(p.total), featureCount: copyStat(p.features), candidateCount: copyStat(p.candidates), ambiguous: p.ambiguous, budgetExhausted: p.exhausted, accepted: p.accepted });
interface PassRejectionState { total: number; byReason: Map<string, number> }
interface TargetState { targetId: string; /** Created only by optional pass facts; evicted first when a legacy fact needs the slot. */ passOnly: boolean; total: number; byStage: Map<string, number>; byReason: Map<string, number>; passRejections: [PassRejectionState, PassRejectionState]; results: number; original: number; previous: number; hull: RunningStat; dispersion: RunningStat; isotropy: RunningStat; points: RunningStat }
interface SessionState {
  sessionId: string; lastTrace: number; lastResult: number; passes: number; ambiguous: number; exhausted: number; twoScale: number; accepted: number; features: RunningStat;
  timing: { traces: number; feature: RunningStat; retrieval: RunningStat; match: RunningStat; geometry: RunningStat; total: RunningStat }; passStats: [PassState, PassState];
  observed: number; measured: number; other: number; computed: number; skippedRate: number; skippedSize: number; skippedInvalid: number; lastComputeAt: number; targets: Map<string, TargetState>;
}
function intOption(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RecognitionDiagnosticsError('INVALID_CONFIG', `${name} must be an integer from ${min} to ${max}`);
  return value;
}

export function createRecognitionDiagnostics(options: RecognitionDiagnosticsOptions = {}): RecognitionDiagnostics {
  if (options === null || typeof options !== 'object') throw new RecognitionDiagnosticsError('INVALID_CONFIG', 'options must be an object');
  const maxSessions = intOption(options.maxSessions, 'maxSessions', 1, 16, 4), maxTargets = intOption(options.maxTargets, 'maxTargets', 1, 32, 16), maxReasons = intOption(options.maxReasons, 'maxReasons', 1, 64, 24);
  const interval = intOption(options.minDispersionIntervalMs, 'minDispersionIntervalMs', 0, 60000, 200);
  if (options.now !== undefined && typeof options.now !== 'function') throw new RecognitionDiagnosticsError('INVALID_CONFIG', 'now must be a function');
  const now = options.now ?? (() => performance.now());
  let disposed = false, sizes = new Map<string, DiagnosticsTarget>();
  const sessions = new Map<string, SessionState>(), closed: string[] = [];
  const dropped = { stale: 0, malformed: 0, closedSession: 0, sessions: 0, targets: 0 };

  function session(sessionId: unknown): SessionState | null {
    if (!text(sessionId, MAX_ID)) { dropped.malformed++; return null; }
    if (closed.includes(sessionId)) { dropped.closedSession++; return null; }
    let state = sessions.get(sessionId);
    if (!state) {
      if (sessions.size >= maxSessions) { const oldest = sessions.keys().next().value as string; sessions.delete(oldest); dropped.sessions++; }
      state = { sessionId, lastTrace: -1, lastResult: -1, passes: 0, ambiguous: 0, exhausted: 0, twoScale: 0, accepted: 0, features: newStat(), timing: { traces: 0, feature: newStat(), retrieval: newStat(), match: newStat(), geometry: newStat(), total: newStat() }, passStats: [newPass(), newPass()], observed: 0, measured: 0, other: 0, computed: 0, skippedRate: 0, skippedSize: 0, skippedInvalid: 0, lastComputeAt: -Infinity, targets: new Map() };
      sessions.set(sessionId, state);
    }
    return state;
  }
  function target(state: SessionState, targetId: string, passOnly = false): TargetState | null {
    let t = state.targets.get(targetId);
    if (t) { if (!passOnly) t.passOnly = false; return t; }
    if (state.targets.size >= maxTargets) {
      // Legacy facts always win capacity over optional pass facts: a pass-only target is evicted for them, and pass-only facts never count as dropped.
      const spare = passOnly ? undefined : [...state.targets.values()].find(x => x.passOnly);
      if (!spare) { if (!passOnly) dropped.targets++; return null; }
      state.targets.delete(spare.targetId);
    }
    t = { targetId, passOnly, total: 0, byStage: new Map(), byReason: new Map(), passRejections: [{ total: 0, byReason: new Map() }, { total: 0, byReason: new Map() }], results: 0, original: 0, previous: 0, hull: newStat(), dispersion: newStat(), isotropy: newStat(), points: newStat() };
    state.targets.set(targetId, t);
    return t;
  }
  const bump = (map: Map<string, number>, key: string, limit: number): void => { if (!map.has(key) && map.size >= limit) key = 'OTHER'; map.set(key, (map.get(key) ?? 0) + 1); };

  return {
    setTargets(targets) {
      if (disposed) return;
      if (!Array.isArray(targets) || targets.length > 32 || !targets.every(t => t && text(t.targetId, MAX_ID) && Number.isFinite(t.widthPx) && t.widthPx > 0 && Number.isFinite(t.heightPx) && t.heightPx > 0)) throw new RecognitionDiagnosticsError('INVALID_CONFIG', 'targets must be at most 32 {targetId, widthPx > 0, heightPx > 0}');
      sizes = new Map(targets.map(t => [t.targetId, { targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx }]));
    },
    observeRecognition(trace) {
      if (disposed) return;
      if (!trace || !text(trace.algorithmVersion, MAX_TEXT) || !count(trace.frameId) || ![trace.featureCount, trace.candidateCount, trace.legacyScalePasses, trace.observationCount].every(count) ||
          typeof trace.ambiguous !== 'boolean' || typeof trace.budgetExhausted !== 'boolean' || !Array.isArray(trace.rejected) || trace.rejected.length > 32 ||
          !trace.rejected.every(r => r && text(r.targetId, MAX_ID) && text(r.reason, MAX_TEXT))) { dropped.malformed++; return; }
      // Optional newer fields are validated on their own terms (floating-point durations, at most two passes agreeing with legacyScalePasses); any violation drops the whole trace as malformed.
      if (trace.stageMs !== undefined && !stageOk(trace.stageMs)) { dropped.malformed++; return; }
      if (trace.passes !== undefined && (!Array.isArray(trace.passes) || trace.passes.length < 1 || trace.passes.length > 2 || trace.passes.length !== trace.legacyScalePasses || !trace.passes.every(passOk))) { dropped.malformed++; return; }
      const state = session(trace.sessionId);
      if (!state) return;
      if (trace.frameId <= state.lastTrace) { dropped.stale++; return; }
      state.lastTrace = trace.frameId;
      state.passes++; state.accepted += trace.observationCount > 0 ? 1 : 0; state.ambiguous += trace.ambiguous ? 1 : 0; state.exhausted += trace.budgetExhausted ? 1 : 0; state.twoScale += trace.legacyScalePasses > 1 ? 1 : 0;
      addStat(state.features, trace.featureCount);
      if (trace.stageMs) { const m = trace.stageMs, g = state.timing; g.traces++; addStat(g.feature, m.featureMs); addStat(g.retrieval, m.retrievalMs); addStat(g.match, m.matchMs); addStat(g.geometry, m.geometryMs); addStat(g.total, m.totalMs); }
      for (const rejection of trace.rejected) {
        const t = target(state, rejection.targetId);
        if (!t) continue;
        // A reason may be a comma-joined list of compile diagnostics; each code is a separate fact, the target is counted once per pass.
        t.total++;
        for (const code of rejection.reason.split(',')) {
          const clean = /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? code : 'OTHER';
          bump(t.byReason, clean, maxReasons);
          bump(t.byStage, STAGES[clean] ?? 'other', 8);
        }
      }
      // Optional pass facts come last: the legacy final-pass statistics and target capacity are settled first and are never displaced by them. Pass-only targets are kept only while capacity remains.
      trace.passes?.forEach((p, i) => {
        const ps = state.passStats[i];
        ps.n++; ps.ambiguous += p.ambiguous ? 1 : 0; ps.exhausted += p.budgetExhausted ? 1 : 0; ps.accepted += p.observationCount > 0 ? 1 : 0;
        addStat(ps.prepare, p.prepareMs); addStat(ps.feature, p.featureMs); addStat(ps.retrieval, p.retrievalMs); addStat(ps.match, p.matchMs); addStat(ps.geometry, p.geometryMs); addStat(ps.total, p.totalMs); addStat(ps.features, p.featureCount); addStat(ps.candidates, p.candidateCount);
        for (const rejection of p.rejected) {
          const t = target(state, rejection.targetId, true);
          if (!t) continue;
          const pr = t.passRejections[i];
          pr.total++;
          for (const code of rejection.reason.split(',')) bump(pr.byReason, /^[A-Z][A-Z0-9_]{0,47}$/.test(code) ? code : 'OTHER', maxReasons);
        }
      });
    },
    observeResult(result) {
      if (disposed) return;
      if (!result || !count(result.frameId) || typeof result.state !== 'string' || !result.quality || typeof result.quality.measured !== 'boolean') { dropped.malformed++; return; }
      const state = session(result.sessionId);
      if (!state) return;
      if (result.frameId <= state.lastResult) { dropped.stale++; return; }
      state.lastResult = result.frameId; state.observed++;
      // Only a genuinely measured TRACKING result counts: predictions, held results and anything flagged unmeasured never enter the distribution, even if they carry points.
      const m = result.matchedPoints;
      if (result.state !== 'TRACKING' || result.quality.measured !== true || result.predictionAgeUs !== 0 || !text(result.targetId, MAX_ID)) { state.other++; return; }
      state.measured++;
      if (!m || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId || !Array.isArray(m.pointsPx) || m.pointsPx.length < 1 || m.pointsPx.length > MAX_POINTS) { state.skippedInvalid++; return; }
      const size = sizes.get(result.targetId);
      if (!size) { state.skippedSize++; return; }
      const at = now();
      if (at - state.lastComputeAt < interval) { state.skippedRate++; return; }
      const inverse = invert(result.H_imageFromTarget as readonly number[]);
      if (!inverse) { state.skippedInvalid++; return; }
      const points: [number, number][] = [];
      for (const p of m.pointsPx) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const w = inverse[6] * p[0] + inverse[7] * p[1] + inverse[8];
        if (!Number.isFinite(w) || Math.abs(w) < 1e-12) continue;
        const x = (inverse[0] * p[0] + inverse[1] * p[1] + inverse[2]) / w, y = (inverse[3] * p[0] + inverse[4] * p[1] + inverse[5]) / w;
        if (Number.isFinite(x) && Number.isFinite(y)) points.push([Math.min(size.widthPx, Math.max(0, x)), Math.min(size.heightPx, Math.max(0, y))]);
      }
      if (!points.length) { state.skippedInvalid++; return; }
      const t = target(state, result.targetId);
      if (!t) return;
      const d = pointDistribution(points, size.widthPx, size.heightPx);
      state.lastComputeAt = at; state.computed++;
      t.results++; if (m.origin === 'previous-frame') t.previous++; else t.original++;
      addStat(t.hull, d.hullCoverage); addStat(t.dispersion, d.dispersion); addStat(t.isotropy, d.isotropy); addStat(t.points, d.count);
    },
    snapshot() {
      const out: SessionDiagnostics[] = [...sessions.values()].map(s => ({
        sessionId: s.sessionId,
        recognition: { passes: s.passes, ambiguous: s.ambiguous, budgetExhausted: s.exhausted, twoScalePasses: s.twoScale, accepted: s.accepted, featureCount: copyStat(s.features) },
        results: { observed: s.observed, measured: s.measured, predictedOrLost: s.other },
        dispersion: { computed: s.computed, skippedByRate: s.skippedRate, skippedNoTargetSize: s.skippedSize, skippedInvalid: s.skippedInvalid },
        stageTiming: { traces: s.timing.traces, featureMs: copyStat(s.timing.feature), retrievalMs: copyStat(s.timing.retrieval), matchMs: copyStat(s.timing.match), geometryMs: copyStat(s.timing.geometry), totalMs: copyStat(s.timing.total) },
        passStats: { first: copyPass(s.passStats[0]), second: copyPass(s.passStats[1]) },
        targets: [...s.targets.values()].map(t => ({
          targetId: t.targetId,
          rejections: { total: t.total, byStage: Object.fromEntries(t.byStage), byReason: Object.fromEntries(t.byReason) },
          passRejections: { first: { total: t.passRejections[0].total, byReason: Object.fromEntries(t.passRejections[0].byReason) }, second: { total: t.passRejections[1].total, byReason: Object.fromEntries(t.passRejections[1].byReason) } },
          measured: { results: t.results, originalTarget: t.original, previousFrame: t.previous, hullCoverage: copyStat(t.hull), dispersion: copyStat(t.dispersion), isotropy: copyStat(t.isotropy), pointCount: copyStat(t.points) },
        })),
      }));
      return { schema: DIAGNOSTICS_SCHEMA, disposed, sessions: out, dropped: { ...dropped } };
    },
    reset(sessionId) {
      if (disposed) return;
      if (sessionId === undefined) { for (const id of sessions.keys()) { closed.push(id); } sessions.clear(); }
      else if (text(sessionId, MAX_ID)) { sessions.delete(sessionId); if (!closed.includes(sessionId)) closed.push(sessionId); }
      while (closed.length > MAX_CLOSED) closed.shift();
    },
    dispose() { disposed = true; sessions.clear(); sizes = new Map(); closed.length = 0; },
  };
}
