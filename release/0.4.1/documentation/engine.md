# @livemira/engine — integration guide

[English](engine.md) | [简体中文](engine.zh-CN.md)

LiveMira recognizes a prepared picture (a "target") in the live camera image, tracks it and plays a video on it.
Recognition and tracking run in a Web Worker; everything runs on the device.

**Status:** 0.4.1. Image-target recognition, tracking, video overlays, and an optional camera UI run in the browser. Camera access requires a secure context and user permission.

**Compatibility limits:** The camera UI has not completed physical-device acceptance. Android and in-app browsers remain unverified. Desktop browser results do not establish compatibility or performance on every device.

## Files

`npm run build` writes to `dist/`:

| File                                           | Use                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| `livemira-engine.min.mjs`                      | The engine in one ES module, with its Worker and WebAssembly embedded. Use this one. |
| `livemira-engine.mjs`                          | The same engine, readable.                                                           |
| `livemira-engine-worker.min.mjs`               | The Worker as a file, for pages whose CSP forbids `blob:` Workers (see below).       |
| `livemira-tracking-visuals.min.mjs` and others | Optional extensions, each its own module ([below](#extensions)).                     |

Importing the engine creates nothing: no Worker, camera or request starts before you call it.

## Quick start

Serve the page over HTTPS (or `localhost`): the camera needs a secure context.

```html
<div id="stage" style="position: fixed; inset: 0"></div>
<button id="start">Start</button>
<script type="module">
  import { createEngine, parseTarget } from './livemira-engine.min.mjs';

  const engine = createEngine({ container: document.getElementById('stage') });
  const target = await parseTarget(await (await fetch('./poster.target.json')).text());
  await engine.setTargets([{ target, media: { url: './poster.mp4' } }]);

  engine.on('targetFound', (event) => console.log('found', event.targetId));
  engine.on('playbackBlocked', () => showRetryButton()); // call engine.media.retry() from a tap
  engine.on('sessionEnded', (event) => console.log('ended', event.reason));

  // Start from a user gesture so the camera prompt and the video can play.
  document.getElementById('start').onclick = () => engine.start();
</script>
```

The container must be positioned and have a size. The engine adds three equal layers inside it — the camera
picture, the video plane and extension drawings — that let pointer events through. Rotation, address-bar and
container size changes are handled inside: the camera region is masked until the new view has settled, and no frame
from before the change is shown or recognized.

## Targets

| Function                                             | Purpose                                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `compileTargetImage(file, { targetId, maxEdgePx? })` | Decodes and compiles an image file in a short-lived Worker (never on the page thread). |
| `compileGrayTarget(gray, { targetId })`              | Compiles a gray8 image `{ widthPx, heightPx, data }`.                                  |
| `serializeTarget(target)` / `parseTarget(text)`      | Store and load a compiled target (format v1, checked with SHA-256).                    |

1 to 10 targets per engine, with unique `targetId`s. Targets compiled by 0.2.x with the ANMS algorithm
(`m0-harris-anms-brief256-v1`) load unchanged, and 0.3.0 compiles the same bytes from the same picture; targets of the
greedy (`m0-harris-brief256-v1`) or oriented v2 algorithms must be recompiled (`INVALID_TARGET`).

## `createEngine(options)`

| Option                                  | Default         | Meaning                                                                                                                                                        |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container`                             | required        | The positioned element the engine draws in.                                                                                                                    |
| `camera.facingMode`                     | `'environment'` | Or `'user'`; ignored when `deviceId` is set.                                                                                                                   |
| `camera.deviceId`                       | —               | A device from `engine.camera.list()`.                                                                                                                          |
| `camera.idealWidthPx` / `idealHeightPx` | 1280 / 720      | Requested capture size.                                                                                                                                        |
| `camera.processingLongEdge`             | 640             | 480, 640, 960 or `'native'`: the long edge of the image recognition works on.                                                                                  |
| `camera.fit`                            | `'cover'`       | How the camera picture fills the container (`'contain'` shows all of it).                                                                                      |
| `camera.capture`                        | `'canvas'`      | `'canvas'`: canvas readback of the processing image; `'auto'`: native frames (VideoFrame, ImageBitmap) with canvas readback as the last resort.                |
| `camera.timestamps`                     | `'callback'`    | `'callback'`: frame time from the frame callback; `'media-time'`: the video's media clock.                                                                     |
| `tracking.maxPredictionMs`              | 100             | 0..100: how long a prediction may be shown after the last measurement.                                                                                         |
| `tracking.lossDisplayGraceMs`           | 200             | 0..1000: keep the last pose and the video at most this long after a loss (visual only); a target that was moving fast is hidden at once.                       |
| `presentation`                          | on              | Loading mask and circular reveal on the video plane: `{ revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 }`; `false` lets the video simply appear. |
| `adapters`                              | defaults        | Replace environment adapters: `previewSurface`, `snapshot`, `playbackRecoveries`, `workerFactory`.                                                             |
| `extensions`                            | none            | Optional extensions (below).                                                                                                                                   |
| `diagnostics`                           | none            | A `DiagnosticLog` (below).                                                                                                                                     |

Invalid options throw `EngineError('INVALID_CONFIG')`.

With `timestamps: 'media-time'`,
when a browser never advances the media time of a camera stream (seen in WebKit), the camera switches to callback
timestamps by itself after three new pictures with the same media time, and the session snapshot's `timestampSource`
becomes `'callback'`.

## `Engine`

| Member                                       | Meaning                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `state`                                      | `'idle'`, `'starting'`, `'running'`, `'stopping'` or `'disposed'`.                                     |
| `setTargets(entries)`                        | Replaces all targets and their media; only while idle. Each entry is `{ target, media? }`.             |
| `setTargetMedia(targetId, media \| null)`    | Sets, replaces or clears one target's video; allowed while running.                                    |
| `start()` / `stop(reason?)` / `dispose()`    | Lifecycle; operations run one after another.                                                           |
| `on(type, listener)`                         | Subscribes to an event; returns the unsubscribe function. A failing listener never affects the engine. |
| `media.setMuted(isMuted)`                    | From a tap: turns the sound on or off.                                                                 |
| `media.retry()`                              | From a tap after `playbackBlocked` or a media error.                                                   |
| `camera.list()` / `camera.configure(change)` | Lists cameras; changes facing mode, device, processing long edge or fit while idle.                    |
| `getEventContext()` / `getDiagnostics()`     | The current event clock; a diagnostic snapshot.                                                        |

A target's media is `{ url }` or `{ file }` plus: `isMuted` (default true), `isLooping` (default true), `fit`
(`'contain'`), `onLost` (`'pause-and-hide'` or `'hide'`), `onResume` (`'resume'` or `'restart'`), `crossOrigin`
(`'anonymous'`) and `playbackRecovery` (`'auto'` or `'off'`). Browsers allow sound only after a tap: videos start
muted; call `engine.media.setMuted(false)` from a button.

## Events

Every event carries `sessionId`, `targetId`, `timestampUs` and `timestampDomain` (the camera session clock once known).

| Event                                   | Payload                                                                                              |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `attemptStart`, `ready`                 | —                                                                                                    |
| `sessionConfig`, `sessionConfigUpdated` | `config`: targets, media identities (hashes, never URLs), policy, camera facts                       |
| `stageTiming`                           | `stage`, `status`, `durationUs`, `attemptTimeUs`                                                     |
| `sessionStartFailed`                    | `code`, `attemptTimeUs`                                                                              |
| `sessionEnded`                          | `reason` (`'stopped'`, `'camera-error'`, `'camera-suspended'`, `'worker-failure'`, …)                |
| `cameraPermission`                      | `phase`, `permission`                                                                                |
| `cameraStatus`                          | `code`, `detail`: the camera stopped (it then ends the session)                                      |
| `cameraSize`                            | `widthPx`, `heightPx`: announced while the picture is still hidden, so the page can adapt its layout |
| `pageVisibility`                        | `visibility`                                                                                         |
| `viewportTransition`                    | `phase` (`'begin'`/`'end'`), `epoch`, `reason` (the raw trigger), `sizes`                            |
| `capabilityChanged`                     | `capability`: engine build, preview surface, frame detection, matching operator and fallback         |
| `targetFound`, `targetUpdated`          | `result`                                                                                             |
| `targetLost`                            | `reason`, `lossContext` (where the target was, in camera pixels)                                     |
| `mediaState`                            | `state`, `media` (numbers and states, including loading and reveal progress)                         |
| `playbackBlocked`                       | — (retry with `engine.media.retry()` from a tap)                                                     |
| `error`                                 | `error`: an `EngineError`                                                                            |

A viewport transition begin hides the overlay at once, without the loss display grace, and reports the target as
lost (`targetLost` with reason `'viewport-transition'`).

## Errors

`EngineError` has a `code`, an `isRecoverable` flag and a `message`. Codes: `INVALID_CONFIG`, `INVALID_TARGET`,
`DISPOSED`, `ABORTED`, `START_FAILED`, `FRAME_FAILED`, `RESOURCE_FAILED`, `UNSUPPORTED`, `CAMERA_UNAVAILABLE`,
`CAMERA_PERMISSION_DENIED`, `CAMERA_START_FAILED`, `CAMERA_TRACK_ENDED`, `CAMERA_FRAME_STALLED`,
`CAMERA_CAPTURE_FAILED`, `CAMERA_CLOCK_RESET`, `CAMERA_SUSPENDED`, `MEDIA_FAILED`, `PLAYBACK_BLOCKED`. Branch on
`code`, never on the message. Extensions are separate modules with their own copy of the class; check `code` (or
`name === 'EngineError'`) rather than `instanceof` for their errors.

## Diagnostics

```js
import { DiagnosticLog } from './livemira-engine.min.mjs';
const log = new DiagnosticLog({ level: 'key' }); // or 'full'
const engine = createEngine({ container, diagnostics: log });
log.setLevel('full'); // applies at the next start
const file = JSON.stringify(log.export()); // the user saves it; nothing is uploaded
```

The key log (session, errors, permission, page visibility, transitions, recognition, media states, capability) is
meant to stay on. The full log adds per-frame scheduling records, results (without matched points) and Worker
timings. Records are numbers and closed enums only: no pictures, URLs or matched point coordinates. Storage is
bounded (10 000 records per kind by default); an export says whether anything was dropped.

## Extensions

| Module                                                                     | Purpose                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`livemira-tracking-visuals`](tracking-visuals.md)               | Draws the recognized boundary and the current matched points.                              |
| [`livemira-recognition-diagnostics`](recognition-diagnostics.md) | Bounded counters of why targets were rejected and where matched points lie.                |
| [`livemira-target-quality`](target-quality.md)                   | Scores how suitable a picture is as a target (not an engine extension; a standalone tool). |

```js
import { createTrackingVisuals } from './livemira-tracking-visuals.min.mjs';
const engine = createEngine({
  container,
  extensions: [createTrackingVisuals({ boundary: true, points: true })],
});
```

What an extension needs from the Worker (matched points, recognition traces) is fixed when the engine is created.

## Content security policy

- The single-file engine starts its Worker from a `blob:` URL: allow `worker-src blob:`. Otherwise serve
  `livemira-engine-worker.min.mjs` and pass `adapters: { workerFactory: () => new Worker(url, { type: 'module' }) }`.
- The exact matcher compiles WebAssembly: allow `'wasm-unsafe-eval'` in `script-src`. Without it the engine falls back
  to the JavaScript matcher with identical results and reports it in `capabilityChanged`.
- Media from another origin needs CORS (`crossOrigin: 'anonymous'` by default).

## Browser requirements

A secure context, `getUserMedia`, module Workers, `OffscreenCanvas` with a 2D context in Workers, and frame-callback
or playback-quality APIs on `<video>`. WebAssembly SIMD is used when available. In iOS WeChat a blocked video is
retried once through the WeChat bridge (`playbackRecovery: 'auto'`).

## Known issues

- At the start of a rotation the video plane may stay on top of the mask for about one more frame.
- Matching can be lost during fast motion.
- Tracking is weakest when the target appears at about 0.7 times its compiled size (between two pyramid levels): it
  is still recognized, but with fewer matches and more jitter.

## License

Apache-2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
