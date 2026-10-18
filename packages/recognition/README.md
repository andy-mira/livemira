# @livemira/recognition

Target recognition on standard gray images: feature extraction (Harris, ANMS, BRIEF-256), descriptor matching, geometric verification, scale retry, and validation of compiled targets.

## Dependencies

`@livemira/contracts`

## Public API

Private workspace package, bundled into the engine's Worker.

- `Recognizer`: feature extraction, retrieval, exact matching and geometric verification of one standard gray image
  against the loaded targets, with the half-octave scale retry.
- `extractFeatures` (Harris corners, ANMS selection, BRIEF-256 over a 3-level pyramid), `hamming`, `matchPacked`,
  `verifyGeometry`, `fitHomography`, `hullArea`.
- Target validation: `validateTarget`, `preflightTarget`, `featuresFromTarget`, `diagnoseFeatures`,
  `ALGORITHM_VERSION`, `COMPILER_VERSION`.
- `traceOf`, `traceForFrame`: the bounded recognition trace; `pointDistribution` for the target quality score.
