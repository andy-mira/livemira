<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" width="140" alt="LiveMira logo">
  </picture>
</p>

# LiveMira

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.6.0-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.6.0)
[![Live demo](https://img.shields.io/badge/demo-live-brightgreen.svg)](https://andy-mira.github.io/livemira/)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.zh-CN.md)

**Try it now: point your phone camera at the sample pictures on the [live demo](https://andy-mira.github.io/livemira/targets.html) — no install, no server, nothing uploaded.**

The engine, the camera UI and the target rating are on npm: `npm install @livemira/engine@0.6.0 @livemira/ui@0.6.0
@livemira/target-rating@0.6.0`. Prebuilt modules, offline npm
packages and the demo are in the [0.6.0 release](release/0.6.0/README.md).

LiveMira is a browser engine for **image-target AR**: it recognizes a prepared picture in the live camera image,
tracks it and plays a video on it. Recognition and tracking run in a Web Worker on the device; the page needs no
server component and uploads nothing.

**Status:** 0.6.0, the next-generation engine: recognition, tracking and composition are new, and so is the engine
API. The camera UI `@livemira/ui` keeps its 0.4.1 API. A standalone module `@livemira/target-rating` rates a
picture as a recognition target without loading the engine. 0.6.0 lets a hidden page suspend a run instead of ending
it, keeps each run's videos, plays one video at a time and no longer shows a made-up percentage while waiting for
camera permission. See the [upgrade notes](documentation/migration-0.4-to-0.5.zh-CN.md) (Chinese) and the
[changelog](CHANGELOG.md).

**Compatibility limits:** Acceptance so far covers iPhone browsers (Safari and Chromium-based) in the demo and in
an integrating product. Android and in-app browsers remain unverified. Desktop browser results do not establish
compatibility or performance on every device.

## Use

Save the following as `index.html`. Put the [0.6.0 engine module](release/0.6.0/files/livemira-engine.min.mjs), your target image `poster.jpg` and its video `poster.mp4` beside it. Serve the directory over HTTPS or localhost (not `file://`), wait for the image to compile, then tap **Start scanning**. The module embeds its Worker and WebAssembly; no build or npm dependencies are needed.

```html
<!doctype html>
<html lang="en">
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>LiveMira 0.6.0</title>
  <button id="start" disabled>Start scanning</button>
  <p id="status" role="status">Preparing the target image…</p>
  <div id="stage" style="position: relative; width: 100%; height: 70vh"></div>
  <script type="module">
    import { createEngine, compileTargetImage } from './livemira-engine.min.mjs';

    const startButton = document.getElementById('start');
    const status = document.getElementById('status');
    const engine = createEngine({
      container: document.getElementById('stage'),
    });
    /** @param {unknown} error */
    const showError = (error) => {
      status.textContent = error instanceof Error ? error.message : String(error);
    };
    engine.on('error', ({ error }) => showError(error));

    try {
      const response = await fetch('./poster.jpg');
      if (!response.ok) throw new Error(`Could not load target image: ${response.status}`);
      const photo = await response.blob();
      const target = await compileTargetImage(photo, { targetId: 'poster' });
      await engine.setTargets([target]);
      engine.setTargetMedia(target.targetId, { url: './poster.mp4' });
      status.textContent = 'Tap Start, then point the camera at poster.jpg.';
      startButton.disabled = false;
      startButton.onclick = () => engine.start().catch(showError);
    } catch (error) {
      showError(error);
    }
  </script>
</html>
```

In 0.6.0, `compileTargetImage(photo, { targetId })` returns a `TargetBundle`; pass it directly to `setTargets([target])` and bind the video separately with `setTargetMedia(targetId, { url })`. Camera access needs user permission; call `await engine.dispose()` when leaving the scanning page to release the camera and other resources. With a bundler such as Vite, you can instead import these functions from `@livemira/engine` after installing the pinned 0.6.0 package above.

The camera UI `@livemira/ui` mounts a full-screen scanning view over the engine with the same API as 0.4.1; see the
[camera UI guide](documentation/ui.md) and the [target rating guide](documentation/target-rating.md).

## Build and try

Requirements: Node.js ≥ 22.18 (runs TypeScript directly). Building the WebAssembly kernels additionally needs the
Rust toolchain with the `wasm32-unknown-unknown` target; the embedded kernels are verified by `npm run
check:kernels`, so a plain checkout builds and tests fine without Rust.

```sh
npm install
npm run check        # format, types, baseline copy, kernels, tests
npm run typecheck && npm test
```

Build a release (into `release/livemira-<version>` with checksums and offline npm packages):

```sh
npm run build:kernels   # only when the kernels change (needs Rust)
node tools/release.ts
```

Try the demo in `release/0.6.0/demo/` over HTTPS or localhost, or just open the hosted copy at
[andy-mira.github.io/livemira](https://andy-mira.github.io/livemira/); camera access requires a secure context and user
permission.

## Repository

The product code and the engineering side (the benchmark suite, the device test kit and the release tools) live in
one workspace.

| Path                                          | Contents                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/contracts`                          | Shared types: images, timing, poses, module metadata, layer interfaces                    |
| `packages/geometry`, `filters`, `imaging`     | Robust geometry (PROSAC/MSAC/LO/LM), Kalman and One Euro filters, pyramids and sampling   |
| `packages/tracking`                           | ESM (the default fast loop), KLT, NCC, the dual-loop orchestration with relocalisation    |
| `packages/features`                           | Oriented multi-scale binary features, the view-synthesis compiler, WASM SIMD matchers     |
| `packages/web`                                | The browser layer: capability probing, camera capture paths, orientation, engine profiles |
| `packages/engine` (`@livemira/engine`)        | The camera session lifecycle, the compile Worker pool, frame-locked video planes          |
| `packages/ui` (`@livemira/ui`)                | The camera UI; keeps the 0.4.1 API                                                        |
| `packages/rating` (`@livemira/target-rating`) | Target rating in its own Worker, without the engine                                       |
| `kernels/vision`                              | Rust → WebAssembly SIMD kernels (Hamming matching, FAST-9 scoring)                        |
| `demo/`                                       | The demo site shipped in the release                                                      |
| `bench/`                                      | The benchmark suite (synthetic scenes, baseline adapter, scoring) and the device test kit |
| `documentation/`                              | Integration guides: camera UI, target rating, migration (the only copy; releases ship it) |
| `release-src/`                                | The release's integration guide (`README*.md`) and release notes template                 |
| `CHANGELOG.md`, `NOTICE`                      | Changes and legal notices; releases ship both                                             |
| `tools/`                                      | Build, sync and check tools                                                               |
| `release/`                                    | The published releases (source-built artifacts with checksums)                            |

Dependency direction: `bench → packages/* → contracts`. Product packages never import `bench`.

The baseline this engine was measured against (the 0.4.1 engine) is not needed to build or test: the benchmark
falls back to its recorded results when the sibling baseline copy is absent (`LIVEMIRA_BASELINE` overrides the
location).

## Contributing

`npm run check` is what a change needs to pass. Report security issues privately by
[GitHub security advisories](https://github.com/andy-mira/livemira/security/advisories/new).

## License

Copyright 2026 Andy (@andy-mira). Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE).

## Made with AI

This repository is built by a human–AI team: the owner (**Andy (@andy-mira)**) sets direction, reviews and accepts the work; the code and artifacts were produced together with AI agents — **Nova** (orchestration & ops), **Codex** (engineering management & acceptance, and takes over development when Claude hits its limits) and **Claude** (implementation). The project is openly licensed under Apache-2.0 — use it freely, within the license terms.

## Buy the author a coffee ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

If LiveMira saves you time, consider buying the author a coffee. This project was built with AI agents — your support helps keep the human + AI team building.
