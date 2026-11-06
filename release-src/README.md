# @livemira/engine — integration guide

[English](README.md) | [简体中文](README.zh-CN.md)

LiveMira recognises prepared pictures ("targets") in the live camera picture, tracks them and plays a video on them.
Recognition and tracking run in Web Workers, entirely on the device.

**Status:** 0.6.0, a stable release, built on 0.5.1 (see the [changelog](CHANGELOG.md)). The engine is the
next-generation engine of 0.5: its recognition, tracking and composition are new, and so is its API. The camera UI
`@livemira/ui` keeps the 0.4.1 API (see the [upgrade notes](documentation/migration-0.4-to-0.5.zh-CN.md)). 0.6.0 adds
suspending a run for a hidden page, per-run retained videos with exclusive playback, and a permission wait that shows
no made-up percentage.

- The engine core was tested on phones: iPhone (iOS 27; Safari, Chrome, WeChat), POCO F4, Samsung A26 and a low-end
  Android 10 phone; 10 minutes without throttling, static jitter 0.005 px (0.5.0 measurements; the recognition and
  tracking algorithms are unchanged since).
- The product layer (video planes, loading region, reveal, streamed videos, camera UI) passed end-to-end tests in
  desktop Chromium and WebKit with a synthetic camera. The 0.6.0 changes (suspend and resume, retained videos, the
  permission-wait view) were exercised with a synthetic camera; the publisher confirmed the improved overall experience on a phone.
- On npm: `npm install @livemira/engine @livemira/ui @livemira/target-rating`. The release also holds the same packages
  as offline tarballs.

## Files

| File                                            | Purpose                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `files/livemira-engine.min.mjs`                 | The engine as one ES module, Worker and WebAssembly embedded. Recommended.             |
| `files/livemira-engine.mjs`                     | The same engine, readable.                                                             |
| `files/livemira-engine-worker.min.js`           | The engine's Worker script (classic), for pages whose CSP forbids `blob:`.             |
| `files/livemira-engine.d.ts`                    | Declarations.                                                                          |
| `files/livemira-ui.min.mjs`, `livemira-ui.d.ts` | The camera UI ([guide](documentation/ui.md)); no engine code inside.                   |
| `files/livemira-target-rating.min.mjs` etc.     | Target rating ([guide](documentation/target-rating.md)); needs no engine.              |
| `npm/*.tgz`                                     | Offline tarballs of the three packages (all three are also on npm).                    |
| `demo/`                                         | Full-screen demo with two sample photos and videos; open `demo/index.html` over HTTPS. |

Importing the engine creates nothing: no Worker, camera or request exists before a call. It imports in Node too.

## Quick start

```html
<div id="stage" style="position: fixed; inset: 0"></div>
<button id="start">Start</button>
<script type="module">
  import { compileTargetImage, createEngine } from './livemira-engine.min.mjs';

  const engine = createEngine({ container: document.getElementById('stage') });
  const photo = await (await fetch('./poster.jpg')).blob();
  await engine.setTargets([await compileTargetImage(photo, { targetId: 'poster' })]);
  engine.on('targetFound', ({ targetId }) => {
    // Requested only now and played by the browser while it downloads; a loading region in the video's shape meanwhile.
    engine.setTargetMedia(targetId, { url: './poster.mp4' });
  });
  document.getElementById('start').onclick = () => engine.start(); // from a tap
</script>
```

## Profiles

`profile: 'swift'` (default, balanced), `'hawk'` (keenest tracking, most power), `'wren'` (widest reach, least
demanding). A device that cannot run the chosen profile falls back along Hawk → Swift → Wren; Hawk steps down to Swift
while running when the Worker averages more than 22 ms per frame. Every profile needs WebGL2 and `VideoFrame`; without
them `start()` rejects with `UNSUPPORTED_DEVICE` and nothing is recognised. `probeDevice()` tells without a camera.

## API summary

- `compileTargetImage(blob, { targetId, maxEdgePx = 640 })` → `TargetBundle` (store `bytes`); `parseTarget(bytes)`.
- `createEngine({ container, profile, camera: { facingMode, deviceId, fit, processingScale }, tracking: { lossGraceMs },
presentation: { revealMs, resumeRevealMs, veilOpacity, accent } | false, workerUrl })`.
- `engine.setTargets(bundles)` (any state; loaded in the background while running), `setTargetMedia(id, { file | url,
isLooping, fit, crossOrigin } | null)`, `setTargetProgress(id, 0..1 | NaN | null)`, `start()`, `stop(reason)`,
  `dispose()`, `on(type, listener)`, `media.setMuted(isMuted)`, `media.retry()`.
- Hidden page: `suspend()`, `resume()`, `isSuspended`. Suspending pauses every video (no sound), idles recognition and
  drawing and switches the camera track off (`enabled = false`); the camera, the targets and the loaded videos stay,
  and targets in view are reported lost with `reason: 'suspended'`. It switches the track off, it does not close the
  camera: `stop()` releases it.
- Exclusive playback: `media.selectTarget(targetId | null)`. Until it is first called every target in view plays its
  video; after it only the selected one's video plays or is drawn, and `setMuted` and `retry` act on it.
- Events: `state`, `ready`, `targetsReady`, `targetFound`, `targetLost` (`reason`: `out-of-view`, `viewport`,
  `suspended`, `stopped`), `viewport`, `media`, `playbackBlocked`, `profileChange`, `ended`, `error`.
- `EngineError.code`: `INVALID_CONFIG`, `INVALID_TARGET`, `UNSUITABLE_TARGET`, `DECODE_FAILED`, `UNSUPPORTED_DEVICE`,
  `CAMERA_PERMISSION_DENIED`, `CAMERA_UNAVAILABLE`, `CAMERA_START_FAILED`, `CAMERA_ENDED`, `WORKER_FAILED`,
  `MEDIA_FAILED`, `ABORTED`, `DISPOSED`.

Target rating is not in the engine: a page that only chooses pictures (a work editor, say) need not load the engine.
The separate module `files/livemira-target-rating.min.mjs` (npm: `@livemira/target-rating`) compiles a picture as the
engine would, in its own Worker, and rates it; see the [target rating guide](documentation/target-rating.md).

The Chinese guide has the full tables. Everything drawn on a photo (recognition glow; while the video is on its way, a
see-through dark region in the video's shape with a spinner or progress ring; the centre-out reveal of that region
with its wavefront once the video can play; the spinner again when playback runs short of data) is drawn in the
frame-locked WebGL2 canvas with the same frame's pose, perspective-correct and anti-aliased; with reduced motion the
reveal is a 0.2 s fade.

## CSP

Allow `worker-src blob:` (or serve `livemira-engine-worker.min.js` and pass `workerUrl`) and `script-src
'wasm-unsafe-eval'`. Videos given by `url` are played while they download: the server must answer range requests
(web servers and CDNs do by default), and another origin must allow CORS. Video behind header authentication is
downloaded by the page and given as `file`.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
