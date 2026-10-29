# @livemira/target-rating — target rating

[English](target-rating.md) | [简体中文](target-rating.zh-CN.md)

Rates a picture for scanning (0.5–5 stars), so a page where the user picks the target picture (an uploaded photo, or
the first, last or any frame of a video) can suggest a better one.

The rating is a separate module and **needs no engine**: a page that never opens the camera, such as a work editor,
loads this one file. In its own Worker it decodes, scales and compiles the picture as the engine's
`compileTargetImage` does, then runs the engine's own detector on synthetic views, so the rating is of exactly the
target the engine would track.

## Files

| File                                         | Purpose                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `files/livemira-target-rating.min.mjs`       | One ES module, Worker embedded (about 47 KB).                              |
| `files/livemira-target-rating.mjs`           | The same module, readable.                                                 |
| `files/livemira-target-rating-worker.min.js` | The rating Worker script (classic), for pages whose CSP forbids `blob:`.   |
| `files/livemira-target-rating.d.ts`          | Declarations.                                                              |
| `npm/livemira-target-rating-*.tgz`           | Offline package `@livemira/target-rating` (not on npm; `npm install` the file). |

Importing the module creates nothing; the first rating starts its Worker, which closes after 4 s idle. One picture is
rated at a time; the rest wait in order.

## Use

```js
import { rateTargetImage, RatingError } from './livemira-target-rating.min.mjs';

try {
  const rating = await rateTargetImage(photoFile, { signal });
  showStars(rating.stars); // 0.5…5 in halves
  if (rating.stars < 3) suggestAnotherFrame(rating.advice);
} catch (error) {
  if (error instanceof RatingError && error.code === 'UNSUITABLE_TARGET') showCannotUse(); // the engine would refuse it
  else if (error?.code !== 'ABORTED') throw error;
}
```

- `rateTargetImage(image, { signal?, workerUrl?, maxEdgePx = 640 })`: a picture file (JPEG, PNG, WebP, …; its own
  orientation applied). Keep `maxEdgePx` equal to the engine's `compileTargetImage`.
- `rateTarget(target, { signal?, workerUrl? })`: a compiled target, the engine's bundle (`compileTargetImage`,
  `parseTarget`) or its `bytes`.
- Abort the previous rating with `signal` when the picture changes. About 0.5 s per picture on a desktop, 1–2 s on a
  phone.
- `RatingError.code`: `UNSUITABLE_TARGET` (too small, or under 48 recognition points: the engine would refuse it),
  `DECODE_FAILED`, `INVALID_TARGET`, `INVALID_INPUT`, `WORKER_FAILED`, `ABORTED`.

## Result

`{ stars, score, factors: { detail, spread, distinctiveness, recognition }, metrics, advice, points, width, height }`.
5 stars: near the best on every count; 4–4.5 good; 3–3.5 usable (steady when frontal and near, loses the picture when
small, tilted or shaken); 2–2.5 better replaced; below, not recommended. Suggest another picture below 3 stars.

Factors (0..1): `detail` (points found in at least 5 of the compiler's 14 views), `spread` (those points over the
picture: grid cells, evenness, the weakest quarter), `distinctiveness` (no look-alikes far apart), `recognition` (the
detector on synthetic views, five tests from easy to hard: smaller, tilted, motion-blurred, dimmer, partly covered;
each view tried twice and counted by its margin; per test in `metrics.tests`). Score = 100 × (0.15 detail + 0.4 spread
+ 0.05 distinctiveness + 0.4 recognition); stars = 0.5 + 4.5 × the score's place between 15 and 95, capped at
1 + 4 × min(spread, recognition)^0.4: detail crowded in one place, or hardly found in the views, cannot rate high.

`advice`, most important first: `HARD_TO_FIND`, `CONCENTRATED`, `WEAK_QUARTER` (`metrics.weakestQuarter`),
`FEW_DETAILS`, `REPETITIVE`, and `FAILS_SMALL`, `FAILS_TILTED`, `FAILS_BLURRED`, `FAILS_DIM`, `FAILS_COVERED` (that
test clearly weaker than for most photos). `points` are the counted points in target pixels (`width` × `height`), for
drawing the spread over the picture.

Calibrated on 28 public pictures (the set 0.4.1's samples come from) and the LiveMorae demo photo against their
measured difficulty in simulation (rank correlation ~0.6); the stars were tuned in two rounds of use on phones,
between a lenient and a strict version (those pictures average 4). The demo's `rate.html` is a complete rating page.

## CSP and browsers

The Worker starts from a `blob:` URL: allow `worker-src blob:`, or serve `livemira-target-rating-worker.min.js` and
pass `workerUrl`. No WebAssembly, no network requests. Needs Workers and `createImageBitmap`; pictures are decoded in
the Worker with `OffscreenCanvas` 2D, else on the page.

## Version

Built apart from the engine (its own build id; `release-manifest.json` lists both under `modules`): a change to the
rating leaves the engine's files as they are. `RATING_VERSION` and `ratingBuildInfo` give the version and build id.

## License

Apache-2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
