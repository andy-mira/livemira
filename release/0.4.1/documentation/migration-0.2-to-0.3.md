# Migrating from 0.2.x to 0.3.0

[English](migration-0.2-to-0.3.md) | [简体中文](migration-0.2-to-0.3.zh-CN.md)

0.3.0 keeps the algorithms, the target format and the behavior of 0.2.x, apart from the few behavior changes listed
below. What changes is how the engine is assembled and named: one `createEngine` call replaces the hand-built camera,
Worker pipeline and renderer, and names follow one convention. Only the default capabilities of 0.2.x were carried
over.

## Assembly

| 0.2.x                                                                                                                                | 0.3.0                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new CameraFrameSource({ previewContainer, camera, geometry, onEvent })`                                                             | `createEngine({ container, camera: { … } })`; camera events become `cameraPermission`, `cameraStatus` and `cameraSize`                              |
| `createWorkerPipeline({ options, prepareFrame, onCapability, onTiming, onFailure })`                                                 | Assembled inside; capability in `capabilityChanged`, timings in the diagnostic log, a Worker failure is an `error` and ends the session             |
| `new CssVideoRenderSink({ geometryForResult, presentation })`                                                                        | `createEngine({ presentation })`; each result is drawn with the geometry of its own frame                                                           |
| `getFrameGeometry`, `prepareWorkerFrame`, your geometry `Map`                                                                        | Removed: not needed any more                                                                                                                        |
| Two stacked elements (`#preview`, `#overlay`)                                                                                        | One positioned container; the engine adds its layers                                                                                                |
| `engine.loadTargets(targets)` + `engine.setTargetMedia(id, media)`                                                                   | `engine.setTargets([{ target, media }])`; `engine.setTargetMedia(id, media \| null)`                                                                |
| `renderer.setTargetMediaFile(id, file, config)`                                                                                      | `media: { file, … }`                                                                                                                                |
| `renderer.setMutedFromGesture(m)`, `retryActiveMediaFromGesture()`, `event.retry()`                                                  | `engine.media.setMuted(m)`, `engine.media.retry()`                                                                                                  |
| `source.updateGeometry({ longEdge })`, `source.configureCamera({ deviceId })`                                                        | `engine.camera.configure({ processingLongEdge, deviceId })` while idle                                                                              |
| `engine.setTrackingMode`, `trackingMode`, `backendPreference`, `cpuMatching`, `cpuFeatures`, `legacyScaleSearch`, `algorithmVersion` | Removed: only the default combination exists (absolute tracking, CPU recognition, exact WebAssembly matching with JavaScript fallback, scale retry) |
| `collectMatchedPoints`, `observeRecognition`                                                                                         | Decided by the extensions you pass (`needs`)                                                                                                        |
| `new Engine(config)`, the exported `Engine` class                                                                                    | `createEngine(options)`; the returned object is typed `Engine` (an interface, no longer a class)                                                    |
| `createEmbeddedWorkerFactory(source)`                                                                                                | Built in: the embedded Worker is the default; pass `adapters: { workerFactory }` to use the Worker file                                             |
| `getSessionContext()`, `refreshSessionConfig()`                                                                                      | `engine.getEventContext()`; session configuration is refreshed by the engine                                                                        |

When the camera fails or the page is hidden, the engine now ends the session itself (`sessionEnded` with
`'camera-error'` or `'camera-suspended'`); 0.2.x stayed "running" until the page called `stop`.

## Targets

Targets compiled with the ANMS algorithm (`m0-harris-anms-brief256-v1`) load unchanged, and the same picture compiles
to the same bytes. Targets of the greedy (`m0-harris-brief256-v1`) or oriented v2 algorithms are rejected with
`INVALID_TARGET`: compile them again. `compileTargetImage(file, { targetId })` compiles an image file in a Worker.
`ALGORITHM_VERSION`, `ANMS_ALGORITHM_VERSION`, `ORIENTED_ALGORITHM_VERSION` and `SUPPORTED_ALGORITHM_VERSIONS` are no
longer exported. Gray images are `{ widthPx, heightPx, data }`.

## Names

| 0.2.x                                                                                                                                              | 0.3.0                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `EngineError(code, recoverable, reason)`, `.recoverable`, `.reason`                                                                                | `.isRecoverable`, `.message`                                                                                       |
| `MediaConfig.muted`, `loop`, `lostBehavior`, `resumeBehavior`, `wechatPlaybackRecovery`                                                            | `isMuted`, `isLooping`, `onLost`, `onResume`, `playbackRecovery` (same values)                                     |
| `result.predictionAgeUs`, `lastReliableObservationTimeUs`, `predictionExpiresAtUs`                                                                 | `result.prediction.ageUs`, `.lastMeasuredTimeUs`, `.expiresAtUs`                                                   |
| `result.quality.measured`, `.degenerate`                                                                                                           | `.isMeasured`, `.isDegenerate`                                                                                     |
| `result.absoluteCorrectionAgeUs`, `T_cameraFromTarget`, `poseMetricValid`, `matchedPoints.origin`                                                  | Removed (always equal to other fields or constant in 0.2.x defaults)                                               |
| Camera options `width`, `height`, `snapshotPreference: 'cpu'`, `timestampPreference: 'media'`                                                      | `idealWidthPx`, `idealHeightPx`, `capture: 'canvas'`, `timestamps: 'media-time'`                                   |
| `mediaState.media.paused`, `loop`, `ended`, `wechatRecoveryAttempts`, `presentation.reducedMotion`                                                 | `isPaused`, `isLooping`, `isEnded`, `recoveryAttempts`, `presentation.isReducedMotion`                             |
| `targetLost.lossContext` frames: `measured`, `inputWidth`, `inputHeight`, `fullyInsideInput`, `sourceObservationId`, `precedingInputFrameRecorded` | `isMeasured`, `inputWidthPx`, `inputHeightPx`, `isFullyInsideInput`, `pictureKey`, `isPrecedingInputFrameRecorded` |

## Events and errors

- `capabilityChanged` carries `capability` (engine build, preview surface, frame detection, matching operator and
  fallback) instead of `backend` and `reason`.
- `playbackBlocked` no longer carries a `retry` function: call `engine.media.retry()` from a tap.
- New events: `cameraPermission`, `cameraStatus`, `cameraSize`, `pageVisibility`, `viewportTransition` (with the raw
  trigger, never merged).
- Media failures are reported with the code `MEDIA_FAILED` (0.2.x: `RESOURCE_FAILED`); its message is the reason, for
  example `media-decode-error` or `media-loading-timeout`.
- Camera failures are `EngineError`s with `CAMERA_*` codes; `cameraStatus.detail` keeps the original reason
  (`TRACK_ENDED`, `NO_VIDEO_CALLBACK`, …).

## Diagnostics

`DiagnosticRecorder` is replaced by `DiagnosticLog({ level: 'key' | 'full' })`, passed as
`createEngine({ diagnostics })`; nothing has to be forwarded by hand any more. The export format is
`livemira-diagnostics/2`: candidate and test-flow fields are gone, events keep allowlisted fields only, and the key
level records no per-frame data. Old analysis scripts need adjusting.

## Extensions

| 0.2.x                                                                                     | 0.3.0                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new TrackingVisualRenderSink({ base, geometryForResult, boundary, points })`             | `createEngine({ extensions: [createTrackingVisuals({ boundary, points })] })`                                                                                                   |
| `createRecognitionDiagnostics()` + forwarding `onRecognitionTrace` and `onResult`         | `extensions: [createRecognitionDiagnostics()]`; snapshot schema `livemira-recognition-diagnostics/2` (`isDisposed`; per-target `originalTarget`/`previousFrame` counts removed) |
| target-quality scorer 1.0.0, greedy algorithm option, `scorerVersion`, `algorithmVersion` | Scorer 2.0.0 and the ANMS algorithm only; result schema `livemira-target-quality/3` (`shouldReplace`, sizes in `…Px`); errors are `EngineError`s                                |

Extensions are separate modules. Their errors are `EngineError`s from their own copy of the class: compare `code`,
not `instanceof`.

## Behavior changes

- The camera defaults are `capture: 'canvas'` and `timestamps: 'callback'` (0.2.x: native frames and the media time).
  Pass `camera: { capture: 'auto', timestamps: 'media-time' }` for the 0.2.x defaults.
- The default loss display grace is 200 ms (0.2.x: 0): after a loss the overlay keeps its last pose for up to 200 ms,
  which hides the brief losses right after a target is found. Pass `tracking: { lossDisplayGraceMs: 0 }` for the
  0.2.x behavior.
- After a loss, a target that was moving fast is hidden at once, and a slow one is held only as long as it could not
  have moved far; the grace is the longest hold. An overlay hidden while its target was still tracked comes back only
  after the target is confirmed again (three fresh measurements in a row).
- A camera whose media time does not advance switches to callback timestamps within the same run instead of stalling.

## Files

| 0.2.x                                          | 0.3.0                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `core/lm-engine.min.mjs`, `core/lm-engine.mjs` | `livemira-engine.min.mjs`, `livemira-engine.mjs`                                                                   |
| `tools/*/lm-*.mjs`                             | `livemira-tracking-visuals.min.mjs`, `livemira-recognition-diagnostics.min.mjs`, `livemira-target-quality.min.mjs` |
| `./development/*` entries                      | Removed                                                                                                            |
| —                                              | `livemira-engine-worker.min.mjs`, for pages whose CSP forbids `blob:` Workers                                      |
