// SPDX-License-Identifier: Apache-2.0
// Metrics of one displayed sequence (design doc §5.2.2): what the user sees, judged against the ground truth of the
// background frame actually on screen.

import type { Corners } from '@livemira-next/contracts';

import type { DisplaySample } from '../sim/display.ts';

/** Ground truth counts as visible when at least half of the target is in view and unoccluded. */
const VISIBLE = 0.5;
/** A displayed overlay is correct when its mean corner error is below 2% of the target diagonal. */
const CORRECT = 0.02;

export interface SequenceMetrics {
  /** Time from the first visible frame on screen to the first correct overlay, ms (null: never). */
  readonly ttfpMs: number | null;
  /** Correct-overlay vsyncs over visible vsyncs, after the first correct overlay. */
  readonly survival: number;
  /** Mean corner error over target diagonal, p50/p95, on vsyncs showing both. */
  readonly errP50: number | null;
  readonly errP95: number | null;
  /** RMS of the error's component faster than ~100 ms, standard-image px. */
  readonly hfJitterPx: number | null;
  /** Overlay shown while the target is not visible (or a wrong target), share of all vsyncs. */
  readonly ghostRate: number;
  /** Median time to show a correct overlay again after the target came back, ms. */
  readonly reacquireMs: number | null;
  /** Mean (now − overlay source capture time), ms. */
  readonly overlayAgeMs: number | null;
  /** Distinct background frames per second over the camera rate, 0..1. */
  readonly backgroundRefresh: number;
  /** Mean background age beyond the native video's, ms. */
  readonly backgroundLagMs: number;
  readonly vsyncs: number;
}

export function cornerError(a: Corners, b: Corners): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += Math.hypot(a[i]![0] - b[i]![0], a[i]![1] - b[i]![1]);
  return sum / 4;
}

export function diagonal(c: Corners): number {
  return (Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) + Math.hypot(c[3][0] - c[1][0], c[3][1] - c[1][1])) / 2;
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function sequenceMetrics(
  samples: readonly DisplaySample[],
  frameTimesUs: readonly number[],
  options: { readonly nativeLatencyUs: number; readonly fps: number },
): SequenceMetrics {
  const visible = (s: DisplaySample): boolean => s.truth !== null && s.visible >= VISIBLE;
  const relError = (s: DisplaySample): number | null =>
    s.truth && s.overlay ? cornerError(s.overlay, s.truth) / Math.max(1, diagonal(s.truth)) : null;
  const correct = (s: DisplaySample): boolean => {
    const e = relError(s);
    return visible(s) && e !== null && e < CORRECT;
  };
  const firstVisible = samples.findIndex(visible);
  const firstCorrect = samples.findIndex(correct);
  const ttfpMs =
    firstVisible >= 0 && firstCorrect >= 0
      ? (samples[firstCorrect]!.timeUs - samples[firstVisible]!.timeUs) / 1000
      : null;
  let visibleAfter = 0;
  let correctAfter = 0;
  let ghosts = 0;
  const errors: number[] = [];
  const ages: number[] = [];
  const lags: number[] = [];
  const backgrounds = new Set<number>();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    backgrounds.add(s.background);
    lags.push((frameTimesUs[s.native]! - frameTimesUs[s.background]!) / 1000);
    if (s.overlay && s.overlaySourceUs !== null) ages.push((s.timeUs - s.overlaySourceUs) / 1000);
    const e = relError(s);
    if (visible(s) && e !== null) errors.push(e);
    if (s.overlay && (!s.truth || s.visible < 0.2 || (e !== null && e > 0.1))) ghosts++;
    if (firstCorrect >= 0 && i >= firstCorrect && visible(s)) {
      visibleAfter++;
      if (correct(s)) correctAfter++;
    }
  }
  // High-frequency error: per-corner error vectors minus their centred moving average over ±3 vsyncs (~100 ms).
  let hf = 0;
  let hfCount = 0;
  for (let i = 3; i < samples.length - 3; i++) {
    const window = samples.slice(i - 3, i + 4);
    if (!window.every((s) => s.truth && s.overlay && visible(s))) continue;
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 2; k++) {
        const e = (s: DisplaySample): number => s.overlay![c]![k]! - s.truth![c]![k]!;
        const mean = window.reduce((sum, s) => sum + e(s), 0) / window.length;
        hf += (e(samples[i]!) - mean) ** 2;
        hfCount++;
      }
  }
  // Reacquisition: after ≥300 ms with the target not visible, time until a correct overlay.
  const reacquire: number[] = [];
  let hiddenSince: number | null = null;
  let waitingFrom: number | null = null;
  for (const s of samples) {
    if (!visible(s)) {
      hiddenSince ??= s.timeUs;
      continue;
    }
    if (hiddenSince !== null && s.timeUs - hiddenSince >= 300_000) waitingFrom = s.timeUs;
    hiddenSince = null;
    if (waitingFrom !== null && correct(s)) {
      reacquire.push((s.timeUs - waitingFrom) / 1000);
      waitingFrom = null;
    }
  }
  const durationS = (samples.at(-1)!.timeUs - samples[0]!.timeUs) / 1e6 || 1;
  return {
    ttfpMs,
    survival: visibleAfter ? correctAfter / visibleAfter : firstCorrect >= 0 ? 1 : 0,
    errP50: quantile(errors, 0.5),
    errP95: quantile(errors, 0.95),
    hfJitterPx: hfCount ? Math.sqrt(hf / hfCount) : null,
    ghostRate: ghosts / samples.length,
    reacquireMs: quantile(reacquire, 0.5),
    overlayAgeMs: quantile(ages, 0.5),
    backgroundRefresh: Math.min(1, backgrounds.size / durationS / options.fps),
    backgroundLagMs: lags.reduce((a, b) => a + b, 0) / lags.length,
    vsyncs: samples.length,
  };
}

export interface TrackingMetrics {
  /** Processed frames with the target visible whose display pose is within 2% of the diagonal of that frame's truth, after the first such frame. */
  readonly survival: number;
  /** RMS of the pose error's component faster than ±3 processed frames, standard-image px. */
  readonly hfJitterPx: number | null;
  /** Per-corner standard deviation of the display pose over processed frames after the first 0.5 s (static scenes). */
  readonly staticJitterPx: number | null;
}

/** Tracking quality in tracking space: each processed frame's display pose against that frame's own truth. */
export function trackingMetrics(
  truth: readonly { readonly corners: Corners | null; readonly visible: number; readonly timeUs: number }[],
  outputs: readonly { readonly index: number; readonly corners: Corners | null }[],
): TrackingMetrics {
  const judged = outputs.map((o) => {
    const t = truth[o.index]!;
    const visible = t.corners !== null && t.visible >= VISIBLE;
    const error = t.corners && o.corners ? cornerError(o.corners, t.corners) / Math.max(1, diagonal(t.corners)) : null;
    return { ...o, t, visible, correct: visible && error !== null && error < CORRECT };
  });
  const first = judged.findIndex((j) => j.correct);
  const after = first < 0 ? [] : judged.slice(first).filter((j) => j.visible);
  let hf = 0;
  let hfCount = 0;
  for (let i = 3; i < judged.length - 3; i++) {
    const window = judged.slice(i - 3, i + 4);
    if (!window.every((j) => j.visible && j.corners && j.t.corners)) continue;
    for (let c = 0; c < 4; c++)
      for (let k = 0; k < 2; k++) {
        const e = (j: (typeof judged)[number]): number => j.corners![c]![k]! - j.t.corners![c]![k]!;
        const mean = window.reduce((sum, j) => sum + e(j), 0) / window.length;
        hf += (e(judged[i]!) - mean) ** 2;
        hfCount++;
      }
  }
  let staticJitterPx: number | null = null;
  if (first >= 0) {
    const from = judged[first]!.t.timeUs + 500_000;
    const shown = judged.filter((j) => j.t.timeUs >= from && j.corners);
    if (shown.length >= 10) {
      let total = 0;
      for (let c = 0; c < 4; c++)
        for (let k = 0; k < 2; k++) {
          const v = shown.map((j) => j.corners![c]![k]!);
          const mean = v.reduce((a, b) => a + b, 0) / v.length;
          total += v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
        }
      staticJitterPx = Math.sqrt(total / 4);
    }
  }
  return {
    survival: after.length ? after.filter((j) => j.correct).length / after.length : 0,
    hfJitterPx: hfCount ? Math.sqrt(hf / hfCount) : null,
    staticJitterPx,
  };
}
