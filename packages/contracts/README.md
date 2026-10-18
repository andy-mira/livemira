# @livemira/contracts

Shared core contracts: frame, geometry, target, tracking result, error and event types, plus a few pure helpers used by several packages.

## Dependencies

none

## Public API

Private workspace package, bundled into `@livemira/engine`; applications use the engine's entry.

- `EngineError` and the closed `ErrorCode` set.
- Types: `Frame`, `FrameImage`, `FrameTiming`, `FrameGeometry`, `RectPx`, `TargetBundle`, `TrackingResult`,
  `TrackingState`, `TrackingReason`, `MatchedPoints`, `EventContext`, `CoreEvents`, `ViewportTransition`.
- Helpers: `validateTargetBundle`, `normalizeHomography`, `IDENTITY_3`, `MAX_MATCHED_POINTS`.
