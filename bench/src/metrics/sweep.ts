// SPDX-License-Identifier: Apache-2.0
// S1 single-frame recognition metrics: recall per sweep value, the range each factor is covered at ≥90% recall,
// false detections on negatives, and detection time.

import { cornersOf, type PoseEstimate } from '@livemira-next/contracts';

import { SWEEPS, type GroundTruthFrame, type SweepCase, type SweepFactor } from '../scene/suites.ts';
import { cornerError, diagonal, quantile } from './sequence.ts';

/** A detection is correct when the target is right and the mean corner error is below 1.5% of the diagonal. */
const CORRECT = 0.015;

export interface SweepOutcome {
  readonly case: SweepCase;
  readonly correct: boolean;
  readonly falsePositive: boolean;
  readonly error: number | null;
  readonly detectUs: number;
}

export function judge(
  c: SweepCase,
  frame: GroundTruthFrame,
  poses: readonly PoseEstimate[],
  detectUs: number,
  size: { width: number; height: number },
): SweepOutcome {
  if (!frame.targetId || !frame.H)
    return { case: c, correct: false, falsePositive: poses.length > 0, error: null, detectUs };
  const truth = cornersOf(frame.H, size.width, size.height);
  const own = poses.find((p) => p.targetId === frame.targetId);
  const error = own ? cornerError(own.corners, truth) / diagonal(truth) : null;
  const wrong = poses.some((p) => p.targetId !== frame.targetId) || (error !== null && error > 0.1);
  return { case: c, correct: error !== null && error < CORRECT, falsePositive: wrong, error, detectUs };
}

export interface SweepMetrics {
  /** Recall per factor and value. */
  readonly recall: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Largest |roll| with recall ≥ 0.9 contiguous from 0, degrees. */
  readonly rollCoverageDeg: number;
  /** Smallest long edge with recall ≥ 0.9 contiguous from the base size, px. */
  readonly minLongPx: number;
  readonly maxTiltDeg: number;
  readonly minGain: number;
  readonly maxBlurPx: number;
  readonly maxOcclusion: number;
  readonly maxNoise: number;
  /** False detections per 1000 frames (negatives and wrong targets anywhere). */
  readonly falsePerThousand: number;
  readonly meanErrorPct: number | null;
  readonly detectP50Ms: number | null;
}

/** Walks the sweep values in `order` from the easy end and returns the last value with recall ≥ 0.9 before a failure. */
function covered(recall: Readonly<Record<string, number>>, order: readonly number[], fallback: number): number {
  let last = fallback;
  for (const v of order) {
    if ((recall[String(v)] ?? 0) >= 0.9) last = v;
    else break;
  }
  return last;
}

export function sweepMetrics(outcomes: readonly SweepOutcome[]): SweepMetrics {
  const recall: Record<string, Record<string, number>> = {};
  const groups = new Map<string, SweepOutcome[]>();
  for (const o of outcomes) {
    if (o.case.factor === 'negative') continue;
    const key = `${o.case.factor}|${o.case.value}`;
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  for (const [key, list] of groups) {
    const [factor, value] = key.split('|') as [SweepFactor, string];
    (recall[factor] ??= {})[value] = list.filter((o) => o.correct).length / list.length;
  }
  const r = (f: string): Record<string, number> => recall[f] ?? {};
  const desc = (values: readonly number[]): number[] => [...values].sort((a, b) => b - a);
  const errors = outcomes.filter((o) => o.correct && o.error !== null).map((o) => o.error! * 100);
  return {
    recall,
    rollCoverageDeg: covered(r('roll'), SWEEPS.roll, 0),
    minLongPx: covered(
      r('longPx'),
      desc(SWEEPS.longPx).filter((v) => v <= 300),
      320,
    ),
    maxTiltDeg: covered(r('tilt'), SWEEPS.tilt, 0),
    minGain: covered(r('gain'), desc(SWEEPS.gain.filter((v) => v <= 1)), 1),
    maxBlurPx: covered(r('blurPx'), SWEEPS.blurPx, 0),
    maxOcclusion: covered(r('occlusion'), SWEEPS.occlusion, 0),
    maxNoise: covered(r('noise'), SWEEPS.noise, 0),
    falsePerThousand: (1000 * outcomes.filter((o) => o.falsePositive).length) / outcomes.length,
    meanErrorPct: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    detectP50Ms: quantile(
      outcomes.map((o) => o.detectUs / 1000),
      0.5,
    ),
  };
}
