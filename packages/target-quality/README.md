# Target suitability preflight (optional utility)

[English](README.md) | [简体中文](README.zh-CN.md)

Scores a picture **0..5** for how suitable it is as an image target, before you ship it. **Below 3 the advice is to replace the image.** A score of 3 or more can still fail on a real device (lighting, motion blur, print quality, the camera, the matcher's own limits); the score is a heuristic preflight, not a calibrated detection probability, not a recognition guarantee and not a Vuforia or ARCore rating. No asset-specific tuning is applied. It is independent of the engine: nothing in `packages/sdk/src/browser.ts`, the Worker or either single-file engine imports it (the engine builder fails if it ever does), and it needs no dependency, Worker, WASM or network.

It reuses the real legacy extractor and geometry (`m0-harris-brief256-v1` or explicit ANMS `m0-harris-anms-brief256-v1`, 384 features, 3 pyramid levels, the same as `compileGrayTarget`), so it measures what the engine would compile. No new recognizer, no per-frame matching.

> [!NOTE]
> This package implements only the standalone scoring utility. It provides no upload preview and no user interface.

## Use

Browser, one call with a `File`/`Blob` (decoded locally with `createImageBitmap` and a canvas; nothing is uploaded or fetched):

```js
import { assessTargetImage, analyzeTargetImage, drawTemplateFeatures } from './lm-target-quality.mjs';   // standalone file, or '@livemira/engine/target-quality/single'
const controller = new AbortController();
const result = await assessTargetImage(input.files[0], { signal: controller.signal });
if (result.recommendReplacement) alert(result.advice);             // exactly: result.score < 3
for (const reason of result.reasons) console.log(reason.severity, reason.code, reason.message);

// Or get both quality result and template feature points from the SAME extraction:
const { result: r, features } = await analyzeTargetImage(input.files[0], { signal: controller.signal });
const drawnCount = drawTemplateFeatures(canvasContext, features, { width: 320, height: 240 });
```

Node (or a Worker), canonical gray8, synchronous, no browser APIs:

```js
import { assessGrayTarget, analyzeGrayTarget } from '@livemira/engine/target-quality';    // the same standalone file; SDK-only multi-file module: '@livemira/engine/development/target-quality'
const result = assessGrayTarget({ width: 512, height: 384, data: grayBytes });   // Uint8Array, width*height bytes, row-major

// With preview points from the same extraction:
const { result: r, features } = analyzeGrayTarget({ width: 512, height: 384, data: grayBytes });
```

### Static Template Features vs Live Matched Points

`features` returned by `analyzeGrayTarget` / `analyzeTargetImage` and drawn by `drawTemplateFeatures` are **static template features**: where the compiler extracts corner features on the reference image alone. They are completely distinct from **live matched points** (inliers from camera frame matching). Template points say nothing about camera recognition success, and `drawTemplateFeatures` renders them as hollow cyan rings to avoid confusion with live match markers.

Supported algorithms: `m0-harris-brief256-v1` (legacy default algorithm) and explicit ANMS `m0-harris-anms-brief256-v1` (explicit ANMS ID).

Result (`webar-target-quality/2` for scorer 2.0.0; `webar-target-quality/1` for 1.0.0, deterministic, no timestamps): `score` (0..5, at most one decimal), `maxScore: 5`, `recommendReplacement` (exactly `score < 3`), `advice`, `rawScore` (3-decimal diagnostic for near-threshold cases; decisions use `score`), `scorer {name, version}`, `algorithm {version, maxFeatures, levels}`, `normalization {id, grayFormula, inputWidth/Height, width/height, scale, resampling}`, `metrics`, `subscores`, `reasons[]`, `disclaimer`.

`reasons[]` entries are `{ code, severity, message, metric, value, threshold }`:

| code | meaning | blocker when |
|---|---|---|
| `LOW_FEATURE_COUNT` | too few corner features | < 24 (warning < 96 in v2, < 60 in v1) |
| `LOW_COVERAGE` | features span a small part of the image | hull < 15% (warning < 35%) |
| `CLUSTERED_FEATURES` | detail concentrated in few regions / low dispersion | warning only (dispersion subscore < 0.5 in v2) |
| `DEGENERATE_GEOMETRY` | features lie mostly along one direction (collinear) | warning only (conditioning subscore < 0.5 in v2) |
| `REPETITIVE_PATTERN` | many features have near-identical twins | > 35% within Hamming 16 (warning > 15%, or > 50% within 32) |
| `LOW_CONTRAST` | brightness range (5th..95th percentile) under 50 | info in v2 (reported, not scored); warning in v1 |
| `WEAK_SCALE_SUPPORT` | few features at the coarser pyramid levels | warning in v1 (reported only in v2) |
| `LOW_RESOLUTION` | long edge under 256 px | warning only |
| `DOWNSCALED` | input reduced to the 640 px long edge | info |

"Blocker" means the engine's own `compileGrayTarget` diagnostics (`LOW_TEXTURE`, `LOW_COVERAGE`, `REPETITIVE_TEXTURE`) would fire on the same image; any blocker caps the raw score at 2.0 (`BLOCKER_CAP = 2`), ensuring the image always lands below 3.

## Score formula 2.0.0 (`SCORER_VERSION = '2.0.0'`, Default)

Scorer 2.0.0 evaluates five necessary geometric and distinctiveness conditions for stable template pose fitting, each as a linear ramp from 0 to 1:

| sub-score | measure | 0 at | 1 at | rationale |
|---|---|---|---|---|
| **support** (0.20) | feature count | 24 | 192 | usable template features (24 = compiler minimum, 192 = half of 384 budget) |
| **coverage** (0.20) | convex hull / target area | 15% | 60% | normalized convex hull coverage (15% = compiler minimum gate) |
| **dispersion** (0.20) | normalized covariance dispersion $(\text{var}\,u + \text{var}\,v) / (2/12)$ | 0.15 | 0.55 | target-normalized scatter ($1.0$ is uniform scatter over whole target) |
| **conditioning** (0.20) | isotropy $4\det(C) / \text{tr}(C)^2$ | 0.10 | 0.50 | conditioning of 2D covariance ($1.0$ = equal spread in all directions, $0$ = collinear) |
| **uniqueness** (0.20) | worse of near-duplicate ratio ($\le 16$) and ambiguous ratio ($\le 32$) | 35% / 60% | 5% / 15% | repeats make matches ambiguous; $< 2$ features scores 0 |

- **Equal weights**: each geometry sub-score has weight `0.2`.
- **Combined formula**: `combined = 0.5 * mean + 0.5 * min(subscores)`. Because of the `0.5 * min` weakest-link term, with one failing condition at 0 and the other four at 1.0 (mean = 0.8), the score is capped at $5 \times (0.5 \times 0.8 + 0.5 \times 0) = 2.0 < 3$.
- **Blockers cap**: any compiler blocker caps `rawScore` at `BLOCKER_CAP = 2.0`.
- **Published score**: `score = round(rawScore, 1 decimal)`. Exactly `score < 3` triggers `recommendReplacement: true`.
- **Nature of formula**: purely an explainable heuristic, **not** labeled calibration, and **not** a detection probability. Contrast range and scale levels are reported in metrics/reasons but no longer directly scored (does not attempt to predict distant/small scale appearance).

## Explicit 1.0.0 Reproduction Option (`SCORER_VERSION_V1 = '1.0.0'`)

To reproduce historical reports and comparisons, callers can specify `{ scorerVersion: '1.0.0' }`:

```js
const resultV1 = assessGrayTarget(gray, { scorerVersion: '1.0.0' });
```

In 1.0.0:
- Subscores: `texture` (0.25), `coverage` (0.20), `distribution` (0.20, effective grid cells), `distinctiveness` (0.15), `scale` (0.10), `contrast` (0.10).
- Combined: `combined = 0.6 * mean + 0.4 * min(subscores)`.
- Blocker cap: 2.0.

## Normalization

Gray is `(77R + 150G + 29B + 128) >> 8` (the engine's luma). Images with a long edge above 640 are reduced to 640 (never enlarged); `normalization` records the original and normalized size and how it was resampled: `none`, `box-area` (gray API: exact area averaging, deterministic) or `canvas-draw-image` (Blob API: drawn at the reduced size by the browser's canvas, as the engine's target compiler does, so its resampling is browser-defined). The Node and browser paths give the same result only when they end up with the same normalized gray pixels; a browser's codec, color management, EXIF orientation and resampling can change those pixels even for an encoded file of 640 px or less, so browser equality is something to check per environment, not a guarantee. Alpha is not composited (as in the engine); EXIF orientation follows the browser's `createImageBitmap` default.

## Limits, validation, errors

- Exported helpers `scoreMetrics`, `scoreMetricsV2`, and `normalizedSize` validate their input: non-finite or out-of-range metrics, non-integer or out-of-range blocker counts (0..16) and invalid dimensions throw `INVALID_INPUT`.
- Abort is honored even if the decoder aborts the signal synchronously or never settles; a decode result that arrives later is closed, and abort listeners are removed. A signal must provide `aborted`, `addEventListener` and `removeEventListener`.
- Gray: `Uint8Array` with `data.length === width*height`; 32..8192 px per side, at most 16,777,216 pixels. Anything else throws `TargetQualityError('INVALID_INPUT')`.
- Blob: non-empty, at most 24,000,000 bytes (`maxImageBytes` may lower it), decoded at most 16,777,216 pixels (`maxPixels` may lower it); the normalized short edge must be ≥ 32 (`UNSUPPORTED_IMAGE`).
- Options are validated: unknown keys, wrong types or out-of-range limits throw `INVALID_OPTIONS`; an `algorithmVersion` other than `m0-harris-brief256-v1` or `m0-harris-anms-brief256-v1` throws `UNSUPPORTED_ALGORITHM`.
- `scorerVersion` must be `'2.0.0'` or `'1.0.0'`.
- `TargetQualityError.code`: `INVALID_INPUT`, `INVALID_OPTIONS`, `UNSUPPORTED_ALGORITHM`, `IMAGE_TOO_LARGE`, `UNSUPPORTED_IMAGE`, `UNSUPPORTED_ENVIRONMENT`, `DECODE_FAILED`. Abort rejects with the signal's reason (an `AbortError`).
- Options are read once before the first `await`; the Blob is immutable. The decoded `ImageBitmap` is closed and the canvas released on success, error and abort, including a bitmap that arrives after an abort.
- Declarations are self-contained and strict (`lm-target-quality.d.mts`; they use the DOM `Blob`, `AbortSignal` and `File` types, so consumers need `lib: ["DOM"]`).

## Build, tests, scoring script

```
npm run build                                            # tsc + dist/target-quality-single/lm-target-quality.{mjs,d.mts,audit.json}
node scripts/release/build-target-quality.mjs --out-dir <new absolute dir>
node --test --test-isolation=none tests/quality/standalone.test.mjs
```

## Not covered

This is not a device test: nothing here measures motion, lighting, the phone camera or the matcher's ratio test against live frames. Perspective, partial occlusion and print quality are not modeled. The thresholds are heuristics, not calibrated on a labeled detection dataset; the scorer has not been validated against phone recognition outcomes.
