// SPDX-License-Identifier: Apache-2.0
// Slow-loop detector for the dual-loop pipelines until C1 exists: the baseline's features and matcher with C4
// geometry (B0+C4), behind the Detector contract. The baseline works in pixel-centre coordinates; poses are converted
// to the pixel-edge convention the new modules use (H_edge = T(+½) · H_centre · T(−½)).

import { compileGrayTarget, serializeTarget } from '@livemira/target-compiler';
import type { TargetBundle } from '@livemira/contracts';
import {
  cornersOf,
  type Capability,
  type Detector,
  type FrameHandle,
  type LoadReport,
  type ModuleInfo,
  type PoseEstimate,
  type ProbeResult,
  type RectPx,
  type TargetImage,
} from '@livemira-next/contracts';
import { multiply3 } from '@livemira-next/geometry';

import { C4Recognizer } from './baseline-c4.ts';

export function centreToEdge(h: ArrayLike<number>): Float64Array {
  const out = multiply3(multiply3([1, 0, 0.5, 0, 1, 0.5, 0, 0, 1], h), [1, 0, -0.5, 0, 1, -0.5, 0, 0, 1]);
  const k = out[8]!;
  return out.map((v) => v / k);
}

export class BaselineC4Detector implements Detector {
  readonly info: ModuleInfo = {
    id: 'B0+C4.detector',
    layer: 'L2',
    route: 'light',
    determinism: 'bit-exact',
    requires: ['wasm-simd'],
  };
  private readonly recognizer = new C4Recognizer();
  private bundles: TargetBundle[] = [];

  probe(capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: capabilities.has('wasm-simd') };
  }

  async load(targets: readonly TargetImage[]): Promise<LoadReport> {
    const report: { id: string; compileUs: number; serialized: Uint8Array }[] = [];
    this.bundles = [];
    for (const t of targets) {
      const started = performance.now();
      const bundle = await compileGrayTarget(
        { widthPx: t.image.width, heightPx: t.image.height, data: t.image.data },
        { targetId: t.info.id, physicalWidthMeters: t.info.physicalWidthMeters },
      );
      report.push({
        id: t.info.id,
        compileUs: (performance.now() - started) * 1000,
        serialized: new TextEncoder().encode(await serializeTarget(bundle)),
      });
      this.bundles.push(bundle);
    }
    await this.recognizer.load(this.bundles);
    return { targets: report };
  }

  async detect(frame: FrameHandle, options: { readonly roi?: RectPx | null } = {}): Promise<readonly PoseEstimate[]> {
    if (frame.image.kind !== 'cpu-gray') throw new Error('detector needs cpu-gray frames');
    const { width, height, data } = frame.image.image;
    const roi = options.roi && options.roi.width >= 48 && options.roi.height >= 48 ? options.roi : null;
    const observations = await this.recognizer.recognize(
      { widthPx: width, heightPx: height, data },
      { sessionId: frame.sessionId, frameId: frame.frameId },
      roi,
    );
    return observations.map((o) => {
      const t = this.bundles.find((b) => b.targetId === o.targetId)!;
      const H = centreToEdge(o.H_imageFromTarget);
      return {
        targetId: o.targetId,
        frameId: frame.frameId,
        timeUs: frame.time.captureUs,
        H_imageFromTarget: H,
        corners: cornersOf(H, t.widthPx, t.heightPx),
        covariance: null,
        quality: {
          support: o.targetPoints.length,
          ratio: 1,
          residual: o.reprojectionErrorPx,
          residualKind: 'px',
          coverage: o.spatialCoverage,
        },
        origin: 'detector',
      };
    });
  }
}
