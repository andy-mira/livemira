# Camera runtime

[English](README.md) | [简体中文](README.zh-CN.md)

Dependency-free ES modules with a typed entry importing `@livemira/contracts` 0.1.0. No competing FramePacket definition. Node is used for reproducible lifecycle tests; browser camera capture uses getUserMedia, a muted playsInline video, requestVideoFrameCallback and an exercised VideoFrame snapshot with ImageBitmap fallback. API presence alone never proves capture.

## SDK integration

```ts
import { CameraFrameSource, ReplayFrameSource } from '@livemira/camera';
const source = new CameraFrameSource({
  camera: { width: 1280, height: 720, facingMode: 'environment' },
  onEvent(event) { /* Handle errors, geometryChanged, clockMapping and suspended. */ },
});
// Pass source to the SDK's createEngine({ source, pipeline, renderer }).
```

CameraFrameSource and ReplayFrameSource implement the canonical FrameSource. The SDK supplies sessionId and AbortSignal; ownership transfers to SDK at onFrame. Only SDK queues and releases transferred frames. stop/dispose never close an already-transferred image. SDK must await all CPU/GPU borrowers before release. Abort settles an outstanding start promptly even when getUserMedia permission remains pending; a subsequently granted stream is immediately stopped.

Both SDK sources implement nowSessionUs(): the active MediaClock arrival clock, or null when stopped/suspended. Prediction expiration must compare with this same session clock, never global performance.now. This includes time spent capturing/copying before delivery to SDK.

For standalone use, CameraRuntime and ReplaySource take `consume(frame): void | Promise<void>`. Their queue allows one processing frame and one candidate. A newer candidate releases its predecessor. Promise settlement ends the borrow; GPU consumers must await GPU completion themselves. stop releases the candidate, invalidates callbacks, and retains an active borrow until it settles. The consumer must reject old session results as well. An unresolved consumer can intentionally keep dispose pending; forced freeing is unsafe.

CameraRuntime manages standalone hide/resume using a fresh session. CameraFrameSource stops on hide and emits `{type:'suspended', requiresRestart:true}`. The SDK integration must stop/restart the engine after visibility returns so its pipeline, renderer and source share a **new** session. Switch devices with `await engine.stop(); source.configureCamera({deviceId}); await engine.start(container)`. Direct `CameraRuntime.switchCamera` is only for standalone use. Errors include permission denial, track ended, failed snapshot and source-clock reset. A reset stops live capture and requires a fresh session. No automatic permission retries.

## Frames, geometry and clocks

- Pixel handles expose canonical kind/data/released/release. Native decoder storage costs are unknown; VideoFrame is not claimed zero-copy. stats.bitmapCopies counts actual successful ImageBitmap snapshots, not hidden browser/GPU allocations.
- Presented-frame counters plus media timestamps suppress repeated callbacks. The older callback fallback uses video playback frame counters, never animation callback time as an observation. API-less browsers reject capture. This fallback still needs device verification.
- FramePacket dimensions describe the actual snapshot. Geometry defaults to a 640-pixel long edge with input rotation 0: browser-displayed orientation is already applied. Do not blindly rotate again using screen orientation. Input mirrored means the **pixels** are mirrored; front-facing selection alone does not set it.
- `geometryChanged` provides canonical FrameGeometry. Matrices map pixel **edges**, row-major with column vectors. Cropping/unmirroring/rotation/scaling are composed once. Viewport output is CSS pixels; DPR is metadata for framebuffer conversion. `updateGeometry` supplies processing size, fit, explicit crop, rotation or mirroring. With the default browser stabilization and a previewContainer, its live bounding rectangle and browser DPR supply CSS sizing automatically; manual CSS sizing is retained when stabilization is disabled. Downstream preprocessing must actually apply H_standardFromInput; this package does not silently rasterize canonical pixels.
- A calibration callback receives device settings (including zoom when exposed), image dimensions and geometry. Changes recompute calibrationId; absent match returns null. No fabricated focal length or precise-calibration claims. Browser zoom/focus metadata gaps require independent calibration validation.
- Exposure time and uncertainty are null. MediaClock aligns the first media timestamp to receipt time, emits the offset separately, and sets mappedObservationTimeUs with **unknown** clockMappingUncertaintyUs. This is approximate receipt alignment, never exposure or motion-to-photon. Drift estimation is not implemented. Replay with accelerated stepping should inject a compatible virtual nowUs clock.

ReplayFrameSource is manually stepped, not an encoded-video decoder: await start, then push(sessionId, sample). Each push transfers ownership even when rejected. CPU buffers must be tightly packed rgba8/bgra8/gray8 with exact byte length. The caller decodes authorized media, controls timing and supplies imageIdentity for repeated-content detection. start creates/reset clocks; stop rejects late decode deliveries. Native image handles are also accepted with their explicit format.

## Build and type-check

From the repository root after `npm ci`:

```sh
node node_modules/typescript/bin/tsc -p packages/camera/tsconfig.json
node packages/camera/examples/replay.mjs
```

Camera behavior varies by device. Lifecycle behavior is covered by synthetic Node tests; the package was exercised on real hardware only through an iPhone browser Demo integration, and other devices are trial. Android camera permission, revocation, focus/zoom, long-run resource stability, frame pacing and thermal behavior are not established.

## Provenance

Original implementation. No third-party source, runtime package, model or sample media is incorporated, and no specification or documentation text is redistributed. Test fixtures (synthetic bytes, corner coordinates) are authored for this project.

## Default orientation and viewport stabilization

`CameraFrameSource({previewContainer})` enables stabilization by default in a browser. Screen orientation signals mask the owned camera region immediately. The SDK subscribes to `onViewportTransition`, hard-hides the overlay even when it is in a separate sibling container, truthfully emits `targetLost` when applicable, discards old work and resets tracking in the same pipeline/session after the current borrower settles. It retains the usable camera stream and Worker, and resumes on newly captured frames. This is distinct from background suspension and does not emit `error` or `suspended` for normal transitions.

The source measures the preview container on capture and observes its size, browser/visual viewport and video intrinsic resize. The default gate requires two consecutive fresh frames with identical capture geometry, and 100 ms of unchanged geometry. An orientation signal additionally waits for changed intrinsic dimensions or up to 400 ms; some browsers retain the same sensor dimensions after rotation. This is a bounded wait for intrinsic orientation, not a timeout that alone resumes display. Subsequent viewport/intrinsic changes rearm the gate. A zero-sized container stays gated. Frame-bound geometry drives both preview and overlay; screen angle is never applied as another pixel rotation.

Keep preview and overlay containers responsive with the same origin and dimensions (siblings are supported). Remove application resize handlers that stop/restart the engine or manually gate the source/renderer. Backgrounding, permission failure, ended track, stop and disposal retain their established lifecycle behavior; valid stream reuse is limited to ordinary viewport transitions. These rules do not make a rejected browser playback permission succeed: existing native-first muted playback and bounded iOS WeChat recovery remain unchanged, and a final rejection is reported.

The optional `viewportStabilization` object accepts `stableFrames`, `quietMs`, and `orientationIntrinsicWaitMs`; defaults are 2, 100 and 400. Values must be finite nonnegative milliseconds and a positive integer frame count. `viewportStabilization:false` disables the default gate and preserves explicit CSS geometry management for integrations that need it. The initial camera setup still uses normal start/permission APIs. Custom FrameSources without the optional transition hook keep their existing behavior. No application-specific test controls or UI buttons are added to the engine.
