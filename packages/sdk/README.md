# Engine integration guide

[English](README.md) | [简体中文](README.zh-CN.md)

This guide ships inside the `@livemira/engine` package (as `INTEGRATION.md` in its `docs` directory) and in the source repository (`packages/sdk/README.md`); the two copies are identical. You do not need the source checkout to follow it.

Status: LiveMira 0.2.1 (patch of the first stable edition, 0.2.0), not published to npm and not declared production-ready. The API below was checked against the shipped declarations and exercised by Node-level tests (imports, strict TypeScript, fake-DOM loop/grace behavior). The engine was tested in an iPhone browser Demo integration; other devices and environments are trial. The example below has **not** itself been run on a phone or with any particular bundler.

## Getting the package

Build the package from the source (`npm ci && npm run build && npm run engine:package -- <fresh-id>`) or receive its directory. It is named `@livemira/engine` (any directory name works; its `package.json` says `@livemira/engine` 0.2.1). Put it where your project can import it, for example `node_modules/@livemira/engine`, or reference it from a local path in your own package manager. The package directory contains the whole built runtime, this guide, `LICENSE`, `NOTICE`, third-party notices and `engine-package-manifest.json` (SHA-256 of every file, source commit, dirty flag).

**Production interface** (identical in the SDK package and in the curated production drop, which has no `shared/runtime/`): `.` and `./browser` (the minified core `core/lm-engine.min.mjs`), `./single` (readable `core/lm-engine.mjs`), `./single/min`, and the tool entries `./target-quality`, `./tracking-visuals`, `./recognition-diagnostics` (each also with `/single`, and `/single/min` where a minified file exists). Every one resolves to a standalone file in `core/` or `tools/`; no documented production import depends on an internal directory, and there is no wildcard export. The declarations are self-contained (no path aliases or workspace source are needed); a TypeScript project needs `lib: ["DOM"]`.

**SDK-specific development entries** (only in the SDK package, outside the stable production interface, may change in any release): `./development/sdk`, `./development/browser`, `./development/cpu`, `./development/worker`, `./development/mock`, `./development/camera`, `./development/renderer`, `./development/renderer/perspective`, `./development/media`, `./development/target-compiler`, `./development/recognition`, `./development/tracking`, `./development/compute`, `./development/contracts`, `./development/contracts/worker`, `./development/target-quality`, `./development/tracking-visuals` and `./development/recognition-diagnostics`. They load the multi-file modules in `shared/runtime/`.

Compatibility: patch releases keep the production interface and the target schema unchanged; minor releases only add to the production interface; a new target schema or algorithm version arrives in a minor release and the engine never mixes algorithm versions. See `docs/release/livemira-release.md` in the source repository (shipped as `README.md` of the production drop).

Video presentation defaults to a 55% black loading layer and rotating ring inside the target plane, then a 420 ms soft circular reveal from its centre after the current video has a decoded frame. `new CssVideoRenderSink({ geometryForResult, presentation: { revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 } })` configures it; `presentation: false` disables it. The first-frame callback belongs to its media request and is cancelled on replacement or stop. The existing `mediaState` event gains loading/first-frame/reveal/failure transitions and bounded `media.presentation` telemetry; numeric diagnostic export preserves these fields. See the renderer guide for details. The presentation was confirmed in an iPhone Chrome Demo using the release candidate. Portrait/landscape transitions can deform the video overlay; this remains unresolved in 0.2.1.

## Complete minimal example (browser)

Serve the page over HTTPS (or `localhost`) so the camera is available. Targets are compiled bundles your app already has (`compileGrayTarget` / `serializeTarget`, exported by the core); media URLs are supplied by you.

```html
<style>
  #stage { position: relative; width: min(100vw, 640px); aspect-ratio: 3 / 4; overflow: hidden; background: #000; }
  #preview, #overlay { position: absolute; inset: 0; }   /* same bounded viewport, stacked */
  #overlay { pointer-events: none; }
</style>
<div id="stage"><div id="preview"></div><div id="overlay"></div></div>
<button id="start">Start camera</button> <button id="stop">Stop</button>

<script type="module">
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry, prepareWorkerFrame,
         CssVideoRenderSink, parseTarget } from '@livemira/engine';

const stage = document.querySelector('#stage');

// Targets: 1..10 bundles with unique targetIds and one algorithm version.
const targets = await Promise.all(['/targets/poster-a.json', '/targets/poster-b.json']
  .map(async url => parseTarget(await (await fetch(url)).text())));

let engine, running = false;
const stopEngine = reason => { running = false; return engine.stop(reason).catch(error => console.warn('stop failed', error)); };

// Camera. longEdge is the processing long edge: 480, 640 (default), 960 or 'native' (the camera's own size).
const source = new CameraFrameSource({
  previewContainer: document.querySelector('#preview'),
  camera: { facingMode: 'environment' },
  geometry: { longEdge: 640, fit: 'contain' }, // previewContainer dimensions/DPR are measured by the source
  onEvent: event => {
    // Camera event types: 'error' (event.code, e.g. CAMERA_PERMISSION_DENIED, TRACK_ENDED, CAMERA_FRAME_STALLED) and 'suspended'
    // (page hidden). Both end capture; stop the whole engine so camera, pipeline and renderer share a fresh session on restart.
    if (event.type === 'error' || event.type === 'suspended') void stopEngine(event.code ?? event.type);
  },
});

// The renderer needs the geometry of the exact frame each result came from.
const geometries = new Map();
const renderer = new CssVideoRenderSink({ geometryForResult: result => geometries.get(`${result.sessionId}:${result.frameId}`) });
const pipeline = createWorkerPipeline({
  options: { trackingMode: 'absolute', backendPreference: 'cpu', algorithmVersion: targets[0].algorithmVersion },
  prepareFrame: async (frame, signal) => {
    const geometry = getFrameGeometry(frame);
    geometries.set(`${frame.sessionId}:${frame.frameId}`, geometry);
    if (geometries.size > 64) geometries.delete(geometries.keys().next().value);
    return prepareWorkerFrame(frame, geometry, signal);
  },
  onFailure: error => { console.warn(error.reason); void stopEngine('worker-failure'); },
});

engine = createEngine({
  source, pipeline, renderer, getFrameGeometry,
  maxPredictionMs: 100,      // default 100, see below
  lossDisplayGraceMs: 500,   // default 0; 0..1000
});
engine.on('error', event => console.warn(event.error));
engine.on('playbackBlocked', () => { /* optional noninteractive notice: the host browser denied playback after bounded recovery */ });
await engine.loadTargets(targets);
for (const target of targets) {
  engine.setTargetMedia(target.targetId, {
    url: `/media/${target.targetId}.mp4`,   // your URL: same origin or CORS-enabled
    loop: true,                             // default true; false plays once
    muted: true,                            // default true; keep muted until a user gesture unmutes
    fit: 'contain',                         // default; or 'cover'
  });
}

// Starting from a click is the user gesture that lets the camera prompt and video playback proceed.
document.querySelector('#start').addEventListener('click', () => {
  running = true;
  engine.start(document.querySelector('#overlay')).catch(error => { running = false; console.warn('start failed', error); });
});
document.querySelector('#stop').addEventListener('click', () => void stopEngine('user'));

// Orientation/container/viewport changes are handled by CameraFrameSource + SDK automatically.
// Keep preview/overlay siblings responsive and equally sized; no app resize gate or restart is needed.
// Leaving the page releases the camera, Worker and media.
addEventListener('pagehide', () => void engine.dispose());
</script>
```

What the options mean (all are plain `createEngine` / media options, none depends on your event handlers):
- **`loop`** (`MediaConfig`, default `true`): the clip loops. A bounded fallback rewinds a clip that stalls at its end; `false` plays once.
- **`maxPredictionMs`** (default 100): the freshness/validity window. A pose is only treated as valid while the result behind it is no older than this; when no fresh valid result arrives within the window the engine reports `targetLost`. It is not a request for longer extrapolation.
- **`lossDisplayGraceMs`** (default 0, maximum 1000): after `targetLost` the overlay stays visible and playing for this long, then hides and pauses. Display only: the `targetLost` event and tracking results are unchanged, and a valid same-target result inside the window updates the pose without restarting the video.
- **Processing size**: `geometry.longEdge` is `480`, `640` (default), `960` or `'native'`. To change it, call `await engine.stop()`, then `source.updateGeometry({ longEdge })`, then `engine.start(...)`.
- **`algorithmVersion`** in the Worker options must match the loaded bundles; one engine cannot mix versions.
- Switching cameras: `await engine.stop(); source.configureCamera({ deviceId }); await engine.start(overlayElement)`.

## Single-file runtime (one JavaScript download)

`@livemira/engine/single/min` (file `core/lm-engine.min.mjs`, **minified**; the recommended file) and `@livemira/engine/single` (`core/lm-engine.mjs`, readable) are the same whole browser engine as **one ES module** each, built by `npm run build` into the build output directory `dist/engine-single/` and classified into `core/` by the release generator (`core/` holds exactly these two files). Pick one file; both have the same exports, types and behavior, and each embeds its own matching (minified or readable) Worker source. `engineBuildInfo.variant` says which one is running. Each file: it embeds the vision Worker (as a Blob source), the scalar WASM binary and glue, and the Hamming WGSL shader. Importing it creates no Worker and makes no request; the page then downloads nothing else from the engine, even with `backendPreference: 'wasm'`. Application targets and media stay yours.

```js
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry, prepareWorkerFrame, CssVideoRenderSink,
         compileGrayTarget, parseTarget, serializeTarget, engineBuildInfo } from '/assets/lm-engine.min.mjs';   // or '@livemira/engine' / '@livemira/engine/single/min'; readable: '/assets/lm-engine.mjs' = '@livemira/engine/single'
```

It exports the same names as the multi-file `@livemira/engine/development/browser` (a `WorkerVisionPipeline` type, no class); the example above works unchanged with either import path, and `createWorkerPipeline` runs recognition in the embedded Worker, never on the UI thread. `engineBuildInfo` reports `{ format: 'single' | 'multi-file', variant: 'readable' | 'minified' | null, buildId, inputHash }` so logs can prove which build ran. The single file excludes DiagnosticRecorder, mocks, replay sources and test/demo code; the numeric `onCapability`, `onTiming`, `onFailure`, `onDiagnostics` hooks remain. The runtime file alone is portable. Types come from the declaration tree (`shared/types/runtime/sdk/src/browser.d.ts`) or `@livemira/engine/single` in the package; `shared/types/core/lm-engine.d.mts` is only a forwarding declaration that needs that tree, not a standalone types file. Audits are in `shared/audits/core/`, third-party notices in `shared/notices/`. The `WorkerVisionPipeline` class is not a value export of this entry (use `createWorkerPipeline`); the SDK-only `./development/worker` module still exports it.

Required CSP for this build: `worker-src blob:` (the Worker is created from a Blob URL that is revoked when the Worker terminates) and, for `backendPreference: 'wasm'`, `script-src ... 'wasm-unsafe-eval'`. Keep `connect-src`/`media-src` for your own target and video URLs. The build is described in the header of `scripts/release/build-engine-single.mjs` in the source repository; each build's audit is in `shared/audits/core/`.

## Optional: draw the recognized boundary and current matched points (tracking visuals)

Two parts, both off by default, and the second is a **separate file** so the core engine stays small:

1. **Core, data only.** `createWorkerPipeline({ options: { collectMatchedPoints: true } })` (also `createCpuPipeline({ collectMatchedPoints: true })`) makes each measured `TRACKING` result carry `result.matchedPoints = { sessionId, frameId, targetId, origin: 'original-target' | 'previous-frame', pointsPx }`. `pointsPx` are the **actual inlier image points of the observation accepted for exactly that frame** (standard-image pixels, the space of `cornersPx`), at most 512, no extra feature extraction. Predictions (`LIMITED`), `ACQUIRING`, missing and lost results never carry points, and points are never copied from an earlier frame. The field is absent unless requested; it is fixed per Worker, so changing it means creating a new pipeline. A non-boolean value throws `INVALID_CONFIG`. The main side drops points that do not match their result. `DiagnosticRecorder` never stores them.
2. **Companion, drawing.** `@livemira/engine/tracking-visuals/single/min` (minified, `tools/tracking-visuals/lm-tracking-visuals.min.mjs`), `.../single` (readable) or `@livemira/engine/tracking-visuals` (the minified file). It imports nothing (no engine, no recorder) and can sit anywhere you serve it; the engine files never import it. Load it only when drawing is wanted:

```js
import { createEngine, createWorkerPipeline, CssVideoRenderSink, getFrameGeometry, prepareWorkerFrame } from '/assets/lm-engine.min.mjs';
const geometryForResult = r => geometries.get(`${r.sessionId}:${r.frameId}`) ?? null;   // same function you give CssVideoRenderSink
const base = new CssVideoRenderSink({ geometryForResult });
let renderer = base;
if (wantDrawing) {
  const { createTrackingVisualRenderSink } = await import('/assets/lm-tracking-visuals.min.mjs');   // loaded only now
  renderer = createTrackingVisualRenderSink({ base, geometryForResult, boundary: true, points: true });    // both default false
}
const pipeline = createWorkerPipeline({ options: { trackingMode: 'absolute', backendPreference: 'cpu', collectMatchedPoints: wantDrawing }, prepareFrame: /* as above */ });
const engine = createEngine({ source, pipeline, renderer });
// Media convenience calls (setTargetMediaFile, setMutedFromGesture, retryActiveMediaFromGesture) stay on `base`; renderer.setVisualization({ boundary, points }) switches live.
```

The decorator forwards everything the engine calls to `base` and owns it from then on (`engine.dispose()` disposes the decorator, which disposes `base`). Drawing is an SVG layer in the overlay container, in CSS pixels through `H_viewportFromStandard` (crop, mirror, rotation and DPR come from that matrix). The boundary is shown for every valid `TRACKING`/`LIMITED` result (dashed amber for a prediction); dots only for a measured result with matching `matchedPoints`. Everything is cleared on `hide()`, on loss (the 500 ms `lossDisplayGraceMs` hold keeps the **video** only), on stop/dispose/new session, on a hidden page, on a media error of that target (resume with `clearMediaFailure()` after a successful retry, or restart), and on any non-valid result. It works for targets with no media configured. `setVisualization({ boundary, points })` and the constructor reject unknown keys and non-boolean values with `INVALID_CONFIG`. `getVisualDiagnostics()` returns counts only. Without the companion, or with both switches off, no extra DOM exists.

## Optional: check whether a picture makes a good target (score 0..5)

`@livemira/engine/target-quality` and `@livemira/engine/target-quality/single` (the same standalone browser ES module, `tools/target-quality/lm-target-quality.mjs`, no dependencies, Worker, WASM or network) score an image **before** you use it as a target. It is separate from the engine: the engine files never import it, and you can ship either without the other. It supports the legacy algorithm (default) and explicit `algorithmVersion: 'm0-harris-anms-brief256-v1'`; use the same algorithm as your compiled targets. The default scorer is 2.0.0 (support, coverage, covariance spread/isotropy and descriptor uniqueness); `scorerVersion: '1.0.0'` reproduces the historical formula and result schema.

```js
// Browser, one call with a File/Blob (decoded locally; nothing is uploaded or fetched)
import { assessTargetImage } from '/assets/lm-target-quality.mjs';   // or '@livemira/engine/target-quality/single'
const result = await assessTargetImage(fileInput.files[0], { signal: abortController.signal });
if (result.recommendReplacement) showWarning(result.advice);            // score < 3: choose another picture
console.log(result.score, 'of', result.maxScore, result.reasons.map(r => r.code));
```

```js
// Node (or a Worker): canonical gray8, no browser needed
import { assessGrayTarget } from '@livemira/engine/target-quality';
const result = assessGrayTarget({ width, height, data /* Uint8Array, width*height bytes */ });
```

`score` is 0..5 with at most one decimal; `recommendReplacement` is exactly `score < 3`, and `reasons[]` lists specific, actionable causes (`LOW_FEATURE_COUNT`, `LOW_COVERAGE`, `CLUSTERED_FEATURES`, `REPETITIVE_PATTERN`, `LOW_CONTRAST`, `WEAK_SCALE_SUPPORT`, `LOW_RESOLUTION`; severity `blocker` = `compileGrayTarget` would flag it). **Below 3 we advise replacing the image. 3 or more can still fail** on a real device (lighting, motion blur, printing, the camera, the matcher's own limits). The score is a heuristic suitability preflight: not a probability of detection, not a guarantee, not a Vuforia or ARCore rating. Images are reduced to a 640 px long edge (never enlarged) like the engine does; the result records the original and normalized sizes. Formula, limits, errors and the strict TypeScript declarations: `TARGET-QUALITY.md` alongside this guide in the package (source: `packages/target-quality/README.md`).

`analyzeGrayTarget` / `analyzeTargetImage` additionally return `{ result, features }` from the same extraction; the optional `drawTemplateFeatures` helper draws those static template points. They are not camera matches.

## Optional: recognition diagnostics

Import `@livemira/engine/recognition-diagnostics/single/min` (or readable `.../single`; `@livemira/engine/recognition-diagnostics` is the same minified file) only when diagnostics are wanted. Its standalone file contains bounded aggregation and point-distribution calculations; the core engine never imports it.

```js
import { createWorkerPipeline, prepareWorkerFrame, getFrameGeometry } from '@livemira/engine/single/min';
import { createRecognitionDiagnostics } from '@livemira/engine/recognition-diagnostics/single/min';
const diagnostics = createRecognitionDiagnostics();
diagnostics.setTargets(targets.map(t => ({ targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx })));
const pipeline = createWorkerPipeline({
  options: { observeRecognition: true, collectMatchedPoints: true },
  prepareFrame: (frame, signal) => prepareWorkerFrame(frame, getFrameGeometry(frame), signal),
  onRecognitionTrace: trace => diagnostics.observeRecognition(trace),
  onResult: result => diagnostics.observeResult(result),
});
// Load targets and start your engine as above. Reading a snapshot never stops collection.
const numericSnapshot = diagnostics.snapshot();
// After ending a session, reset it to reject late callbacks; dispose the collector with its host.
// diagnostics.reset(endedSessionId); diagnostics.dispose();
```

Both Worker options default to false. Recognition traces contain bounded counts and rejection codes for the same session/frame as the result. When observed, a trace may also carry `stageMs` (feature/retrieval/match/geometry/total milliseconds, summed over the passes) and `passes` (one record per recognition pass, at most two: the standard image and the half-octave scale retry). Each pass record holds its own scale, `prepareMs` (resampling of the retry), stage times, feature/candidate/observation counts and rejection reasons, snapshotted before any accumulation, so the first pass's rejection reasons survive a successful retry. `featureCount` stays the last pass's count, not a sum. Both fields are optional (older traces stay valid), finite non-negative bounded floats only, no pixels, coordinates or URLs; no extra feature extraction happens and nothing is stored when `observeRecognition` is off. The companion reports them as separate `stageTiming`, `passStats` and per-target `passRejections` fields; the original `recognition` and `rejections` counters keep their meaning and are not added to. They describe recognizer candidate acceptance, not the tracker's later temporal/quality decision. Distributions use only measured `TRACKING` results, normalize accepted inliers back to target coordinates, and run at most once per 200 ms by default. Snapshots contain no pixels, URLs or point arrays. The core recorder stays independent of this companion.

## Legacy scale retry control

`WorkerPipelineOptions.legacyScaleSearch` (also accepted by `createCpuPipeline` and `CpuRecognizer`) is a boolean, default `true`: after a global miss the legacy-family algorithms (greedy and ANMS) retry once at a half-octave scale. `false` skips that retry. It exists for **diagnostic comparison only; do not turn it off in normal use**, because it removes the recovery for scale gaps between the saved descriptors and the live image. Any non-boolean (`null`, a string, a number) is rejected with `INVALID_CONFIG`; the v2 algorithm never retries, so it ignores the option. The option is fixed for the lifetime of the Worker.

## CPU feature implementation options

`WorkerPipelineOptions.cpuFeatures` (also accepted by `createCpuPipeline`, `CpuRecognizer` and `compileGrayTarget`) is optional. Since 0.2.1 the default is `{ briefOffsets: true }`, applied when it is omitted, `undefined` or a partial object; `{ briefOffsets: false }` selects the reference extraction. `briefOffsets` computes the legacy-family BRIEF-256 sample offsets once per pyramid layer instead of per sampled pair; features, descriptors, selection order and compiled bundles are bit-identical, and the algorithm identity, budgets, levels and thresholds are unchanged. The v2 algorithm ignores it. The value must be an object (not an array) whose only key is a boolean `briefOffsets`; `null`, strings, arrays, other keys or a non-boolean value are rejected with `INVALID_CONFIG`. It is copied at construction and fixed for the lifetime of the Worker. When enabled for a legacy-family algorithm the capability reports `operators.recognitionFeatures: 'cpu-brief-offsets'` (absent with `briefOffsets: false`). Speed on a given device is not established by this option. `compileGrayTarget` keeps its explicit-only behavior; its bundles are byte-identical either way.

## WebAssembly exact matching (default)

`WorkerPipelineOptions.cpuMatching` is `'wasm-experimental'` or `'js'`. Since 0.2.1 the default (omitted or `undefined`) is the WebAssembly matcher unless `backendPreference` is `'webgpu'`, where the GPU matcher keeps its existing behavior and no CPU WebAssembly matcher is applied; `'wasm-experimental'` remains the public spelling for it (retained for compatibility, not an indication of an unstable feature), and `'js'` opts out. The WebAssembly matcher runs the legacy-family (greedy and ANMS) exact BRIEF Hamming matcher in WebAssembly inside the Worker, with exactly the same contract and results as the JavaScript matcher (`hamming32-mutual-ratio075-max64/1`): target descriptors stay resident in a fixed 256 KiB WebAssembly memory, each frame's descriptors are copied in once per batch, and only accepted `(targetIndex, frameIndex, distance)` triples come back. At initialization the Worker selects the SIMD module when the engine validates it and it reproduces the JavaScript reference on a built-in self-test, otherwise the scalar module, otherwise the JavaScript matcher. `onCapability` reports what really runs: `operators.matching` is `'wasm-simd'`, `'wasm-scalar'` or `'cpu'`, with `cpuMatching`, `matchingScope`, `matchingSelection` (each attempt and its outcome) and `matchingFallback`; a JavaScript fallback also sets `fallbackReason: 'WASM_MATCHING_JS_FALLBACK'`. A WebAssembly failure during a frame disables the module, that same frame is matched in JavaScript, and the changed capability is announced with that frame's result. oriented-v2 targets keep the JavaScript matcher (`matchingFallback: 'ORIENTED_V2_USES_JS_MATCHER'`). Explicitly combining `'wasm-experimental'` with `backendPreference: 'webgpu'` is rejected with `INVALID_CONFIG`, as is any other value. The single-file engine embeds both modules (1,844 bytes of WebAssembly together, about 2.5 KB as base64 text); nothing is fetched. A strict CSP needs `script-src ... 'wasm-unsafe-eval'`, otherwise the JavaScript matcher is reported. With `'js'` the JavaScript matcher runs and the capability carries no `cpuMatching` facts. Timing differences were measured on specific devices only and are not a guarantee; this option does not fix matching loss during fast motion. Fixed for the lifetime of the Worker.

## ANMS test algorithm

The old engine/compiler default remains `m0-harris-brief256-v1`. Explicit `ANMS_ALGORITHM_VERSION` (`m0-harris-anms-brief256-v1`) uses Brown/Szeliski/Winder CVPR 2005 §3 suppression-radius selection with robustness 0.9. Work is bounded to the strongest 1024 candidates per pyramid level, and the existing per-level feature quotas remain (384 template / 512 live, three levels). This is a documented approximation, not the paper's full MOPS pipeline. Algorithm changes require recompiling targets and constructing a matching pipeline; mixed bundles are rejected. More inliers do not guarantee more accurate corners; an improvement on phones is not established. Tracking validity remains 100 ms and the configurable 500 ms visual grace does not extend it.

When `observeRecognition: true` is explicitly requested, per-frame `onTiming` also reports optional `prepareStages`: input packing/upload, standard-image drawing, pixel readback and grayscale conversion, in microseconds. Those additional clock reads and fields are absent by default. The values describe measured operations, not browser-internal copy volume or camera exposure/screen latency.

## CPU fallback, Worker, assets

- `createWorkerPipeline` runs recognition and tracking in a module Worker (`new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' })` inside `shared/runtime/sdk/src/worker-pipeline.js`). `backendPreference: 'cpu'` runs everything on CPU inside the Worker; `'wasm'` adds scalar WASM grayscale preprocessing; `'webgpu'` explicitly requests experimental exact GPU matching for legacy/ANMS and oriented-v2 targets. CPU remains the default; a GPU preference is not a performance guarantee. Check `operators.matching` for the actual matching backend; recognition and tracking remain CPU. The Worker reports what it actually used, including a `fallbackReason`, through `onCapability`.
- `createCpuPipeline` from the SDK-only `@livemira/engine/development/cpu` runs the same recognizer on the calling thread. It can block the page and is a fallback for environments without module Workers; the engine never switches to it by itself.
- **Static copy (the layout that is supported):** this is the optional multi-file development layout of the SDK package (the `./development/...` entries); keep `shared/runtime/` intact and serve it as static files (the production `core/` files need none of it). The Worker, `shared/runtime/compute/artifacts/{scalar,simd}/compute.{mjs,wasm}` and `shared/runtime/compute/shaders/*.wgsl` are located relative to the modules that load them.
- **Bundlers:** the Worker URL, WASM and WGSL files must be emitted as assets with their relative layout kept, or you pass `workerFactory: () => new Worker(yourWorkerUrl, { type: 'module' })` to `createWorkerPipeline`. No specific bundler has been tested.
- **Browser requirements:** ES modules, module Workers, `getUserMedia` in a secure context, a muted `playsInline` video for media. Sound needs a user gesture (hence `playbackBlocked`). Camera behavior varies by device; nothing here is a phone-performance or production claim.
