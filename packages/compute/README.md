# Compute backend

Native-style preprocessing (gray conversion and a Gaussian pyramid) on the CPU, in scalar or SIMD WebAssembly, plus an optional Worker-safe resident WebGPU Hamming matcher with an exact CPU fallback. Neither means the whole engine runs in WebAssembly or on the GPU: recognition and tracking run on the CPU, and GPU matching is opt-in (small batches regress, and full recognition does not meet a 33 ms budget on the measured desktop fixtures).

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

### Hamming matching

For direct matching, `setTargets([{id, descriptors: Uint8Array}])`, then `matchBatch(targetIds, frameDescriptors, signal)` returns the backend, version, matches, timings and `fallbackReason`. At most ten target snapshots are retained; each target or frame has at most 512 descriptors of 32 bytes; a batch has at most three candidates. Target descriptors stay on the GPU between calls and a frame is uploaded once per batch. Only the forward best/second and reverse-nearest reductions return, not the full distance matrix or images. Returned pairs carry `targetIndex`, `frameIndex` and `distance`, ordered by target index.

Exact numerical contract `hamming32-mutual-ratio075-max64/1`: best <= 64, strict `4*best < 3*second`; accept only the unique reverse nearest target (equal reverse distances reject). Empty inputs return no matches. All distances and index decisions must match the CPU exactly. The matcher does not compute orientation, descriptors, retrieval or homography.

`diagnostics` and `onCapabilityChanged` expose the actual backend, generation and fallback reason. `invalidateGpu()` destroys the current GPU generation: already submitted work is awaited, temporary buffers are destroyed, and non-aborted matching falls back to exact CPU. An abort rejects instead of silently finishing on the CPU. Disposal blocks new work, waits for initialization and active work, and invalidates buffers. One batch is allowed in flight and `setTargets` rejects while busy. CPU loops observe cancellation at operation boundaries; hard cancellation is Worker termination.

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
