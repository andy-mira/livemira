// SPDX-License-Identifier: Apache-2.0
// Benchmark composition: any pipeline with a display filter (E1/E2) on its output. Measured poses update the filter;
// held or predicted ones are replaced by the filter's own prediction. The output's predictor is a frozen snapshot.

import type {
  Capability,
  FrameHandle,
  FrameOutput,
  LoadReport,
  ModuleInfo,
  PoseEstimate,
  ProbeResult,
  TargetImage,
  TargetInfo,
  VisionPipeline,
} from '@livemira-next/contracts';

export interface SnapshotFilter {
  readonly info: ModuleInfo;
  update(measurement: PoseEstimate): PoseEstimate;
  predict(targetId: string, timeUs: number): PoseEstimate | null;
  snapshot(targetId: string): ((timeUs: number) => PoseEstimate | null) | null;
  reset(targetId?: string): void;
}

export class FilteredPipeline implements VisionPipeline {
  readonly info: ModuleInfo;
  private filter: SnapshotFilter | null = null;
  private readonly inner: VisionPipeline;
  private readonly createFilter: (targets: readonly TargetInfo[]) => SnapshotFilter;

  constructor(inner: VisionPipeline, createFilter: (targets: readonly TargetInfo[]) => SnapshotFilter, id: string) {
    this.inner = inner;
    this.createFilter = createFilter;
    this.info = { ...inner.info, id };
  }

  probe(capabilities: ReadonlySet<Capability>): ProbeResult {
    return this.inner.probe(capabilities);
  }

  async load(targets: readonly TargetImage[]): Promise<LoadReport> {
    this.filter = this.createFilter(targets.map((t) => t.info));
    return this.inner.load(targets);
  }

  reset(sessionId: string): void {
    this.filter?.reset();
    this.inner.reset(sessionId);
  }

  async process(frame: FrameHandle): Promise<FrameOutput> {
    const out = await this.inner.process(frame);
    const filter = this.filter!;
    const started = performance.now();
    const display: PoseEstimate[] = [];
    for (const pose of out.display) {
      if (pose.origin === 'detector' || pose.origin === 'tracker') display.push(filter.update(pose));
      else {
        const predicted = filter.predict(pose.targetId, frame.time.captureUs);
        display.push(predicted ?? pose);
      }
    }
    if (!out.display.length) filter.reset();
    const snapshots = display.map((p) => filter.snapshot(p.targetId)).filter((s) => s !== null);
    const filterUs = (performance.now() - started) * 1000;
    return {
      ...out,
      display,
      predict: (timeUs) => snapshots.map((s) => s(timeUs)).filter((p): p is PoseEstimate => p !== null),
      timings: { ...out.timings, filter: filterUs, total: (out.timings.total ?? 0) + filterUs },
    };
  }

  detect(frame: FrameHandle): Promise<readonly PoseEstimate[]> {
    return this.inner.detect(frame);
  }

  dispose(): void {
    this.inner.dispose();
  }
}
