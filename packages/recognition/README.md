# CPU recognition baseline

[English](README.md) | [简体中文](README.zh-CN.md)

`CpuRecognizer` finds image targets in gray8 frames on the CPU. It produces original-target `RecognitionObservation` candidates only, never tracking state or SDK events; confirmation and rematch scheduling belong to the tracking package.

## Algorithms

The same `CpuRecognizer` accepts either a uniform roster of legacy targets or a uniform roster of `c-oriented-brief256-v2` targets; mixed versions reject. Legacy targets use `m0-harris-brief256-v1` (greedy per-level selection) or `m0-harris-anms-brief256-v1` (ANMS selection). Targets must be recompiled to change algorithm; the compiler default stays the legacy algorithm. See [the target compiler README](../target-compiler/README.md).

For legacy targets a global miss gets one half-octave retry without changing saved descriptors or geometric thresholds. `legacyScaleSearch: false` skips that retry (diagnostic comparison only).

```ts
const recognizer = new CpuRecognizer();
await recognizer.loadTargets(targets); // 1..10 unique IDs; validates and snapshots atomically
const batch = await recognizer.recognizeFrame(frame, { signal });
// The tracking pipeline consumes batch.observations. Ambiguous target evidence yields an empty list.
recognizer.dispose();
```

`recognizeFrame` borrows live packed gray8 with `rotation=0` and `mirrored=false`, preserving `sessionId` and `frameId`. It does not release the input. `recognizeGray(image, { sessionId, frameId }, { roi, signal })` is available for replay and compute-backend callers. The ROI is a standard-image rectangle; it filters candidate centers, retains full-image coordinates, and still builds the full pyramid. It does **not** imply an optimized cropped-image kernel.

## Matching and geometry

Both algorithm families run the matcher through `matchPacked` on 8-word packed descriptors (cached per target, packed once per frame pass). It is output-identical to the historical byte-wise `matchFeatures`, which stays in `experimental/` as the differential oracle.

Matcher: reciprocal nearest neighbors, Hamming <= 64, strict best/second ratio < 0.75; ties reject. Geometry: seeded 256-iteration RANSAC with normalized 8-unknown least squares, threshold 3 image pixels, >= 12 inliers, ratio >= 0.35, convex-hull coverage >= 0.08, refit, no singularity, reflection or target-domain horizon. Public coverage is convex hull / (width * height), and the public homography is checked against the target edge corners. Degenerate or weak observations are rejected; no default identity observation is manufactured. Equal or near-equal top target support (second >= 85% of first) is ambiguous and suppressed. This is a conservative heuristic, not proof against arbitrary similar images.

## Loading, limits and cancellation

Target loading rejects an unsupported compiler or algorithm and incompatible preprocessing. CPU features must start from canonical unsmoothed gray8: this recognizer uses a box2 pyramid and box3 layer smoothing, not the compute backend's Gaussian5 preprocessing. Backend switching cannot relabel descriptors as compatible. A failed load keeps the previous active target set. A newer load or dispose invalidates a pending load completion. At most 10 target snapshots and 512 features per extraction bound the work; brute-force target retrieval is O(targets * targetFeatures * frameFeatures * 32). Coarse-to-fine retrieval is not implemented.

Cancellation is checked before work and between targets. Arithmetic is synchronous on the caller's JavaScript thread, so an event-loop-delivered abort cannot interrupt it; hard cancellation is done by terminating the Worker that hosts the recognizer. Promise settlement leaves no outstanding frame reads or GPU work. Do not run this baseline on a UI thread at camera rate; the SDK hosts it in a Worker.

Minimal integration with the tracking package: instantiate the recognizer once, reload it when the target set changes, then inject `(frame, targets, signal) => recognizer.recognizeFrame(frame, { signal }).then(batch => batch.observations)` into `createTrackingPipeline`. The callback must ensure its cached target set matches `targets`; loading on every frame adds avoidable hashing and copy costs. This module never triggers global recognition on its own.

## Build

From the repository root after `npm ci`:

```sh
node node_modules/typescript/bin/tsc -p packages/recognition/tsconfig.json
```

Measurements of this recognizer are bounded by the environment they were taken in; no phone-performance or production-readiness claim is made here. The recognition algorithms are original implementations (see the target compiler README for provenance).
