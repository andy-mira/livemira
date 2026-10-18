/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// How fast a tracked target was moving at its last measurement, in target diagonals per second, from measured corners
// only. A target that moves fast when it is lost is not where its overlay was; a still one very likely is. The speed
// is the larger of a three-point fit and the latest step, so neither smoothing nor one noisy step hides a speed-up;
// motion that starts after the last measurement cannot be seen at all.

import type { Corners } from '@livemira/contracts';

export type MotionMode = 'unknown' | 'slow' | 'fast';

/** At or above this speed the target counts as moving fast. */
export const FAST_DIAGONALS_PER_S = 0.5;
/** Back to slow only after this many measurements in a row below `SLOW_DIAGONALS_PER_S`, spanning `SLOW_SPAN_US`. */
export const SLOW_DIAGONALS_PER_S = 0.35;
const SLOW_COUNT = 3;
const SLOW_SPAN_US = 50_000;
/** Fit window: the last three measurements spanning 50–100 ms. Step: one measurement 20–100 ms before the last. */
const FIT_POINTS = 3;
const FIT_MIN_SPAN_US = 50_000;
const MAX_SPAN_US = 100_000;
const STEP_MIN_SPAN_US = 20_000;

interface Pose {
  readonly timeUs: number;
  readonly corners: Corners;
}

const diagonal = (c: Corners): number =>
  (Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) +
    Math.hypot(c[3][0] - c[1][0], c[3][1] - c[1][1])) /
  2;

/** Mean corner speed of a least-squares line through the poses, in pixels per second. */
function fittedSpeed(poses: readonly Pose[]): number {
  const n = poses.length;
  const meanT = poses.reduce((s, p) => s + p.timeUs, 0) / n;
  const varT = poses.reduce((s, p) => s + (p.timeUs - meanT) ** 2, 0);
  let sum = 0;
  for (let corner = 0; corner < 4; corner++) {
    let vx = 0;
    let vy = 0;
    const meanX = poses.reduce((s, p) => s + p.corners[corner]![0], 0) / n;
    const meanY = poses.reduce((s, p) => s + p.corners[corner]![1], 0) / n;
    for (const p of poses) {
      vx += (p.timeUs - meanT) * (p.corners[corner]![0] - meanX);
      vy += (p.timeUs - meanT) * (p.corners[corner]![1] - meanY);
    }
    sum += Math.hypot(vx / varT, vy / varT);
  }
  return (sum / 4) * 1e6;
}

/** Mean corner speed between two poses, in pixels per second. */
function stepSpeed(a: Pose, b: Pose): number {
  let sum = 0;
  for (let corner = 0; corner < 4; corner++)
    sum += Math.hypot(
      b.corners[corner]![0] - a.corners[corner]![0],
      b.corners[corner]![1] - a.corners[corner]![1],
    );
  return (sum / 4 / (b.timeUs - a.timeUs)) * 1e6;
}

/** Motion of one tracked target; reset whenever its overlay is hidden, its target changes or the view changes. */
export class MotionModel {
  private poses: Pose[] = [];
  private slowRun: Pose[] = [];
  private current: MotionMode = 'unknown';
  private lastSpeed: number | null = null;

  get mode(): MotionMode {
    return this.current;
  }

  /** Speed at the last measurement in target diagonals per second; null while unknown. */
  get speed(): number | null {
    return this.lastSpeed;
  }

  reset(): void {
    this.poses = [];
    this.slowRun = [];
    this.current = 'unknown';
    this.lastSpeed = null;
  }

  /** Adds a measured pose (strictly later than the previous one) and updates the mode. */
  add(timeUs: number, corners: Corners): void {
    const last = this.poses.at(-1);
    if (last && timeUs <= last.timeUs) return;
    const pose = { timeUs, corners };
    this.poses.push(pose);
    this.poses = this.poses.filter((p) => timeUs - p.timeUs <= MAX_SPAN_US).slice(-FIT_POINTS);
    const size = diagonal(corners);
    const speeds: number[] = [];
    if (this.poses.length >= FIT_POINTS) {
      const span = timeUs - this.poses[0]!.timeUs;
      if (span >= FIT_MIN_SPAN_US) speeds.push(fittedSpeed(this.poses));
    }
    for (let i = this.poses.length - 2; i >= 0; i--) {
      const span = timeUs - this.poses[i]!.timeUs;
      if (span < STEP_MIN_SPAN_US) continue;
      speeds.push(stepSpeed(this.poses[i]!, pose));
      break;
    }
    if (speeds.length === 0 || !(size > 0)) {
      // A fast target stays fast until it is seen to be slow, by measurements in a row; otherwise nothing is known yet.
      this.lastSpeed = null;
      this.slowRun = [];
      if (this.current !== 'fast') this.current = 'unknown';
      return;
    }
    const speed = Math.max(...speeds) / size;
    this.lastSpeed = speed;
    if (speed >= FAST_DIAGONALS_PER_S) {
      this.current = 'fast';
      this.slowRun = [];
    } else if (this.current !== 'fast') {
      this.current = 'slow';
    } else if (speed < SLOW_DIAGONALS_PER_S) {
      this.slowRun.push(pose);
      const first = this.slowRun.at(-SLOW_COUNT);
      if (this.slowRun.length >= SLOW_COUNT && first && timeUs - first.timeUs >= SLOW_SPAN_US) {
        this.current = 'slow';
        this.slowRun = [];
      }
    } else this.slowRun = [];
  }
}
