# LiveMira

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.4.1-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.4.1)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.zh-CN.md)

Prebuilt modules, offline npm packages and the demo are in the [0.4.1 release](release/0.4.1/README.md).

LiveMira is a browser engine for **image-target AR**: it recognizes a prepared picture in the live camera image,
tracks it and plays a video on it. Recognition and tracking run in a Web Worker on the device; the page needs no
server component and uploads nothing.

**Status:** 0.4.1. Image-target recognition, tracking, video overlays, and an optional camera UI run in the browser. Camera access requires a secure context and user permission.

**Compatibility limits:** The camera UI has not completed physical-device acceptance. Android and in-app browsers remain unverified. Desktop browser results do not establish compatibility or performance on every device.

## Use

```js
import { createEngine, parseTarget } from './livemira-engine.min.mjs';

const engine = createEngine({ container: document.getElementById('stage') });
await engine.setTargets([{ target: await parseTarget(text), media: { url: './poster.mp4' } }]);
startButton.onclick = () => engine.start();
```

The [integration guide](packages/sdk/README.md) covers options, events, targets, media, diagnostics, extensions, the
content security policy and browser requirements. Coming from 0.2.x: see the
[migration notes](documentation/migration-0.2-to-0.3.md).

## Build and try

Requirements: Node.js ≥ 25.9. No network access beyond `npm ci`.

```sh
npm ci
npm run build   # dist/: the single-file engine, its Worker file, the extensions and the demo site
npm run dev     # builds the demo and serves it at http://127.0.0.1:5173/
npm run check   # format, lint, types, API, version, structure, content and WebAssembly checks, tests
```

| Output                                          |                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `dist/livemira-engine.min.mjs`                  | The engine: one ES module with its Worker and WebAssembly embedded. |
| `dist/livemira-engine.mjs`                      | The same, readable.                                                 |
| `dist/livemira-engine-worker.min.mjs`           | The Worker as a file, for pages whose CSP forbids `blob:` Workers.  |
| `dist/livemira-tracking-visuals.min.mjs`        | Optional: draws the recognized boundary and matched points.         |
| `dist/livemira-recognition-diagnostics.min.mjs` | Optional: bounded recognition counters.                             |
| `dist/livemira-target-quality.min.mjs`          | Optional: scores a picture 0..5 as a target.                        |
| `dist/livemira-ui.min.mjs`                      | Optional: the full-screen [camera UI](packages/ui/README.md).       |
| `dist/demo/`                                    | The [demo](apps/demo/README.md) as a static site.                   |
| `dist/livemira-*.d.ts`                          | Merged declarations, one per module.                                |
| `dist/packages/`                                | One publishable npm package directory per module.                   |

Builds are reproducible: the same sources give the same bytes, and `engineBuildInfo.buildId` identifies them.

## Repository

| Path                                                                     | Contents                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `packages/contracts`                                                     | Shared types, errors and validators                                                  |
| `packages/compute`                                                       | Gray conversion, standard image, exact Hamming matching (JavaScript and WebAssembly) |
| `packages/recognition`, `tracking`, `target-compiler`                    | Recognition, tracking, target compilation                                            |
| `packages/camera`, `media`, `renderer`                                   | Camera frame source and preview, video session, overlay renderer                     |
| `packages/diagnostics`                                                   | The two-level diagnostic log                                                         |
| `packages/sdk`                                                           | `@livemira/engine`: assembly, scheduling, events, Worker protocol and runtime        |
| `packages/tracking-visuals`, `recognition-diagnostics`, `target-quality` | Optional extensions                                                                  |
| `packages/ui`                                                            | `@livemira/ui`: optional full-screen camera UI on the public engine API              |
| `apps/page-shell`, `apps/demo`                                           | Full-screen page shell and the public demo                                           |
| `tools`, `tests`                                                         | Build tools, structure checks, browser probes                                        |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Copyright 2026 Andy (@andy-mira). Licensed under the [Apache License 2.0](LICENSE); see [NOTICE](NOTICE). The demo's sample
photographs are CC0 works by their authors ([credits](apps/demo/assets/CREDITS.md)).

## Made with AI

This repository is built by a human–AI team: the owner (**Andy (@andy-mira)**) sets direction, reviews and accepts the work; the code and artifacts were produced together with AI agents — **Nova** (orchestration & ops), **Codex** (engineering management & acceptance, and takes over development when Claude hits its limits) and **Claude** (implementation). The project is openly licensed under Apache-2.0 — use it freely, within the license terms.

## Buy the author a coffee ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

If LiveMira saves you time, consider buying the author a coffee. This project was built with AI agents — your support helps keep the human + AI team building.
