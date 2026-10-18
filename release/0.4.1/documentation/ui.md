# @livemira/ui — camera UI

[English](ui.md) | [简体中文](ui.zh-CN.md)

A full-screen AR camera for the engine in one call: photos become targets in the browser, a video is downloaded once
its photo is recognized, and a default view shows the status, notices and controls in Simplified Chinese or English,
with warm dark controls, a black transition cover, and configurable theme variables.
The engine itself draws the camera, masks rotation, reveals the video and ends its session when the page is hidden;
this package follows its events. It contains no engine code: the page passes the engine module in.

**Compatibility limits:** Physical-device compatibility has not been established. Validate camera, playback and orientation behavior on the devices and browsers your application supports.

## Use

```js
import { mountArCamera } from './livemira-ui.min.mjs';

const camera = mountArCamera(document.body, {
  loadEngine: () => import('./livemira-engine.min.mjs'),
  targets: [{ id: 'poster-1', photo: './poster-1.jpg', video: './poster-1.mp4' }],
  locale: 'en',
  onExit: () => camera.destroy(),
});
```

The camera starts as soon as its stage has a size. `destroy()` removes the view, then stops and disposes the engine,
camera, Worker and videos; calls share one promise.

## Targets

| Field    | Meaning                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------- |
| `id`     | Stable id, also the engine's target id: 1..128 characters from A–Z, a–z, 0–9, `_`, `.`, `-`.         |
| `photo`  | A `Blob`, or a URL downloaded through `loadMedia`; compiled with the engine's `compileTargetImage`.  |
| `target` | Instead of `photo`: an already compiled target (`parseTarget`); its `targetId` must equal `id`.      |
| `video`  | A URL (downloaded through `loadMedia` once the photo is recognized) or a `Blob` given to the engine. |

1 to 10 targets with unique ids. A photo that cannot become a target is skipped and counted (`skippedCount`); it
never moves another photo's video. One video is bound at a time: recognizing another photo cancels the previous
download and releases the previous video.

## Options

| Option                | Default                 | Meaning                                                                                                |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `loadEngine`          | required                | Returns the engine module (or a promise of it); called at the first start.                             |
| `targets`             | required                | See above. `session.setTargets()` changes the targets of the next start.                               |
| `loadMedia`           | `fetch`, no credentials | `(url, { signal, kind: 'photo' \| 'video', targetId }) => Promise<Blob>`: authentication belongs here. |
| `classifyError`       | built-in notices        | `(cause, { phase, targetId }) => { notice?, shouldStop?, isStale? }` (see below).                      |
| `observe`             | none                    | Numbers and codes of the run (lifecycle, targets, raw engine events, sound); never a URL.              |
| `engineOptions`       | engine defaults         | Every `createEngine` option except `container` (camera, tracking, presentation, extensions, …).        |
| `video`               | loop, `contain`         | `{ isLooping, fit }` for every video. Videos start muted.                                              |
| `photoMaxEdgePx`      | 640                     | Long edge photos are scaled to before compiling.                                                       |
| `locale`              | `'zh-CN'`               | `'zh-CN'` or `'en'` (`en-*` → `en`, anything else → `zh-CN`).                                          |
| `messages`            | none                    | Per locale, own or replaced messages: `{ en: { 'host.expired': '…' } }`.                               |
| `translate`           | none                    | `(key, params, locale) => string \| undefined`; a string wins.                                         |
| `onExit`              | none                    | The exit control (top left) calls it; without it and `exitHref` there is no exit control.              |
| `exitHref`            | none                    | Renders the exit control as a link.                                                                    |
| `isStoppedWhenHidden` | true                    | End the run with a notice when the page is hidden or left.                                             |
| `isAutoStart`         | true                    | false: call `view.start()` yourself, best from a tap.                                                  |
| `mode`                | `'fullscreen'`          | Fixed to the viewport with the page scroll locked; `'embedded'` fills the container you size.          |
| `theme`               | none                    | CSS variables on `.lm-ar`: `{ accent: '#c0674a' }` sets `--lm-ar-accent`.                              |

Errors are classified by phase: `engine-load`, `photo-load`, `photo-compile`, `start` always end the run (the host may
change the notice and mark it stale, e.g. expired links); `video-load` keeps the camera running and offers "Reload
video" unless the host returns `shouldStop: true`.

## Session and view separately

```js
import { createArSession, mountArView } from './livemira-ui.min.mjs';

const session = createArSession({ loadEngine, targets });
session.subscribe(() => render(session.getState()));
const view = mountArView(container, session, { locale: 'zh-CN' }); // or draw your own from the state
await session.stop({ notice: { key: 'host.unauthorized' }, isStale: true }); // the host ends a run
await session.dispose();
```

`state`: `phase` (`idle | preparing | starting | scanning | stopping`), `view` (`searching | loading | playing | lost
| videoError`), `progress`, `notice` (`{ key, params?, text? }`), `isMuted`, `isAdjusting` (a view change is being
settled), `isPlaybackBlocked`, `isStale`, `skippedCount`, `activeTargetId`, `isDisposed`. Listeners are called when a
field changes, never per frame. `view` is `playing` only after the engine reports real playback; a media failure stays
`videoError` until the video is reloaded.

Call `session.setMuted()` and `session.retryVideo()` from a tap: the engine must see the gesture. A refused unmute
while a video plays goes back to muted and says so. `start()` never rejects: the state says what happened.

## Migrating from `@web-ar/ui` 0.1

| 0.1                                                     | `@livemira/ui`                                            |
| ------------------------------------------------------- | --------------------------------------------------------- |
| `engine` / `loadEngine` (the 0.2.1 engine)              | `loadEngine` (the 0.3 engine module)                      |
| `{ id, photo, videoUrl, bundle }`                       | `{ id, photo \| target, video }`                          |
| `config` (camera, worker, grace, long edge, fit)        | `engineOptions` (engine defaults: `cover`, 200 ms grace)  |
| `stop(reason, notice)`                                  | `stop({ reason, notice, isStale })`                       |
| `classifyError → { stop, stale, notice }`               | `{ shouldStop, isStale, notice }`                         |
| `state.muted`, `stale`, `skipped`, `viewportTransition` | `isMuted`, `isStale`, `skippedCount`, `isAdjusting`       |
| `.wa-ar` classes and `--wa-ar-*` variables              | `.lm-ar` and `--lm-ar-*`; same layout, colors and wording |
| `show`, `icons`, `className`, `injectStyles`            | not offered                                               |

The view keeps the 0.1 layout: exit top left, sound top right while scanning, the status line and notices below them,
a black cover with "Adjusting the view…" while a view change settles, and "Start again" / "Reload video" at the
bottom only when needed. A blocked autoplay is only a notice; a tap on the sound control resumes playback. A hidden
or left page ends the run with a notice (`isStoppedWhenHidden: false` to keep it running).

0.1 defaulted to a `contain` camera and a 500 ms loss grace; the engine defaults (`cover`, 200 ms) are what was
tested on phones. Pass `engineOptions: { camera: { fit: 'contain' } }` to keep the old framing.

## License

Apache-2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
