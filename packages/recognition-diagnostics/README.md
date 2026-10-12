# Optional recognition diagnostics companion

[English](README.md) | [简体中文](README.zh-CN.md)

This independently loadable companion tracks **why targets were rejected** during recognition passes and **where matched inlier points lie** during tracking. It is **NOT** part of the engine runtime: nothing in the core engine closures imports it (the engine builder gates that), and it imports nothing from the engine. It ships as its own standalone module.

Outputs are **purely numeric and bounded** (counters, means, min/max; never image pixels, URLs, coordinates, or point arrays) and safe to export with diagnostics logs.

## Portable exports and distribution

Package entries of `@livemira/engine`:
- Production entry: `@livemira/engine/recognition-diagnostics` (the minified standalone file below)
- SDK-only multi-file module (development, outside the stable production interface): `@livemira/engine/development/recognition-diagnostics`
- Standalone ES module (readable): `@livemira/engine/recognition-diagnostics/single` (`tools/recognition-diagnostics/lm-recognition-diagnostics.mjs`)
- Standalone ES module (minified): `@livemira/engine/recognition-diagnostics/single/min` (`tools/recognition-diagnostics/lm-recognition-diagnostics.min.mjs`)

Named portable exports:
- `createRecognitionDiagnostics(options?: RecognitionDiagnosticsOptions): RecognitionDiagnostics`
- `DIAGNOSTICS_SCHEMA = 'webar-recognition-diagnostics/1'`
- `RecognitionDiagnosticsError`

## Engine seams and feeding callbacks

The companion connects to two generic, disabled-by-default seams in the engine runtime:
1. `WorkerPipelineOptions.observeRecognition` (default `false`) + `WorkerPipelineConfig.onRecognitionTrace` $\to$ feeds `collector.observeRecognition(trace)`
2. `WorkerPipelineOptions.collectMatchedPoints` (default `false`) + `WorkerPipelineConfig.onResult` $\to$ feeds `collector.observeResult(result)`

When both options are `false` (default), the engine incurs zero diagnostic overhead, zero matched-point tracking overhead, and extracts no additional features.

```js
import { createWorkerPipeline, prepareWorkerFrame, getFrameGeometry } from '@livemira/engine/single/min';
import { createRecognitionDiagnostics } from '@livemira/engine/recognition-diagnostics/single/min';

const diagnostics = createRecognitionDiagnostics({
  maxSessions: 4,               // 1..16, default 4
  maxTargets: 16,               // 1..32, default 16
  maxReasons: 24,               // 1..64, default 24
  minDispersionIntervalMs: 200, // 0..60000, default 200 (~5/sec rate limit)
});

// Provide target dimensions (in target pixels) for normalization
diagnostics.setTargets([
  { targetId: 'poster-a', widthPx: 640, heightPx: 480 },
]);

const pipeline = createWorkerPipeline({
  prepareFrame: (frame, signal) => prepareWorkerFrame(frame, getFrameGeometry(frame), signal),
  options: {
    observeRecognition: true,
    collectMatchedPoints: true,
  },
  onRecognitionTrace: trace => diagnostics.observeRecognition(trace),
  onResult: result => diagnostics.observeResult(result),
});
```

## Stage timing and per-pass facts (optional trace fields)

Traces from a newer engine may carry `stageMs` (feature/retrieval/match/geometry/total milliseconds, summed over the passes) and `passes` (1..2 records: the standard image and the half-octave scale retry; `passes.length` must equal `legacyScalePasses`). The companion validates them independently of the integer counters: durations must be finite, non-negative and at most 600000 ms, `scale` in (0, 1]; a violation (NaN, Infinity, negative, too large, more than two passes, wrong count) drops the whole trace as `malformed`. Traces without these fields (older engines) keep working.

New snapshot fields, all separate from the original ones (which are unchanged and never double counted):
- `sessions[].stageTiming`: `traces` and running statistics (`n/mean/min/max`) of the five stage times over traces that carried `stageMs`.
- `sessions[].passStats.first` / `.second`: per pass position `n`, running statistics of `prepareMs`, the stage times, `featureCount`, `candidateCount`, and counts of `ambiguous`, `budgetExhausted`, `accepted`. The second pass only exists after a scale retry; `featureCount` of the trace is the last pass, not a sum.
- `sessions[].targets[].passRejections.first` / `.second`: `total` and `byReason` of that pass's rejection reasons, so the first pass's reason survives a successful retry. `rejections` keeps counting `trace.rejected` only (the final pass).

## Lifecycle and bounded counters

- `setTargets(targets: readonly DiagnosticsTarget[])`: updates known target dimensions (up to 32 targets). Required to normalize matched-point locations back into target space.
- `observeRecognition(trace: TraceInput)`: records per-pass recognition stats and failure reasons per target.
- `observeResult(result: ResultInput)`: records tracking result states and inlier dispersion stats. Only genuinely measured `TRACKING` results with `result.quality.measured === true` and `predictionAgeUs === 0` are counted; predicted/held/lost frames never enter point distributions.
- **Rate limiting**: point distribution computation is throttled by `minDispersionIntervalMs` (default 200 ms, at most ~5 calculations per second regardless of frame rate).
- `snapshot(): DiagnosticsSnapshot`: extracts current numeric counters across active sessions.
- `reset(sessionId?: string)`: forgets one session or all active sessions. Subsequent events for forgotten sessions are dropped rather than re-counted.
- `dispose()`: clears all sessions and target data; subsequent calls become no-ops.

## Rejection stages describe RECOGNIZER, NOT final tracker acceptance

Rejection stages categorized by the diagnostics module:
- `target-diagnostics`: initial image checks (`LOW_TEXTURE`, `LOW_COVERAGE`, `REPETITIVE_TEXTURE`)
- `retrieval`: candidate retrieval filtering (`NOT_SHORTLISTED`, `RETRIEVAL_AMBIGUITY`)
- `matching`: feature correspondence (`INSUFFICIENT_MATCHES`)
- `geometry`: homography / pose verification (`DEGENERATE_MODEL`, `DEGENERATE_REFINEMENT`, `NO_ROBUST_MODEL`, `LOW_INLIER_SUPPORT`, `LOW_SPATIAL_COVERAGE`)
- `boundary`: geometric boundary validity (`INVALID_BOUNDARY`)
- `ambiguity`: multi-target disambiguation (`AMBIGUOUS_TARGETS`)
- `other`: uncategorized reason codes

> [!IMPORTANT]
> Rejection stage counts describe single-frame candidate rejection inside the **RECOGNIZER**. They do **NOT** represent final tracker acceptance or rejection. The tracker has its own temporal consistency, prediction, and state machines; a candidate accepted by the recognizer may still be filtered or held by the tracker.

## Spatial Selection: ANMS vs Legacy Algorithm

The engine supports two legacy-family spatial feature selection algorithms:
1. `m0-harris-brief256-v1` (legacy baseline): greedy response-based feature selection.
2. `m0-harris-anms-brief256-v1` (Brown, Szeliski, Winder CVPR 2005 §3 ANMS): adaptive non-maximal suppression.

### ANMS Algorithm Details and Deliberate Approximations

In CVPR 2005 §3, corner candidate $i$ receives a suppression radius:
$$r_i = \min_j |\mathbf{x}_i - \mathbf{x}_j| \quad \text{for } j \text{ where } \text{strength}_i < 0.9 \cdot \text{strength}_j$$
Candidates with the largest suppression radii are selected within the feature budget (384 template / 512 live features, 3 pyramid levels).

Engine implementation approximations:
- **Bounded candidate pool**: only the strongest 1,024 candidates (`ANMS_POOL_LIMIT = 1024`) per pyramid level participate in suppression radius evaluation. This bounds work to at most $1024^2 / 2 \approx 5.2 \times 10^5$ distance evaluations instead of $O(N^2)$ quadratic explosion over thousands of raw Harris corners. Since any candidate stronger than a pool member is also in the pool, computed radii for pool members are exact.
- **Per-level quota**: applied per pyramid level rather than across all levels globally.
- **Deterministic ordering**: tie-breaking is strictly deterministic: radius descending, then strength descending, then $y$, then $x$.
- **Distinct algorithm ID**: targets compiled with ANMS must specify `algorithmVersion: 'm0-harris-anms-brief256-v1'` to ensure bundle compiler/worker/matcher consistency. Mixed algorithm versions within a session are rejected.

### Known limitation: more points are not always more accurate

ANMS enforces spatial dispersion of features across the image, which prevents features from clustering tightly in high-contrast textures. However, in one fixed synthetic probe (a 360x640 frame at 0.85 scale) the legacy algorithm gave 32 inliers with a maximum corner error of 3.010 px, while ANMS gave 43 inliers with a maximum corner error of 5.402 px. Whether such an error passes depends on the tolerance: 1% of the reference target diagonal (about 5.475 px on that fixture) is met, 1% of the projected target diagonal (about 3.272 px) is not, and a stricter fixed 4.0 px probe is not.

- **Takeaway**: more matched points and broader spatial spread do not guarantee lower corner reprojection error. A hypothesized explanation (not verified causality) is that higher inlier counts can introduce points at distant edges whose homography leverage increases sensitivity to noise.
- **No claim of phone performance improvement**: synthetic regression results do not imply or prove improved recognition or tracking on physical mobile devices.
