// SPDX-License-Identifier: Apache-2.0
// Constant-velocity Kalman filter on the eight corner coordinates (each an independent position/velocity pair
// driven by white acceleration). The measurement noise follows the pose's origin and quality (an ESM pose is far
// more precise than a raw detection), innovations beyond the gate restart the filter instead of dragging it, and
// the state extrapolates to any display time.

import type {
  Capability,
  ModuleInfo,
  PoseEstimate,
  PoseFilter,
  ProbeResult,
  TargetInfo,
} from '@livemira-next/contracts';

import { flatCorners, withCorners } from './corners.ts';

export interface KalmanOptions {
  /** White-acceleration spectral density, px²/s³. */
  readonly accelerationNoise?: number;
  /** Measurement standard deviation of tracker poses (photometric residual) and of others, px. */
  readonly trackerSigmaPx?: number;
  readonly detectorSigmaPx?: number;
  /** Mahalanobis gate (squared, per coordinate) above which the filter restarts at the measurement. */
  readonly gate?: number;
  readonly maxPredictionUs?: number;
  readonly resetGapUs?: number;
}

interface State {
  readonly info: TargetInfo;
  timeUs: number;
  /** Per coordinate: position, velocity and the 2×2 covariance (pp, pv, vv). */
  x: Float64Array;
  v: Float64Array;
  pp: Float64Array;
  pv: Float64Array;
  vv: Float64Array;
  last: PoseEstimate;
}

export class KalmanPoseFilter implements PoseFilter {
  readonly info: ModuleInfo = {
    id: 'E2.kalman-cv',
    layer: 'L4',
    route: 'light',
    determinism: 'bit-exact',
    requires: [],
  };
  private readonly targets = new Map<string, TargetInfo>();
  private readonly states = new Map<string, State>();
  private readonly q: number;
  private readonly trackerSigma: number;
  private readonly detectorSigma: number;
  private readonly gate: number;
  private readonly maxPredictionUs: number;
  private readonly resetGapUs: number;

  constructor(targets: readonly TargetInfo[], options: KalmanOptions = {}) {
    for (const t of targets) this.targets.set(t.id, t);
    // Defaults from the filter sweep (bench/src/tune-filter.ts) on dual-loop ESM output: lowest registration error in
    // both frame-locked and predicted display; static jitter stays ≈0.02 px.
    this.q = options.accelerationNoise ?? 1e6;
    this.trackerSigma = options.trackerSigmaPx ?? 0.15;
    this.detectorSigma = options.detectorSigmaPx ?? 1.5;
    this.gate = options.gate ?? 25;
    this.maxPredictionUs = options.maxPredictionUs ?? 100_000;
    this.resetGapUs = options.resetGapUs ?? 300_000;
  }

  probe(_capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: true };
  }

  private start(m: PoseEstimate, info: TargetInfo, r: number): PoseEstimate {
    const z = flatCorners(m.corners);
    this.states.set(m.targetId, {
      info,
      timeUs: m.timeUs,
      x: z,
      v: new Float64Array(8),
      pp: new Float64Array(8).fill(r),
      pv: new Float64Array(8),
      vv: new Float64Array(8).fill(1e6),
      last: m,
    });
    return { ...m, origin: 'filter' };
  }

  update(m: PoseEstimate): PoseEstimate {
    const info = this.targets.get(m.targetId);
    if (!info) return m;
    const sigma = m.origin === 'tracker' ? this.trackerSigma : this.detectorSigma;
    const r = sigma * sigma;
    const s = this.states.get(m.targetId);
    if (!s || m.timeUs <= s.timeUs || m.timeUs - s.timeUs > this.resetGapUs) return this.start(m, info, r);
    const dt = (m.timeUs - s.timeUs) / 1e6;
    const z = flatCorners(m.corners);
    // Predict, then test the innovation of every coordinate before committing anything.
    const q = this.q;
    const px = new Float64Array(8);
    const ppp = new Float64Array(8);
    const ppv = new Float64Array(8);
    const pvv = new Float64Array(8);
    let worst = 0;
    for (let i = 0; i < 8; i++) {
      px[i] = s.x[i]! + dt * s.v[i]!;
      ppp[i] = s.pp[i]! + 2 * dt * s.pv[i]! + dt * dt * s.vv[i]! + (q * dt ** 3) / 3;
      ppv[i] = s.pv[i]! + dt * s.vv[i]! + (q * dt * dt) / 2;
      pvv[i] = s.vv[i]! + q * dt;
      worst = Math.max(worst, (z[i]! - px[i]!) ** 2 / (ppp[i]! + r));
    }
    if (worst > this.gate) return this.start(m, info, r);
    for (let i = 0; i < 8; i++) {
      const sInv = 1 / (ppp[i]! + r);
      const kx = ppp[i]! * sInv;
      const kv = ppv[i]! * sInv;
      const y = z[i]! - px[i]!;
      s.x[i] = px[i]! + kx * y;
      s.v[i] = s.v[i]! + kv * y;
      s.pp[i] = (1 - kx) * ppp[i]!;
      s.pv[i] = (1 - kx) * ppv[i]!;
      s.vv[i] = pvv[i]! - kv * ppv[i]!;
    }
    s.timeUs = m.timeUs;
    const filtered = withCorners(m, info, s.x, m.timeUs, 'filter') ?? m;
    s.last = filtered;
    return filtered;
  }

  predict(targetId: string, timeUs: number): PoseEstimate | null {
    const s = this.states.get(targetId);
    return s ? extrapolate(s, timeUs, this.maxPredictionUs) : null;
  }

  snapshot(targetId: string): ((timeUs: number) => PoseEstimate | null) | null {
    const s = this.states.get(targetId);
    if (!s) return null;
    const frozen: State = { ...s, x: new Float64Array(s.x), v: new Float64Array(s.v) };
    return (timeUs) => extrapolate(frozen, timeUs, this.maxPredictionUs);
  }

  reset(targetId?: string): void {
    if (targetId) this.states.delete(targetId);
    else this.states.clear();
  }
}

function extrapolate(s: State, timeUs: number, maxUs: number): PoseEstimate | null {
  const dtS = Math.max(0, Math.min(maxUs, timeUs - s.timeUs)) / 1e6;
  const x = Float64Array.from(s.x, (v, i) => v + s.v[i]! * dtS);
  return withCorners(s.last, s.info, x, timeUs, 'predicted');
}
