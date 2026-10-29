// SPDX-License-Identifier: Apache-2.0
// Fast-loop tracker of one target: KLT (target-anchored points followed from the previous frame, robust homography)
// and/or ESM (alignment against the template). 'klt+esm' uses KLT for the inter-frame motion and ESM to remove
// drift and jitter against the template.

import {
  cornersOf,
  type Capability,
  type FrameTracker,
  type ImagePyramid,
  type ModuleInfo,
  type PoseEstimate,
  type ProbeResult,
  type Rejection,
  type TargetImage,
  type TrackInput,
} from '@livemira-next/contracts';
import { estimateHomography, isPlausible } from '@livemira-next/geometry';
import { scharr, type Gradients } from '@livemira-next/imaging';

import { esmAlign, imageScale, type EsmOptions } from './esm.ts';
import { matchPatches, type NccOptions } from './ncc.ts';
import { trackPointsChecked, type KltOptions } from './klt.ts';
import { buildTargetModel, type TargetModel, type TargetModelOptions } from './target-model.ts';

export type TemplateTrackerMode = 'klt' | 'esm' | 'klt+esm' | 'ncc';

export interface TemplateTrackerOptions {
  readonly mode?: TemplateTrackerMode;
  readonly model?: TargetModelOptions;
  readonly klt?: KltOptions;
  readonly esm?: EsmOptions;
  readonly ncc?: NccOptions;
  /** ESM acceptance: minimum normalised cross-correlation and valid-pixel share. */
  readonly minNcc?: number;
  readonly minValidRatio?: number;
}

/** Scharr gradients of the levels of the last two pyramids seen, with reused buffers. */
interface GradientSlot {
  pyramid: ImagePyramid | null;
  /** Gradients computed for `pyramid`, per level. */
  current: (Gradients | null)[];
  /** Buffers kept for reuse by later pyramids of the same size. */
  buffers: (Gradients | undefined)[];
}

export class GradientCache {
  private readonly slots: GradientSlot[] = [
    { pyramid: null, current: [], buffers: [] },
    { pyramid: null, current: [], buffers: [] },
  ];
  private next = 0;

  of(pyramid: ImagePyramid): (level: number) => Gradients {
    let slot = this.slots.find((s) => s.pyramid === pyramid);
    if (!slot) {
      slot = this.slots[this.next]!;
      this.next ^= 1;
      slot.pyramid = pyramid;
      slot.current = [];
    }
    const s = slot;
    return (level) => {
      const hit = s.current[level];
      if (hit) return hit;
      const image = pyramid.levels[level]!;
      const buffer = s.buffers[level];
      const g = scharr(image, buffer && buffer.gx.length === image.width * image.height ? buffer : undefined);
      s.current[level] = g;
      s.buffers[level] = g;
      return g;
    };
  }
}

function pose(model: TargetModel, H: Float64Array, input: TrackInput, quality: PoseEstimate['quality']): PoseEstimate {
  return {
    targetId: model.info.id,
    frameId: input.frame.frameId,
    timeUs: input.frame.time.captureUs,
    H_imageFromTarget: H,
    corners: cornersOf(H, model.info.width, model.info.height),
    covariance: null,
    quality,
    origin: 'tracker',
  };
}

function project(H: ArrayLike<number>, x: number, y: number): [number, number] {
  const w = H[6]! * x + H[7]! * y + H[8]!;
  return [(H[0]! * x + H[1]! * y + H[2]!) / w, (H[3]! * x + H[4]! * y + H[5]!) / w];
}

export class TemplateTracker implements FrameTracker {
  readonly info: ModuleInfo;
  private readonly models = new Map<string, TargetModel>();
  private readonly gradients = new GradientCache();
  private readonly options: TemplateTrackerOptions;
  private readonly mode: TemplateTrackerMode;

  constructor(options: TemplateTrackerOptions = {}) {
    this.options = options;
    this.mode = options.mode ?? 'klt+esm';
    this.info = {
      id: { klt: 'D1.klt', esm: 'D2.esm', 'klt+esm': 'D1+D2.klt-esm', ncc: 'D3.ncc' }[this.mode],
      layer: 'L3',
      route: 'light',
      determinism: 'bit-exact',
      requires: [],
    };
  }

  probe(_capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: true };
  }

  prepare(targets: readonly TargetImage[]): void {
    this.models.clear();
    for (const t of targets) this.models.set(t.info.id, buildTargetModel(t, this.options.model));
  }

  model(targetId: string): TargetModel | undefined {
    return this.models.get(targetId);
  }

  private trackNcc(model: TargetModel, input: TrackInput, H: Float64Array): PoseEstimate | Rejection {
    const { width, height } = model.info;
    const scale = imageScale(H, width, height);
    const level = Math.max(
      0,
      Math.min(model.pyramid.levels.length - 1, Math.round(Math.log2(1 / Math.max(scale, 1e-6)))),
    );
    const m = matchPatches(model, input.pyramid.levels[0]!, H, level, this.options.ncc);
    if (m.count < 10) return { targetId: model.info.id, reason: 'NCC_TOO_FEW' };
    const order = Array.from({ length: m.count }, (_, i) => i).sort((a, b) => m.score[b]! - m.score[a]! || a - b);
    const t = Float64Array.from(order.flatMap((i) => [m.target[2 * i]!, m.target[2 * i + 1]!]));
    const im = Float64Array.from(order.flatMap((i) => [m.image[2 * i]!, m.image[2 * i + 1]!]));
    const result = estimateHomography(t, im, m.count, width, height, {
      thresholdPx: 1.5,
      maxIterations: 100,
      minInliers: 10,
      minInlierRatio: 0.4,
      minCoverage: 0.05,
    });
    if (!result.accepted) return { targetId: model.info.id, reason: `NCC_${result.reason}` };
    return pose(model, result.H, input, {
      support: result.inliers,
      ratio: result.ratio,
      residual: result.rmsPx,
      residualKind: 'px',
      coverage: result.coverage,
    });
  }

  track(input: TrackInput): PoseEstimate | Rejection {
    const model = this.models.get(input.prior.targetId);
    if (!model) return { targetId: input.prior.targetId, reason: 'UNKNOWN_TARGET' };
    const { width, height } = model.info;
    let H = input.prior.H_imageFromTarget;
    if (this.mode === 'ncc') return this.trackNcc(model, input, H);
    let kltQuality: PoseEstimate['quality'] | null = null;
    if (this.mode !== 'esm' && input.previous && input.previous.pose.targetId === model.info.id) {
      const prevH = input.previous.pose.H_imageFromTarget;
      const a = model.anchors;
      const n = a.length / 2;
      const points = new Float64Array(2 * n);
      const guesses = new Float64Array(2 * n);
      const frame0 = input.previous.pyramid.levels[0]!;
      let m = 0;
      const keep: number[] = [];
      for (let k = 0; k < n; k++) {
        const [px, py] = project(prevH, a[2 * k]!, a[2 * k + 1]!);
        if (!(px > 8 && py > 8 && px < frame0.width - 8 && py < frame0.height - 8)) continue;
        const [qx, qy] = project(H, a[2 * k]!, a[2 * k + 1]!);
        points[2 * m] = px;
        points[2 * m + 1] = py;
        guesses[2 * m] = qx - px;
        guesses[2 * m + 1] = qy - py;
        keep.push(k);
        m++;
      }
      if (m >= 12) {
        const tracked = trackPointsChecked(
          input.previous.pyramid,
          this.gradients.of(input.previous.pyramid),
          input.pyramid,
          this.gradients.of(input.pyramid),
          points.subarray(0, 2 * m),
          guesses.subarray(0, 2 * m),
          1,
          this.options.klt,
        );
        const target: number[] = [];
        const image: number[] = [];
        const errors: number[] = [];
        for (let i = 0; i < m; i++) {
          if (!tracked.status[i]) continue;
          const k = keep[i]!;
          target.push(a[2 * k]!, a[2 * k + 1]!);
          image.push(tracked.positions[2 * i]!, tracked.positions[2 * i + 1]!);
          errors.push(tracked.error[i]!);
        }
        // Best (smallest round-trip error) first for PROSAC.
        const order = errors.map((_, i) => i).sort((p, q) => errors[p]! - errors[q]! || p - q);
        const t = Float64Array.from(order.flatMap((i) => [target[2 * i]!, target[2 * i + 1]!]));
        const im = Float64Array.from(order.flatMap((i) => [image[2 * i]!, image[2 * i + 1]!]));
        const result =
          order.length >= 12
            ? estimateHomography(t, im, order.length, width, height, {
                thresholdPx: 2,
                maxIterations: 100,
                minInliers: 10,
                minInlierRatio: 0.5,
                minCoverage: 0.05,
              })
            : null;
        if (result?.accepted) {
          H = result.H;
          kltQuality = {
            support: result.inliers,
            ratio: result.ratio,
            residual: result.rmsPx,
            residualKind: 'px',
            coverage: result.coverage,
          };
        }
      }
      if (this.mode === 'klt') {
        if (!kltQuality) return { targetId: model.info.id, reason: 'KLT_LOST' };
        return pose(model, H, input, kltQuality);
      }
    }
    const result = esmAlign(model, input.pyramid, this.gradients.of(input.pyramid), H, this.options.esm);
    if (!result) return { targetId: model.info.id, reason: 'ESM_FAILED' };
    if (result.ncc < (this.options.minNcc ?? 0.6) || result.validRatio < (this.options.minValidRatio ?? 0.2))
      return { targetId: model.info.id, reason: 'ESM_LOW_QUALITY' };
    if (!isPlausible(result.H, width, height)) return { targetId: model.info.id, reason: 'ESM_IMPLAUSIBLE' };
    return pose(model, result.H, input, {
      support: result.valid,
      ratio: result.ncc,
      residual: result.rms,
      residualKind: 'gray',
      coverage: result.validRatio,
    });
  }
}
