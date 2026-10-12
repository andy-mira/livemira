# LiveMira

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.2.0-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.2.0)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.zh-CN.md)

[简体中文](README.zh-CN.md)

LiveMira is a browser engine for **image-target AR**: it recognizes a prepared image in the live camera feed, tracks it in real time and overlays a video on it. Recognition and tracking run in a Web Worker with WebAssembly preprocessing and optional WebGPU matching; the page needs no server component.

This repository contains the source of the current stable edition of **LiveMira**. It contains the engine only; applications built on it and their media are not included.

## Status and support scope

- Recognition and the existing camera/media behavior inherit previously tested iPhone browser evidence. The loading overlay and soft circular reveal were confirmed in an iPhone Chrome Demo using the release candidate. Final 0.2.0 changes only version metadata and public documentation; these final artifacts were not tested directly on a phone. Other devices and environments are trial.
- **Known issue:** portrait/landscape transitions can deform the video overlay. This remains unresolved in 0.2.0; prefer a fixed orientation where consistent alignment is required.
- The engine is **not declared production-ready** (`productionReady: false` in release manifests). Confirm performance and device behavior in your own target environment.
- Packages are private (`"private": true` only prevents accidental publishing to npm; it is not a license restriction). Nothing here is published to npm.

## What you get

A build produces two self-contained engine files and three optional tools. Everything the core needs at run time (Worker, WebAssembly, shaders) is embedded; the page downloads nothing else from the engine.

| File | Purpose |
| --- | --- |
| `core/lm-engine.min.mjs` | The engine, minified. Use this one. |
| `core/lm-engine.mjs` | The same engine, readable. |
| `tools/target-quality/lm-target-quality.mjs` | Optional: scores an image 0..5 for use as a target. |
| `tools/tracking-visuals/lm-tracking-visuals{,.min}.mjs` | Optional: draws the recognized boundary and matched points. |
| `tools/recognition-diagnostics/lm-recognition-diagnostics{,.min}.mjs` | Optional: bounded recognition counters. |

The tools are separate files; the core never imports them. The classified layout of a distribution (`core/`, `tools/`, `shared/{types,audits,notices,runtime}/`, `docs/`) is defined once in [`scripts/release/release-layout.json`](scripts/release/release-layout.json).

## Build

Requirements: Node.js >= 25.9.0 and npm >= 10 (measured with Node 25.9.0 and npm 11.12.1). No Docker, Emscripten or network access beyond `npm ci` is needed: the WebAssembly modules are pinned prebuilt files in [`packages/compute/artifacts/`](packages/compute/README.md), recorded in `packages/compute/prebuilt-artifacts.json`.

```sh
npm ci
npm run build   # tsc, then the single-file engine and the three tools into dist/
npm test        # build, then the focused unit tests
```

The build writes `dist/engine-single/lm-engine{,.min}.mjs`, `dist/target-quality-single/`, `dist/tracking-visuals-single/` and `dist/recognition-diagnostics-single/` (each with declarations and an audit JSON). Builders refuse to overwrite anything they did not create.

To assemble the classified SDK package (`@livemira/engine`) from `dist/`:

```sh
npm run engine:package -- my-sdk-id      # writes artifacts/my-sdk-id/ ; refuses an existing directory
python3 scripts/release/package-livemira.py artifacts/my-sdk-id artifacts/my-drop-id   # optional curated drop without shared/runtime
```

Curating a drop requires a clean Git checkout. The standalone build and SDK assembly also work from a source archive; their manifests record an unavailable Git identity as unknown.

The package contains `LICENSE`, `NOTICE`, the unchanged third-party texts in `shared/notices/`, and a manifest with the SHA-256 of every file and the state of the source it was built from (a `dirty` source is recorded as such).

## Use

```js
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry,
  prepareWorkerFrame, CssVideoRenderSink, parseTarget, engineBuildInfo }
  from '/assets/lm-engine.min.mjs';        // core/lm-engine.min.mjs of your build, served over HTTPS
```

The production interface of `@livemira/engine` is the same in the SDK package and in the curated drop: `.` and `./browser` serve the minified core, `./single` the readable core and `./single/min` the minified core; `./target-quality`, `./tracking-visuals` and `./recognition-diagnostics` (and their `/single` and `/single/min` forms) serve the standalone tools. The SDK package alone also has explicit `./development/...` entries for the multi-file modules; they are outside the stable production interface. There is no wildcard export. Compatibility rules for patch and minor releases and for the target schema are in [`docs/release/livemira-release.md`](docs/release/livemira-release.md). A complete example, the API description and the content security policy requirements (`worker-src blob:`, WebAssembly compilation) are in [`packages/sdk/README.md`](packages/sdk/README.md), shipped as `INTEGRATION.md` in the `docs` directory of the package. Optional guides: [target quality](packages/target-quality/README.md), [tracking visuals](packages/tracking-visuals/README.md), [recognition diagnostics](packages/recognition-diagnostics/README.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/contracts` | Shared types and validators |
| `packages/sdk` | Engine API, Worker pipeline, single-file entry |
| `packages/camera`, `renderer`, `media` | Camera frame source, CSS video renderer, video session |
| `packages/target-compiler`, `recognition`, `tracking` | Target compilation, CPU recognition, tracking |
| `packages/compute` | WebAssembly preprocessing, WebGPU Hamming matcher, shaders, prebuilt modules and notices |
| `packages/target-quality`, `tracking-visuals`, `recognition-diagnostics` | The optional tools |
| `native/` | C++ sources of the preprocessing module and a CMake build |
| `scripts/release/` | Build, package and layout automation |

## Native rebuild

The prebuilt modules were produced with Emscripten 4.0.15 (pin in `packages/compute/toolchain-pin.json`). The documented rebuild route is `scripts/build-wasm.ps1`, a PowerShell script from a Windows environment. It has not been verified on other platforms and no cross-platform rebuild is claimed. See [`packages/compute/README.md`](packages/compute/README.md).

## Made with AI

This repository is built by a human–AI team: the owner (**Andy Mira**) sets direction, reviews and accepts the work; the code and artifacts were produced together with AI agents — **Nova** (GLM-5.3, orchestration & ops), **Codex** (GPT, engineering management & acceptance, and takes over development when Claude hits its limits) and **Claude** (implementation). The project is openly licensed under Apache-2.0 — use it freely, within the license terms.

## Buy us a coffee ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

If LiveMira saves you time, consider buying the author a coffee. Half of every donation goes to the AI agents that helped build this — they run on subscriptions, and coffee is literally their fuel.

## License

Copyright 2026 Andy (@andy-mira)
Author: Andy (@andy-mira)

The original LiveMira source code, shaders, native sources, build scripts and documentation are licensed under the [Apache License 2.0](LICENSE); see [`NOTICE`](NOTICE).

The prebuilt WebAssembly modules and their JavaScript glue also contain code from upstream projects that keeps its own license and is **not** relicensed here: [Emscripten](https://github.com/emscripten-core/emscripten) (MIT or NCSA, at your choice), [musl libc](https://musl.libc.org) (MIT), LLVM libc++ (Apache License v2.0 **with LLVM Exceptions** and the retained legacy licenses, which is not the plain Apache License 2.0) and dlmalloc (public domain). Their unchanged texts are in [`packages/compute/EMSCRIPTEN-LICENSE.txt`](packages/compute/EMSCRIPTEN-LICENSE.txt), [`packages/compute/MUSL-COPYRIGHT.txt`](packages/compute/MUSL-COPYRIGHT.txt), [`packages/compute/LIBCXX-LICENSE.txt`](packages/compute/LIBCXX-LICENSE.txt) and [`packages/compute/DLMALLOC-NOTICE.txt`](packages/compute/DLMALLOC-NOTICE.txt), and in `shared/notices/` of every package. The compiler toolchain itself is only identified (`packages/compute/toolchain-pin.json`), not redistributed. Third-party reference material, datasets and sample media are not part of this source and are not licensed by it.

## Release metadata

The root `package.json` is the source of the release version, author, license and `livemira` display/package metadata. Workspace manifests and the npm lockfile contain generated copies required by npm. Set the next version with `npm run version:set -- 0.2.1` (or run it without an argument to synchronize existing root metadata). `npm run version:check` checks consistency without changing files; builds run this check automatically. No environment file is needed.

Distribution paths and exports are defined in `scripts/release/release-layout.json`. Algorithm, compiler and target-schema versions describe separate compatibility contracts and are not changed by the release-version command. Historical evidence and original copyright notices remain under their original identities.
