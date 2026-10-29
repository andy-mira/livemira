# Changelog

All notable changes are listed here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.5.0] — 2026-10-26

The 0.5.0 release: the engine, camera UI and rating of 0.5.0-rc.2 (accepted on phones inside LiveMorae), with the
rating made a module of its own and the engine reduced to its core.

### Added

- `@livemira/target-rating` (`files/livemira-target-rating.min.mjs`, with its Worker file and declarations): the
  target rating as a module of its own, for pages that choose pictures without the engine (a work editor).
  `rateTargetImage(blob)` decodes and compiles the picture as the engine's `compileTargetImage` would, in the module's
  own Worker, and rates it; `rateTarget(bundle | bytes)` rates a compiled target. Errors are `RatingError`s
  (`UNSUITABLE_TARGET` for a picture the engine would refuse). Same ratings as rc.2. The release manifest lists the
  engine's and the rating's build ids apart (`modules`): a change to one leaves the other's files as they are.

### Removed

- `rateTarget` and its types are no longer in the engine (`@livemira/engine`); use `@livemira/target-rating`.

### Changed

- The engine is 7 KB smaller (123 KB, was 130 KB): besides the rating, device-test diagnostics (frame strips, per-frame traces,
  orientation thumbnails) are compiled out of releases, and the vision Worker no longer estimates a 6-DoF pose every
  frame (nothing used it). Recognition, tracking and presentation are unchanged.
- The demo's rating page uses the rating module; the engine is not loaded there.
- The engine and the camera UI are on npm (`@livemira/engine`, `@livemira/ui`). Their packages hold the minified
  modules, the engine's Worker file, the declarations and the guides (links pointing to the release on GitHub), with
  repository metadata; the readable builds stay in the release's `files/`. The target rating is an offline package in
  the release's `npm/` only.

## [0.5.0-rc.2] — 2026-10-25

Second release candidate of 0.5.0: small photos kept and found again, recognition on the camera's own size by
default (both accepted on a phone with the ⑩ comparison), and target rating. For the acceptance inside LiveMorae;
0.5.0 will differ only in its version.

### Added

- `rateTarget(bundle)`: target rating in stars (0.5–5) from the compiled target and the engine's own detector on
  synthetic views, with four factors (detail, spread, distinctiveness, recognition), five recognition tests (size,
  tilt, motion blur, dim light, partly covered; each a ladder from easy to hard, each view tried twice and counted by
  its inlier margin), advice codes and the counted points. Detail crowded in one place caps the stars. Weights
  calibrated on 28 public pictures (the set 0.4.1's demo pictures come from) and the LiveMorae demo photo against
  their measured difficulty in the bench's scene (bench/src/measure-targets.ts; rank correlation ~0.6). The stars sit
  between a first, lenient version (most photos 5) and a strict one (most 3–4), fitted to their midpoint: those
  pictures average 4 (2 rate 5, 12 rate 4.5, 7 rate 4, 3–4 rate 3.5, 3–4 rate 3 or less); 0.4.1's samples rate 4.5
  (bird), 4.5 (forest), 3–3.5 (mountain), 2.5 (ship), the LiveMorae demo photo 4. Pictures with detail kept in a
  quarter or the centre rate 0.5, in a half 1.5, all but a quarter 3; low-texture 0.5, a repeating tile 1. The demo gains `rate.html`: a picture or a video frame
  (first, last or any), its rating drawn over it with the five tests, what the stars mean, and the ratings of the 0.4.1
  samples next to 0.4.1's own scores and their measured difficulty.
- The demo's `targets.html` shows one picture per page, as large as the page allows, turned by swiping, the arrows or
  the arrow keys (`#2` opens a page); printed, one picture per sheet.
- `camera.processingScale` (1, 0.75, 0.5; default 1; in `@livemira/ui` through `engineOptions.camera`): recognition and tracking work on the camera's own size by
  default, no longer on a fixed 640 px long edge (0.5 of a 720p camera). In simulation (a 1280 × 720 camera, the
  LiveMorae demo photo) the reliable range starts at about 25% of the frame's short edge instead of 40%. On an iPhone
  (⑩, 2.5 minutes each) the own size lost the photo 0 times, 0.5 six times, for 3.4–4.6 ms per frame instead of
  1.7–2.7 ms at 30 fps. A quarter size recognised no photo in simulation and is not offered.

### Changed

- The detector takes features from a whole frame at the density of 700 per 640 × 360 (never fewer than 700), so a
  larger processed picture is not searched more thinly.
- The luma resample of integer ratios (the camera's size, half, quarter) averages and turns by index steps instead of
  interpolating; RGB frames reuse their gray buffer.

### Fixed

- Photos small on screen were lost more often and came back slowly (found with the ⑩ comparison on a phone: below
  about half of the frame's short edge). After a short tracking failure (a jerk, a refocus) the engine searched the
  whole frame at its own size, where a photo under about 140 px long edge cannot be recognised. It now searches
  around the photo's last place for up to 2 s (the region growing with time; the whole frame every third frame),
  and enlarges a small photo's region up to 3× before taking its features; the coasting search and the periodic
  relocalisation enlarge it too. In simulation the detector finds 80–120 px photos in 85–100% of frames instead of
  0–25%.

## [0.5.0-rc.1] — 2026-10-23

Release candidate of 0.5.0: the code of 0.5.0-preview.3 (accepted on a phone with the test page), for the acceptance
inside LiveMorae. 0.5.0 will differ only in its version.

### Changed

- The guides and release notes no longer describe a preview; the release manifest marks neither `stable` nor
  `preview`.
- The upgrade notes also list the version assertion in LiveMorae's `tests/scanTargets.test.ts` and the documents that
  name the current version.

## [0.5.0-preview.3] — 2026-10-23

### Changed

- Videos stream: a video URL goes to the browser's player, which fetches it in ranges and starts as soon as enough has
  arrived (it used to be downloaded whole first). Camera UI: `video.isStreamed`, default true, or false when the host
  gives its own `loadMedia` (media behind header authentication keeps being downloaded whole). A streamed video that
  cannot be fetched is a `video-load` error the host may classify.
- The loading look follows the video: right on recognition a see-through dark region in the video's shape (the
  photo's until the browser knows the video's size, then easing to it) with the spinner in its centre; the reveal
  opens that region from its centre once the video can play, its wavefront kept inside it.
- The engine asks a recognised photo's video to play at once (some browsers load a video only when asked to play).

### Added

- The spinner shows again over a playing video that runs short of data for more than 0.4 s (the browser's `waiting`).

## [0.5.0-preview.2] — 2026-10-23

### Fixed

- The camera UI's default `loadMedia` sends cookies to the page's own origin (never to another origin). With
  `credentials: 'omit'` a page behind a login or an access cookie could not load its own photos and videos, and the
  run ended with "the photos could not be loaded" (found in the first phone test).

## [0.5.0-preview.1] — 2026-10-23

A preview of the next-generation engine for LiveMorae's internal testing. The engine is new; the camera UI keeps the
0.4.1 API.

### Added

- Engine profiles: `'swift'` (default), `'hawk'` and `'wren'`, with fallback by device capability and Hawk stepping
  down to Swift at run time. Devices without WebGL2 and `VideoFrame` are refused with `UNSUPPORTED_DEVICE`.
- Frame-locked composition: the camera picture and everything drawn on a photo come from the same processed frame in
  one WebGL2 canvas, so videos do not drift against their photos.
- On the photo: recognition glow, loading veil with a progress ring (`setTargetProgress`), a play mark when playback
  needs a tap, and the centre-out reveal with a light wavefront; perspective-correct and anti-aliased; a 0.2 s fade
  with reduced motion.
- `setTargets` while running (loaded in the background, `targetsReady`), `probeDevice()`, `parseTarget` for stored
  targets, the Worker file for strict CSPs (`workerUrl`).
- Camera UI: a loader card with real progress, a scanning guide, recognition vibration (`isHapticEnabled`), download
  progress through `loadMedia`'s `onProgress`, state fields `readiness`, `isCameraOn`, `videoProgress`.

### Changed

- Recognition and tracking: C1 oriented multi-scale binary features with view synthesis, ESM fast loop, corner-space
  Kalman filter, concurrent relocalisation, WebAssembly SIMD kernels (see the design document's measured results).
- Photos compile in a pool of up to three short-lived Workers, at the same time as the camera opens.
- Target format v2 (`livemira-target/2`, SHA-256, descriptor version); 0.4 targets must be compiled again.
- Engine API: new events (`targetFound`, `targetLost`, `media`, `viewport`, `ended`, …) and error codes; see the
  integration guide.

### Removed

- 0.4 engine options without a counterpart (`processingLongEdge`, `capture`, `timestamps`, `maxPredictionMs`,
  `adapters`, `extensions`, `diagnostics`) and the optional extensions (tracking visuals, recognition diagnostics,
  target quality).

## [0.4.1] — 2026-10-18

See the 0.4.1 release.
