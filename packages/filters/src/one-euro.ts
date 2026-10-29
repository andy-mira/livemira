// SPDX-License-Identifier: Apache-2.0
// One Euro filter (Casiez, Roussel, Vogel, CHI 2012) on the eight target-corner coordinates. Slow corners get a
// low cut-off (strong smoothing, no visible jitter); fast ones a cut-off that rises with their speed (little lag).
// The filtered speed also extrapolates the pose to a display time.

import type {
  Capability,
  ModuleInfo,
  PoseEstimate,
  PoseFilter,
  ProbeResult,
  TargetInfo,
} from '@livemira-next/contracts';

import { flatCorners, withCorners } from './corners.ts';

export interface OneEuroOptions {
  /** Cut-off at rest, Hz. */
  readonly minCutoffHz?: number;
  /** Cut-off increase per px/s of corner speed. */
  readonly beta?: number;
  /** Cut-off of the speed estimate, Hz. */
  readonly derivativeCutoffHz?: number;
  /** Longest extrapolation, µs. */
  readonly maxPredictionUs?: number;
  /** A gap longer than this restarts the filter, µs. */
  readonly resetGapUs?: number;
}

interface State {
  readonly info: TargetInfo;
  timeUs: number;
  x: Float64Array;
  dx: Float64Array;
  last: PoseEstimate;
}

const alpha = (cutoffHz: number, dtS: number): number => {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtS);
};

export class OneEuroPoseFilter implements PoseFilter {
  readonly info: ModuleInfo = {
    id: 'E1.one-euro',
    layer: 'L4',
    route: 'light',
    determinism: 'bit-exact',
    requires: [],
  };
  private readonly targets = new Map<string, TargetInfo>();
  private readonly states = new Map<string, State>();
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private readonly maxPredictionUs: number;
  private readonly resetGapUs: number;

  constructor(targets: readonly TargetInfo[], options: OneEuroOptions = {}) {
    for (const t of targets) this.targets.set(t.id, t);
    // Defaults from the filter sweep (bench/src/tune-filter.ts): strongest jitter reduction that keeps 100% tracking
    // survival on pan, 3 Hz shake and drift at the mid tier.
    this.minCutoff = options.minCutoffHz ?? 0.7;
    this.beta = options.beta ?? 0.15;
    this.dCutoff = options.derivativeCutoffHz ?? 4;
    this.maxPredictionUs = options.maxPredictionUs ?? 100_000;
    this.resetGapUs = options.resetGapUs ?? 300_000;
  }

  probe(_capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: true };
  }

  update(m: PoseEstimate): PoseEstimate {
    const info = this.targets.get(m.targetId);
    if (!info) return m;
    const z = flatCorners(m.corners);
    const s = this.states.get(m.targetId);
    if (!s || m.timeUs <= s.timeUs || m.timeUs - s.timeUs > this.resetGapUs) {
      this.states.set(m.targetId, { info, timeUs: m.timeUs, x: z, dx: new Float64Array(8), last: m });
      return { ...m, origin: 'filter' };
    }
    const dt = (m.timeUs - s.timeUs) / 1e6;
    const aD = alpha(this.dCutoff, dt);
    for (let i = 0; i < 8; i++) {
      const raw = (z[i]! - s.x[i]!) / dt;
      s.dx[i] = aD * raw + (1 - aD) * s.dx[i]!;
    }
    // One cut-off for all corners (from their mean speed) keeps the quadrilateral's shape coherent.
    let speed = 0;
    for (let c = 0; c < 4; c++) speed += Math.hypot(s.dx[2 * c]!, s.dx[2 * c + 1]!);
    const a = alpha(this.minCutoff + this.beta * (speed / 4), dt);
    for (let i = 0; i < 8; i++) s.x[i] = a * z[i]! + (1 - a) * s.x[i]!;
    s.timeUs = m.timeUs;
    const filtered = withCorners(m, info, s.x, m.timeUs, 'filter') ?? m;
    s.last = filtered;
    return filtered;
  }

  predict(targetId: string, timeUs: number): PoseEstimate | null {
    const s = this.states.get(targetId);
    return s ? extrapolate(s, timeUs, this.maxPredictionUs) : null;
  }

  /** An immutable predictor of the current state (later updates do not change it). */
  snapshot(targetId: string): ((timeUs: number) => PoseEstimate | null) | null {
    const s = this.states.get(targetId);
    if (!s) return null;
    const frozen: State = { ...s, x: new Float64Array(s.x), dx: new Float64Array(s.dx) };
    return (timeUs) => extrapolate(frozen, timeUs, this.maxPredictionUs);
  }

  reset(targetId?: string): void {
    if (targetId) this.states.delete(targetId);
    else this.states.clear();
  }
}

function extrapolate(s: State, timeUs: number, maxUs: number): PoseEstimate | null {
  const dtS = Math.max(0, Math.min(maxUs, timeUs - s.timeUs)) / 1e6;
  const x = Float64Array.from(s.x, (v, i) => v + s.dx[i]! * dtS);
  return withCorners(s.last, s.info, x, timeUs, 'predicted');
}
