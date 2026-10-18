/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Optional target-image suitability preflight. It runs the engine's own feature extraction on the picture, so it
// measures what the target compiler would compile. The score is a conservative heuristic for "is this picture worth
// using as a target", not a detection probability, a recognition guarantee or another vendor's rating. Every formula
// step uses only + - * / comparisons and Math.round/floor, so the result is identical across JavaScript engines.
// Nothing in the engine imports this module.

import { EngineError, type Point2 } from '@livemira/contracts';
import {
  ALGORITHM_VERSION,
  extractFeatures,
  hamming,
  hullArea,
  pointDistribution,
  TARGET_LEVELS,
  TARGET_MAX_FEATURES,
  type GrayImage,
} from '@livemira/recognition';

export const SCORER_NAME = 'webar-target-suitability';
export const SCORER_VERSION = '2.0.0';
export const RESULT_SCHEMA = 'livemira-target-quality/3';
export const MAX_SCORE = 5;
/** Below this published score the advice is to replace the image (decided on the rounded score). */
export const REPLACE_BELOW = 3;
export const MAX_LONG_EDGE = 640;
export const MAX_IMAGE_BYTES = 24_000_000;
export const MAX_INPUT_PIXELS = 16_777_216;
export const MAX_INPUT_DIMENSION = 8192;
export const MIN_DIMENSION = 32;
const GRID = 4;
export const DISCLAIMER =
  'Heuristic preflight of image suitability only. It is not a calibrated probability of detection, does not guarantee recognition and is not a Vuforia or ARCore rating. A score of 3 or more can still fail on a device.';

export type ReasonSeverity = 'blocker' | 'warning' | 'info';
export type ReasonCode =
  | 'LOW_FEATURE_COUNT'
  | 'LOW_COVERAGE'
  | 'CLUSTERED_FEATURES'
  | 'DEGENERATE_GEOMETRY'
  | 'REPETITIVE_PATTERN'
  | 'LOW_CONTRAST'
  | 'LOW_RESOLUTION'
  | 'DOWNSCALED';

export interface QualityReason {
  readonly code: ReasonCode;
  readonly severity: ReasonSeverity;
  readonly message: string;
  readonly metric: string;
  readonly value: number;
  readonly threshold: number;
}

export interface QualityMetrics {
  readonly featureCount: number;
  readonly featuresPerLevel: readonly number[];
  readonly hullCoverage: number;
  readonly occupiedCells: number;
  readonly effectiveCells: number;
  readonly nearDuplicateRatio: number;
  readonly ambiguousRatio: number;
  readonly medianNearestDistance: number;
  readonly contrastRange: number;
  /** Target-normalized spread of the features (see the score formula). */
  readonly dispersion: number;
  readonly isotropy: number;
}

/** Each sub-score is a 0..1 ramp. */
export interface QualitySubscores {
  readonly support: number;
  readonly coverage: number;
  readonly dispersion: number;
  readonly conditioning: number;
  readonly uniqueness: number;
}

export interface QualityNormalization {
  readonly id: string;
  readonly grayFormula: string;
  readonly maxLongEdge: number;
  readonly inputWidthPx: number;
  readonly inputHeightPx: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly scale: number;
  readonly resampling: 'none' | 'box-area' | 'canvas-draw-image';
}

export interface TargetQualityResult {
  readonly schema: typeof RESULT_SCHEMA;
  readonly scorer: { readonly name: string; readonly version: string };
  readonly algorithm: {
    readonly version: string;
    readonly maxFeatures: number;
    readonly levels: number;
  };
  readonly normalization: QualityNormalization;
  /** 0..5, at most one decimal. */
  readonly score: number;
  readonly maxScore: 5;
  /** Unrounded value (3 decimals) for diagnosing near-threshold results; decisions use `score`. */
  readonly rawScore: number;
  /** Exactly `score < 3`. */
  readonly shouldReplace: boolean;
  readonly advice: string;
  readonly metrics: QualityMetrics;
  readonly subscores: QualitySubscores;
  readonly reasons: readonly QualityReason[];
  readonly disclaimer: string;
}

/** The template feature points behind a score, in normalized-image pixels, for static display; never live matches. */
export interface TemplateFeaturePreview {
  readonly algorithmVersion: string;
  readonly maxFeatures: number;
  readonly levels: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly points: readonly { readonly x: number; readonly y: number; readonly level: number }[];
}

export interface TargetAnalysis {
  readonly result: TargetQualityResult;
  readonly features: TemplateFeaturePreview;
}

const invalidInput = (message: string): never => {
  throw new EngineError('INVALID_CONFIG', message, { isRecoverable: false });
};
const invalidImage = (message: string): never => {
  throw new EngineError('INVALID_TARGET', message, { isRecoverable: false });
};

// ---- Score formula 2.0.0 ----
// Five necessary conditions for a stable pose from a template, each a 0..1 ramp whose anchors come from engine
// constants or from the definition of the measure, not from any image set:
//   support      usable template features      0 at 24 (the compiler's minimum) .. 1 at 192 (half the 384 budget)
//   coverage     convex hull / target area     0 at 15% (the compiler's gate)   .. 1 at 60%
//   dispersion   (var u + var v) / (2/12)      0 at 0.15 .. 1 at 0.55
//   conditioning 4 det(C) / trace(C)²          0 at 0.10 .. 1 at 0.50 (0 = collinear, a degenerate homography fit)
//   uniqueness   worse of near-duplicate and similar descriptor ratios (repeats make matches ambiguous)
// Equal weights; score = 5 × (0.5 × mean + 0.5 × min), so one failing condition cannot be hidden by strong others.
// Contrast is reported but not scored. The mapping to 0..5 is an explainable heuristic without labeled calibration.
const ramp = (value: number, low: number, high: number): number =>
  value <= low ? 0 : value >= high ? 1 : (value - low) / (high - low);
const round = (value: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
export const WEIGHT = 0.2;
const WEAKEST_LINK_SHARE = 0.5;
/** Compile blockers cap the score here, so such an image always lands below REPLACE_BELOW. */
export const BLOCKER_CAP = 2;

const isInRange = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

export interface ScoringInput {
  readonly metrics: QualityMetrics;
  readonly blockers: number;
}

function validateScoringInput(input: ScoringInput): ScoringInput {
  const m = (input as Partial<ScoringInput> | null)?.metrics;
  const blockers = (input as Partial<ScoringInput> | null)?.blockers;
  const levels = m?.featuresPerLevel;
  if (
    !m ||
    typeof m !== 'object' ||
    !Number.isInteger(blockers) ||
    (blockers as number) < 0 ||
    (blockers as number) > 16 ||
    !Array.isArray(levels) ||
    levels.length !== TARGET_LEVELS ||
    !levels.every((c) => isInRange(c, TARGET_MAX_FEATURES)) ||
    !isInRange(m.featureCount, TARGET_MAX_FEATURES) ||
    !isInRange(m.hullCoverage, 1) ||
    !isInRange(m.occupiedCells, GRID * GRID) ||
    !isInRange(m.effectiveCells, GRID * GRID) ||
    !isInRange(m.nearDuplicateRatio, 1) ||
    !isInRange(m.ambiguousRatio, 1) ||
    !isInRange(m.medianNearestDistance, 256) ||
    !isInRange(m.contrastRange, 255) ||
    !isInRange(m.dispersion, 1) ||
    !isInRange(m.isotropy, 1)
  )
    invalidInput(
      `Invalid scoring input: expected finite metrics within their bounds (featureCount 0..${TARGET_MAX_FEATURES}, ${TARGET_LEVELS} per-level counts, ratios 0..1, effectiveCells 0..${GRID * GRID}, contrastRange 0..255, dispersion and isotropy 0..1) and an integer blocker count 0..16`,
    );
  return input;
}

/** The pure scoring step: metrics → sub-scores and the published score. */
export function scoreMetrics(input: ScoringInput): {
  subscores: QualitySubscores;
  score: number;
  rawScore: number;
} {
  const { metrics, blockers } = validateScoringInput(input);
  const subscores: QualitySubscores = {
    support: ramp(metrics.featureCount, 24, 192),
    coverage: ramp(metrics.hullCoverage, 0.15, 0.6),
    dispersion: ramp(metrics.dispersion, 0.15, 0.55),
    conditioning: ramp(metrics.isotropy, 0.1, 0.5),
    uniqueness:
      metrics.featureCount < 2
        ? 0
        : Math.min(
            ramp(-metrics.nearDuplicateRatio, -0.35, -0.05),
            ramp(-metrics.ambiguousRatio, -0.6, -0.15),
          ),
  };
  const values = Object.values(subscores);
  const mean = values.reduce((sum, v) => sum + WEIGHT * v, 0);
  let raw =
    MAX_SCORE * ((1 - WEAKEST_LINK_SHARE) * mean + WEAKEST_LINK_SHARE * Math.min(...values));
  if (blockers > 0) raw = Math.min(raw, BLOCKER_CAP);
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw * 10) / 10));
  return {
    subscores: Object.fromEntries(
      Object.entries(subscores).map(([k, v]) => [k, round(v, 3)]),
    ) as unknown as QualitySubscores,
    score,
    rawScore: round(raw, 3),
  };
}

function buildReasons(
  metrics: QualityMetrics,
  subscores: QualitySubscores,
  normalization: QualityNormalization,
): QualityReason[] {
  const reasons: QualityReason[] = [];
  const add = (
    code: ReasonCode,
    severity: ReasonSeverity,
    message: string,
    metric: string,
    value: number,
    threshold: number,
  ): void =>
    void reasons.push({ code, severity, message, metric, value: round(value, 3), threshold });
  if (metrics.featureCount < 24)
    add(
      'LOW_FEATURE_COUNT',
      'blocker',
      `Only ${metrics.featureCount} usable corner features; the engine needs at least 24 to compile a target. Use a picture with fine, high-contrast detail (text, foliage, texture, edges) over its whole area; avoid plain, blurry or smooth images.`,
      'featureCount',
      metrics.featureCount,
      24,
    );
  else if (metrics.featureCount < 96)
    add(
      'LOW_FEATURE_COUNT',
      'warning',
      `Only ${metrics.featureCount} corner features; detail is thin. A picture with more fine detail gives the pose fit more to work with.`,
      'featureCount',
      metrics.featureCount,
      96,
    );
  if (metrics.hullCoverage < 0.15)
    add(
      'LOW_COVERAGE',
      'blocker',
      `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image; the engine needs at least 15%. Use a picture whose detail fills the frame instead of a small subject on a plain background.`,
      'hullCoverage',
      metrics.hullCoverage,
      0.15,
    );
  else if (metrics.hullCoverage < 0.35)
    add(
      'LOW_COVERAGE',
      'warning',
      `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image. Crop tighter or choose a picture with detail across the whole area.`,
      'hullCoverage',
      metrics.hullCoverage,
      0.35,
    );
  if (metrics.nearDuplicateRatio > 0.35)
    add(
      'REPETITIVE_PATTERN',
      'blocker',
      `${Math.round(metrics.nearDuplicateRatio * 100)}% of features have a near-identical twin (repeating pattern); the engine allows at most 35%. Avoid tiles, grids, stripes and symmetric artwork.`,
      'nearDuplicateRatio',
      metrics.nearDuplicateRatio,
      0.35,
    );
  else if (metrics.nearDuplicateRatio > 0.15 || metrics.ambiguousRatio > 0.5)
    add(
      'REPETITIVE_PATTERN',
      'warning',
      `Many features resemble each other (${Math.round(metrics.nearDuplicateRatio * 100)}% near duplicates, ${Math.round(metrics.ambiguousRatio * 100)}% similar); similar patches can be matched to the wrong place. Prefer non-repeating artwork.`,
      'ambiguousRatio',
      metrics.ambiguousRatio,
      0.5,
    );
  if (subscores.dispersion < 0.5)
    add(
      'CLUSTERED_FEATURES',
      'warning',
      `Features are concentrated: their spread is ${round(metrics.dispersion, 2)} of an even scatter over the image. Tracking is steadier when detail covers the whole picture; move detail into the empty areas or choose another picture.`,
      'dispersion',
      metrics.dispersion,
      0.35,
    );
  if (subscores.conditioning < 0.5)
    add(
      'DEGENERATE_GEOMETRY',
      'warning',
      `Features lie mostly along one direction (isotropy ${round(metrics.isotropy, 2)}); a pose estimated from them is poorly conditioned. Use a picture with detail in both directions.`,
      'isotropy',
      metrics.isotropy,
      0.3,
    );
  if (metrics.contrastRange < 50)
    add(
      'LOW_CONTRAST',
      'info',
      `Brightness range is only ${metrics.contrastRange} of 255 levels (reported, not scored). Faded or flat images lose features under camera exposure.`,
      'contrastRange',
      metrics.contrastRange,
      50,
    );
  if (Math.max(normalization.widthPx, normalization.heightPx) < 256)
    add(
      'LOW_RESOLUTION',
      'warning',
      `The image is only ${normalization.widthPx}x${normalization.heightPx} px; very small sources hold little detail. Supply at least 512 px on the long edge.`,
      'longEdge',
      Math.max(normalization.widthPx, normalization.heightPx),
      256,
    );
  if (normalization.resampling !== 'none')
    add(
      'DOWNSCALED',
      'info',
      `The ${normalization.inputWidthPx}x${normalization.inputHeightPx} input was reduced to ${normalization.widthPx}x${normalization.heightPx} (long edge ${MAX_LONG_EDGE}) before scoring, as the engine does.`,
      'scale',
      normalization.scale,
      1,
    );
  return reasons;
}

function adviceFor(score: number, reasons: readonly QualityReason[]): string {
  if (score < REPLACE_BELOW)
    return `Replace this image (score ${score.toFixed(1)} of ${MAX_SCORE}, below ${REPLACE_BELOW}). ${reasons.find((r) => r.severity !== 'info')?.message ?? ''}`.trim();
  const warning = reasons.find((r) => r.severity === 'warning');
  return `${score >= 4 ? 'Good' : 'Acceptable'} target candidate (score ${score.toFixed(1)} of ${MAX_SCORE}); this is a preflight, not a guarantee of recognition.${warning ? ' Consider: ' + warning.message : ''}`;
}

// ---- Normalization and measurement ----

/** The size an image is scored at: a long edge of at most 640, never enlarged. */
export function normalizedSize(
  widthPx: number,
  heightPx: number,
): { widthPx: number; heightPx: number; scale: number } {
  if (
    !Number.isInteger(widthPx) ||
    !Number.isInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1 ||
    widthPx > MAX_INPUT_DIMENSION ||
    heightPx > MAX_INPUT_DIMENSION
  )
    invalidInput(`Dimensions must be integers from 1 to ${MAX_INPUT_DIMENSION}`);
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(widthPx, heightPx));
  return scale === 1
    ? { widthPx, heightPx, scale }
    : { widthPx: Math.round(widthPx * scale), heightPx: Math.round(heightPx * scale), scale };
}

/** Area-average (box) reduction with exact fractional weights; deterministic and alias-free. */
function boxReduce(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy;
    const y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx;
      const x1 = (x + 1) * fx;
      let sum = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          sum += w * src[sy * sw + sx]!;
          area += w;
        }
      }
      out[y * dw + x] = Math.round(sum / area);
    }
  }
  return out;
}

function measure(
  gray: Uint8Array,
  widthPx: number,
  heightPx: number,
): { metrics: QualityMetrics; features: { x: number; y: number; level: number }[] } {
  const { features } = extractFeatures(
    { widthPx, heightPx, data: gray },
    { maxFeatures: TARGET_MAX_FEATURES, levels: TARGET_LEVELS },
  );
  const n = features.length;
  const perLevel = Array<number>(TARGET_LEVELS).fill(0);
  const cells = Array<number>(GRID * GRID).fill(0);
  for (const f of features) {
    perLevel[f.level]!++;
    cells[
      Math.min(GRID - 1, Math.floor((f.y * GRID) / heightPx)) * GRID +
        Math.min(GRID - 1, Math.floor((f.x * GRID) / widthPx))
    ]!++;
  }
  const concentration = cells.reduce((sum, c) => sum + (c / n) * (c / n), 0);
  const nearest = features.map((f, i) => {
    let best = 257;
    for (let j = 0; j < n; j++)
      if (j !== i) best = Math.min(best, hamming(f.descriptor, features[j]!.descriptor));
    return best;
  });
  const sorted = nearest.filter((d) => d <= 256).sort((a, b) => a - b);
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]!++;
  const percentile = (p: number): number => {
    let seen = 0;
    const goal = gray.length * p;
    for (let v = 0; v < 256; v++) {
      seen += hist[v]!;
      if (seen >= goal) return v;
    }
    return 255;
  };
  const points = features.map((f) => [f.x, f.y] as Point2);
  const distribution = pointDistribution(points, widthPx, heightPx);
  const metrics: QualityMetrics = {
    featureCount: n,
    featuresPerLevel: perLevel,
    hullCoverage: round(hullArea(points) / (widthPx * heightPx), 4),
    occupiedCells: cells.filter((c) => c > 0).length,
    effectiveCells: n ? round(1 / concentration, 3) : 0,
    nearDuplicateRatio: n ? round(nearest.filter((d) => d <= 16).length / n, 4) : 0,
    ambiguousRatio: n ? round(nearest.filter((d) => d <= 32).length / n, 4) : 0,
    medianNearestDistance: sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0,
    contrastRange: percentile(0.95) - percentile(0.05),
    dispersion: round(distribution.dispersion, 4),
    isotropy: round(distribution.isotropy, 4),
  };
  return { metrics, features: features.map((f) => ({ x: f.x, y: f.y, level: f.level })) };
}

function assessNormalized(gray: Uint8Array, normalization: QualityNormalization): TargetAnalysis {
  const { widthPx, heightPx } = normalization;
  if (Math.min(widthPx, heightPx) < MIN_DIMENSION)
    invalidImage(
      `Normalized image ${widthPx}x${heightPx} is below ${MIN_DIMENSION} px on its short edge; the engine cannot compile it. Use a less elongated picture.`,
    );
  const { metrics, features } = measure(gray, widthPx, heightPx);
  const preview: TemplateFeaturePreview = {
    algorithmVersion: ALGORITHM_VERSION,
    maxFeatures: TARGET_MAX_FEATURES,
    levels: TARGET_LEVELS,
    widthPx,
    heightPx,
    points: features,
  };
  const blockers = buildReasons(
    metrics,
    scoreMetrics({ metrics, blockers: 0 }).subscores,
    normalization,
  ).filter((r) => r.severity === 'blocker').length;
  const { subscores, score, rawScore } = scoreMetrics({ metrics, blockers });
  const reasons = buildReasons(metrics, subscores, normalization);
  return {
    features: preview,
    result: {
      schema: RESULT_SCHEMA,
      scorer: { name: SCORER_NAME, version: SCORER_VERSION },
      algorithm: {
        version: ALGORITHM_VERSION,
        maxFeatures: TARGET_MAX_FEATURES,
        levels: TARGET_LEVELS,
      },
      normalization,
      score,
      rawScore,
      maxScore: MAX_SCORE,
      shouldReplace: score < REPLACE_BELOW,
      advice: adviceFor(score, reasons),
      metrics,
      subscores,
      reasons,
      disclaimer: DISCLAIMER,
    },
  };
}

const NORMALIZATION_ID = `gray8-luma-77-150-29-r128;long-edge<=${MAX_LONG_EDGE};no-upscale`;
const GRAY_FORMULA = '(77R+150G+29B+128)>>8';

/**
 * Scores a canonical gray8 image (row-major, widthPx × heightPx bytes). Synchronous and pure. Images with a long edge
 * above 640 are first reduced by exact area averaging; smaller images are never enlarged.
 */
export function assessGrayTarget(image: GrayImage): TargetQualityResult {
  return analyzeGrayTarget(image).result;
}

/** assessGrayTarget plus the template feature points behind the score, for static display. */
export function analyzeGrayTarget(image: GrayImage): TargetAnalysis {
  const { widthPx, heightPx, data } = (image ?? {}) as Partial<GrayImage>;
  if (
    !Number.isInteger(widthPx) ||
    !Number.isInteger(heightPx) ||
    (widthPx as number) < MIN_DIMENSION ||
    (heightPx as number) < MIN_DIMENSION ||
    (widthPx as number) > MAX_INPUT_DIMENSION ||
    (heightPx as number) > MAX_INPUT_DIMENSION ||
    (widthPx as number) * (heightPx as number) > MAX_INPUT_PIXELS ||
    !(data instanceof Uint8Array) ||
    data.length !== (widthPx as number) * (heightPx as number)
  )
    invalidInput(
      `Expected gray8 {widthPx, heightPx, data: Uint8Array}, ${MIN_DIMENSION}..${MAX_INPUT_DIMENSION} px per side, at most ${MAX_INPUT_PIXELS} pixels, data.length === widthPx*heightPx`,
    );
  const w = widthPx as number;
  const h = heightPx as number;
  const size = normalizedSize(w, h);
  const reduced =
    size.scale === 1
      ? (data as Uint8Array)
      : boxReduce(data as Uint8Array, w, h, size.widthPx, size.heightPx);
  return assessNormalized(reduced, {
    id: NORMALIZATION_ID,
    grayFormula: GRAY_FORMULA,
    maxLongEdge: MAX_LONG_EDGE,
    inputWidthPx: w,
    inputHeightPx: h,
    widthPx: size.widthPx,
    heightPx: size.heightPx,
    scale: size.scale,
    resampling: size.scale === 1 ? 'none' : 'box-area',
  });
}

// ---- Image files ----

export interface ImageBitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}
export interface ContextLike {
  drawImage(image: ImageBitmapLike, dx: number, dy: number, dw: number, dh: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> };
}
export interface CanvasLike {
  width: number;
  height: number;
  getContext(type: '2d', options?: { willReadFrequently?: boolean }): ContextLike | null;
}
/** Decode primitives; default the page or Worker globals. */
export interface DecodeEnvironment {
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmapLike>;
  OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
  document?: { createElement(name: 'canvas'): CanvasLike };
}

export interface AssessImageOptions {
  readonly signal?: AbortSignal;
  /** Lowers the encoded size limit (never above MAX_IMAGE_BYTES). */
  readonly maxImageBytes?: number;
  /** Lowers the decoded pixel limit (never above MAX_INPUT_PIXELS). */
  readonly maxPixels?: number;
  readonly environment?: DecodeEnvironment;
}

const OPTION_KEYS = new Set(['signal', 'maxImageBytes', 'maxPixels', 'environment']);

function positiveLimit(value: unknown, name: string, cap: number): number {
  if (value === undefined) return cap;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > cap)
    invalidInput(`${name} must be an integer from 1 to ${cap}`);
  return value as number;
}

const aborted = (): EngineError =>
  new EngineError('ABORTED', 'Target assessment cancelled', { isRecoverable: true });

/** Awaits `promise` but rejects promptly on abort; a value that arrives after the race is lost is released. */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  dispose: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let isDone = false;
    const release = (value: T): void => {
      try {
        dispose(value);
      } catch {
        // Best effort.
      }
    };
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      if (!isDone) {
        isDone = true;
        reject(aborted());
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // The decoder may have aborted synchronously before the listener existed; that event is not delivered again.
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (isDone) release(value);
        else {
          isDone = true;
          resolve(value);
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (!isDone) {
          isDone = true;
          reject(error);
        }
      },
    );
  });
}

/** Decodes an image file locally (no network, no upload) the way the target compiler does, then scores it. */
export async function assessTargetImage(
  blob: Blob,
  options?: AssessImageOptions,
): Promise<TargetQualityResult> {
  return (await analyzeTargetImage(blob, options)).result;
}

/** assessTargetImage plus the template feature points; every decode resource is released on success, error and abort. */
export async function analyzeTargetImage(
  blob: Blob,
  options: AssessImageOptions = {},
): Promise<TargetAnalysis> {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    invalidInput('options must be an object');
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key)) invalidInput(`Unknown option: ${key}`);
  const maxBytes = positiveLimit(options.maxImageBytes, 'maxImageBytes', MAX_IMAGE_BYTES);
  const maxPixels = positiveLimit(options.maxPixels, 'maxPixels', MAX_INPUT_PIXELS);
  const signal = options.signal;
  if (
    signal !== undefined &&
    !(
      signal &&
      typeof signal.aborted === 'boolean' &&
      typeof signal.addEventListener === 'function'
    )
  )
    invalidInput('signal must be an AbortSignal');
  const env = (options.environment ?? globalThis) as DecodeEnvironment;
  if (typeof Blob === 'undefined' || !(blob instanceof Blob))
    invalidInput('Expected a Blob or File');
  const bytes = blob.size;
  if (!Number.isSafeInteger(bytes) || bytes < 1) invalidImage('The image is empty');
  if (bytes > maxBytes)
    invalidImage(
      `The image file is ${bytes} bytes; the limit is ${maxBytes}. Export a smaller copy (a 1024 px long edge is plenty).`,
    );
  const decode = env.createImageBitmap;
  if (
    typeof decode !== 'function' ||
    (typeof env.OffscreenCanvas !== 'function' && typeof env.document?.createElement !== 'function')
  )
    throw new EngineError(
      'UNSUPPORTED',
      'Image decoding needs createImageBitmap and a canvas (browser page or Worker)',
      {
        isRecoverable: false,
      },
    );
  if (signal?.aborted) throw aborted();
  let bitmap: ImageBitmapLike;
  try {
    bitmap = await raceAbort(decode.call(env, blob), signal, (b) => b.close());
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw new EngineError(
      'INVALID_TARGET',
      `The image could not be decoded: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`,
      { isRecoverable: false, cause: error },
    );
  }
  let canvas: CanvasLike | null = null;
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1)
      invalidImage('The decoded image has no size');
    if (w > MAX_INPUT_DIMENSION || h > MAX_INPUT_DIMENSION || w * h > maxPixels)
      invalidImage(
        `The decoded image is ${w}x${h}; the limit is ${maxPixels} pixels and ${MAX_INPUT_DIMENSION} px per side. Export a smaller copy.`,
      );
    if (Math.min(w, h) < MIN_DIMENSION)
      invalidImage(`The image is ${w}x${h}; at least ${MIN_DIMENSION} px per side is required.`);
    if (signal?.aborted) throw aborted();
    const size = normalizedSize(w, h);
    canvas =
      typeof env.OffscreenCanvas === 'function'
        ? new env.OffscreenCanvas(size.widthPx, size.heightPx)
        : env.document!.createElement('canvas');
    canvas.width = size.widthPx;
    canvas.height = size.heightPx;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context)
      throw new EngineError('UNSUPPORTED', 'No 2D canvas context is available', {
        isRecoverable: false,
      });
    context.drawImage(bitmap, 0, 0, size.widthPx, size.heightPx);
    const rgba = context.getImageData(0, 0, size.widthPx, size.heightPx).data;
    if (rgba.length !== size.widthPx * size.heightPx * 4)
      invalidImage('Canvas returned unexpected pixel data');
    const gray = new Uint8Array(size.widthPx * size.heightPx);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4)
      gray[i] = (77 * rgba[p]! + 150 * rgba[p + 1]! + 29 * rgba[p + 2]! + 128) >>> 8;
    if (signal?.aborted) throw aborted();
    return assessNormalized(gray, {
      id: NORMALIZATION_ID,
      grayFormula: GRAY_FORMULA,
      maxLongEdge: MAX_LONG_EDGE,
      inputWidthPx: w,
      inputHeightPx: h,
      widthPx: size.widthPx,
      heightPx: size.heightPx,
      scale: size.scale,
      resampling: size.scale === 1 ? 'none' : 'canvas-draw-image',
    });
  } finally {
    try {
      bitmap.close();
    } finally {
      if (canvas) {
        try {
          canvas.width = 0;
          canvas.height = 0;
        } catch {
          // Best effort.
        }
      }
    }
  }
}

// ---- Static template preview ----
// The points are TEMPLATE features: where the compiler finds corners in the target picture itself. They are not
// matches against a camera frame and say nothing about recognition success; the style (hollow cyan rings) is unlike
// a live matched-point marker on purpose.

export const TEMPLATE_PREVIEW_LABEL = 'template features (static, not live matches)';

export interface PreviewContext2D {
  save(): void;
  restore(): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
}

/** Clears the box and draws one hollow ring per template feature, scaled to `box`. Returns the rings drawn. */
export function drawTemplateFeatures(
  context: PreviewContext2D,
  preview: TemplateFeaturePreview,
  box: { readonly widthPx: number; readonly heightPx: number },
  options: { readonly radius?: number; readonly color?: string; readonly maxPoints?: number } = {},
): number {
  const {
    radius = 3.5,
    color = 'rgba(0, 229, 255, 0.95)',
    maxPoints = TARGET_MAX_FEATURES,
  } = options;
  if (
    !context ||
    !preview ||
    !(box?.widthPx > 0) ||
    !(box?.heightPx > 0) ||
    !(preview.widthPx > 0) ||
    !(preview.heightPx > 0) ||
    !Array.isArray(preview.points) ||
    !(radius > 0) ||
    !Number.isInteger(maxPoints) ||
    maxPoints < 0
  )
    return 0;
  context.clearRect(0, 0, box.widthPx, box.heightPx);
  context.save();
  let drawn = 0;
  try {
    context.lineWidth = 1.5;
    context.strokeStyle = color;
    for (const point of preview.points) {
      if (drawn >= maxPoints) break;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
      context.beginPath();
      context.arc(
        ((point.x + 0.5) * box.widthPx) / preview.widthPx,
        ((point.y + 0.5) * box.heightPx) / preview.heightPx,
        radius,
        0,
        Math.PI * 2,
      );
      context.stroke();
      drawn++;
    }
  } finally {
    context.restore();
  }
  return drawn;
}
