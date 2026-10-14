# Compute backend

[English](README.md) | [简体中文](README.zh-CN.md)

Native-style preprocessing (gray conversion and a Gaussian pyramid) on the CPU, in scalar or SIMD WebAssembly, plus an optional Worker-safe resident WebGPU Hamming matcher with an exact CPU fallback. Neither means the whole engine runs in WebAssembly or on the GPU: recognition and tracking run on the CPU. CPU is the default; GPU matching is an explicit experimental option. Speedups depend on the device, browser and workload and must be verified on the full live-camera path before enabling it.

## Runtime entry points

`src/index.ts` exports the following. The modules are Worker-safe and have no DOM or window dependency.

```ts
const preprocessing = await createWasmPreprocessor({ variant: 'scalar', signal });
const copied = preprocessing.copyFrame(frame, signal);
// Native gray/pyramid operators with owned JS output, no exposed heap pointers.
const backend = new CpuComputeBackend(operators, preprocessing);
await backend.init();
await backend.dispose(); // also disposes its preprocessing instance

const matcher = new HammingMatcher();
await matcher.init(); // an unavailable GPU or a shader failure exposes an explicit CPU fallback
const exactMatching = createExactMatchingAdapter(matcher);
const recognizer = new CpuRecognizer({ exactMatching }); // oriented-v2 path only
// await recognizer.loadTargets(...), recognizeGray(...)
recognizer.dispose();
await matcher.dispose();
```

`CpuComputeBackend` accepts injected `CpuOperators` (feature detection, describe-and-match, point tracking); the backend owns bounded resource lifetime (at most 32 handles and 32 MiB retained) and `dispose` drains active work. Each prepared frame or pyramid handle must be released; `readGray` returns an owned copy. `src/canonical-frame.ts` (`copyCanonicalFrame`) copies packed canonical gray8 or RGBA8 while preserving frame and session identity and respecting borrowed input ownership; it rejects noncanonical orientation, released handles and aborted calls.

For SDK applications, `createWorkerPipeline({ prepareFrame, options: { backendPreference: 'webgpu' } })` can request exact GPU matching for legacy/ANMS as well as oriented-v2 targets. Keep `backendPreference: 'cpu'` as the default. Check `onCapability` and `operators.matching` for the actual backend; the overall `backend` remains `cpu` because recognition and tracking run there. An unavailable GPU leaves legacy matching with the original CPU matcher. A matching-device generation change during processing rejects the frame and requires reset; it does not produce a valid stale pose. The low-level `exactMatching` example above remains oriented-v2 only.

### Hamming matching

For direct matching, `setTargets([{id, descriptors: Uint8Array}])`, then `matchBatch(targetIds, frameDescriptors, signal)` returns the backend, version, matches, timings and `fallbackReason`. At most ten target snapshots are retained; each target or frame has at most 512 descriptors of 32 bytes; a batch has at most ten candidates. Target descriptors stay on the GPU between calls and a frame is uploaded once per batch. Only the forward best/second and reverse-nearest reductions return, not the full distance matrix or images. Returned pairs carry `targetIndex`, `frameIndex` and `distance`, ordered by target index.

Exact numerical contract `hamming32-mutual-ratio075-max64/1`: best <= 64, strict `4*best < 3*second`; accept only the unique reverse nearest target (equal reverse distances reject). Empty inputs return no matches. All distances and index decisions must match the CPU exactly. The matcher does not compute orientation, descriptors, retrieval or homography.

`diagnostics` and `onCapabilityChanged` expose the actual backend, generation and fallback reason. `invalidateGpu()` destroys the current GPU generation: already submitted work is awaited, temporary buffers are destroyed, and non-aborted matching falls back to exact CPU. An abort rejects instead of silently finishing on the CPU. Disposal blocks new work, waits for initialization and active work, and invalidates buffers. One batch is allowed in flight and `setTargets` rejects while busy. CPU loops observe cancellation at operation boundaries; hard cancellation is Worker termination.

### WebAssembly exact matching (experimental)

`src/wasm-exact-matcher.mjs` is a CPU-only alternative to the JavaScript `matchPacked` for the legacy BRIEF family, selected in the Worker by default since 0.2.1 (`WorkerPipelineOptions.cpuMatching` omitted or `'wasm-experimental'`; `'js'` opts out; see the SDK README). `selectWasmExactMatcher()` tries the SIMD module, then the scalar module: each must pass `WebAssembly.validate`, instantiate, and reproduce `matchHamming32` on a built-in deterministic self-test (ties, boundaries, 512 x 512); otherwise `matcher` is `null` with the reason, and the caller keeps JavaScript. `WasmExactMatcher` has the same numerical contract and request limits as `HammingMatcher` (ten resident targets, at most 512 descriptors each, one frame of at most 512 per batch, pairs in ascending target index). It is synchronous, observes `signal` between targets, and `dispose()` drops the instance and its memory. `createWasmExactMatchingAdapter(matcher, {onFailure})` is the recognizer's `legacyExactMatching` operator: it resolves `null` (JavaScript for that frame) when the matcher is unavailable or a request exceeds the fixed capacity, and on a WebAssembly failure it disables the matcher permanently, calls `onFailure` once and also resolves `null`; aborts reject.

The modules are original, hand-written WebAssembly text in [`exact-matching-wasm/`](exact-matching-wasm) (Apache-2.0): `hamming-exact-scalar.wat` (MVP `i64.popcnt`) and `hamming-exact-simd.wat` (fixed-width SIMD128 `i8x16.popcnt`, four frame descriptors per step; no relaxed SIMD, no threads). Both use one non-growable 4-page memory with a fixed layout, no imports, no allocator. They contain no third-party code, so no further notices apply. [`exact-matching-wasm/build.mjs`](exact-matching-wasm/build.mjs) assembles them with the WAT assembler `wabt` pinned in [`exact-matching-wasm/toolchain-pin.json`](exact-matching-wasm/toolchain-pin.json) (npm integrity, tarball and `index.js` hashes; build time only, not a dependency, not redistributed) into the generated `src/exact-matching-wasm-binaries.mjs` (base64, so the single-file Blob Worker never fetches a `.wasm`) and [`exact-matching-wasm/manifest.json`](exact-matching-wasm/manifest.json) (source, toolchain and output hashes). The script never downloads; obtain the pinned package once outside the repository:

```sh
npm pack wabt@1.0.39 && tar -xzf wabt-1.0.39.tgz -C <dir>
node packages/compute/exact-matching-wasm/build.mjs --wabt <dir>/package --check   # byte-identical rebuild, or omit --check to regenerate
```

The development repository's test suite (not part of the public source) checks the manifest against the sources and embedded bytes (and runs the rebuild check when `LM_WABT_DIR` points at the pinned package), and compares both variants with a definition-level oracle, `matchPacked`, the frozen RC5 oracle and `matchHamming32`. The public source includes the WAT sources, `build.mjs`, `manifest.json` and the toolchain pin so the embedded binaries can be reviewed and rebuilt.

### WebAssembly limits

WASM supports <= 1,048,576 pixels and <= 8 MiB of source payload per conversion on a fixed 64 MiB heap, frees temporary allocations in `finally`, returns copies, and drops the module reference on dispose. Retained module or heap references would prevent garbage collection; JavaScript cannot forcibly unmap the heap. `copyFrame` uses native RGBA conversion; already-gray input is copied in JavaScript. Pyramid downsampling is an integer Gaussian that matches the native and JavaScript references exactly. It is not the oriented-v2 pyramid or the tracking package's normalized Lucas-Kanade pyramid and must not replace either silently.

## Numerical contract

Algorithm ID `e-preprocess-u8-v1`. RGB is encoded byte RGB; alpha is ignored, not unpremultiplied. Luma = `(77R+150G+29B+128)>>8`, an integer approximation, not linear-light conversion. The pyramid uses the outer product of `[1,4,6,4,1]`, edge clamping, a single `(sum+128)>>8` rounding after both axes, ceil dimensions, and samples centered at `(2x,2y)`. A level pixel maps back by `2^level` without a half-pixel offset. The pyramid stops at 1x1. Gray and pyramid CPU/WASM/GPU acceptance tolerance is exactly 0 byte difference.

`native/common/preprocess.*` is the equivalent scalar C++ C ABI with source and destination byte capacities; separate non-overlapping caller-owned buffers are required, and operators do not allocate, throw, own frames or run asynchronously. `src/reference.mjs` is the owned-output JavaScript reference (RGBA8 input may have row padding; invalid, empty or oversized layouts fail before allocation; at most 16,777,216 pixels). `shaders/gray.wgsl` is an experimental integer gray operator (one packed RGBA u32 in, one gray u32 out per pixel; it needs four times the CPU gray8 storage and is not production enabled). `src/probe.mjs` is a disposable WebGPU device probe.

## Prebuilt WebAssembly artifacts

The root build **does not compile native code**. It copies and embeds the pinned prebuilt modules in `artifacts/{scalar,simd}/compute.{mjs,wasm}`, whose sizes and SHA-256 are recorded in [`prebuilt-artifacts.json`](prebuilt-artifacts.json). The single-file engine embeds the scalar module. SIMD must be runtime-probed before selection, scalar is the default, and no pthread build exists. Automatic scalar fallback after an explicit SIMD module failure is not implemented by `createWasmPreprocessor`; the caller catches the initialization failure and reports the CPU fallback.

Licensing: the C++ sources are Apache-2.0 like the rest of the project. The generated `compute.mjs` glue and `compute.wasm` also contain upstream code under its own licenses, which is not relicensed: Emscripten (`EMSCRIPTEN-LICENSE.txt`), musl libc (`MUSL-COPYRIGHT.txt`), LLVM libc++ (`LIBCXX-LICENSE.txt`: Apache License v2.0 **with LLVM Exceptions** plus retained legacy licenses, not the plain Apache License 2.0) and dlmalloc (`DLMALLOC-NOTICE.txt`: public-domain dedication of Emscripten's default malloc/free). See also the root `NOTICE`. The compiler toolchain is identified in `toolchain-pin.json` but is not redistributed.

### Rebuild route

The modules were built with Emscripten 4.0.15 pinned in [`toolchain-pin.json`](toolchain-pin.json) (emsdk commit, emcc commit and the digest of the official `emscripten/emsdk:4.0.15` container image). [`scripts/build-wasm.ps1`](../../scripts/build-wasm.ps1) is the recorded build entry point. It was written for a Windows PowerShell environment; it has **not** been verified on other platforms, and no cross-platform rebuild is claimed. It never downloads an SDK. With the pinned `emcc` on `PATH`, or the official image by digest through `-UseDocker`:

```powershell
powershell -NoProfile -File scripts/build-wasm.ps1 -Variant scalar
powershell -NoProfile -File scripts/build-wasm.ps1 -Variant simd
```

The script compiles `native/common/preprocess.cpp` with `-std=c++17 -O2 --no-entry` as a modularized ES6 module for web, worker and node, with a fixed 64 MiB heap (`-sALLOW_MEMORY_GROWTH=0`) and exports `_e_rgba_gray`, `_e_pyr_down`, `_malloc` and `_free`; the SIMD variant adds `-msimd128`. A rebuild yields new artifact bytes: record their hashes in `prebuilt-artifacts.json` before using them to build a release. The fixed heap cannot fit arbitrary maximum-sized RGBA frames plus outputs, so the adapter must handle allocation failures; the intended workload is 640x360. Threads are disabled.

## Native reference build

```sh
cmake -S native -B build/native
cmake --build build/native
ctest --test-dir build/native --output-on-failure
```

Add `-A x64` and `--config Release` on MSVC. `tests/compute/native-reference.cpp` is the native parity check for the preprocessing ABI.

## Type-check

```sh
node node_modules/typescript/bin/tsc -p packages/compute/tsconfig.json
```

## Provenance

Original implementation. Reference projects consulted as reading material only (WebARKitLib is LGPL-3.0 and BabylonAR is MIT) were neither copied nor linked, and a transitive license review would be needed before any future adoption of such code.
