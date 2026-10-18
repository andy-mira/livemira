# @livemira/target-compiler

Compiles gray images into target bundles and serializes or parses them with an integrity envelope.

## Dependencies

`@livemira/contracts`, `@livemira/recognition`

## Public API

Private workspace package; the engine re-exports its functions.

- `compileGrayTarget(image, { targetId, physicalWidthMeters? })`: base image plus two pyramid levels, at most 384 ANMS
  features with BRIEF-256 descriptors, image hash and quality diagnostics.
- `serializeTarget`, `parseTarget`: format v1 with a SHA-256 integrity envelope.
