# @livemira/renderer

Overlay renderer: perspective video plane, loading and reveal presentation, and the visual hold after target loss.

## Dependencies

`@livemira/contracts`, `@livemira/media`

## Public API

Private workspace package, bundled into `@livemira/engine`.

- `OverlayRenderer`: places a perspective video plane on each presentable result with the geometry of its own frame,
  owns the active target's video session, the loading mask with circular reveal and the visual hold after a loss, and
  reports media states, blocked playback and media failures.
- `VideoPlane`, `PlanePresentation`, `homographyFromCorners`, `cssMatrix`, `MAX_LOSS_DISPLAY_GRACE_MS`.
