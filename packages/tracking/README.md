# Tracking

[English](README.md) | [简体中文](README.zh-CN.md)

`src/index.ts` imports `@livemira/contracts` 0.1.0 and exports `createTrackingPipeline(recognize): VisionPipeline`, plus two opt-in variants (`createHybridTrackingPipeline`, `createSubpixelTrackingPipeline`). The injected async `recognize` callback receives `(FramePacket, readonly TargetBundle[], AbortSignal)` and returns `readonly RecognitionObservation[]`. It must finish all borrowed image work before settling. The pipeline owns no callback or backend resources and never releases SDK-owned frames; the integrator owns callback and backend disposal. There is no default or mock recognizer. Callback errors propagate.

```ts
import { createTrackingPipeline } from '@livemira/tracking';
import { CpuRecognizer } from '@livemira/recognition';
const recognizer = new CpuRecognizer(); // reload it whenever the target set changes
const pipeline = createTrackingPipeline(async (frame, targets, signal) =>
  (await recognizer.recognizeFrame(frame, { signal })).observations);
// Supply pipeline to createEngine({ source, pipeline, renderer }).
```

The default pipeline performs original-image recognition on each fresh frame, not optical-flow propagation. It rejects observations without an explicit `original-target` origin or the target's matching `algorithmVersion`. Input requires mapped monotonic time and `imageIdentity`; it never substitutes arrival time for observation time. Up to 128 recent content identities are retained. Target arrays are cloned at load. Concurrent process calls reject; reset and dispose cancel and await outstanding callback work. Returned results are detached from internal state.

## Confirmation and quality gates

All factories accept an optional second argument `{ maxObservationGapUs: 1000000 }`. The default allows 1 s between valid same-target original observations and a 2 s total three-observation window; explicit values are bounded to 125000..2000000 us (the total window is twice the value). At least three fresh independent observations over 50 ms are still required. A failed match, an error or a target change interrupts acquisition, and duplicate content does not advance it.

The first valid frame only enters ACQUIRING with null geometry and `quality.measured=false`. Gates: >= 8 inliers, ratio >= 0.6, recalculated target convex-hull coverage >= 0.2, recalculated reprojection RMS <= 2 px, finite nonsingular H, no target horizon crossing and projected area >= 16 px². Recognition confirmation and render freshness are separate: even a confirmed latest result retains `predictionExpiresAtUs = observationTimeUs + 100 ms`, and a slow result may already be expired and must stay hidden. These module parameters are provisional, not production thresholds.

Active targets cannot directly switch. Without a new validated same-target absolute observation, 100 ms since the last reliable measurement enters LOST and requires reacquisition. A fresh validated absolute observation can resume measured TRACKING after a gap; it never extends old predicted geometry. The SDK must independently hide expired output while processing continues. Render edges use width/height; feature samples are bounded by width-1/height-1. Pose stays null even when the target size is supplied: calibrated decomposition is not implemented.

## Opt-in variants

`createHybridTrackingPipeline(recognize)` keeps, after original-image confirmation, one owned standard gray8 snapshot (<= 1M pixels) and <= 64 paired points. It performs point tracking and robust target-space H refitting with the same quality gates, rematches the original image at >= 200 ms since the last accepted absolute observation and on any flow failure, and only original matches acquire or reacquire. Flow measurements preserve the absolute correction age and use the reason `point-track-measured`, while predicted holds remain unmeasured. Flow observations keep the target `algorithmVersion` and explicitly use `correspondenceOrigin = 'previous-frame'`; `sourceFrameId` binds the previous measured input. The point operator ID stays distinct from the target descriptor ID. Measured benefits were mixed; keep it opt-in.

`createSubpixelTrackingPipeline(recognize)` uses the algorithm `d-gauss5-znlk13-fb/0.2.0`, exported as `subpixelPointOperator` for compute-backend CPU operators with owned level-zero gray copies: 13x13 normalized photometric Lucas-Kanade over a Gaussian5 floating-point pyramid, bilinear subpixel sampling and forward-backward checks, with a QR robust plane estimator and spatially spread support. Absolute correction has a hard 200 ms maximum, shortened to 100 ms on low coverage or RMS; failed or weak flow immediately requests an original match. Points cannot reset the absolute clock, predicted holds expire at 100 ms, and no output smoothing is applied. Its error tails improve over integer tracking in synthetic tests, but accuracy and p95 timing do not beat the default in general, so it is not the default.

`src/cpu-points.ts` implements `trackGrayPoints` independently with the existing `ComputeBackend` value payload type: up to three box/floor pyramid levels, 7x7 patch search within ±3 pixels per level, texture variance, SSD and ambiguity checks, forward-backward error <= 1 px, integer output. Hard bounds: 1M pixels per input and 256 points. `cpuPointOperator` and `CPU_POINT_ALGORITHM` can be supplied to `new CpuComputeBackend({ algorithmVersion: CPU_POINT_ALGORITHM, trackPoints: cpuPointOperator })`; consume original level-zero gray copies, not the backend's Gaussian pyramid, and never label recognition descriptors with this algorithm ID. Arithmetic is synchronous and cancellation is checked at call boundaries. The default pipeline does not use it.

## Experimental prototype

`experimental/*.mjs` is a numerical and control prototype (normalized homography estimation with deterministic four-point consensus sampling, a small state machine), not a frozen public API; it imports no recognition, compute, SDK, WebAssembly or browser module. Its design: explicit session reset; stale sessions and frames and backward or nonfinite timestamps are rejected; ACQUIRING hides geometry; low quality or another target enters LIMITED with a zero-order hold, which is predicted and never reliable coverage; at age >= 100000 us (including timer-only ticks) it enters LOST and hides H. Normal-equations least squares with a fixed 256-trial seeded consensus loop is a small CPU experiment, not a replacement for production SVD/RANSAC. Output smoothing (alpha 0.35) reduced synthetic static noise but delayed constant-speed motion by about 61.9 ms at 30 Hz, so no smoothing is enabled.

## Build

From the repository root after `npm ci`: `npm run build` (the root TypeScript build includes this package), or `node node_modules/typescript/bin/tsc -p packages/tracking/tsconfig.json` to type-check alone.

## Provenance

Original code; no third-party source is copied, linked or distributed. Public computer-vision projects (OpenCV, MindAR, OpenVINS) were consulted as reading material only and none of their implementation was ported.
