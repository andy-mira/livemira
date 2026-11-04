# @livemira/ui — camera UI

[English](ui.md) | [简体中文](ui.zh-CN.md)

The full-screen AR camera in one call: photos are compiled in the browser while the camera opens, a video is
requested only once its photo is recognised and played while it downloads, and one video is bound at a time. The default view shows status,
notices and controls in Simplified Chinese or English, with the layout, colours and wording of the LiveMorae camera.
There is no engine code inside: the page hands the engine module in through `loadEngine`.

**Status:** 0.5.0. The API is that of 0.4.1; the implementation is new. Passed end-to-end tests with the real engine
and a synthetic camera in desktop Chromium and WebKit, and was accepted on phones inside LiveMorae.

```js
import { mountArCamera } from './livemira-ui.min.mjs';

const camera = mountArCamera(document.body, {
  loadEngine: () => import('./livemira-engine.min.mjs'),
  targets: [{ id: 'poster-1', photo: './poster-1.jpg', video: './poster-1.mp4' }],
  locale: 'en',
  onExit: () => camera.destroy(),
});
```

## What is new compared with 0.4.1

- Photos compile while the camera opens (the permission prompt comes earlier, the wait is shorter).
- A loader card with real progress (engine, photos, camera), translucent once the camera picture is there.
- A scanning guide (breathing corners and a soft sweep) while nothing is recognised.
- Videos stream: a video URL goes to the browser's player, which starts as soon as enough has arrived
  (`video.isStreamed`, default true; false, or a custom `loadMedia`, downloads the whole file first).
- On the photo, drawn frame-locked in WebGL2: a recognition glow; right on recognition, a see-through dark region in
  the video's shape with a spinner (a progress ring when a download reports progress); the centre-out reveal of that
  region with a light wavefront once the video can play; the spinner again when playback runs short of data; a play
  mark when playback needs a tap. Perspective-correct and drift-free.
- A short vibration on recognition where supported (`isHapticEnabled`, default true).
- Devices without WebGL2 get "WebGL2 is required" and no pointless "Start again".

## Options

As in 0.4.1: `loadEngine`, `targets` (`{ id, photo | target, video }`; `target` may be a bundle or its bytes),
`loadMedia` (now also given `onProgress`), `classifyError`, `observe`, `engineOptions` (`profile`, `camera`, `tracking`,
`presentation`, `workerUrl`), `video` (new: `isStreamed`), `photoMaxEdgePx`, `locale`, `messages`, `translate`, `onExit`, `exitHref`,
`isStoppedWhenHidden`, `isAutoStart`, `mode`, `theme`; new: `isHapticEnabled`.

State as in 0.4.1, plus `readiness` (0..1 while preparing), `isCameraOn` and `videoProgress`. New message keys:
`loader.engine`, `loader.photos`, `loader.camera`, `loader.hint`, `status.loadingProgress`, `status.blocked`,
`notice.cameraUnavailable`, `notice.unsupported`, `notice.insecure`.

## License

Apache-2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
