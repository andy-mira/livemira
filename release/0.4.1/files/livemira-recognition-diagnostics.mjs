/*! LiveMira recognition-diagnostics | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

// packages/contracts/src/errors.ts
var EngineError = class extends Error {
  code;
  isRecoverable;
  constructor(code, message, options) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "EngineError";
    this.code = code;
    this.isRecoverable = options.isRecoverable;
  }
};

// packages/recognition-diagnostics/src/point-distribution.ts
var UNIFORM_AXIS_VARIANCE = 1 / 12;
var cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hullArea(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const half = (values) => {
    const h = [];
    for (const p of values) {
      while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(
    hull.reduce((s, p, i) => {
      const q = hull[(i + 1) % hull.length];
      return s + p[0] * q[1] - p[1] * q[0];
    }, 0)
  ) / 2;
}
function pointDistribution(points, widthPx, heightPx) {
  const empty = { count: 0, hullCoverage: 0, dispersion: 0, isotropy: 0 };
  if (!Array.isArray(points) || !(widthPx > 0) || !(heightPx > 0)) return empty;
  const u = [];
  const v = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[1] < 0 || p[0] > widthPx || p[1] > heightPx)
      continue;
    u.push(p[0] / widthPx);
    v.push(p[1] / heightPx);
  }
  const n = u.length;
  if (!n) return empty;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    mu += u[i];
    mv += v[i];
  }
  mu /= n;
  mv /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (let i = 0; i < n; i++) {
    const du = u[i] - mu;
    const dv = v[i] - mv;
    suu += du * du;
    svv += dv * dv;
    suv += du * dv;
  }
  suu /= n;
  svv /= n;
  suv /= n;
  const trace = suu + svv;
  const det = suu * svv - suv * suv;
  const hull = n >= 3 ? hullArea(u.map((x, i) => [x, v[i]])) : 0;
  return {
    count: n,
    hullCoverage: Math.min(1, hull),
    dispersion: Math.min(1, trace / (2 * UNIFORM_AXIS_VARIANCE)),
    isotropy: n >= 3 && trace > 0 ? Math.min(1, Math.max(0, 4 * det / (trace * trace))) : 0
  };
}

// packages/recognition-diagnostics/src/recognition-diagnostics.ts
var DIAGNOSTICS_SCHEMA = "livemira-recognition-diagnostics/2";
var MAX_MS = 6e5;
var MAX_TEXT = 64;
var MAX_ID = 256;
var MAX_CLOSED = 32;
var MAX_POINTS = 512;
var STAGES = Object.freeze({
  LOW_TEXTURE: "target-diagnostics",
  LOW_COVERAGE: "target-diagnostics",
  REPETITIVE_TEXTURE: "target-diagnostics",
  NOT_SHORTLISTED: "retrieval",
  RETRIEVAL_AMBIGUITY: "retrieval",
  INSUFFICIENT_MATCHES: "matching",
  DEGENERATE_MODEL: "geometry",
  DEGENERATE_REFINEMENT: "geometry",
  NO_ROBUST_MODEL: "geometry",
  LOW_INLIER_SUPPORT: "geometry",
  LOW_SPATIAL_COVERAGE: "geometry",
  INVALID_BOUNDARY: "boundary",
  AMBIGUOUS_TARGETS: "ambiguity"
});
var REASON_CODE = /^[A-Z][A-Z0-9_]{0,47}$/;
var isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
var isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1e6;
var isMillis = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MS;
var isStageMs = (s) => {
  const m = s;
  return !!m && typeof m === "object" && [m.featureMs, m.retrievalMs, m.matchMs, m.geometryMs, m.totalMs].every(isMillis);
};
var areRejections = (r) => Array.isArray(r) && r.length <= 32 && r.every((x) => x && isText(x.targetId, MAX_ID) && isText(x.reason, MAX_TEXT));
var isPass = (p) => {
  const q = p;
  return isStageMs(q) && typeof q.scale === "number" && Number.isFinite(q.scale) && q.scale > 0 && q.scale <= 1 && isMillis(q.prepareMs) && [q.featureCount, q.candidateCount, q.observationCount].every(isCount) && typeof q.isAmbiguous === "boolean" && typeof q.isBudgetExhausted === "boolean" && areRejections(q.rejected);
};
var newStat = () => ({ n: 0, mean: 0, min: 0, max: 0 });
function addStat(stat, value) {
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
var copyStat = (s) => ({ n: s.n, mean: s.mean, min: s.min, max: s.max });
function invert(h) {
  if (!Array.isArray(h) || h.length !== 9 || !h.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, i, j] = h;
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
    (a * e - b * d) / det
  ];
}
var newPass = () => ({
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
  accepted: 0
});
var copyPass = (p) => ({
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
  accepted: p.accepted
});
var invalidConfig = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
function intOption(value, name, min, max, fallback) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw invalidConfig(`${name} must be an integer from ${min} to ${max}`);
  return value;
}
function createRecognitionDiagnostics(options = {}) {
  if (options === null || typeof options !== "object")
    throw invalidConfig("options must be an object");
  const maxSessions = intOption(options.maxSessions, "maxSessions", 1, 16, 4);
  const maxTargets = intOption(options.maxTargets, "maxTargets", 1, 32, 16);
  const maxReasons = intOption(options.maxReasons, "maxReasons", 1, 64, 24);
  const interval = intOption(
    options.minDispersionIntervalMs,
    "minDispersionIntervalMs",
    0,
    6e4,
    200
  );
  if (options.nowMs !== void 0 && typeof options.nowMs !== "function")
    throw invalidConfig("nowMs must be a function");
  const nowMs = options.nowMs ?? (() => performance.now());
  let isDisposed = false;
  let sizes = /* @__PURE__ */ new Map();
  let host = null;
  const sessions = /* @__PURE__ */ new Map();
  const closed = [];
  const dropped = { stale: 0, malformed: 0, closedSession: 0, sessions: 0, targets: 0 };
  function session(sessionId) {
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
        const oldest = sessions.keys().next().value;
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
          total: newStat()
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
        targets: /* @__PURE__ */ new Map()
      };
      sessions.set(sessionId, state);
    }
    return state;
  }
  function target(state, targetId, isPassOnly = false) {
    let t = state.targets.get(targetId);
    if (t) {
      if (!isPassOnly) t.isPassOnly = false;
      return t;
    }
    if (state.targets.size >= maxTargets) {
      const spare = isPassOnly ? void 0 : [...state.targets.values()].find((x) => x.isPassOnly);
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
      byStage: /* @__PURE__ */ new Map(),
      byReason: /* @__PURE__ */ new Map(),
      passRejections: [
        { total: 0, byReason: /* @__PURE__ */ new Map() },
        { total: 0, byReason: /* @__PURE__ */ new Map() }
      ],
      results: 0,
      hull: newStat(),
      dispersion: newStat(),
      isotropy: newStat(),
      points: newStat()
    };
    state.targets.set(targetId, t);
    return t;
  }
  const bump = (map, key, limit) => {
    if (!map.has(key) && map.size >= limit) key = "OTHER";
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  const sizeOf = (targetId) => sizes.get(targetId) ?? host?.getTargets().find((t) => t.targetId === targetId);
  const diagnostics = {
    name: "recognition-diagnostics",
    needs: { matchedPoints: true, recognitionTrace: true },
    attach(next) {
      host = next;
      const offTrace = next.onRecognitionTrace((trace) => diagnostics.observeRecognition(trace));
      const offResult = next.onResult((result) => diagnostics.observeResult(result));
      return {
        detach() {
          offTrace();
          offResult();
          host = null;
        }
      };
    },
    setTargets(targets) {
      if (isDisposed) return;
      if (!Array.isArray(targets) || targets.length > 32 || !targets.every(
        (t) => t && isText(t.targetId, MAX_ID) && Number.isFinite(t.widthPx) && t.widthPx > 0 && Number.isFinite(t.heightPx) && t.heightPx > 0
      ))
        throw invalidConfig("targets must be at most 32 {targetId, widthPx > 0, heightPx > 0}");
      sizes = new Map(
        targets.map((t) => [
          t.targetId,
          { targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx }
        ])
      );
    },
    observeRecognition(trace) {
      if (isDisposed) return;
      if (!trace || !isText(trace.algorithmVersion, MAX_TEXT) || !isCount(trace.frameId) || ![
        trace.featureCount,
        trace.candidateCount,
        trace.scalePasses,
        trace.observationCount
      ].every(isCount) || typeof trace.isAmbiguous !== "boolean" || typeof trace.isBudgetExhausted !== "boolean" || !Array.isArray(trace.rejected) || trace.rejected.length > 32 || !trace.rejected.every((r) => r && isText(r.targetId, MAX_ID) && isText(r.reason, MAX_TEXT))) {
        dropped.malformed++;
        return;
      }
      if (trace.stageMs !== void 0 && !isStageMs(trace.stageMs)) {
        dropped.malformed++;
        return;
      }
      if (trace.passes !== void 0 && (!Array.isArray(trace.passes) || trace.passes.length < 1 || trace.passes.length > 2 || trace.passes.length !== trace.scalePasses || !trace.passes.every(isPass))) {
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
        t.total++;
        for (const code of rejection.reason.split(",")) {
          const clean = REASON_CODE.test(code) ? code : "OTHER";
          bump(t.byReason, clean, maxReasons);
          bump(t.byStage, STAGES[clean] ?? "other", 8);
        }
      }
      trace.passes?.forEach((p, i) => {
        const ps = state.passStats[i];
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
          const pr = t.passRejections[i];
          pr.total++;
          for (const code of rejection.reason.split(","))
            bump(pr.byReason, REASON_CODE.test(code) ? code : "OTHER", maxReasons);
        }
      });
    },
    observeResult(result) {
      if (isDisposed) return;
      if (!result || !isCount(result.frameId) || typeof result.state !== "string" || !result.quality || typeof result.quality.isMeasured !== "boolean") {
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
      const m = result.matchedPoints;
      if (result.state !== "TRACKING" || result.quality.isMeasured !== true || result.prediction?.ageUs !== 0 || !isText(result.targetId, MAX_ID)) {
        state.other++;
        return;
      }
      state.measured++;
      if (!m || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId || !Array.isArray(m.pointsPx) || m.pointsPx.length < 1 || m.pointsPx.length > MAX_POINTS) {
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
      const points = [];
      for (const p of m.pointsPx) {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        const w = inverse[6] * p[0] + inverse[7] * p[1] + inverse[8];
        if (!Number.isFinite(w) || Math.abs(w) < 1e-12) continue;
        const x = (inverse[0] * p[0] + inverse[1] * p[1] + inverse[2]) / w;
        const y = (inverse[3] * p[0] + inverse[4] * p[1] + inverse[5]) / w;
        if (Number.isFinite(x) && Number.isFinite(y))
          points.push([
            Math.min(size.widthPx, Math.max(0, x)),
            Math.min(size.heightPx, Math.max(0, y))
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
      const out = [...sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        recognition: {
          passes: s.passes,
          ambiguous: s.ambiguous,
          budgetExhausted: s.exhausted,
          twoScalePasses: s.twoScale,
          accepted: s.accepted,
          featureCount: copyStat(s.features)
        },
        results: { observed: s.observed, measured: s.measured, predictedOrLost: s.other },
        dispersion: {
          computed: s.computed,
          skippedByRate: s.skippedRate,
          skippedNoTargetSize: s.skippedSize,
          skippedInvalid: s.skippedInvalid
        },
        stageTiming: {
          traces: s.timing.traces,
          featureMs: copyStat(s.timing.feature),
          retrievalMs: copyStat(s.timing.retrieval),
          matchMs: copyStat(s.timing.match),
          geometryMs: copyStat(s.timing.geometry),
          totalMs: copyStat(s.timing.total)
        },
        passStats: { first: copyPass(s.passStats[0]), second: copyPass(s.passStats[1]) },
        targets: [...s.targets.values()].map((t) => ({
          targetId: t.targetId,
          rejections: {
            total: t.total,
            byStage: Object.fromEntries(t.byStage),
            byReason: Object.fromEntries(t.byReason)
          },
          passRejections: {
            first: {
              total: t.passRejections[0].total,
              byReason: Object.fromEntries(t.passRejections[0].byReason)
            },
            second: {
              total: t.passRejections[1].total,
              byReason: Object.fromEntries(t.passRejections[1].byReason)
            }
          },
          measured: {
            results: t.results,
            hullCoverage: copyStat(t.hull),
            dispersion: copyStat(t.dispersion),
            isotropy: copyStat(t.isotropy),
            pointCount: copyStat(t.points)
          }
        }))
      }));
      return { schema: DIAGNOSTICS_SCHEMA, isDisposed, sessions: out, dropped: { ...dropped } };
    },
    reset(sessionId) {
      if (isDisposed) return;
      if (sessionId === void 0) {
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
      sizes = /* @__PURE__ */ new Map();
      closed.length = 0;
    }
  };
  return diagnostics;
}
export {
  DIAGNOSTICS_SCHEMA,
  createRecognitionDiagnostics
};
