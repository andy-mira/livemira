// SPDX-License-Identifier: Apache-2.0
// Detector (the slow loop): oriented multi-scale features of the frame, grouped nearest-two matching against each
// target's view-synthesised descriptor bank (WASM SIMD), ratio test, one match per target point, then a robust
// homography. Targets given as pictures are compiled, encoded and decoded again, so detection uses what would ship.

import {
  cornersOf,
  type Capability,
  type Detector,
  type FrameHandle,
  type GrayImage,
  type Keypoints,
  type LoadReport,
  type ModuleInfo,
  type PoseEstimate,
  type ProbeResult,
  type RectPx,
  type TargetImage,
} from '@livemira-next/contracts';
import { estimateHomography } from '@livemira-next/geometry';
import { sample } from '@livemira-next/imaging';

import { compileTarget, type CompiledTarget, type CompileOptions } from './compile.ts';
import { decodeTarget, encodeTarget } from './format.ts';
import { HammingMatcher } from './hamming.ts';
import { extractOrb, type OrbOptions } from './orb.ts';

export interface OrbDetectorOptions {
  readonly orb?: OrbOptions;
  readonly compile?: CompileOptions;
  /**
   * Nearest/second-nearest ratio a match must stay below; 1 keeps every match within `maxDistance` and lets PROSAC
   * (which draws in ratio order) sort them out.
   */
  readonly ratio?: number;
  readonly maxDistance?: number;
  /** Inlier threshold of the detection geometry, px (the tracker refines the pose afterwards). */
  readonly thresholdPx?: number;
  readonly templateMaxEdge?: number;
  readonly allowWasm?: boolean;
}

/**
 * Features taken from a whole frame: the density of 700 on 640 × 360, so a larger processed picture (the camera's own
 * size) keeps its finer detail for small targets instead of spreading the same features thinner; never fewer than 700.
 * Measured with bench/src/diagnose-small-target.ts --scales: at 1280 × 720 a photo across 30% of the short edge is
 * found in no frame with 700 features and in all of them with 2800.
 */
const wholeFrameBudget = (image: GrayImage): number =>
  Math.max(700, Math.round((700 * image.width * image.height) / (640 * 360)));

/** An enlarged region stays within about one and a half processed frames of pixels. */
const MAX_ENLARGED_PX = 360_000;

/**
 * Features of `roi` enlarged by `scale` (bilinear): a target small on screen gets enough pixels for its features to
 * appear at the scales the target was compiled at. Positions are mapped back to frame pixels.
 */
function enlargedFeatures(image: GrayImage, roi: RectPx, scale: number, options: OrbOptions): Keypoints | null {
  const s = Math.min(scale, 3, Math.sqrt(MAX_ENLARGED_PX / (roi.width * roi.height)));
  if (s < 1.2) return null;
  const width = Math.round(roi.width * s);
  const height = Math.round(roi.height * s);
  const data = new Uint8Array(width * height);
  // Edge coordinates kept inside the frame, where bilinear sampling is defined.
  const xMax = image.width - 1.001;
  const yMax = image.height - 1.001;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(yMax, Math.max(0.5, roi.y + (y + 0.5) / s));
    for (let x = 0; x < width; x++)
      data[y * width + x] = Math.round(sample(image, Math.min(xMax, Math.max(0.5, roi.x + (x + 0.5) / s)), sy));
  }
  const k = extractOrb({ width, height, stride: width, data }, { budget: 500, ...options });
  return {
    ...k,
    x: k.x.map((v) => roi.x + (v + 0.5) / s - 0.5),
    y: k.y.map((v) => roi.y + (v + 0.5) / s - 0.5),
  };
}

export class OrbDetector implements Detector {
  readonly info: ModuleInfo = {
    id: 'C1.orb-views',
    layer: 'L2',
    route: 'light',
    determinism: 'bit-exact',
    requires: [],
  };
  private readonly options: OrbDetectorOptions;
  private readonly matcher: HammingMatcher;
  private targets: CompiledTarget[] = [];

  constructor(options: OrbDetectorOptions = {}) {
    this.options = options;
    this.matcher = HammingMatcher.create(options.allowWasm === false ? { allowWasm: false } : {});
  }

  get backend(): string {
    return this.matcher.backend;
  }

  probe(_capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: true };
  }

  async load(targets: readonly TargetImage[]): Promise<LoadReport> {
    const report: LoadReport['targets'][number][] = [];
    this.targets = [];
    for (const t of targets) {
      const started = performance.now();
      const compiled = compileTarget(t, this.options.compile);
      const serialized = await encodeTarget(compiled, t.image, {
        templateMaxEdge: this.options.templateMaxEdge ?? 480,
      });
      const asset = await decodeTarget(serialized);
      this.targets.push(asset.compiled);
      report.push({
        id: t.info.id,
        compileUs: (performance.now() - started) * 1000,
        serialized,
        template: asset.template,
      });
    }
    return { targets: report };
  }

  async loadEncoded(assets: readonly Uint8Array[]): Promise<LoadReport> {
    const report: LoadReport['targets'][number][] = [];
    this.targets = [];
    for (const bytes of assets) {
      const started = performance.now();
      const asset = await decodeTarget(bytes);
      this.targets.push(asset.compiled);
      report.push({
        id: asset.compiled.info.id,
        compileUs: (performance.now() - started) * 1000,
        serialized: bytes,
        template: asset.template,
        info: asset.compiled.info,
      });
    }
    return { targets: report };
  }

  async detect(
    frame: FrameHandle,
    options: { readonly roi?: RectPx | null; readonly upscale?: number } = {},
  ): Promise<readonly PoseEstimate[]> {
    if (frame.image.kind !== 'cpu-gray') throw new Error('OrbDetector needs cpu-gray frames');
    const roi = options.roi ?? null;
    const k =
      (roi && (options.upscale ?? 1) > 1
        ? enlargedFeatures(frame.image.image, roi, options.upscale!, this.options.orb ?? {})
        : null) ??
      extractOrb(frame.image.image, {
        budget: roi ? 500 : wholeFrameBudget(frame.image.image),
        ...this.options.orb,
        roi,
      });
    if (k.count < 8) return [];
    // Measured on the single-frame detection sweeps (bench/src/tune-detector.ts): without the ratio test, false detections rise to ~4.5 per 1000
    // frames for little recall; 0.85 keeps them at zero.
    const ratio = this.options.ratio ?? 0.85;
    const maxDistance = this.options.maxDistance ?? 80;
    const found: { pose: PoseEstimate; inliers: number }[] = [];
    for (const t of this.targets) {
      const nn = this.matcher.nearest2Grouped(k.descriptors, t.descriptors, t.descriptorPoint);
      // One match per target point: the frame feature with the lowest ratio wins.
      const byPoint = new Map<number, { q: number; r: number }>();
      for (let q = 0; q < k.count; q++) {
        const best = nn[3 * q + 1]!;
        const second = nn[3 * q + 2]!;
        if (best > maxDistance || (ratio < 1 && best >= ratio * second)) continue;
        const point = t.descriptorPoint[nn[3 * q]!]!;
        const r = best / Math.max(1, second);
        const prev = byPoint.get(point);
        if (!prev || r < prev.r) byPoint.set(point, { q, r });
      }
      const matches = [...byPoint].sort((a, b) => a[1].r - b[1].r || a[0] - b[0]);
      if (matches.length < 12) continue;
      const tp = new Float64Array(2 * matches.length);
      const ip = new Float64Array(2 * matches.length);
      matches.forEach(([point, { q }], i) => {
        tp[2 * i] = t.points[2 * point]!;
        tp[2 * i + 1] = t.points[2 * point + 1]!;
        ip[2 * i] = k.x[q]!;
        ip[2 * i + 1] = k.y[q]!;
      });
      const result = estimateHomography(tp, ip, matches.length, t.info.width, t.info.height, {
        thresholdPx: this.options.thresholdPx ?? 4,
        maxIterations: 1000,
        minInliers: 12,
        minInlierRatio: 0.1,
        minCoverage: 0.05,
      });
      if (!result.accepted) continue;
      found.push({
        inliers: result.inliers,
        pose: {
          targetId: t.info.id,
          frameId: frame.frameId,
          timeUs: frame.time.captureUs,
          H_imageFromTarget: result.H,
          corners: cornersOf(result.H, t.info.width, t.info.height),
          covariance: null,
          quality: {
            support: result.inliers,
            ratio: result.ratio,
            residual: result.rmsPx,
            residualKind: 'px',
            coverage: result.coverage,
          },
          origin: 'detector',
        },
      });
    }
    found.sort((a, b) => b.inliers - a.inliers || a.pose.targetId.localeCompare(b.pose.targetId));
    if (found.length > 1 && found[1]!.inliers >= 0.85 * found[0]!.inliers) return [];
    return found.map((f) => f.pose);
  }
}
