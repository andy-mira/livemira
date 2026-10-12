# CPU target compiler

[English](README.md) | [简体中文](README.zh-CN.md)

Compiles a packed gray8 image into a `TargetBundle` (features, descriptors and a gray8 pyramid), serializes it with a checksum envelope, and parses it back with full validation. The adapter imports `@livemira/contracts` 0.1.0. Entry: `src/index.ts`; the package entry `index.mjs` uses the root build. There is no external runtime dependency and no copied reference source.

```ts
import { compileGrayTarget, serializeTarget, parseTarget } from '@livemira/target-compiler';
const target = await compileGrayTarget({width, height, data: packedGray8}, {
  targetId: 'poster-1', physicalWidthMeters: null,
});
const saved = await serializeTarget(target);
const loaded = await parseTarget(saved);
```

Input must already be upright, unmirrored, packed gray8. Image decoding, EXIF orientation, color conversion and camera geometry belong to the caller; this compiler does not implement those conversions. The hash is SHA-256 of the canonical gray8 bytes, explicitly `imageHashDomain: canonical-gray8`; an absent physical width stays null. Input pixels and dimensions are snapshotted before asynchronous hashing.

## Algorithms

- **Legacy (default), `m0-harris-brief256-v1`**: builds a box2 pyramid (rounded 2x2 average), extracts Harris corners with fixed seeded 256-bit upright BRIEF-style descriptors after box3 smoothing, and diagnoses low count, low convex-hull coverage and repeated descriptors. The descriptor is **not ORB or MindAR compatible** and is not rotation invariant. Features keep original-image pixel-center coordinates; pyramid coordinates map as `(p+0.5)*scale-0.5`. Original-target edges for rendering stay `(0,0),(width,0),(width,height),(0,height)`. Compiler `webar-gray8-cpu/0.1.0`, 384 features and three box2 levels by default.
- **ANMS, `m0-harris-anms-brief256-v1`**: the same detector, descriptor and matcher with adaptive non-maximal suppression for the per-level selection.
- **Oriented, `c-oriented-brief256-v2` (opt-in)**: `compileGrayTarget(gray, {targetId, algorithmVersion: 'c-oriented-brief256-v2'})` produces compiler `webar-gray8-cpu/0.2.0`, 512 features and six 1.2x levels by default, with preprocessing `bilinear-1.2-center` / `binomial3` / `intensity-centroid-r12`. Up to eight levels are accepted; the actual depth stops when either dimension would fall below 40. Features carry original pixel-center coordinates, and the geometry and render edges are unchanged.

Both parser paths enforce their exact compiler, algorithm and preprocessing tuple; changing a string does not migrate a bundle. Preserve the original pixels and recompile. The shared `TargetBundle` schema stays 1 and the descriptor length stays 32 bytes.

Bounds: 32..4096 per dimension, at most 4,194,304 pixels, 1..4 pyramid levels for the legacy algorithms, 16..512 requested features (default 384). Spatial quotas can yield fewer actual features. Public descriptor storage is a flat byte-valued number array with stride 32; the pyramid holds gray8 pixel arrays. Per-feature level and score stay internal because the public `FeatureSet` does not include them.

## Serialization

The envelope is JSON `{payload: string, sha256: string}`; the checksum covers the exact UTF-8 payload bytes. The payload is a contracts `TargetBundle` schema 1. The parser caps total UTF-8 bytes at 24,000,000 before JSON parsing, verifies the checksum, runs the shared structural validation, checks the algorithm, compiler, domain and bounds, pyramid consistency, descriptor byte ranges and the canonical gray8 hash. The checksum detects corruption; it is not authenticity. In-memory target input is trusted for descriptor provenance: matching cannot prove an adversarial publisher actually compiled those descriptors. JSON parsing and array storage cost memory and time; this is not a packed production format. Diagnostics are recomputed by recognition, so forged diagnostics cannot override quality rejection.

`experimental/bundle.mjs` is an isolated Node-only format (`webar-m0-experiment/1`, no pyramid pixels). The public adapter rejects it on purpose and it must not be loaded into the SDK. Its standalone raw-gray CLI is:

```sh
node packages/target-compiler/experimental/cli.mjs input.gray 320 240 poster-1 output.json
```

The CLI refuses existing output files. The raw file must be exactly width*height bytes. No original encoded-image hash is claimed.

## Build

From the repository root after `npm ci`:

```sh
node node_modules/typescript/bin/tsc -p packages/target-compiler/tsconfig.json
```

## Provenance

Original implementation. Public projects (MindAR, MIT; OpenCV, Apache-2.0) were consulted as reading material only; none of their code was copied or linked. Synthetic test fixtures are generated rectangles and checkers and need no external image license.
