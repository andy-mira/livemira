/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Optional, independent image-target suitability preflight. NOT part of the engine runtime: nothing here is imported by sdk/browser.ts, the Worker or the
// single-file engine closures (the engine builder gates that). It reuses the real legacy-family extractor/geometry, so it measures what the engine would compile.
// The score is a conservative heuristic for "is this picture worth using as a target", not a detection probability, a recognition guarantee or a
// Vuforia/ARCore rating. Every formula step below uses only + - * / comparisons and Math.round/floor, so the result is bit-identical across JS engines.
// Two scorer versions are kept: 2.0.0 (default, geometry based) and 1.0.0 (the original formula, selectable for reproducing old reports).
import { ALGORITHM, ANMS_ALGORITHM, hamming } from '../../recognition/experimental/features.mjs';
import { hullArea } from '../../recognition/experimental/geometry.mjs';
import { extractLegacyFamily } from '../../recognition/src/legacy-family.mjs';
import { pointDistribution } from '../../recognition/src/point-stats.mjs';

export const SCORER_NAME = 'webar-target-suitability';
export const SCORER_VERSION_V1 = '1.0.0';
export const SCORER_VERSION = '2.0.0';
export const SCORER_VERSIONS: readonly string[] = Object.freeze([SCORER_VERSION_V1, SCORER_VERSION]);
export const RESULT_SCHEMA_V1 = 'webar-target-quality/1';
export const RESULT_SCHEMA = 'webar-target-quality/2';
export const MAX_SCORE = 5;
/** Below this published score the advice is to replace the image. Evaluated on the rounded (published) score. */
export const REPLACE_BELOW = 3;
/** The legacy family: the same detector and descriptor, greedy or ANMS spatial selection. The default stays the legacy identity; callers choose the algorithm their targets use. */
export const SUPPORTED_ALGORITHMS: readonly string[] = Object.freeze([ALGORITHM, ANMS_ALGORITHM]);
export const MAX_LONG_EDGE = 640;
export const MAX_IMAGE_BYTES = 24_000_000;
export const MAX_INPUT_PIXELS = 16_777_216;
export const MAX_INPUT_DIMENSION = 8192;
export const MIN_DIMENSION = 32;
const FEATURES = 384, LEVELS = 3, GRID = 4;
export const DISCLAIMER = 'Heuristic preflight of image suitability only. It is not a calibrated probability of detection, does not guarantee recognition and is not a Vuforia or ARCore rating. A score of 3 or more can still fail on a device.';

export interface GrayImage { width: number; height: number; data: Uint8Array }
export type TargetQualityErrorCode = 'INVALID_INPUT' | 'INVALID_OPTIONS' | 'UNSUPPORTED_ALGORITHM' | 'IMAGE_TOO_LARGE' | 'UNSUPPORTED_IMAGE' | 'UNSUPPORTED_ENVIRONMENT' | 'DECODE_FAILED';
export class TargetQualityError extends Error {
  readonly code: TargetQualityErrorCode;
  constructor(code: TargetQualityErrorCode, message: string) { super(message); this.name = 'TargetQualityError'; this.code = code; }
}
function reject(code: TargetQualityErrorCode, message: string): never { throw new TargetQualityError(code, message); }

export type ReasonSeverity = 'blocker' | 'warning' | 'info';
export type ReasonCode = 'LOW_FEATURE_COUNT' | 'LOW_COVERAGE' | 'CLUSTERED_FEATURES' | 'DEGENERATE_GEOMETRY' | 'REPETITIVE_PATTERN' | 'LOW_CONTRAST' | 'WEAK_SCALE_SUPPORT' | 'LOW_RESOLUTION' | 'DOWNSCALED';
export interface QualityReason { code: ReasonCode; severity: ReasonSeverity; message: string; metric: string; value: number; threshold: number }
export interface QualityMetrics {
  featureCount: number; featuresPerLevel: number[]; hullCoverage: number; occupiedCells: number; effectiveCells: number;
  nearDuplicateRatio: number; ambiguousRatio: number; medianNearestDistance: number; contrastRange: number;
  /** Scorer 2.0.0 only (absent from 1.0.0 results): target-normalized point distribution, see README "Score formula 2.0.0". */
  dispersion?: number; isotropy?: number;
}
export interface QualitySubscores { texture: number; coverage: number; distribution: number; distinctiveness: number; scale: number; contrast: number }
/** Scorer 2.0.0 sub-scores, each a 0..1 ramp. */
export interface GeometrySubscores { support: number; coverage: number; dispersion: number; conditioning: number; uniqueness: number }
export interface QualityNormalization {
  id: string; grayFormula: string; maxLongEdge: number; inputWidth: number; inputHeight: number; width: number; height: number; scale: number;
  resampling: 'none' | 'box-area' | 'canvas-draw-image';
}
export interface TargetQualityResult {
  schema: typeof RESULT_SCHEMA | typeof RESULT_SCHEMA_V1;
  scorer: { name: string; version: string };
  algorithm: { version: string; maxFeatures: number; levels: number };
  normalization: QualityNormalization;
  /** 0..5, at most one decimal. */
  score: number; maxScore: 5;
  /** Unrounded value (3 decimals) for diagnosing near-threshold results. Decisions use `score`, never this field. */
  rawScore: number;
  /** Exactly `score < 3`. */
  recommendReplacement: boolean;
  advice: string;
  metrics: QualityMetrics; subscores: QualitySubscores | GeometrySubscores;
  reasons: QualityReason[];
  disclaimer: string;
}
export interface AssessGrayOptions {
  /** Legacy-family algorithm whose features are scored (SUPPORTED_ALGORITHMS). Default: the legacy identity. Use the algorithm your targets are compiled with. */
  algorithmVersion?: string;
  /** SCORER_VERSIONS entry. Default: SCORER_VERSION (2.0.0). '1.0.0' reproduces the original formula and result schema. */
  scorerVersion?: string;
}
/** The template feature points behind a score, in normalized-image pixels (normalization.width x normalization.height), for static display. Never live matches. */
export interface TemplateFeaturePreview {
  algorithmVersion: string; maxFeatures: number; levels: number; width: number; height: number;
  points: { x: number; y: number; level: number }[];
}
export interface TargetAnalysis { result: TargetQualityResult; features: TemplateFeaturePreview }
export interface DecodeEnvironment {
  createImageBitmap?: (blob: Blob) => Promise<ImageBitmapLike>;
  OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
  document?: { createElement(name: 'canvas'): CanvasLike };
}
export interface ImageBitmapLike { width: number; height: number; close(): void }
export interface CanvasLike { width: number; height: number; getContext(type: '2d', options?: { willReadFrequently?: boolean }): ContextLike | null }
export interface ContextLike { drawImage(image: ImageBitmapLike, dx: number, dy: number, dw: number, dh: number): void; getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } }
export interface AssessImageOptions extends AssessGrayOptions {
  signal?: AbortSignal;
  /** Lower the encoded size limit (never above MAX_IMAGE_BYTES). */
  maxImageBytes?: number;
  /** Lower the decoded pixel limit (never above MAX_INPUT_PIXELS). */
  maxPixels?: number;
  /** Decode primitives; defaults to the page/Worker globals. For hosts without them and for tests. */
  environment?: DecodeEnvironment;
}

// ---- Scoring (documented in README.md "Score formula") ----------------------------------------------------------------------------------------
// Each sub-score is a linear ramp 0..1. Thresholds are deliberately conservative round numbers taken from the engine's own compile diagnostics
// (24 features, 15% hull, 35% near duplicates) and from first principles, not fitted to any image set.
const ramp = (value: number, low: number, high: number): number => value <= low ? 0 : value >= high ? 1 : (value - low) / (high - low);
const round = (value: number, places: number): number => { const f = 10 ** places; return Math.round(value * f) / f; };
export const WEIGHTS = Object.freeze({ texture: 0.25, coverage: 0.2, distribution: 0.2, distinctiveness: 0.15, scale: 0.1, contrast: 0.1 });
const WEAKEST_LINK_SHARE = 0.4;
/** Compile blockers (the engine's own hard diagnostics) cap the score here, so such an image always lands below REPLACE_BELOW. */
export const BLOCKER_CAP = 2;
const LEVEL_FLOORS = [24, 12, 6];

const inRange = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
/** Public helpers never emit a malformed bounded result: non-finite or out-of-range measurements are INVALID_INPUT. Valid measured values pass unchanged. */
function validateScoringInput(input: ScoringInput): ScoringInput {
  const m = (input as Partial<ScoringInput> | null)?.metrics, blockers = (input as Partial<ScoringInput> | null)?.blockers;
  const levels = m?.featuresPerLevel;
  if (!m || typeof m !== 'object' || !Number.isInteger(blockers) || (blockers as number) < 0 || (blockers as number) > 16 || !Array.isArray(levels) || levels.length !== LEVELS || !levels.every(c => inRange(c, FEATURES)) ||
      !inRange(m.featureCount, FEATURES) || !inRange(m.hullCoverage, 1) || !inRange(m.occupiedCells, GRID * GRID) || !inRange(m.effectiveCells, GRID * GRID) || !inRange(m.nearDuplicateRatio, 1) ||
      !inRange(m.ambiguousRatio, 1) || !inRange(m.medianNearestDistance, 256) || !inRange(m.contrastRange, 255)) reject('INVALID_INPUT', `Invalid scoring input: expected finite metrics within their bounds (featureCount 0..${FEATURES}, ${LEVELS} per-level counts, ratios 0..1, effectiveCells 0..${GRID * GRID}, contrastRange 0..255) and an integer blocker count 0..16`);
  return input;
}
export interface ScoringInput { metrics: QualityMetrics; blockers: number }
/** The pure scoring step: metrics -> sub-scores and the published score. Exposed so threshold behavior can be tested without images. */
export function scoreMetrics(input: ScoringInput): { subscores: QualitySubscores; score: number; rawScore: number } {
  const { metrics, blockers } = validateScoringInput(input);
  const levelSupport = LEVEL_FLOORS.reduce((sum, floor, level) => sum + Math.min(1, (metrics.featuresPerLevel[level] ?? 0) / floor), 0) / LEVEL_FLOORS.length;
  const subscores: QualitySubscores = {
    texture: ramp(metrics.featureCount, 12, 120),
    coverage: ramp(metrics.hullCoverage, 0.15, 0.6),
    distribution: ramp(metrics.effectiveCells, 4, 10),
    // Distinctiveness needs at least two descriptors to compare; with fewer there is no evidence, which scores 0 rather than a free 1.
    distinctiveness: metrics.featureCount < 2 ? 0 : Math.min(ramp(-metrics.nearDuplicateRatio, -0.35, -0.05), ramp(-metrics.ambiguousRatio, -0.6, -0.15)),
    scale: levelSupport,
    contrast: ramp(metrics.contrastRange, 30, 90),
  };
  const values = Object.values(subscores);
  const mean = (Object.keys(WEIGHTS) as (keyof QualitySubscores)[]).reduce((sum, key) => sum + WEIGHTS[key] * subscores[key], 0);
  const combined = (1 - WEAKEST_LINK_SHARE) * mean + WEAKEST_LINK_SHARE * Math.min(...values);
  let raw = MAX_SCORE * combined;
  if (blockers > 0) raw = Math.min(raw, BLOCKER_CAP);
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw * 10) / 10));
  return { subscores: Object.fromEntries(Object.entries(subscores).map(([k, v]) => [k, round(v, 3)])) as unknown as QualitySubscores, score, rawScore: round(raw, 3) };
}


// ---- Scorer 2.0.0: geometry based -------------------------------------------------------------------------------------------------------------
// Five necessary conditions for a stable pose from a template, each a 0..1 ramp whose anchors come from engine constants or from the definition of the measure,
// NOT from any image set (no asset name, hash or ranking is involved):
//   support      usable template features        0 at 24 (the compiler's minimum) .. 1 at 192 (half of the 384 budget)
//   coverage     convex hull / target area       0 at 15% (the compiler's gate)   .. 1 at 60%
//   dispersion   (var u + var v) / (2/12)        0 at 0.15 .. 1 at 0.55            1.0 would be uniform scatter over the whole target
//   conditioning 4 det(C) / trace(C)^2           0 at 0.10 .. 1 at 0.50            1 = equal spread in all directions, 0 = collinear (a degenerate homography fit)
//   uniqueness   worse of near-duplicate / similar descriptor ratios, as in 1.0.0 (repeats make matches ambiguous)
// Equal weights; score = 5 x (0.5 x mean + 0.5 x min), so one failing condition cannot be hidden by strong others (a condition at 0 caps the score at 2.0 < 3).
// The mapping to 0..5 is an explainable heuristic WITHOUT labeled calibration against measured recognition outcomes.
// Contrast and pyramid-level counts are still reported but no longer scored: the score does not try to predict small or distant appearance.
export const GEOMETRY_WEIGHT = 0.2;
const GEOMETRY_WEAKEST_LINK_SHARE = 0.5;
export interface ScoringInputV2 { metrics: QualityMetrics & { dispersion: number; isotropy: number }; blockers: number }
function validateScoringInputV2(input: ScoringInputV2): ScoringInputV2 {
  validateScoringInput(input);
  const m = input.metrics;
  if (!inRange(m.dispersion, 1) || !inRange(m.isotropy, 1)) reject('INVALID_INPUT', 'Invalid scoring input: dispersion and isotropy must be finite numbers within 0..1');
  return input;
}
/** The pure 2.0.0 step: metrics -> sub-scores and the published score. */
export function scoreMetricsV2(input: ScoringInputV2): { subscores: GeometrySubscores; score: number; rawScore: number } {
  const { metrics, blockers } = validateScoringInputV2(input);
  const subscores: GeometrySubscores = {
    support: ramp(metrics.featureCount, 24, 192),
    coverage: ramp(metrics.hullCoverage, 0.15, 0.6),
    dispersion: ramp(metrics.dispersion, 0.15, 0.55),
    conditioning: ramp(metrics.isotropy, 0.1, 0.5),
    uniqueness: metrics.featureCount < 2 ? 0 : Math.min(ramp(-metrics.nearDuplicateRatio, -0.35, -0.05), ramp(-metrics.ambiguousRatio, -0.6, -0.15)),
  };
  const values = Object.values(subscores), mean = values.reduce((sum, v) => sum + GEOMETRY_WEIGHT * v, 0);
  let raw = MAX_SCORE * ((1 - GEOMETRY_WEAKEST_LINK_SHARE) * mean + GEOMETRY_WEAKEST_LINK_SHARE * Math.min(...values));
  if (blockers > 0) raw = Math.min(raw, BLOCKER_CAP);
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw * 10) / 10));
  return { subscores: Object.fromEntries(Object.entries(subscores).map(([k, v]) => [k, round(v, 3)])) as unknown as GeometrySubscores, score, rawScore: round(raw, 3) };
}
function buildReasonsV2(metrics: QualityMetrics, subscores: GeometrySubscores, normalization: QualityNormalization): QualityReason[] {
  const reasons: QualityReason[] = [];
  const add = (code: ReasonCode, severity: ReasonSeverity, message: string, metric: string, value: number, threshold: number) => reasons.push({ code, severity, message, metric, value: round(value, 3), threshold });
  if (metrics.featureCount < 24) add('LOW_FEATURE_COUNT', 'blocker', `Only ${metrics.featureCount} usable corner features; the engine needs at least 24 to compile a target. Use a picture with fine, high-contrast detail (text, foliage, texture, edges) over its whole area; avoid plain, blurry or smooth images.`, 'featureCount', metrics.featureCount, 24);
  else if (metrics.featureCount < 96) add('LOW_FEATURE_COUNT', 'warning', `Only ${metrics.featureCount} corner features; detail is thin. A picture with more fine detail gives the pose fit more to work with.`, 'featureCount', metrics.featureCount, 96);
  if (metrics.hullCoverage < 0.15) add('LOW_COVERAGE', 'blocker', `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image; the engine needs at least 15%. Use a picture whose detail fills the frame instead of a small subject on a plain background.`, 'hullCoverage', metrics.hullCoverage, 0.15);
  else if (metrics.hullCoverage < 0.35) add('LOW_COVERAGE', 'warning', `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image. Crop tighter or choose a picture with detail across the whole area.`, 'hullCoverage', metrics.hullCoverage, 0.35);
  if (metrics.nearDuplicateRatio > 0.35) add('REPETITIVE_PATTERN', 'blocker', `${Math.round(metrics.nearDuplicateRatio * 100)}% of features have a near-identical twin (repeating pattern); the engine allows at most 35%. Avoid tiles, grids, stripes and symmetric artwork.`, 'nearDuplicateRatio', metrics.nearDuplicateRatio, 0.35);
  else if (metrics.nearDuplicateRatio > 0.15 || metrics.ambiguousRatio > 0.5) add('REPETITIVE_PATTERN', 'warning', `Many features resemble each other (${Math.round(metrics.nearDuplicateRatio * 100)}% near duplicates, ${Math.round(metrics.ambiguousRatio * 100)}% similar); similar patches can be matched to the wrong place. Prefer non-repeating artwork.`, 'ambiguousRatio', metrics.ambiguousRatio, 0.5);
  if (subscores.dispersion < 0.5) add('CLUSTERED_FEATURES', 'warning', `Features are concentrated: their spread is ${round(metrics.dispersion ?? 0, 2)} of an even scatter over the image. Tracking is steadier when detail covers the whole picture; move detail into the empty areas or choose another picture.`, 'dispersion', metrics.dispersion ?? 0, 0.35);
  if (subscores.conditioning < 0.5) add('DEGENERATE_GEOMETRY', 'warning', `Features lie mostly along one direction (isotropy ${round(metrics.isotropy ?? 0, 2)}); a pose estimated from them is poorly conditioned. Use a picture with detail in both directions.`, 'isotropy', metrics.isotropy ?? 0, 0.3);
  if (metrics.contrastRange < 50) add('LOW_CONTRAST', 'info', `Brightness range is only ${metrics.contrastRange} of 255 levels (reported, not scored). Faded or flat images lose features under camera exposure.`, 'contrastRange', metrics.contrastRange, 50);
  if (Math.max(normalization.width, normalization.height) < 256) add('LOW_RESOLUTION', 'warning', `The image is only ${normalization.width}x${normalization.height} px; very small sources hold little detail. Supply at least 512 px on the long edge.`, 'longEdge', Math.max(normalization.width, normalization.height), 256);
  if (normalization.resampling !== 'none') add('DOWNSCALED', 'info', `The ${normalization.inputWidth}x${normalization.inputHeight} input was reduced to ${normalization.width}x${normalization.height} (long edge ${MAX_LONG_EDGE}) before scoring, as the engine does.`, 'scale', normalization.scale, 1);
  return reasons;
}

function buildReasons(metrics: QualityMetrics, subscores: QualitySubscores, normalization: QualityNormalization): QualityReason[] {
  const reasons: QualityReason[] = [];
  const add = (code: ReasonCode, severity: ReasonSeverity, message: string, metric: string, value: number, threshold: number) => reasons.push({ code, severity, message, metric, value: round(value, 3), threshold });
  if (metrics.featureCount < 24) add('LOW_FEATURE_COUNT', 'blocker', `Only ${metrics.featureCount} usable corner features; the engine needs at least 24 to compile a target. Use a picture with fine, high-contrast detail (text, foliage, texture, edges) over its whole area; avoid plain, blurry or smooth images.`, 'featureCount', metrics.featureCount, 24);
  else if (metrics.featureCount < 60) add('LOW_FEATURE_COUNT', 'warning', `Only ${metrics.featureCount} corner features; detail is thin. A picture with more fine detail is recognised more reliably.`, 'featureCount', metrics.featureCount, 60);
  if (metrics.hullCoverage < 0.15) add('LOW_COVERAGE', 'blocker', `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image; the engine needs at least 15%. Use a picture whose detail fills the frame instead of a small subject on a plain background.`, 'hullCoverage', metrics.hullCoverage, 0.15);
  else if (metrics.hullCoverage < 0.35) add('LOW_COVERAGE', 'warning', `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image. Crop tighter or choose a picture with detail across the whole area.`, 'hullCoverage', metrics.hullCoverage, 0.35);
  if (metrics.nearDuplicateRatio > 0.35) add('REPETITIVE_PATTERN', 'blocker', `${Math.round(metrics.nearDuplicateRatio * 100)}% of features have a near-identical twin (repeating pattern); the engine allows at most 35%. Avoid tiles, grids, stripes and symmetric artwork.`, 'nearDuplicateRatio', metrics.nearDuplicateRatio, 0.35);
  else if (metrics.nearDuplicateRatio > 0.15 || metrics.ambiguousRatio > 0.5) add('REPETITIVE_PATTERN', 'warning', `Many features resemble each other (${Math.round(metrics.nearDuplicateRatio * 100)}% near duplicates, ${Math.round(metrics.ambiguousRatio * 100)}% similar); similar patches can be matched to the wrong place. Prefer non-repeating artwork.`, 'ambiguousRatio', metrics.ambiguousRatio, 0.5);
  if (subscores.distribution < 0.5) add('CLUSTERED_FEATURES', 'warning', `Features are concentrated in about ${round(metrics.effectiveCells, 1)} of ${GRID * GRID} image regions (${metrics.occupiedCells} regions have any). Tracking is steadier when detail is spread evenly; move detail into the empty areas or choose another picture.`, 'effectiveCells', metrics.effectiveCells, 7);
  if (metrics.contrastRange < 50) add('LOW_CONTRAST', 'warning', `Brightness range is only ${metrics.contrastRange} of 255 levels. Increase contrast or use a punchier picture; faded or flat images lose features under camera exposure.`, 'contrastRange', metrics.contrastRange, 50);
  if (subscores.scale < 0.6) add('WEAK_SCALE_SUPPORT', 'warning', `Few features survive at reduced size (per level ${metrics.featuresPerLevel.join('/')}); the target may be lost when it appears small or far. Use a picture with both coarse shapes and fine detail.`, 'scaleSupport', subscores.scale, 0.6);
  if (Math.max(normalization.width, normalization.height) < 256) add('LOW_RESOLUTION', 'warning', `The image is only ${normalization.width}x${normalization.height} px; very small sources hold little detail. Supply at least 512 px on the long edge.`, 'longEdge', Math.max(normalization.width, normalization.height), 256);
  if (normalization.resampling !== 'none') add('DOWNSCALED', 'info', `The ${normalization.inputWidth}x${normalization.inputHeight} input was reduced to ${normalization.width}x${normalization.height} (long edge ${MAX_LONG_EDGE}) before scoring, as the engine does.`, 'scale', normalization.scale, 1);
  return reasons;
}
function adviceFor(score: number, reasons: readonly QualityReason[]): string {
  if (score < REPLACE_BELOW) return `Replace this image (score ${score.toFixed(1)} of ${MAX_SCORE}, below ${REPLACE_BELOW}). ${reasons.find(r => r.severity !== 'info')?.message ?? ''}`.trim();
  const warning = reasons.find(r => r.severity === 'warning');
  return `${score >= 4 ? 'Good' : 'Acceptable'} target candidate (score ${score.toFixed(1)} of ${MAX_SCORE}); this is a preflight, not a guarantee of recognition.${warning ? ' Consider: ' + warning.message : ''}`;
}

// ---- Normalization and measurement ------------------------------------------------------------------------------------------------------------
export function normalizedSize(width: number, height: number): { width: number; height: number; scale: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_INPUT_DIMENSION || height > MAX_INPUT_DIMENSION) reject('INVALID_INPUT', `Dimensions must be integers from 1 to ${MAX_INPUT_DIMENSION}`);
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height));
  return scale === 1 ? { width, height, scale } : { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}
/** Area-average (box) reduction with exact fractional weights; deterministic and alias-free. */
function boxReduce(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh), fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy, y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx, x1 = (x + 1) * fx;
      let sum = 0, area = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          sum += w * src[sy * sw + sx]; area += w;
        }
      }
      out[y * dw + x] = Math.round(sum / area);
    }
  }
  return out;
}
function measure(gray: Uint8Array, width: number, height: number, algorithmVersion: string, geometry: boolean): { metrics: QualityMetrics; features: { x: number; y: number; level: number }[] } {
  const { features } = extractLegacyFamily({ width, height, data: gray }, algorithmVersion, { maxFeatures: FEATURES, levels: LEVELS });
  const n = features.length, perLevel = Array<number>(LEVELS).fill(0), cells = Array<number>(GRID * GRID).fill(0);
  for (const f of features) {
    perLevel[f.level]++;
    cells[Math.min(GRID - 1, Math.floor(f.y * GRID / height)) * GRID + Math.min(GRID - 1, Math.floor(f.x * GRID / width))]++;
  }
  const concentration = cells.reduce((sum, c) => sum + (c / n) * (c / n), 0);
  const nearest = features.map((f, i) => { let best = 257; for (let j = 0; j < n; j++) if (j !== i) best = Math.min(best, hamming(f.descriptor, features[j].descriptor)); return best; });
  const sorted = nearest.filter(d => d <= 256).sort((a, b) => a - b);
  const hist = new Array<number>(256).fill(0);
  for (const v of gray) hist[v]++;
  const percentile = (p: number) => { let seen = 0; const goal = gray.length * p; for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= goal) return v; } return 255; };
  const distribution = geometry ? pointDistribution(features.map(f => [f.x, f.y] as [number, number]), width, height) : null;
  const metrics: QualityMetrics = {
    featureCount: n, featuresPerLevel: perLevel,
    hullCoverage: round(hullArea(features.map(f => [f.x, f.y])) / (width * height), 4),
    occupiedCells: cells.filter(c => c > 0).length, effectiveCells: n ? round(1 / concentration, 3) : 0,
    nearDuplicateRatio: n ? round(nearest.filter(d => d <= 16).length / n, 4) : 0, ambiguousRatio: n ? round(nearest.filter(d => d <= 32).length / n, 4) : 0,
    medianNearestDistance: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    contrastRange: percentile(0.95) - percentile(0.05),
    ...(distribution ? { dispersion: round(distribution.dispersion, 4), isotropy: round(distribution.isotropy, 4) } : {}),
  };
  return { metrics, features: features.map(f => ({ x: f.x, y: f.y, level: f.level })) };
}
function assessNormalized(gray: Uint8Array, width: number, height: number, normalization: QualityNormalization, algorithmVersion: string, scorerVersion: string): TargetAnalysis {
  if (Math.min(width, height) < MIN_DIMENSION) reject('UNSUPPORTED_IMAGE', `Normalized image ${width}x${height} is below ${MIN_DIMENSION} px on its short edge; the engine cannot compile it. Use a less elongated picture.`);
  const v2 = scorerVersion === SCORER_VERSION, { metrics, features } = measure(gray, width, height, algorithmVersion, v2);
  const preview: TemplateFeaturePreview = { algorithmVersion, maxFeatures: FEATURES, levels: LEVELS, width, height, points: features };
  const identity = { scorer: { name: SCORER_NAME, version: scorerVersion }, algorithm: { version: algorithmVersion, maxFeatures: FEATURES, levels: LEVELS }, normalization };
  if (v2) {
    const scoring = metrics as ScoringInputV2['metrics'];
    const blockers = buildReasonsV2(metrics, scoreMetricsV2({ metrics: scoring, blockers: 0 }).subscores, normalization).filter(r => r.severity === 'blocker').length;
    const { subscores, score, rawScore } = scoreMetricsV2({ metrics: scoring, blockers }), reasons = buildReasonsV2(metrics, subscores, normalization);
    return { features: preview, result: { schema: RESULT_SCHEMA, ...identity, score, rawScore, maxScore: MAX_SCORE, recommendReplacement: score < REPLACE_BELOW, advice: adviceFor(score, reasons), metrics, subscores, reasons, disclaimer: DISCLAIMER } };
  }
  const reasonsDraft = buildReasons(metrics, scoreMetrics({ metrics, blockers: 0 }).subscores, normalization);
  const { subscores, score, rawScore } = scoreMetrics({ metrics, blockers: reasonsDraft.filter(r => r.severity === 'blocker').length });
  const reasons = buildReasons(metrics, subscores, normalization);
  return { features: preview, result: { schema: RESULT_SCHEMA_V1, ...identity, score, rawScore, maxScore: MAX_SCORE, recommendReplacement: score < REPLACE_BELOW, advice: adviceFor(score, reasons), metrics, subscores, reasons, disclaimer: DISCLAIMER } };
}
const NORMALIZATION_ID = `gray8-luma-77-150-29-r128;long-edge<=${MAX_LONG_EDGE};no-upscale`;
const GRAY_FORMULA = '(77R+150G+29B+128)>>8';

// ---- Validation -------------------------------------------------------------------------------------------------------------------------------
const OPTION_KEYS = new Set(['algorithmVersion', 'scorerVersion', 'signal', 'maxImageBytes', 'maxPixels', 'environment']);
function readOptions(options: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) reject('INVALID_OPTIONS', 'options must be an object');
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(options as object)) {
    if (!OPTION_KEYS.has(key) || !allowed.includes(key)) reject('INVALID_OPTIONS', `Unknown option: ${key}`);
    const value = (options as Record<string, unknown>)[key];
    if (value !== undefined) snapshot[key] = value;
  }
  const algorithm = snapshot.algorithmVersion;
  if (algorithm !== undefined) {
    if (typeof algorithm !== 'string') reject('INVALID_OPTIONS', 'algorithmVersion must be a string');
    if (!SUPPORTED_ALGORITHMS.includes(algorithm as string)) reject('UNSUPPORTED_ALGORITHM', `Unsupported algorithm ${JSON.stringify(algorithm).slice(0, 80)}; supported: ${SUPPORTED_ALGORITHMS.join(', ')}`);
  }
  const scorer = snapshot.scorerVersion;
  if (scorer !== undefined && (typeof scorer !== 'string' || !SCORER_VERSIONS.includes(scorer))) reject('INVALID_OPTIONS', `scorerVersion must be one of ${SCORER_VERSIONS.join(', ')}`);
  return snapshot;
}
const algorithmOf = (settings: Record<string, unknown>): string => (settings.algorithmVersion as string | undefined) ?? ALGORITHM;
const scorerOf = (settings: Record<string, unknown>): string => (settings.scorerVersion as string | undefined) ?? SCORER_VERSION;
function positiveLimit(value: unknown, name: string, cap: number): number {
  if (value === undefined) return cap;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > cap) reject('INVALID_OPTIONS', `${name} must be an integer from 1 to ${cap}`);
  return value as number;
}

/**
 * Scores a canonical gray8 image (Uint8Array, row-major, width*height bytes). Synchronous and pure: no browser APIs, no I/O. Images with a long edge
 * above 640 are first reduced by exact area averaging; smaller images are never enlarged.
 */
export function assessGrayTarget(image: GrayImage, options?: AssessGrayOptions): TargetQualityResult {
  return analyzeGrayTarget(image, options).result;
}
/** assessGrayTarget plus the template feature points that produced the score (same algorithm, same normalized gray): for static display, never live matches. */
export function analyzeGrayTarget(image: GrayImage, options?: AssessGrayOptions): TargetAnalysis {
  const settings = readOptions(options, ['algorithmVersion', 'scorerVersion']);
  const { width, height, data } = (image ?? {}) as Partial<GrayImage>;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < MIN_DIMENSION || (height as number) < MIN_DIMENSION ||
      (width as number) > MAX_INPUT_DIMENSION || (height as number) > MAX_INPUT_DIMENSION || (width as number) * (height as number) > MAX_INPUT_PIXELS ||
      !(data instanceof Uint8Array) || data.length !== (width as number) * (height as number)) reject('INVALID_INPUT', `Expected gray8 {width,height,data: Uint8Array}, ${MIN_DIMENSION}..${MAX_INPUT_DIMENSION} px per side, at most ${MAX_INPUT_PIXELS} pixels, data.length === width*height`);
  const w = width as number, h = height as number, size = normalizedSize(w, h);
  const reduced = size.scale === 1 ? (data as Uint8Array) : boxReduce(data as Uint8Array, w, h, size.width, size.height);
  return assessNormalized(reduced, size.width, size.height, { id: NORMALIZATION_ID, grayFormula: GRAY_FORMULA, maxLongEdge: MAX_LONG_EDGE, inputWidth: w, inputHeight: h, width: size.width, height: size.height, scale: size.scale, resampling: size.scale === 1 ? 'none' : 'box-area' }, algorithmOf(settings), scorerOf(settings));
}

const abortError = (signal: AbortSignal): unknown => signal.reason ?? (typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
/** Awaits `promise` but rejects promptly on abort; a value that arrives after the race is lost is released with `dispose`. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, dispose: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject_) => {
    let done = false;
    const release = (value: T) => { try { dispose(value); } catch { /* best effort */ } };
    const onAbort = () => { signal.removeEventListener('abort', onAbort); if (!done) { done = true; reject_(abortError(signal)); } };
    signal.addEventListener('abort', onAbort, { once: true });
    // The decoder may have aborted the signal synchronously before the listener existed: that event is never delivered again, so check the flag.
    if (signal.aborted) onAbort();
    promise.then(value => { signal.removeEventListener('abort', onAbort); if (done) release(value); else { done = true; resolve(value); } },
      error => { signal.removeEventListener('abort', onAbort); if (!done) { done = true; reject_(error); } });
  });
}
/**
 * Browser convenience: decodes an image Blob/File locally (no network, no upload) the way the engine's target compiler does, then scores it.
 * Reads only the Blob; every decode resource (ImageBitmap, canvas) is released on success, error and abort.
 */
export async function assessTargetImage(blob: Blob, options?: AssessImageOptions): Promise<TargetQualityResult> {
  return (await analyzeTargetImage(blob, options)).result;
}
/** assessTargetImage plus the template feature points that produced the score (same decode, algorithm and normalized gray). Resources are released exactly as in assessTargetImage. */
export async function analyzeTargetImage(blob: Blob, options?: AssessImageOptions): Promise<TargetAnalysis> {
  const settings = readOptions(options, ['algorithmVersion', 'scorerVersion', 'signal', 'maxImageBytes', 'maxPixels', 'environment']);
  const maxBytes = positiveLimit(settings.maxImageBytes, 'maxImageBytes', MAX_IMAGE_BYTES), maxPixels = positiveLimit(settings.maxPixels, 'maxPixels', MAX_INPUT_PIXELS);
  const signal = settings.signal as AbortSignal | undefined;
  if (signal !== undefined && !(signal && typeof signal.aborted === 'boolean' && typeof signal.addEventListener === 'function' && typeof signal.removeEventListener === 'function')) reject('INVALID_OPTIONS', 'signal must be an AbortSignal');
  const env = (settings.environment ?? globalThis) as unknown as DecodeEnvironment;
  if (typeof Blob === 'undefined' || !(blob instanceof Blob)) reject('INVALID_INPUT', 'Expected a Blob or File');
  const bytes = blob.size;
  if (!Number.isSafeInteger(bytes) || bytes < 1) reject('INVALID_INPUT', 'The image is empty');
  if (bytes > maxBytes) reject('IMAGE_TOO_LARGE', `The image file is ${bytes} bytes; the limit is ${maxBytes}. Export a smaller copy (a 1024 px long edge is plenty).`);
  const decode = env.createImageBitmap;
  if (typeof decode !== 'function' || (typeof env.OffscreenCanvas !== 'function' && typeof env.document?.createElement !== 'function')) reject('UNSUPPORTED_ENVIRONMENT', 'Image decoding needs createImageBitmap and a canvas (browser page or Worker)');
  if (signal?.aborted) throw abortError(signal);
  let bitmap: ImageBitmapLike;
  try { bitmap = await raceAbort(decode.call(env, blob), signal, b => b.close()); }
  catch (error) { if (signal?.aborted) throw abortError(signal); throw new TargetQualityError('DECODE_FAILED', `The image could not be decoded: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`); }
  let canvas: CanvasLike | null = null;
  try {
    const w = bitmap.width, h = bitmap.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) reject('DECODE_FAILED', 'The decoded image has no size');
    if (w > MAX_INPUT_DIMENSION || h > MAX_INPUT_DIMENSION || w * h > maxPixels) reject('IMAGE_TOO_LARGE', `The decoded image is ${w}x${h}; the limit is ${maxPixels} pixels and ${MAX_INPUT_DIMENSION} px per side. Export a smaller copy.`);
    if (Math.min(w, h) < MIN_DIMENSION) reject('UNSUPPORTED_IMAGE', `The image is ${w}x${h}; at least ${MIN_DIMENSION} px per side is required.`);
    if (signal?.aborted) throw abortError(signal);
    const size = normalizedSize(w, h);
    canvas = typeof env.OffscreenCanvas === 'function' ? new env.OffscreenCanvas(size.width, size.height) : env.document!.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) reject('UNSUPPORTED_ENVIRONMENT', 'No 2D canvas context is available');
    context!.drawImage(bitmap, 0, 0, size.width, size.height);
    const rgba = context!.getImageData(0, 0, size.width, size.height).data;
    if (rgba.length !== size.width * size.height * 4) reject('DECODE_FAILED', 'Canvas returned unexpected pixel data');
    const gray = new Uint8Array(size.width * size.height);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2] + 128) >>> 8;
    if (signal?.aborted) throw abortError(signal);
    return assessNormalized(gray, size.width, size.height, { id: NORMALIZATION_ID, grayFormula: GRAY_FORMULA, maxLongEdge: MAX_LONG_EDGE, inputWidth: w, inputHeight: h, width: size.width, height: size.height, scale: size.scale, resampling: size.scale === 1 ? 'none' : 'canvas-draw-image' }, algorithmOf(settings), scorerOf(settings));
  } finally {
    try { bitmap.close(); } finally { if (canvas) { try { canvas.width = 0; canvas.height = 0; } catch { /* best effort */ } } }
  }
}

// ---- Static template preview drawing (optional, reusable) -------------------------------------------------------------------------------------
// The points are TEMPLATE features: where the compiler finds corners in the target picture itself. They are not matches against a camera frame, are not
// inliers and say nothing about recognition success; the style (hollow cyan rings) is deliberately unlike a live matched-point marker.
export const TEMPLATE_PREVIEW_LABEL = 'template features (static, not live matches)';
export interface PreviewContext2D {
  save(): void; restore(): void; beginPath(): void; arc(x: number, y: number, r: number, start: number, end: number): void; stroke(): void; clearRect(x: number, y: number, w: number, h: number): void;
  lineWidth: number; strokeStyle: string | CanvasGradient | CanvasPattern;
}
export interface PreviewBox { width: number; height: number }
/** Clears the box and draws one hollow ring per template feature, scaled from the preview's image size to `box`. Returns the number of rings drawn. Draws nothing for an invalid box. */
export function drawTemplateFeatures(context: PreviewContext2D, preview: TemplateFeaturePreview, box: PreviewBox, options: { radius?: number; color?: string; maxPoints?: number } = {}): number {
  const { radius = 3.5, color = 'rgba(0, 229, 255, 0.95)', maxPoints = FEATURES } = options;
  if (!context || !preview || !(box?.width > 0) || !(box?.height > 0) || !(preview.width > 0) || !(preview.height > 0) || !Array.isArray(preview.points) || !(radius > 0) || !Number.isInteger(maxPoints) || maxPoints < 0) return 0;
  context.clearRect(0, 0, box.width, box.height);
  context.save();
  let drawn = 0;
  try {
    context.lineWidth = 1.5; context.strokeStyle = color;
    for (const point of preview.points) {
      if (drawn >= maxPoints) break;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
      context.beginPath(); context.arc((point.x + 0.5) * box.width / preview.width, (point.y + 0.5) * box.height / preview.height, radius, 0, Math.PI * 2); context.stroke(); drawn++;
    }
  } finally { context.restore(); }
  return drawn;
}
