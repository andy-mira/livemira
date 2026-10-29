// SPDX-License-Identifier: Apache-2.0
// Dual-loop orchestration. The fast loop tracks the target in every processed frame from a motion-model prior;
// the slow loop (an injected detector) searches the whole frame when nothing is tracked, re-checks a region around
// the tracked target periodically, and relocalises while the pose is coasting. One detection that the tracker can
// refine is enough to show a target (no three-frame confirmation). Display poses go through an optional filter.

import {
  cornersOf,
  type Capability,
  type Detector,
  type FrameHandle,
  type FrameOutput,
  type FrameTracker,
  type LoadReport,
  type ModuleInfo,
  type PoseEstimate,
  type PoseFilter,
  type ProbeResult,
  type RectPx,
  type TargetImage,
  type TargetInfo,
  type TrackState,
  type VisionPipeline,
  type ImagePyramid,
} from '@livemira-next/contracts';
import { homographyFromCorners } from '@livemira-next/filters';
import { invert3, multiply3 } from '@livemira-next/geometry';
import { PyramidWorkspace } from '@livemira-next/imaging';

export interface DualLoopOptions {
  readonly pyramidLevels?: number;
  /** Slow-loop period while tracking, in processed frames (0: only when tracking fails). */
  readonly relocalizeEvery?: number;
  /** ROI margin around the predicted target box, as a fraction of the box size. */
  readonly roiMargin?: number;
  /** How long a lost pose is extrapolated and shown, µs. */
  readonly coastUs?: number;
  /** A periodic detection farther than this (fraction of the diagonal) from the tracked pose re-initialises. */
  readonly reinitDisagreement?: number;
  /** Tracker quality (ratio) below which the state is DEGRADED. */
  readonly degradedRatio?: number;
  /**
   * Run periodic relocalisation concurrently (a second Worker in the browser): its time is reported as `background`
   * instead of `total`, and its result is applied `asyncDelayFrames` processed frames later, transferred to that
   * frame through the tracked motion. Searching (nothing tracked) stays on the critical path.
   */
  readonly asyncRelocalization?: boolean;
  readonly asyncDelayFrames?: number;
  /**
   * After a loss, the search keeps to a region around the last pose for this long, µs (the region grows by one target
   * size per second; every third frame still searches the whole frame).
   */
  readonly lostSearchUs?: number;
  /** A target whose long edge is shorter than this on screen, px, is searched in an enlarged region (up to 3×). */
  readonly smallTargetPx?: number;
}

/**
 * How much to enlarge a search region around `pose` for the detector: a target whose long edge on screen is well under
 * `smallPx` is enlarged towards that size, at most 3×; otherwise 1. Measured with
 * bench/src/diagnose-small-target.ts: the detector finds targets of 80–140 px long edge in 0–90% of frames at their
 * own size and in 85–100% once enlarged 2–3×.
 */
export function upscaleFor(pose: PoseEstimate, smallPx = 240): number {
  const c = pose.corners;
  let long = 0;
  for (let i = 0; i < 4; i++)
    long = Math.max(long, Math.hypot(c[(i + 1) % 4]![0] - c[i]![0], c[(i + 1) % 4]![1] - c[i]![1]));
  // Below 1.2× an enlarged region finds no more than the frame does.
  const k = long > 0 ? smallPx / long : 1;
  return k >= 1.2 ? Math.min(3, k) : 1;
}

/** A periodic relocalisation handed to a concurrent detector (e.g. a second Worker). */
export interface RelocalizeRequest {
  readonly frame: FrameHandle;
  readonly roi: RectPx;
  /** The pose tracked in that frame; the answer comes back with it through `deliverRelocalization`. */
  readonly tracked: PoseEstimate;
}

export interface DualLoopParts {
  readonly id: string;
  readonly detector: Detector;
  readonly tracker: FrameTracker;
  readonly filter?: (targets: readonly TargetInfo[]) => PoseFilter;
  /**
   * With `asyncRelocalization`, periodic relocalisation is sent here instead of being run in place; results return
   * through `deliverRelocalization`. Searching (nothing tracked) always uses `detector` in place.
   */
  readonly relocalizer?: (request: RelocalizeRequest) => void;
}

const isPose = (r: unknown): r is PoseEstimate => typeof r === 'object' && r !== null && 'H_imageFromTarget' in r;

function meanCornerDistance(a: PoseEstimate, b: PoseEstimate): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a.corners[i]![0] - b.corners[i]![0], a.corners[i]![1] - b.corners[i]![1]);
  return s / 4;
}

function diagonal(p: PoseEstimate): number {
  const c = p.corners;
  return (Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) + Math.hypot(c[3][0] - c[1][0], c[3][1] - c[1][1])) / 2;
}

export class DualLoopPipeline implements VisionPipeline {
  readonly info: ModuleInfo;
  private readonly parts: DualLoopParts;
  private readonly options: Required<DualLoopOptions>;
  private readonly workspaces = [new PyramidWorkspace(), new PyramidWorkspace()];
  private flip = 0;
  private targets = new Map<string, TargetInfo>();
  private filter: PoseFilter | null = null;
  private state: TrackState = 'SEARCHING';
  /** The last measured pose and the two before it, for the constant-velocity prior. */
  private measured: PoseEstimate[] = [];
  private previousFrame: { frameId: number; pyramid: ImagePyramid } | null = null;
  private processed = 0;
  /** A concurrent relocalisation result waiting to be applied: detected and tracked poses of the same frame. */
  private late: { applyAt: number; detected: PoseEstimate; tracked: PoseEstimate } | null = null;
  /** The last measured pose before the latest loss, for searching around it. */
  private lost: { pose: PoseEstimate; timeUs: number } | null = null;

  constructor(parts: DualLoopParts, options: DualLoopOptions = {}) {
    this.parts = parts;
    this.options = {
      pyramidLevels: options.pyramidLevels ?? 4,
      relocalizeEvery: options.relocalizeEvery ?? 10,
      roiMargin: options.roiMargin ?? 0.35,
      coastUs: options.coastUs ?? 150_000,
      reinitDisagreement: options.reinitDisagreement ?? 0.04,
      degradedRatio: options.degradedRatio ?? 0.75,
      asyncRelocalization: options.asyncRelocalization ?? false,
      asyncDelayFrames: options.asyncDelayFrames ?? 2,
      lostSearchUs: options.lostSearchUs ?? 2_000_000,
      smallTargetPx: options.smallTargetPx ?? 240,
    };
    this.info = {
      id: parts.id,
      layer: 'L3',
      route: 'light',
      determinism: 'bit-exact',
      requires: [...parts.detector.info.requires, ...parts.tracker.info.requires],
    };
  }

  probe(capabilities: ReadonlySet<Capability>): ProbeResult {
    const d = this.parts.detector.probe(capabilities);
    return d.isAvailable ? this.parts.tracker.probe(capabilities) : d;
  }

  async load(targets: readonly TargetImage[]): Promise<LoadReport> {
    this.targets = new Map(targets.map((t) => [t.info.id, t.info]));
    const report = await this.parts.detector.load(targets);
    const started = performance.now();
    // Track against the template as shipped in the asset, when the detector's asset carries its own.
    const shipped = targets.map((t) => {
      const template = report.targets.find((r) => r.id === t.info.id)?.template;
      return template ? { info: t.info, image: template } : t;
    });
    this.parts.tracker.prepare(shipped);
    const trackerUs = ((performance.now() - started) * 1000) / Math.max(1, targets.length);
    this.filter = this.parts.filter ? this.parts.filter(targets.map((t) => t.info)) : null;
    return { targets: report.targets.map((t) => ({ ...t, compileUs: t.compileUs + trackerUs })) };
  }

  /** Loads precompiled assets through the detector; the tracker uses the templates they carry. */
  async loadEncoded(assets: readonly Uint8Array[]): Promise<LoadReport> {
    if (!this.parts.detector.loadEncoded) throw new Error('Detector cannot load encoded assets');
    const report = await this.parts.detector.loadEncoded(assets);
    const targets = report.targets.map((t) => {
      if (!t.info || !t.template) throw new Error('Encoded asset without info or template');
      return { info: t.info, image: t.template };
    });
    this.targets = new Map(targets.map((t) => [t.info.id, t.info]));
    const started = performance.now();
    this.parts.tracker.prepare(targets);
    const trackerUs = ((performance.now() - started) * 1000) / Math.max(1, targets.length);
    this.filter = this.parts.filter ? this.parts.filter(targets.map((t) => t.info)) : null;
    return { targets: report.targets.map((t) => ({ ...t, compileUs: t.compileUs + trackerUs })) };
  }

  /** The answer of a concurrent relocalisation; applied at the next processed frame. */
  deliverRelocalization(detected: PoseEstimate | null, tracked: PoseEstimate): void {
    if (detected && detected.targetId === tracked.targetId) this.late = { applyAt: this.processed, detected, tracked };
  }

  reset(_sessionId: string): void {
    this.late = null;
    this.lost = null;
    this.state = 'SEARCHING';
    this.measured = [];
    this.previousFrame = null;
    this.processed = 0;
    this.filter?.reset();
  }

  /** Constant-velocity prediction of the last measured pose to `timeUs`, in corner space. */
  private prior(timeUs: number): PoseEstimate | null {
    const last = this.measured.at(-1);
    if (!last) return null;
    const info = this.targets.get(last.targetId)!;
    const before = this.measured.at(-2);
    if (!before || last.timeUs - before.timeUs > 150_000 || last.timeUs <= before.timeUs) return last;
    const k = Math.min(timeUs - last.timeUs, 100_000) / (last.timeUs - before.timeUs);
    const corners: number[] = [];
    for (let i = 0; i < 4; i++)
      for (let a = 0; a < 2; a++)
        corners.push(last.corners[i]![a]! + k * (last.corners[i]![a]! - before.corners[i]![a]!));
    const H = homographyFromCorners(info, corners);
    return H
      ? { ...last, H_imageFromTarget: H, corners: cornersOf(H, info.width, info.height), timeUs, origin: 'predicted' }
      : last;
  }

  private roi(p: PoseEstimate, width: number, height: number, grow = 0): RectPx {
    const xs = p.corners.map((c) => c[0]);
    const ys = p.corners.map((c) => c[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    const m = this.options.roiMargin + grow;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - m * w));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - m * h));
    const x1 = Math.min(width, Math.ceil(Math.max(...xs) + m * w));
    const y1 = Math.min(height, Math.ceil(Math.max(...ys) + m * h));
    return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  }

  async process(frame: FrameHandle): Promise<FrameOutput> {
    if (frame.image.kind !== 'cpu-gray') throw new Error('DualLoopPipeline needs cpu-gray frames');
    const timings: Record<string, number> = {};
    const t0 = performance.now();
    const ws = this.workspaces[(this.flip ^= 1)]!;
    const pyramid = ws.build(frame.image.image, this.options.pyramidLevels);
    const t1 = performance.now();
    timings.pyramid = (t1 - t0) * 1000;
    const timeUs = frame.time.captureUs;
    const lastMeasured = this.measured.at(-1) ?? null;
    const previous =
      lastMeasured && this.previousFrame && lastMeasured.frameId === this.previousFrame.frameId
        ? { pyramid: this.previousFrame.pyramid, pose: lastMeasured }
        : null;
    let pose: PoseEstimate | null = null;
    const prior = this.prior(timeUs);
    const tracking = prior !== null && lastMeasured !== null && timeUs - lastMeasured.timeUs <= this.options.coastUs;
    if (tracking) {
      const r = this.parts.tracker.track({ frame, pyramid, prior: { ...prior, frameId: frame.frameId }, previous });
      if (isPose(r)) pose = r;
    }
    const t2 = performance.now();
    timings.track = (t2 - t1) * 1000;
    // A concurrent relocalisation from an earlier frame: move its discrepancy to this frame and re-initialise if large.
    if (this.late && this.processed >= this.late.applyAt) {
      const { detected, tracked } = this.late;
      this.late = null;
      const inverse = invert3(tracked.H_imageFromTarget);
      if (pose && inverse && detected.targetId === pose.targetId) {
        const D = multiply3(detected.H_imageFromTarget, inverse);
        const moved = multiply3(D, pose.H_imageFromTarget);
        const info = this.targets.get(pose.targetId)!;
        const candidate: PoseEstimate = {
          ...pose,
          H_imageFromTarget: moved,
          corners: cornersOf(moved, info.width, info.height),
          origin: 'detector',
        };
        if (meanCornerDistance(candidate, pose) > this.options.reinitDisagreement * diagonal(pose)) {
          const refined = this.parts.tracker.track({ frame, pyramid, prior: candidate, previous: null });
          if (isPose(refined)) pose = refined;
        }
      }
    }
    const every = this.options.relocalizeEvery;
    const periodic = pose !== null && every > 0 && this.processed % every === every - 1;
    if (periodic && this.options.asyncRelocalization && this.parts.relocalizer) {
      this.parts.relocalizer({
        frame,
        roi: this.roi(pose!, pyramid.levels[0]!.width, pyramid.levels[0]!.height),
        tracked: pose!,
      });
    } else if (periodic && this.options.asyncRelocalization) {
      const started = performance.now();
      const roi = this.roi(pose!, pyramid.levels[0]!.width, pyramid.levels[0]!.height);
      const upscale = upscaleFor(pose!, this.options.smallTargetPx);
      const detected = (await this.parts.detector.detect(frame, { roi, upscale })).find(
        (d) => d.targetId === pose!.targetId,
      );
      if (detected) this.late = { applyAt: this.processed + this.options.asyncDelayFrames, detected, tracked: pose! };
      timings.background = (performance.now() - started) * 1000;
    }
    const due = !pose || (periodic && !this.options.asyncRelocalization);
    if (due) {
      // Shortly after a loss the target is most likely still near where it was: search there (enlarged when small,
      // where the whole frame would not show it), and the whole frame every third frame.
      const recent =
        !tracking && this.lost && timeUs - this.lost.timeUs <= this.options.lostSearchUs ? this.lost : null;
      const around = tracking ? (pose ?? prior!) : recent && this.processed % 3 !== 0 ? recent.pose : null;
      const grow = recent && !tracking ? (timeUs - recent.timeUs) / 1e6 : 0;
      const roi = around ? this.roi(around, pyramid.levels[0]!.width, pyramid.levels[0]!.height, grow) : null;
      const upscale = around ? upscaleFor(around, this.options.smallTargetPx) : 1;
      const detections = await this.parts.detector.detect(frame, { roi, upscale });
      const wanted = tracking ? prior!.targetId : null;
      const best = detections
        .filter((d) => !wanted || d.targetId === wanted)
        .sort((a, b) => b.quality.support - a.quality.support || a.targetId.localeCompare(b.targetId))[0];
      if (best && (!pose || meanCornerDistance(best, pose) > this.options.reinitDisagreement * diagonal(pose))) {
        // Refine the detection with the tracker (template alignment); a refused refinement keeps the tracked pose.
        const refined = this.parts.tracker.track({ frame, pyramid, prior: best, previous: null });
        if (isPose(refined)) pose = refined;
        else if (!pose) pose = best;
      }
      timings.detect = (performance.now() - t2) * 1000;
    }
    this.processed++;
    this.previousFrame = { frameId: frame.frameId, pyramid };
    let display: PoseEstimate[] = [];
    const poses: PoseEstimate[] = [];
    if (pose) {
      this.lost = null;
      if (lastMeasured && lastMeasured.targetId !== pose.targetId) {
        this.measured = [];
        this.filter?.reset();
      }
      this.measured = [...this.measured.slice(-2), pose];
      this.state = pose.quality.ratio < this.options.degradedRatio ? 'DEGRADED' : 'TRACKING';
      poses.push(pose);
      display = [this.filter ? this.filter.update(pose) : pose];
    } else if (tracking && prior) {
      this.state = 'COASTING';
      const coasted = this.filter?.predict(prior.targetId, timeUs) ?? prior;
      display = [{ ...coasted, frameId: frame.frameId, origin: 'predicted' }];
    } else {
      this.state = this.measured.length ? 'LOST' : 'SEARCHING';
      const last = this.measured.at(-1);
      if (last) this.lost = { pose: last, timeUs: last.timeUs };
      this.measured = [];
      this.filter?.reset();
    }
    const snapshots = this.filter
      ? display.map((d) => this.filter!.snapshot(d.targetId)).filter((s) => s !== null)
      : [];
    timings.total = (performance.now() - t0) * 1000 - (timings.background ?? 0);
    return {
      frameId: frame.frameId,
      timeUs,
      state: this.state,
      poses,
      display,
      ...(snapshots.length
        ? { predict: (t: number) => snapshots.map((s) => s(t)).filter((p): p is PoseEstimate => p !== null) }
        : {}),
      timings,
    };
  }

  /** Single-frame recognition as the live path does it: each detection refined by the tracker when it can be. */
  async detect(frame: FrameHandle): Promise<readonly PoseEstimate[]> {
    if (frame.image.kind !== 'cpu-gray') throw new Error('DualLoopPipeline needs cpu-gray frames');
    const detections = await this.parts.detector.detect(frame);
    if (!detections.length) return detections;
    const pyramid = new PyramidWorkspace().build(frame.image.image, this.options.pyramidLevels);
    return detections.map((d) => {
      const refined = this.parts.tracker.track({ frame, pyramid, prior: d, previous: null });
      return isPose(refined) ? refined : d;
    });
  }

  dispose(): void {
    this.measured = [];
    this.previousFrame = null;
  }
}
