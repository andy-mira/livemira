# @livemira/target-quality

[English](README.md) | [简体中文](README.zh-CN.md)

Scores how suitable a picture is as a target, 0 to 5, before you compile it. It runs the engine's own feature
extraction on the picture, so it measures what the compiler would compile. Built as its own module
(`livemira-target-quality.min.mjs`); it does not need the engine.

```js
import { assessTargetImage } from './livemira-target-quality.min.mjs';

const result = await assessTargetImage(file);
if (result.shouldReplace) alert(result.advice);
```

**Score formula 2.0.0.** Five conditions for a stable pose, each a 0..1 ramp whose anchors come from engine constants:
feature **support** (24 → 192 features), hull **coverage** (15% → 60%), **dispersion** of the features over the
picture, **conditioning** (how evenly they spread in every direction) and **uniqueness** (few near-duplicate
descriptors). Score = 5 × (0.5 × mean + 0.5 × minimum), so one failing condition cannot be hidden; an image the
compiler would reject is capped at 2. Below 3 the advice is to replace the picture.

The score is a heuristic preflight, not a calibrated probability of recognition: a picture scoring 3 or more can still
fail on a device. Contrast is reported but not scored.

| API                                                      |                                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `assessTargetImage(blob, options?)`                      | Decodes the file locally and scores it. Options: `signal`, `maxImageBytes`, `maxPixels`, `environment`. |
| `assessGrayTarget(gray)`                                 | Scores a gray8 image `{ widthPx, heightPx, data }`; synchronous.                                        |
| `analyzeTargetImage` / `analyzeGrayTarget`               | The same, plus the template feature points behind the score.                                            |
| `drawTemplateFeatures(context, features, box, options?)` | Draws the template features as hollow rings (static; never live matches).                               |
| `scoreMetrics(input)`                                    | The pure scoring step.                                                                                  |

Pictures are reduced to a 640-pixel long edge before scoring, as the compiler does. Nothing is uploaded; decode
resources are released on success, error and abort.

Apache-2.0.
