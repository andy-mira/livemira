// SPDX-License-Identifier: Apache-2.0
// How well a compiled target will work, in stars (0.5–5), from what the engine ships for it (points, how many of the
// compiler's views found each, descriptors, template) and from the engine's own detector on synthetic views of it.
// Four factors, each 0..1:
//   detail          robust points (found in at least ROBUST_VIEWS of the compiler's views)
//   spread          those points over the picture: populated grid cells, evenness, the weakest quarter's share
//   distinctiveness robust points whose descriptors have no near twin elsewhere in the picture (a twin a few pixels
//                   away is the same corner seen at another scale and does no harm)
//   recognition     synthetic views the detector finds, five tests each a ladder of growing difficulty (smaller, more
//                   tilted, more motion blur, dimmer, more covered), each view tried twice and counted by its margin
//                   (inliers above the detector's minimum)
// The score is a weighted mean (0–100); the stars map it (STAR_RANGE) and are capped by the weaker of spread and
// recognition (CAP_CURVE): many points in one place, or none found in the synthetic views, cannot rate high. Weights
// are calibrated with bench/src/rate-targets.ts against bench/src/measure-targets.ts.

import type { GrayImage } from '@livemira-next/contracts';
import { cornersOf } from '@livemira-next/contracts';
import { decodeTarget, OrbDetector } from '@livemira-next/features';
import { invert3, solve4 } from '@livemira-next/geometry';
import { buildPyramid, sample } from '@livemira-next/imaging';

import type { RatingAdvice, RecognitionTest, TargetRating } from './api.ts';

/** A point is robust when at least this many of the compiler's 14 views found it. */
const ROBUST_VIEWS = 5;
/** Descriptors this close (bits of 256) to a point's at least TWIN_AWAY of the diagonal away are twins. */
const TWIN_BITS = 24;
const TWIN_AWAY = 0.08;
/** Weights of the score; with these it ranks the 28 pictures of bench/assets/target-set (and the LiveMorae demo
 * photo) like their measured difficulty in the bench's scene (bench/src/measure-targets.ts), Spearman ≈ 0.6. */
const WEIGHTS = { detail: 0.15, spread: 0.4, distinctiveness: 0.05, recognition: 0.4 } as const;
/** The weighted share of views found that counts as no and as full recognition (the best of those pictures: ~0.65). */
const RECOGNITION_RANGE = [0.1, 0.7] as const;
/**
 * Scores mapped to 0.5 and 5 stars, and the cap's curve (1 + 4 × min(spread, recognition) ** CAP_CURVE): fitted to
 * the midpoint of the first rating (most photos 5 stars) and the strict one that followed (most 3–4), which users
 * found too high and too low; those pictures average 4 stars.
 */
const STAR_RANGE = [15, 95] as const;
const CAP_CURVE = 0.4;
/** Below these a test is named in the advice (about the weakest quarter of those pictures). */
const FAILS: Readonly<Record<RecognitionTest, number>> = { size: 0.08, tilt: 0.15, blur: 0.33, dim: 0.6, covered: 0.6 };

const ramp = (value: number, low: number, high: number): number =>
  value <= low ? 0 : value >= high ? 1 : (value - low) / (high - low);

/** Synthetic camera frames of the target, as the detector would see them: 640 × 360, a 65° field of view. */
const FRAME_W = 640;
const FRAME_H = 360;
const FOCAL = 500;
const BACKGROUND = 118;

interface View {
  readonly name: string;
  readonly test: RecognitionTest;
  /** Long edge of the target in the frame, px. */
  readonly longPx: number;
  /** Turned away from the camera about its horizontal axis, degrees. */
  readonly tiltDeg?: number;
  /** Horizontal motion blur, px. */
  readonly blurPx?: number;
  /** Contrast around the background's gray (dim light), with sensor noise. */
  readonly gain?: number;
  /** Quarters covered (0 top-left … 3 bottom-right). */
  readonly covered?: readonly number[];
  /** Turned in the frame, degrees, and moved off centre, px: each view is tried twice, held a little differently. */
  readonly rollDeg: number;
  readonly offset: readonly [number, number];
}

type Step = Omit<View, 'rollDeg' | 'offset'>;
/** Each test a ladder of growing difficulty, each step held two ways; a test scores the views the detector finds. */
const VIEWS: readonly View[] = [
  ...[160, 120, 90, 70].map((longPx): Step => ({ name: `size-${longPx}`, test: 'size', longPx })),
  ...[45, 60, 70].map((tiltDeg): Step => ({ name: `tilt-${tiltDeg}`, test: 'tilt', longPx: 240, tiltDeg })),
  ...[6, 10, 16].map((blurPx): Step => ({ name: `blur-${blurPx}`, test: 'blur', longPx: 240, blurPx })),
  ...[0.35, 0.2].map((gain): Step => ({ name: `dim-${gain}`, test: 'dim', longPx: 240, gain })),
  ...[[0], [1], [2], [3], [0, 2], [1, 3], [0, 1], [2, 3]].map((covered): Step => ({
    name: `covered-${covered.join('')}`,
    test: 'covered',
    longPx: 240,
    covered,
  })),
].flatMap((step) => [
  { ...step, rollDeg: 8, offset: [24, 12] as const },
  { ...step, rollDeg: -12, offset: [-30, -8] as const },
]);
/** Inliers of a found view from which it starts to count (the detector accepts 12) and counts in full. */
const MARGIN_INLIERS = [12, 40] as const;
const TEST_WEIGHTS: Readonly<Record<RecognitionTest, number>> = {
  size: 0.25,
  tilt: 0.2,
  blur: 0.2,
  dim: 0.15,
  covered: 0.2,
};

/** Frame-from-target homography of a view. */
function viewHomography(v: View, tw: number, th: number): Float64Array {
  const s = v.longPx / Math.max(tw, th);
  const w = tw * s;
  const h = th * s;
  const cx = FRAME_W / 2 + v.offset[0];
  const cy = FRAME_H / 2 + v.offset[1];
  let quad: [number, number][] = [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ];
  // A pinhole camera FOCAL px from the picture's centre: the near edge wider, the picture shorter.
  if (v.tiltDeg) {
    const a = (v.tiltDeg * Math.PI) / 180;
    quad = quad.map(([x, y]) => {
      const z = FOCAL + (y - cy) * Math.sin(a);
      return [cx + ((x - cx) * FOCAL) / z, cy + ((y - cy) * Math.cos(a) * FOCAL) / z];
    });
  }
  const r = (v.rollDeg * Math.PI) / 180;
  quad = quad.map(([x, y]) => [
    cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r),
    cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r),
  ]);
  const target = Float64Array.from([0, 0, tw, 0, tw, th, 0, th]);
  const image = Float64Array.from(quad.flat());
  return solve4(target, image, [0, 1, 2, 3])!;
}

/** Renders a view: the template warped into a gray frame with faint deterministic noise, sampled at the pyramid level
 * that matches its size on screen; then dimmed, blurred along x. */
function renderView(pyramid: ReturnType<typeof buildPyramid>, v: View, H: Float64Array): GrayImage {
  const template = pyramid.levels[0]!;
  const scale = v.longPx / Math.max(template.width, template.height);
  const level = Math.max(0, Math.min(pyramid.levels.length - 1, Math.floor(Math.log2(1 / scale))));
  const image = pyramid.levels[level]!;
  const k = 2 ** level;
  const inverse = invert3(H)!;
  const data = new Uint8Array(FRAME_W * FRAME_H);
  let seed = 12345;
  const hw = template.width / 2;
  const hh = template.height / 2;
  for (let y = 0; y < FRAME_H; y++)
    for (let x = 0; x < FRAME_W; x++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      let value = BACKGROUND + ((seed >>> 16) % 9) - 4;
      const px = x + 0.5;
      const py = y + 0.5;
      const w = inverse[6]! * px + inverse[7]! * py + inverse[8]!;
      const u = (inverse[0]! * px + inverse[1]! * py + inverse[2]!) / w;
      const t = (inverse[3]! * px + inverse[4]! * py + inverse[5]!) / w;
      if (u >= 0 && t >= 0 && u < template.width && t < template.height) {
        const quarter = (t < hh ? 0 : 2) + (u < hw ? 0 : 1);
        if (!v.covered?.includes(quarter)) {
          const s = sample(
            image,
            Math.min(image.width - 0.51, Math.max(0.5, u / k)),
            Math.min(image.height - 0.51, Math.max(0.5, t / k)),
          );
          if (!Number.isNaN(s)) value = s;
        }
      }
      if (v.gain !== undefined) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        value = BACKGROUND + (value - BACKGROUND) * v.gain + ((seed >>> 16) % 13) - 6;
      }
      data[y * FRAME_W + x] = Math.max(0, Math.min(255, Math.round(value)));
    }
  if (v.blurPx) {
    const half = Math.floor(v.blurPx / 2);
    const row = new Float64Array(FRAME_W + 1);
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) row[x + 1] = row[x]! + data[y * FRAME_W + x]!;
      for (let x = 0; x < FRAME_W; x++) {
        const a = Math.max(0, x - half);
        const b = Math.min(FRAME_W, x - half + v.blurPx);
        data[y * FRAME_W + x] = Math.round((row[b]! - row[a]!) / (b - a));
      }
    }
  }
  return { width: FRAME_W, height: FRAME_H, stride: FRAME_W, data };
}

/** Rates a compiled target (the bytes of a `livemira-target/2` bundle, as the engine's `compileTargetImage` makes). */
export async function rateCompiledTarget(bytes: Uint8Array): Promise<TargetRating> {
  const asset = await decodeTarget(bytes);
  const { compiled, template } = asset;
  const { width, height } = compiled.info;
  const n = compiled.points.length / 2;

  // Detail: points found again in many of the compiler's views.
  const robust: number[] = [];
  for (let i = 0; i < n; i++) if (compiled.repeatability[i]! >= ROBUST_VIEWS) robust.push(i);
  const points = new Float32Array(2 * robust.length);
  robust.forEach((p, i) => {
    points[2 * i] = compiled.points[2 * p]!;
    points[2 * i + 1] = compiled.points[2 * p + 1]!;
  });
  const detail = ramp(robust.length, 40, 250);

  // Spread: a grid shaped like the picture (about 16 cells), evenness, and the weakest quarter.
  const aspect = width / height;
  const columns = Math.max(2, Math.round(4 * Math.sqrt(aspect)));
  const rows = Math.max(2, Math.round(4 / Math.sqrt(aspect)));
  const counts = new Array<number>(columns * rows).fill(0);
  const quarters = [0, 0, 0, 0];
  for (let i = 0; i < robust.length; i++) {
    const x = points[2 * i]!;
    const y = points[2 * i + 1]!;
    counts[
      Math.min(rows - 1, Math.floor((y / height) * rows)) * columns +
        Math.min(columns - 1, Math.floor((x / width) * columns))
    ]!++;
    quarters[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!++;
  }
  const total = Math.max(1, robust.length);
  const cells = columns * rows;
  const populatedCells = counts.filter((c) => c >= Math.max(3, (0.3 * total) / cells)).length;
  const concentration = counts.reduce((s, c) => s + (c / total) ** 2, 0);
  const evenness = robust.length ? 1 / concentration / cells : 0;
  const weakestIndex = quarters.indexOf(Math.min(...quarters));
  const weakestShare = quarters[weakestIndex]! / total;
  // Cells and evenness say whether the detail fills the picture; an empty quarter takes off up to 40%.
  const spread =
    (0.5 * ramp(populatedCells / cells, 0.3, 0.85) + 0.5 * ramp(evenness, 0.25, 0.65)) *
    (0.6 + 0.4 * ramp(weakestShare, 0.03, 0.15));

  // Distinctiveness: robust points none of whose descriptors has a twin among the descriptors of points far from it.
  const d32 = new Uint32Array(
    compiled.descriptors.buffer,
    compiled.descriptors.byteOffset,
    compiled.descriptors.length / 4,
  );
  const ofPoint: number[][] = Array.from({ length: n }, () => []);
  compiled.descriptorPoint.forEach((p, d) => ofPoint[p]!.push(d));
  const away = (TWIN_AWAY * Math.hypot(width, height)) ** 2;
  const hamming = (a: number, b: number): number => {
    let bits = 0;
    for (let k = 0; k < 8; k++) {
      let v = (d32[8 * a + k]! ^ d32[8 * b + k]!) >>> 0;
      v -= (v >>> 1) & 0x55555555;
      v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
      bits += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    }
    return bits;
  };
  const hasFarTwin = (p: number): boolean => {
    const px = compiled.points[2 * p]!;
    const py = compiled.points[2 * p + 1]!;
    for (let q = 0; q < n; q++) {
      if ((compiled.points[2 * q]! - px) ** 2 + (compiled.points[2 * q + 1]! - py) ** 2 < away) continue;
      for (const a of ofPoint[p]!) for (const b of ofPoint[q]!) if (hamming(a, b) <= TWIN_BITS) return true;
    }
    return false;
  };
  const distinctShare = robust.length ? robust.filter((p) => !hasFarTwin(p)).length / robust.length : 0;
  const distinctiveness = ramp(distinctShare, 0.35, 0.7);

  // Recognition: the engine's detector on synthetic views, test by test.
  const detector = new OrbDetector();
  await detector.loadEncoded([bytes]);
  const pyramid = buildPyramid(template, 6, 16);
  const views: { name: string; test: RecognitionTest; found: boolean; margin: number }[] = [];
  for (const [i, v] of VIEWS.entries()) {
    const H = viewHomography(v, width, height);
    const truth = cornersOf(H, width, height);
    const found = await detector.detect({
      sessionId: 'rate',
      frameId: i + 1,
      time: { captureUs: i, receiveUs: i, source: 'replay' },
      image: { kind: 'cpu-gray', image: renderView(pyramid, v, H) },
    });
    const hit = found.find(
      (d) =>
        d.corners.reduce((s, c, k) => s + Math.hypot(c[0] - truth[k]![0], c[1] - truth[k]![1]), 0) / 4 <
        0.08 * v.longPx,
    );
    // A view found with few inliers is found by a narrow margin: it counts in part.
    views.push({
      name: v.name,
      test: v.test,
      found: !!hit,
      margin: hit ? ramp(hit.quality.support, MARGIN_INLIERS[0], MARGIN_INLIERS[1]) : 0,
    });
  }
  const tests = Object.fromEntries(
    (Object.keys(TEST_WEIGHTS) as RecognitionTest[]).map((test) => {
      const own = views.filter((v) => v.test === test);
      return [test, own.reduce((sum, v) => sum + v.margin, 0) / own.length];
    }),
  ) as Record<RecognitionTest, number>;
  const recognition = ramp(
    (Object.keys(TEST_WEIGHTS) as RecognitionTest[]).reduce((sum, test) => sum + TEST_WEIGHTS[test] * tests[test], 0),
    ...RECOGNITION_RANGE,
  );

  const score =
    100 *
    (WEIGHTS.detail * detail +
      WEIGHTS.spread * spread +
      WEIGHTS.distinctiveness * distinctiveness +
      WEIGHTS.recognition * recognition);
  const raw = Math.min(0.5 + 4.5 * ramp(score, ...STAR_RANGE), 1 + 4 * Math.min(spread, recognition) ** CAP_CURVE);
  const stars = Math.min(5, Math.max(0.5, Math.round(raw * 2) / 2));

  const advice: RatingAdvice[] = [];
  if (recognition < 0.4) advice.push('HARD_TO_FIND');
  if (spread < 0.6 && (populatedCells / cells < 0.6 || evenness < 0.45)) advice.push('CONCENTRATED');
  if (weakestShare < 0.08) advice.push('WEAK_QUARTER');
  if (detail < 0.5) advice.push('FEW_DETAILS');
  if (distinctiveness < 0.4) advice.push('REPETITIVE');
  if (tests.size < FAILS.size) advice.push('FAILS_SMALL');
  if (tests.tilt < FAILS.tilt) advice.push('FAILS_TILTED');
  if (tests.blur < FAILS.blur) advice.push('FAILS_BLURRED');
  if (tests.dim < FAILS.dim) advice.push('FAILS_DIM');
  if (tests.covered < FAILS.covered) advice.push('FAILS_COVERED');

  return {
    stars,
    score: Math.round(20 * raw),
    factors: { detail, spread, distinctiveness, recognition },
    metrics: {
      robustPoints: robust.length,
      grid: { columns, rows, counts },
      populatedCells,
      evenness,
      weakestQuarter: { index: weakestIndex, share: weakestShare },
      distinctShare,
      tests,
      views,
    },
    advice,
    points,
    width,
    height,
  };
}
