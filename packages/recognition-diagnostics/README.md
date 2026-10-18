# @livemira/recognition-diagnostics

[English](README.md) | [简体中文](README.zh-CN.md)

Optional engine extension that aggregates bounded numeric recognition diagnostics: **why** targets were rejected
(by stage, reason code and recognition pass), how long the recognition stages took, and **where** the matched points
of measured results lie on the target (hull coverage, dispersion, isotropy). No pictures, URLs or point arrays are
kept, so a snapshot is safe to add to a diagnostic log. Built as its own module
(`livemira-recognition-diagnostics.min.mjs`); the engine never loads it.

```js
import { createRecognitionDiagnostics } from './livemira-recognition-diagnostics.min.mjs';

const recognition = createRecognitionDiagnostics();
const engine = createEngine({ container, diagnostics: log, extensions: [recognition] });
// later
log.setSection('recognition', recognition.snapshot());
```

The extension asks the engine for recognition traces and matched points (fixed when the engine is created) and reads
target sizes from the engine. Rejection stages describe the recognizer's single-frame candidate checks, not whether
the tracker accepted a result; the point distribution counts only measured TRACKING results.

| API                                                                           |                                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRecognitionDiagnostics(options?)`                                      | `maxSessions` 1..16 (4), `maxTargets` 1..32 (16), `maxReasons` 1..64 (24), `minDispersionIntervalMs` 0..60000 (200), `nowMs`.                                             |
| `snapshot()`                                                                  | Schema `livemira-recognition-diagnostics/2`: per session recognition counts, stage timing, per-pass statistics, results, dispersion and per-target counts; drop counters. |
| `reset(sessionId?)`                                                           | Forgets one session or all; late events of a forgotten session are dropped.                                                                                               |
| `observeRecognition(trace)` / `observeResult(result)` / `setTargets(targets)` | For hosts that feed it themselves.                                                                                                                                        |
| `dispose()`                                                                   | Releases everything.                                                                                                                                                      |

Apache-2.0.
