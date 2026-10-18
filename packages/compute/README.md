# @livemira/compute

Pixel and descriptor operators that do not depend on the recognition algorithm: RGBA to gray conversion, standard image drawing and exact Hamming matching (JavaScript reference and WebAssembly).

## Dependencies

`@livemira/contracts`

## Public API

Private workspace package, bundled into `@livemira/engine`.

- `rgbaToGray`: integer luma `(77R + 150G + 29B + 128) >> 8`.
- `standardize`, `StandardImageWorkspace`: draw a captured picture (RGBA, ImageBitmap or VideoFrame) into the standard
  image of its frame geometry, in the Worker.
- `matchHammingReference` and the WebAssembly exact matcher (`WasmExactMatcher`, `selectWasmExactMatcher`,
  `createWasmMatchOperator`): SIMD, then scalar, then JavaScript, all with identical results. The modules are generated
  from `src/matching/wasm/*.wat` by `npm run build:wasm`.
