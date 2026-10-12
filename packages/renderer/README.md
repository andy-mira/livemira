# CSS video renderer

`src/index.ts` exports `CssVideoRenderSink implements RenderSink` using `@livemira/contracts` 0.1.0. `src/perspective.mjs` is a dependency-free browser compatibility implementation. It uses CSS `matrix3d` projective `w` rather than affine triangles. Video decoding and compositing belong to the browser; this path has no explicit texture upload or WebGPU device and never borrows a camera image handle.

Media sources can be a URL or an owned `File`/`Blob`, with explicit retry and audio controls, numeric media diagnostics and pagehide cleanup. `examples/media-controls.mjs` shows how to bind these to existing UI (it creates no DOM).

Supply a positioned overlay container aligned with the camera viewport. CSS geometry is in CSS pixels, so do not multiply the transform by DPR. The viewport transform already contains rotation, crop and display mirroring. Target edges are (0,0), (width,0), (width,height), (0,height). No additional filtering or coordinate sorting is performed. Invalid or crossing quadrilaterals hide and reject.

Minimal SDK wiring:

```ts
const renderer = new CssVideoRenderSink({
  geometryForResult: result => geometryForSessionAndFrame(result.sessionId, result.frameId),
});
const engine = createEngine({ source, pipeline, renderer });
engine.on('playbackBlocked', event => showRetryButton(event.retry));
engine.on('error', event => showMediaError(event.error));
await engine.loadTargets(targetBundles);
engine.setTargetMedia(targetBundles[0].targetId, { url: mediaUrl, muted: true });
await engine.start(overlayContainer);
```

The SDK must call `hide()` when prediction expires even without new frames; the renderer rejects supplied prediction ages >= 100 ms but does not create a second tracking clock. `geometryForResult` must resolve the geometry for that result, not a mutable unrelated latest camera frame. No calibrated pose or Three.js conversion is used in this 2D path.

Only one video exists at a time. Switching media or targets, or stopping, removes the source and pending frame callbacks. `lostBehavior: hide` intentionally lets media continue while hidden; the default `pause-and-hide` pauses. Document backgrounding always pauses, and a new valid update is needed to show or resume afterwards. Blocked play does not retry on every tracking frame; the caller supplies the explicit retry gesture. Error and load retries are zero automatic attempts; the caller can replace the configuration. Network error causes are not classified as proven CORS failures.

A resource failure hides the native media error layer and latches the failed source until `setTargetMedia` replaces it or the target or session changes. Normal tracking updates do not repeatedly call play on a failed source. This does not alter tracking state or `targetFound`/`targetLost` semantics.

The SDK `loadTargets` calls the optional public `setTargets` hook and connects `RendererEventSink` through `connectEvents`. Constructor callbacks remain supported, but an application should choose one UI subscription to avoid duplicate messages. Observers are isolated, unsubscribe is idempotent, dispose clears subscriptions, and old media retry closures are inert.

Type-check from the repository root after `npm ci`:

```sh
node node_modules/typescript/bin/tsc -p packages/renderer/tsconfig.json
```

Behavior in real browsers varies; `MediaRecorder` and `captureStream` are test-fixture techniques, not runtime dependencies. Existing video rendering was exercised through an iPhone browser Demo integration; the loading mask and circular reveal were confirmed in an iPhone Chrome Demo using the release candidate. Portrait/landscape transitions can still deform the video overlay; 0.2.0 does not fix this issue.

Provenance: the code and any fixture artwork were written for this project; no third-party code or media is incorporated.

## Tracking visuals are not part of this renderer

`CssVideoRenderSink` draws video only. The optional recognized-boundary and current-matched-point layer is the separate companion `packages/tracking-visuals` (`TrackingVisualRenderSink`, a `RenderSink` decorator around this class, built as `lm-tracking-visuals{,.min}.mjs`). It shares no code with the renderer, so a renderer-only integration pays nothing for it. See the SDK README section "Optional: draw the recognized boundary and current matched points".

## Loading mask and circular reveal (default on)

`CssVideoRenderSink` shows loading and reveal *inside the perspective plane*, as children after the video (the video stays the plane's first child), so they follow `matrix3d`, are clipped by the plane, inherit `pointer-events:none` and never cover the camera view or capture touches. Source: `src/loading-reveal.mjs` (DOM/animation only, no media knowledge) and the request state machine in `src/index.ts`.

**Behavior.** (1) A recognized target whose current video has no presentable picture shows a black layer (`overlayOpacity`, default .55) and a centered rotating ring; the video is masked out, not removed, so it can still decode and present. (2) When the current media request's first frame is presentable (`VideoSession.awaitPresentableFrame`: a `requestVideoFrameCallback` callback with `readyState >= 2`, non-zero intrinsic size and no error; without that API a documented conservative fallback: unpaused, `currentTime` strictly increasing over two consecutive 100 ms polls and, if the platform reports it, a rising decoded-frame count; it can lag the real frame by about two polls but never precedes it), a circle grows from the plane centre with an ease-out cubic over `revealMs` (default 420 ms; chosen inside the requested 350–500 ms range, to be tuned from the phone result). The video is visible inside the circle and the dim layer only outside it, with a feathered edge (22% of the shorter plane side); the spinner fades out early in the reveal. At the end the mask and layer are removed. Without CSS mask support the same timing is an opacity cross-fade. (3) `prefers-reduced-motion: reduce` (read at use time): static ring, no expansion, 120 ms cross-fade.

**Ownership.** Each media request (new video element for a target, a gesture reload, or a retry after blocked playback) has a `requestGeneration` and its own readiness watch. Every continuation (first frame, timeout, animation end) re-checks that it is still the sink's current request for the same session, target and media element; a released or replaced request (target switch, `setTargetMedia`/`clearTargetMedia`, `stop`, `dispose`, A→B→A) is reported once as `reveal-cancel` and its late callbacks do nothing. A new target always gets a new element, so an old picture can never show through the mask. Reentrant observers are safe: a release reports its request with its own ids after the sink state was already cleared, a `hide` during a release cannot snap-complete or double-report it, and an older update cannot dispose a newer plane.

**Not restarted.** Repeated tracking updates never touch the animation. A hide/loss while loading keeps the same request and its watch (the loading budget pauses while hidden); a hide during the reveal completes it at once (`reveal-end` with the shorter `revealElapsedMs`); a hidden first frame completes without animation. Reacquiring presentable media (including inside `lossDisplayGraceMs`) shows the finished video with no new loading or reveal.

**Failure.** Media error, blocked playback and the bounded loading timeout (`loadingTimeoutMs`, default 15 s of *visible* time, finite by validation) all clear the spinner (`loading-failed`, `failureReason` `media-error` / `playback-blocked` / `loading-timeout`) and then follow the unchanged contract: `error` `RESOURCE_FAILED` (timeout reason `media-loading-timeout`, recoverable) with the failed-source latch, or `playbackBlocked` with its `retry`. `retryActiveMediaFromGesture()` and the blocked `retry()` start a new request (new generation, loading again). Playback itself is still `VideoSession` (native `play()` first, WeChat recovery only after `NotAllowedError`); nothing about the gesture path changed.

**Options and opt-out.** `new CssVideoRenderSink({ geometryForResult, presentation })`: omitted/`true`/object = on; `presentation: { revealMs (0..2000, 0 = no animation), loadingTimeoutMs (1..600000), overlayOpacity (.05..1) }`; `presentation: false` = previous behavior (no extra DOM, no extra events). Invalid values throw `INVALID_CONFIG`. Per-target media options (`MediaConfig`) are unchanged.

**Telemetry.** `mediaState` events (`loading`, `first-frame`, `reveal-start`, `reveal-end`, `reveal-cancel`, `loading-failed`) carry `media.presentation` (`MediaPresentationTelemetry` in `@livemira/contracts`): request generation, phase, ready signal, elapsed/first-frame/reveal milliseconds, configured duration, reduced-motion flag and failure reason. Transitions only, never per frame, never URLs or pixels. `DiagnosticRecorder.event` keeps it as a closed set of bounded numbers/enums (anything else is dropped) so log export retains it. `getMediaDiagnostics().presentation` returns the current request's snapshot.
