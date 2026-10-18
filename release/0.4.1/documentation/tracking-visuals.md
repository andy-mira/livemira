# @livemira/tracking-visuals

[English](tracking-visuals.md) | [简体中文](tracking-visuals.zh-CN.md)

Optional engine extension that draws, over the camera picture, the recognized target boundary and the current
matched inlier points. Built as its own module (`livemira-tracking-visuals.min.mjs`); the engine never loads it.

```js
import { createEngine } from './livemira-engine.min.mjs';
import { createTrackingVisuals } from './livemira-tracking-visuals.min.mjs';

const visuals = createTrackingVisuals({ boundary: true, points: true });
const engine = createEngine({ container, extensions: [visuals] });
visuals.setVisualization({ boundary: true, points: false }); // any time
```

- **Boundary**: drawn for every presented TRACKING or LIMITED result — green when measured, amber dashed for a
  short prediction.
- **Points**: the matched inlier points of the same, measured result; a prediction has none. Points need matched
  points from the Worker, which the engine requests only if the extension was created with `points: true`.
- The drawing is cleared whenever the engine hides the video plane, holds it after a loss, stops, starts a new
  session, the page is hidden, or the shown target's media fails or is replaced.
- `getDiagnostics()` returns counts only, never coordinates.

These are drawings of the engine's own geometry: they do not prove that recognition is correct.

| API                                       |                                                                 |
| ----------------------------------------- | --------------------------------------------------------------- |
| `createTrackingVisuals(options?)`         | `{ boundary?: boolean, points?: boolean }`, both default false. |
| `setVisualization(options)`               | Changes the switches.                                           |
| `getVisualization()` / `getDiagnostics()` | Current switches; shown boundary and point count.               |
| `currentMatchedPoints(result)`            | The current measured inlier points of a result, or null.        |

Apache-2.0.
