# @livemira/tracking

Tracking state machine that turns per-frame recognition into confirmed, measured, predicted and lost results.

## Dependencies

`@livemira/contracts`, `@livemira/recognition`

## Public API

Private workspace package, bundled into the engine's Worker.

- `Tracker`: confirms a new target over three observations at least 50 ms apart, then reports measured results,
  short predictions (`PREDICTION_LIMIT_US`, 100 ms) and losses; `checkObservation` checks one observation.
