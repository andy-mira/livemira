# LiveMira 0.2.1

[English](livemira-release.md) | [简体中文](livemira-release.zh-CN.md)

LiveMira is a browser engine for image-target AR: it recognizes a prepared image target in the live camera feed, tracks it, and shows a video on it. 0.2.1 is a patch release of the first stable edition (0.2.0). Recognition, matching results, scale retry, camera and tracking behave as before; two CPU optimizations that produce bit-identical results are now on by default (see "CPU defaults"). Video presentation keeps the black translucent loading layer and spinner, followed by a soft circular reveal from the centre when a decoded frame is available, as introduced in 0.2.0 and unchanged here. The package name, distribution file names and import paths follow the LiveMira naming in `NAMING.md` of the `docs` directory.

## Layout

| Directory | Contents |
| --- | --- |
| `core/` | Exactly two files: `lm-engine.min.mjs` (minified, the file to integrate) and `lm-engine.mjs` (readable). Each is self-contained, with its Worker, WebAssembly and shaders embedded |
| `tools/target-quality/`, `tools/tracking-visuals/`, `tools/recognition-diagnostics/` | Optional standalone modules, each self-contained; the core never imports them |
| `shared/types/` | All type declarations (`core/`, `tools/<name>/`, `runtime/`) |
| `shared/audits/` | Build audits, grouped by core and tool |
| `shared/notices/` | Unchanged third-party license texts and the toolchain pin |
| `docs/` | Guides for naming, media and target quality |

The root holds only `package.json`, the English and Simplified Chinese README files, `LICENSE`, `NOTICE`, `release-layout.json` and `release-manifest.json`. `release-manifest.json` records the class, size and SHA-256 of every file. The SDK package (`@livemira/engine`) additionally holds `shared/runtime/`, the multi-file development modules; the production drop does not.

## Production interface

These entries are the stable production interface. They are the same names, files and types in the SDK package and in this production drop:

| Import | File |
| --- | --- |
| `@livemira/engine`, `@livemira/engine/browser`, `@livemira/engine/single/min` | `core/lm-engine.min.mjs` |
| `@livemira/engine/single` | `core/lm-engine.mjs` (readable) |
| `@livemira/engine/target-quality` (also `/single`) | `tools/target-quality/lm-target-quality.mjs` |
| `@livemira/engine/tracking-visuals`, `.../single/min` | `tools/tracking-visuals/lm-tracking-visuals.min.mjs` |
| `@livemira/engine/tracking-visuals/single` | `tools/tracking-visuals/lm-tracking-visuals.mjs` (readable) |
| `@livemira/engine/recognition-diagnostics`, `.../single/min` | `tools/recognition-diagnostics/lm-recognition-diagnostics.min.mjs` |
| `@livemira/engine/recognition-diagnostics/single` | `tools/recognition-diagnostics/lm-recognition-diagnostics.mjs` (readable) |

```js
import { createEngine, createWorkerPipeline, CameraFrameSource,
  CssVideoRenderSink, prepareWorkerFrame, parseTarget, engineBuildInfo }
  from '/assets/lm/core/lm-engine.min.mjs';
```

Types live in `shared/types/` and are for development only; the core never requests types, audits or declaration files. Existing compiled targets need no recompilation, and target and media delivery stay yours.

Validated settings: CPU backend, absolute tracking mode, 640 px long edge, ANMS Harris/BRIEF, `legacyScaleSearch: true`, `maxPredictionMs: 100`, `lossDisplayGraceMs: 500`, media `loop: true` and `muted: true`. Serve JavaScript with the correct MIME type over HTTPS. A content security policy must allow `worker-src blob:` and WebAssembly compilation, and `connect-src` / `media-src` for your own target and media URLs.

## SDK-specific development entries

Only the SDK package contains the multi-file modules (`shared/runtime/`). They are reachable through explicitly named `@livemira/engine/development/...` subpaths: `sdk`, `browser`, `cpu`, `worker`, `mock`, `camera`, `renderer`, `renderer/perspective`, `media`, `target-compiler`, `recognition`, `tracking`, `compute`, `contracts`, `contracts/worker`, `target-quality`, `tracking-visuals` and `recognition-diagnostics`. They are for development, tests and bundler setups that need the individual modules. They are not part of the production interface above, are not in this drop, and may change in any release. There is no wildcard export and no documented production import depends on an internal directory.

## Support scope

Existing recognition and camera/media behavior were tested in an iPhone browser Demo integration. Other devices and environments are trial. The loading mask and circular reveal were confirmed in an iPhone Chrome Demo using the release candidate. Release 0.2.1 makes two optimizations the shared defaults: exact WebAssembly matching and BRIEF offset reuse. The candidate build with both options explicitly enabled was physically tested on two phones, labelled 14 PM and 18 PM (input-to-result p95 about 55 → 28 ms and 62 → 28 ms; testers saw little or no clear difference; the inputs were not physically paired). That evidence is reused, not relabelled: the final 0.2.1 artifacts were not tested directly on a phone, and parity between the packaged defaults and that candidate was checked separately by automated comparison. Fast-motion matching loss and the portrait/landscape overlay deformation remain. `productionReady` is false: a stable channel does not mean that full commercial validation has been completed.

The default presentation uses a 55% black loading layer, a rotating ring and a 420 ms circular reveal with a soft edge. It waits for the current video's first decoded frame; downloading the entire video is not required. Configure `new CssVideoRenderSink({ geometryForResult, presentation: { revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 } })`, or use `presentation: false` to disable it. Reduced-motion settings use a short fade. Request generations prevent old callbacks from revealing a replaced or stopped video. Presentation transitions are available in the existing `mediaState` event and numeric log export.

## Known issue

Portrait/landscape transitions can deform the video overlay. This remains unresolved in 0.2.1. Use a fixed orientation when consistent alignment is required.

Matching can still be lost during fast motion. The 0.2.1 defaults do not fix this, and no clear subjective improvement is claimed.

## CPU defaults

Since 0.2.1, when `cpuMatching` and `cpuFeatures` are omitted:

- the legacy-family exact Hamming matcher runs in embedded WebAssembly inside the Worker: SIMD when validated and self-tested, else scalar, else the JavaScript matcher. The capability's `operators.matching` reports `wasm-simd`, `wasm-scalar` or `cpu` (with `matchingFallback` and `fallbackReason: 'WASM_MATCHING_JS_FALLBACK'` on fallback). The string `'wasm-experimental'` is kept as a compatibility spelling of this default;
- BRIEF sample offsets are precomputed once per pyramid layer (`cpuFeatures: { briefOffsets: true }`; the capability reports `recognitionFeatures: 'cpu-brief-offsets'`). A partial or `undefined` `cpuFeatures` uses the same defaults.

Opt out with `cpuMatching: 'js'` and `cpuFeatures: { briefOffsets: false }`. Results, compiled targets, and algorithm and schema identifiers are unchanged. `backendPreference: 'webgpu'` stays opt-in and keeps its own matcher (the CPU WebAssembly matcher is not applied to it); oriented-v2 targets keep the JavaScript matcher. In the two phone input-to-result p95 measurements the latency dropped from about 55 to 28 ms and from 62 to 28 ms; human testers saw little or no clear difference, and the inputs were not physically paired, so this is not a user-visible fix. `productionReady` remains false.

## Compatibility

- **Patch releases (0.2.x)** contain fixes only. They keep every production entry above (name, file role and exported API), do not change the target schema, and never change how an already compiled target is interpreted.
- **Minor releases (0.x.0)** are strictly additive for the production interface: new exports, options or optional tools may appear, and existing production entries keep their names, file roles and compatible behavior. Release notes cannot excuse a break. Removing or breaking a stable entry, or dropping a readable target format, requires a new major compatibility boundary, or a new opt-in versioned entry while the old stable entry stays compatible.
- **Development entries** (`./development/...`) are outside both rules.
- **Target schema.** A compiled target carries `schemaVersion`, `compilerVersion` and `algorithmVersion`. These algorithm and schema IDs are separate from the package version and are not changed by a package release. The engine accepts the versions it lists in `SUPPORTED_ALGORITHM_VERSIONS`, rejects anything else and never mixes algorithm versions in one engine. A new target schema or algorithm version is added alongside the existing ones in a minor release (opt-in), and every previously readable target format stays readable until a new major boundary. Patch and minor releases never require recompiling targets.
- The layout contract (`release-layout.json`, `layoutVersion` 2) is checked by the generators; a distribution always ships the contract it was built with.

## License

The original LiveMira code and documentation are licensed under the Apache License 2.0 (`LICENSE`); `NOTICE` gives the attribution and the scope of that license. The embedded WebAssembly also contains upstream code that keeps its own licenses and is not relicensed: Emscripten, musl libc, LLVM libc++ (Apache-2.0 with LLVM Exceptions, not plain Apache-2.0) and dlmalloc (public domain). The unchanged texts are in `shared/notices/`.
