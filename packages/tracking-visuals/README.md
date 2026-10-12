# Optional tracking visuals

This independently loaded RenderSink decorator draws recognized target boundaries and current matched inlier points. The core engine never imports it. Both drawing flags and core point collection default off.

Build: `npm run build` produces `dist/tracking-visuals-single/lm-tracking-visuals.mjs` and `.min.mjs`, self-contained declarations, and a closure/hash audit. Either companion runtime has no imports, Worker, WASM or recorder; copy it beside your own assets and import only when wanted. The separate target-quality utility stays independent.

```js
import {CssVideoRenderSink, createWorkerPipeline, createEngine} from './lm-engine.min.mjs';
import {TrackingVisualRenderSink} from './lm-tracking-visuals.min.mjs';
const base = new CssVideoRenderSink({geometryForResult});
const renderer = new TrackingVisualRenderSink({base, geometryForResult, boundary: true, points: true});
const pipeline = createWorkerPipeline({prepareFrame, options: {collectMatchedPoints: true}});
const engine = createEngine({source, pipeline, renderer});
```

`geometryForResult` must resolve the captured standard-image→viewport transform for that exact session and frame. Yellow dots come from the accepted observation's actual inliers; they are absent during prediction, acquisition and loss. Green boundaries become dashed amber during a valid short prediction. Loss clears auxiliary geometry immediately even while the video stays visible for its configured 500 ms grace. Stop, background, errors and target or session replacement clear it too. An asynchronous old update cannot repopulate a new session.

`renderer.setVisualization({boundary, points})` changes drawing on the next valid frame and clears old geometry immediately; neither flag starts a camera. Collection is fixed per Worker pipeline, so toggling collection requires recreating the pipeline. The decorator owns base renderer disposal and forwards engine events. Media convenience methods may be called on `base`; its media events invalidate old auxiliary geometry. Use `clearMediaFailure()` only after a successful gesture retry.

Package exports: `@livemira/engine/tracking-visuals` (the minified standalone file), `/tracking-visuals/single` (readable) and `/tracking-visuals/single/min`; the SDK-only multi-file module is `@livemira/engine/development/tracking-visuals`. Full integration is in `packages/sdk/README.md` (shipped as `INTEGRATION.md` in the `docs` directory of the package).
