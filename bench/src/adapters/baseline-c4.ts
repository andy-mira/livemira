// SPDX-License-Identifier: Apache-2.0
// Baseline recognition with only its geometric stage replaced: the 0.4.1 features, matcher and half-octave retry,
// then C4 (PROSAC + MSAC + local optimisation + LM) and guided matching instead of the fixed 256-iteration RANSAC.
// The returned correspondences are the final inliers, so the baseline tracker's own gate sees C4's verdict.

import { createWasmMatchOperator, selectWasmExactMatcher, type ExactMatchOperator } from '@livemira/compute';
import type { TargetBundle } from '@livemira/contracts';
import {
  extractFeatures,
  featuresFromTarget,
  hamming,
  intermediateScaleImage,
  INTERMEDIATE_SCALE,
  matchPacked,
  packDescriptors,
  type GrayImage,
  type LocalFeature,
  type RecognitionObservation,
} from '@livemira/recognition';
import { estimateHomography, refineHomography } from '@livemira-next/geometry';

interface Prepared {
  readonly bundle: TargetBundle;
  readonly features: LocalFeature[];
  readonly packed: Uint32Array;
  readonly bytes: Uint8Array;
}

/** Guided matching: target features projected by `H` pair with the nearest unclaimed frame feature in `radiusPx`. */
function guided(
  H: Float64Array,
  target: readonly LocalFeature[],
  frame: readonly LocalFeature[],
  radiusPx: number,
  maxDistance: number,
): { t: number; f: number; d: number }[] {
  const cell = radiusPx;
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number): number => Math.floor(y / cell) * 4096 + Math.floor(x / cell);
  frame.forEach((f, i) => {
    const k = key(f.x, f.y);
    grid.set(k, [...(grid.get(k) ?? []), i]);
  });
  const claimed = new Map<number, { t: number; d: number }>();
  target.forEach((t, ti) => {
    const w = H[6]! * t.x + H[7]! * t.y + H[8]!;
    if (!(w > 0)) return;
    const u = (H[0]! * t.x + H[1]! * t.y + H[2]!) / w;
    const v = (H[3]! * t.x + H[4]! * t.y + H[5]!) / w;
    let best = -1;
    let bestD = maxDistance + 1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const fi of grid.get(key(u + dx * cell, v + dy * cell)) ?? []) {
          const f = frame[fi]!;
          if (Math.hypot(f.x - u, f.y - v) > radiusPx) continue;
          const d = hamming(t.descriptor, f.descriptor);
          if (d < bestD) {
            bestD = d;
            best = fi;
          }
        }
    if (best < 0) return;
    const prev = claimed.get(best);
    if (!prev || bestD < prev.d) claimed.set(best, { t: ti, d: bestD });
  });
  return [...claimed].map(([f, { t, d }]) => ({ t, f, d })).sort((a, b) => a.t - b.t);
}

export class C4Recognizer {
  private targets: Prepared[] = [];
  private matcher: ExactMatchOperator | null = null;

  async load(bundles: readonly TargetBundle[]): Promise<void> {
    this.targets = bundles.map((bundle) => {
      const features = featuresFromTarget(bundle);
      return {
        bundle,
        features,
        packed: packDescriptors(features),
        bytes: new Uint8Array(bundle.features.descriptors),
      };
    });
    const wasm = await selectWasmExactMatcher();
    this.matcher = wasm.matcher ? createWasmMatchOperator(wasm.matcher) : null;
  }

  /** `roi` (frame pixels) limits feature extraction like the baseline's own ROI option and skips the scale retry. */
  async recognize(
    image: GrayImage,
    identity: { sessionId: string; frameId: number },
    roi: { x: number; y: number; width: number; height: number } | null = null,
  ): Promise<RecognitionObservation[]> {
    const first = await this.once(image, identity, 1, roi);
    if (first.length || roi) return first;
    const scaled = intermediateScaleImage(image);
    return scaled ? this.once(scaled, identity, INTERMEDIATE_SCALE, null) : [];
  }

  private async once(
    image: GrayImage,
    identity: { sessionId: string; frameId: number },
    scale: number,
    roi: { x: number; y: number; width: number; height: number } | null,
  ): Promise<RecognitionObservation[]> {
    const { features } = extractFeatures(image, { maxFeatures: 512, levels: 3, roi });
    if (scale !== 1)
      for (const f of features) {
        f.x = (f.x + 0.5) / scale - 0.5;
        f.y = (f.y + 0.5) / scale - 0.5;
      }
    const frameBytes = new Uint8Array(features.flatMap((f) => f.descriptor));
    const batch = this.matcher
      ? await this.matcher(
          this.targets.map((t) => ({ targetId: t.bundle.targetId, descriptors: t.bytes })),
          frameBytes,
        )
      : null;
    const packed = packDescriptors(features);
    const observations: RecognitionObservation[] = [];
    for (const t of this.targets) {
      const pairs =
        batch?.matches
          .find((m) => m.targetId === t.bundle.targetId)
          ?.pairs.map((p) => ({ t: p.targetIndex, f: p.frameIndex, d: p.distance })) ??
        matchPacked(t.features, features, t.packed, packed).map((p) => ({
          t: t.features.findIndex((q) => q.x === p.target[0] && q.y === p.target[1]),
          f: features.findIndex((q) => q.x === p.image[0] && q.y === p.image[1]),
          d: p.distance,
        }));
      pairs.sort((a, b) => a.d - b.d || a.t - b.t);
      const n = pairs.length;
      const tp = new Float64Array(2 * n);
      const ip = new Float64Array(2 * n);
      pairs.forEach((p, i) => {
        tp.set([t.features[p.t]!.x, t.features[p.t]!.y], 2 * i);
        ip.set([features[p.f]!.x, features[p.f]!.y], 2 * i);
      });
      const result = estimateHomography(tp, ip, n, t.bundle.widthPx, t.bundle.heightPx, { minInliers: 12 });
      if (!result.accepted) continue;
      // Guided matching around the verified model, then a final refinement over everything within the threshold.
      const more = guided(result.H, t.features, features, 6, 80);
      const gt = new Float64Array(2 * more.length);
      const gi = new Float64Array(2 * more.length);
      more.forEach((p, i) => {
        gt.set([t.features[p.t]!.x, t.features[p.t]!.y], 2 * i);
        gi.set([features[p.f]!.x, features[p.f]!.y], 2 * i);
      });
      const mask = new Uint8Array(more.length);
      for (let i = 0; i < more.length; i++) {
        const x = gt[2 * i]!;
        const y = gt[2 * i + 1]!;
        const H = result.H;
        const w = H[6]! * x + H[7]! * y + 1;
        mask[i] =
          Math.hypot(
            (H[0]! * x + H[1]! * y + H[2]!) / w - gi[2 * i]!,
            (H[3]! * x + H[4]! * y + H[5]!) / w - gi[2 * i + 1]!,
          ) < 3
            ? 1
            : 0;
      }
      const useGuided = mask.reduce((a, b) => a + b, 0) > result.inliers;
      const final = useGuided ? refineHomography(result.H, gt, gi, mask, more.length, { huberPx: 1.5 }).H : result.H;
      const targetPoints: [number, number][] = [];
      const imagePoints: [number, number][] = [];
      const src = useGuided ? { t: gt, i: gi, m: mask, n: more.length } : { t: tp, i: ip, m: result.mask, n };
      for (let i = 0; i < src.n; i++) {
        if (!src.m[i]) continue;
        targetPoints.push([src.t[2 * i]!, src.t[2 * i + 1]!]);
        imagePoints.push([src.i[2 * i]!, src.i[2 * i + 1]!]);
      }
      observations.push({
        sessionId: identity.sessionId,
        frameId: identity.frameId,
        targetId: t.bundle.targetId,
        algorithmVersion: t.bundle.algorithmVersion,
        H_imageFromTarget: Array.from(final) as unknown as RecognitionObservation['H_imageFromTarget'],
        targetPoints,
        imagePoints,
        inliers: targetPoints.map(() => true),
        reprojectionErrorPx: result.rmsPx,
        spatialCoverage: result.coverage,
      });
    }
    observations.sort((a, b) => b.targetPoints.length - a.targetPoints.length);
    if (observations.length > 1 && observations[1]!.targetPoints.length >= 0.85 * observations[0]!.targetPoints.length)
      return [];
    return observations;
  }
}
