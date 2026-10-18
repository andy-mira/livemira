# Changelog

All notable changes are listed here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [Semantic Versioning](https://semver.org/).

## [0.4.1] — 2026-10-18

The engine API and runtime behavior are unchanged in this release.

### Changed

- The camera UI's default view uses warm dark controls, terracotta buttons, and bilingual messages: a black
  cover with "Adjusting the view…" while a view change settles, "Start again" only after a run stopped with a notice,
  and no "Play video" button (a blocked autoplay is a notice; a tap on the sound control resumes playback). A start
  that fails for another reason than the camera permission says the camera or the recognition could not start; an
  empty video file is reported as such.

### Fixed

- The camera UI ends the run with a notice when the page is left (`pagehide`) without being hidden first, which the
  engine alone does not detect.

## [0.4.0] — 2026-10-17

This release adds the optional camera UI.

### Added

- `@livemira/ui` (`livemira-ui.min.mjs`): an optional full-screen AR camera on the public engine API. Photos are
  compiled in the browser, a video is downloaded only once its photo is recognized, and a default view shows the
  status, notices and controls (exit, sound, start again, reload video, play video) in Simplified Chinese or English.
  It also offers the headless session and the view separately, and hooks for media loading, error meaning and
  observations. It replaces `@web-ar/ui` 0.1, which needs the 0.2.1 engine; see its README for the migration.

## [0.3.0] — 2026-10-17

This version introduces a unified engine API. See the
[migration notes](documentation/migration-0.2-to-0.3.md) for breaking changes.

### Added

- `createEngine({ container, … })` assembles the camera, the vision Worker, the overlay renderer, extensions and
  diagnostics inside one container; each result is drawn with the geometry of its own frame.
- Engine events for the camera and the page: `cameraPermission`, `cameraStatus`, `cameraSize`, `pageVisibility` and
  `viewportTransition` with the raw trigger.
- `capabilityChanged` reports what actually runs: preview surface, frame detection, matching operator and fallback.
- `DiagnosticLog` with a key level (always on) and a full level (per-frame records), bounded and numeric only.
- `compileTargetImage(file, { targetId })` compiles an image file in a short-lived Worker.
- Replaceable environment adapters: preview surface, snapshot strategies, playback recoveries, Worker factory.
- A Worker file (`livemira-engine-worker.min.mjs`) for pages whose content security policy forbids `blob:` Workers.
- Extensions plug into the engine (`extensions: [...]`) instead of wrapping the renderer.
- Each module is its own package with merged type declarations (`types` in its exports): `@livemira/engine`
  (`.`, `./readable`, `./worker`) and the optional `@livemira/tracking-visuals`, `@livemira/recognition-diagnostics`
  and `@livemira/target-quality`.
- A full-screen demo with a page shell, in English and Simplified Chinese; `npm run dev` serves it.

### Changed

- The camera defaults are `capture: 'canvas'` and `timestamps: 'callback'` (0.2.x: native frames and the media
  time). Pass `camera: { capture: 'auto', timestamps: 'media-time' }` for the 0.2.x
  defaults.
- After the overlay of a target was hidden while it was still tracked, it is shown again only once three fresh
  measurements in a row, at least 50 ms apart in all, confirm the target.
- After a loss the overlay stays in place only while that is plausible: a target that was moving fast (half its
  diagonal per second or more) is hidden at the first frame without a measurement, a slower one is held at most until it
  could have moved 5 % of its diagonal, and a target measured only once is held 100 ms.
- The default loss display grace (`tracking.lossDisplayGraceMs`) is 200 ms instead of 0: the overlay keeps its last
  pose for up to 200 ms after a loss, so the brief losses right after a target is found no longer make it flash.
  Pass 0 for the 0.2.x behavior.
- When the camera fails or the page is hidden, the engine ends the session itself.
- Media failures are reported as `MEDIA_FAILED`; camera failures as `CAMERA_*` error codes.
- Names follow one convention (`isMuted`, `prediction.ageUs`, `quality.isMeasured`, `…Px`); see the migration notes.
- The diagnostic export format is `livemira-diagnostics/2`.
- target-quality keeps only scorer 2.0.0 and the ANMS algorithm; results use schema `livemira-target-quality/3`.

### Removed

- Hand assembly: `CameraFrameSource`, `createWorkerPipeline`, `CssVideoRenderSink`, `getFrameGeometry`,
  `prepareWorkerFrame`, `DiagnosticRecorder` and the `./development/*` entries.
- Non-default capabilities: hybrid and subpixel tracking, WebGPU matching, WebAssembly preprocessing, the greedy and
  oriented v2 feature algorithms (their targets must be recompiled), the options that selected them, and
  target-quality scorer 1.0.0.

### Fixed

- A display grace no longer starts over when the timer that ends a prediction runs late (a busy main thread): nothing of
  a measurement stays visible longer than the prediction and the grace after it.
- Canvas capture reads the camera picture back at the processing size instead of its full
  size, reducing pixel-copy volume while preserving the recognition image.
- A camera whose media time does not advance (seen in WebKit) no longer stalls two seconds after it starts: after three
  new pictures with the same media time, the run switches to callback timestamps. 0.2.x stalled and used them only
  from the next start.

### Known issues

- At the start of a rotation the video plane may stay on top of the mask for about one more frame.
- Matching can be lost during fast motion.
- Tracking is weakest when the target appears at about 0.7 times its compiled size (between two pyramid levels): it
  is still recognized, but with fewer matches and more jitter.
