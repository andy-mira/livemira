// SPDX-License-Identifier: Apache-2.0
// B0: the LiveMira 0.4.1 vision core (Recognizer + Tracker, WASM SIMD matching as in its Worker) behind the
// VisionPipeline contract, so the baseline runs through exactly the same benchmark as every candidate.

import { selectWasmExactMatcher, createWasmMatchOperator } from '@livemira/compute';
import type { TargetBundle, TrackingResult, TrackingState } from '@livemira/contracts';
import { Recognizer, type RecognitionObservation } from '@livemira/recognition';
import { compileGrayTarget, serializeTarget } from '@livemira/target-compiler';
import { checkObservation, Tracker } from '@livemira/tracking';

import { C4Recognizer } from './baseline-c4.ts';
import {
  cornersOf,
  mat3,
  type Capability,
  type FrameHandle,
  type FrameOutput,
  type LoadReport,
  type ModuleInfo,
  type PoseEstimate,
  type ProbeResult,
  type TargetImage,
  type TrackState,
  type VisionPipeline,
} from '@livemira-next/contracts';

const STATE: Record<TrackingState, TrackState> = {
  SEARCHING: 'SEARCHING',
  ACQUIRING: 'CANDIDATE',
  TRACKING: 'TRACKING',
  LIMITED: 'COASTING',
  LOST: 'LOST',
};

function gray(frame: FrameHandle): { widthPx: number; heightPx: number; data: Uint8Array } {
  if (frame.image.kind !== 'cpu-gray') throw new Error('B0 adapter needs cpu-gray frames');
  const { width, height, stride, data } = frame.image.image;
  if (stride !== width) throw new Error('B0 adapter needs tight rows');
  return { widthPx: width, heightPx: height, data };
}

export interface BaselineOptions {
  /** 'baseline': the 0.4.1 Recognizer; 'c4': its features and matcher with C4 geometry and guided matching. */
  readonly geometry?: 'baseline' | 'c4';
}

export class BaselinePipeline implements VisionPipeline {
  readonly info: ModuleInfo;
  private readonly geometry: 'baseline' | 'c4';
  private recognizer: Recognizer | null = null;
  private c4: C4Recognizer | null = null;
  private tracker: Tracker | null = null;
  private targets: TargetBundle[] = [];
  private session = 'b0';
  private resetting: Promise<void> | null = null;
  private stages: Record<string, number> = {};

  constructor(options: BaselineOptions = {}) {
    this.geometry = options.geometry ?? 'baseline';
    this.info = {
      id: this.geometry === 'c4' ? 'B0+C4' : 'B0.livemira-0.4.1',
      layer: 'L3',
      route: 'light',
      determinism: 'bit-exact',
      requires: ['wasm-simd'],
    };
  }

  /** Observations of one frame from the configured recognition path, with stage times recorded. */
  private async observe(
    image: { widthPx: number; heightPx: number; data: Uint8Array },
    identity: { sessionId: string; frameId: number },
    signal?: AbortSignal,
  ): Promise<readonly RecognitionObservation[]> {
    if (this.c4) {
      const started = performance.now();
      const observations = await this.c4.recognize(image, identity);
      this.stages = { recognize: (performance.now() - started) * 1000 };
      return observations;
    }
    const batch = await this.recognizer!.recognize(image, identity, signal ? { signal } : {});
    this.stages = {
      features: batch.facts.featureMs * 1000,
      match: batch.facts.matchMs * 1000,
      geometry: batch.facts.geometryMs * 1000,
    };
    return batch.observations;
  }

  probe(capabilities: ReadonlySet<Capability>): ProbeResult {
    return { isAvailable: capabilities.has('wasm-simd') };
  }

  async load(targets: readonly TargetImage[]): Promise<LoadReport> {
    const report: { id: string; compileUs: number; serialized: Uint8Array }[] = [];
    this.targets = [];
    for (const t of targets) {
      const started = performance.now();
      const bundle = await compileGrayTarget(
        { widthPx: t.image.width, heightPx: t.image.height, data: t.image.data },
        { targetId: t.info.id, physicalWidthMeters: t.info.physicalWidthMeters },
      );
      const compileUs = (performance.now() - started) * 1000;
      this.targets.push(bundle);
      report.push({ id: t.info.id, compileUs, serialized: new TextEncoder().encode(await serializeTarget(bundle)) });
    }
    if (this.geometry === 'c4') {
      this.c4 = new C4Recognizer();
      await this.c4.load(this.targets);
    } else {
      const wasm = await selectWasmExactMatcher();
      this.recognizer = new Recognizer(wasm.matcher ? { exactMatcher: createWasmMatchOperator(wasm.matcher) } : {});
      await this.recognizer.loadTargets(this.targets);
    }
    this.tracker = new Tracker({
      recognize: (frame, _targets, signal) => this.observe(frame.image, frame, signal),
    });
    await this.tracker.loadTargets(this.targets);
    return { targets: report };
  }

  reset(sessionId: string): void {
    this.session = sessionId;
    this.resetting = this.tracker?.reset(sessionId) ?? null;
  }

  private pose(
    targetId: string,
    H: ArrayLike<number>,
    frame: FrameHandle,
    origin: PoseEstimate['origin'],
    q: TrackingResult['quality'] | null,
  ): PoseEstimate {
    const t = this.targets.find((x) => x.targetId === targetId)!;
    const h = mat3(H);
    return {
      targetId,
      frameId: frame.frameId,
      timeUs: frame.time.captureUs,
      H_imageFromTarget: h,
      corners: cornersOf(h, t.widthPx, t.heightPx),
      covariance: null,
      quality: {
        support: q?.inlierCount ?? 0,
        ratio: q?.inlierRatio ?? 0,
        residual: q?.reprojectionErrorPx ?? 0,
        residualKind: 'px',
        coverage: q?.spatialCoverage ?? 0,
      },
      origin,
    };
  }

  async process(frame: FrameHandle): Promise<FrameOutput> {
    if (!this.tracker) throw new Error('B0 targets not loaded');
    if (this.resetting) {
      await this.resetting;
      this.resetting = null;
    }
    return this.processFrame(frame);
  }

  private async processFrame(frame: FrameHandle): Promise<FrameOutput> {
    this.stages = {};
    const started = performance.now();
    const result = await this.tracker!.process(
      {
        sessionId: this.session,
        frameId: frame.frameId,
        pictureKey: `${this.session}:${frame.frameId}`,
        observationTimeUs: frame.time.captureUs,
        image: gray(frame),
      },
      new AbortController().signal,
    );
    const totalUs = (performance.now() - started) * 1000;
    const hasPose = result.targetId !== null && result.H_imageFromTarget !== null;
    const measured = hasPose && result.quality.isMeasured;
    const shown = hasPose && (result.state === 'TRACKING' || result.state === 'LIMITED');
    const measuredPose = measured
      ? this.pose(result.targetId!, result.H_imageFromTarget!, frame, 'detector', result.quality)
      : null;
    return {
      frameId: frame.frameId,
      timeUs: frame.time.captureUs,
      state: STATE[result.state],
      poses: measuredPose ? [measuredPose] : [],
      display: shown
        ? [measuredPose ?? this.pose(result.targetId!, result.H_imageFromTarget!, frame, 'predicted', result.quality)]
        : [],
      timings: { ...this.stages, total: totalUs },
    };
  }

  async detect(frame: FrameHandle): Promise<readonly PoseEstimate[]> {
    if (!this.tracker) throw new Error('B0 targets not loaded');
    const observations = await this.observe(gray(frame), { sessionId: 'detect', frameId: frame.frameId });
    const poses: PoseEstimate[] = [];
    for (const o of observations) {
      const target = this.targets.find((t) => t.targetId === o.targetId);
      if (!target) continue;
      try {
        const checked = checkObservation(o, target);
        poses.push(
          this.pose(o.targetId, checked.h, frame, 'detector', {
            ...checked.quality,
          }),
        );
      } catch {
        // The baseline tracker would reject this observation too.
      }
    }
    return poses;
  }

  dispose(): void {
    void this.tracker?.dispose();
    this.recognizer?.dispose();
    this.tracker = null;
    this.recognizer = null;
    this.c4 = null;
  }
}
