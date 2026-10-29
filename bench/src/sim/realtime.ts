// SPDX-License-Identifier: Apache-2.0
// Real-time scheduling of a vision pipeline on a simulated device: frames arrive at camera rate, the pipeline takes
// the newest arrived frame whenever it is free (latest wins, like the baseline engine), and each frame costs its
// measured compute time scaled by the device tier. Skipped frames are never processed, so a slow pipeline also
// sees larger motion between the frames it does process.

import type { FrameHandle, FrameOutput, VisionPipeline } from '@livemira-next/contracts';

import type { GroundTruthFrame } from '../scene/suites.ts';

/**
 * Compute-time multipliers relative to this benchmark host (Apple M4 Max, Node/V8, single thread). Assumptions until
 * the real-device stage calibrates them: high ≈ flagship Android / recent iPhone, mid ≈ Snapdragon 7-class,
 * low ≈ 4×A55-class.
 */
export const TIERS = { host: 1, high: 2, mid: 4, low: 8 } as const;
export type Tier = keyof typeof TIERS;

export interface PipelineCosts {
  /** Capture → arrival at the pipeline (decode, readback, transfer) at the mid tier, µs. Scaled with the tier. */
  readonly arrivalUs: number;
  /** Main-thread work per camera frame at the mid tier, µs (reported, not on the pipeline's critical path). */
  readonly mainThreadUs: number;
}

export interface ProcessedFrame {
  readonly index: number;
  readonly startUs: number;
  readonly endUs: number;
  /** Measured host compute time, µs. */
  readonly computeUs: number;
  readonly output: FrameOutput;
}

export function frameHandle(
  sessionId: string,
  f: GroundTruthFrame,
  width: number,
  height: number,
  arrivalUs: number,
): FrameHandle {
  return {
    sessionId,
    frameId: f.index,
    time: { captureUs: f.timeUs, receiveUs: f.timeUs + arrivalUs, source: 'replay' },
    image: { kind: 'cpu-gray', image: { width, height, stride: width, data: f.image } },
  };
}

export async function runRealtime(
  pipeline: VisionPipeline,
  frames: readonly GroundTruthFrame[],
  options: {
    readonly tier: Tier;
    readonly costs: PipelineCosts;
    readonly width: number;
    readonly height: number;
    readonly sessionId: string;
  },
): Promise<ProcessedFrame[]> {
  const factor = TIERS[options.tier];
  const arrivalUs = (options.costs.arrivalUs * factor) / TIERS.mid;
  const arrival = (i: number): number => frames[i]!.timeUs + arrivalUs;
  pipeline.reset(options.sessionId);
  const processed: ProcessedFrame[] = [];
  let now = arrival(0);
  let last = -1;
  while (last + 1 < frames.length) {
    let next = last + 1;
    if (arrival(next) > now) now = arrival(next);
    while (next + 1 < frames.length && arrival(next + 1) <= now) next++;
    const handle = frameHandle(options.sessionId, frames[next]!, options.width, options.height, arrivalUs);
    const started = performance.now();
    const output = await pipeline.process(handle);
    // Work a pipeline runs concurrently (a second Worker) is reported as `background` and is off the critical path.
    const computeUs = (performance.now() - started) * 1000 - (output.timings.background ?? 0);
    const endUs = now + computeUs * factor;
    processed.push({ index: next, startUs: now, endUs, computeUs, output });
    now = endUs;
    last = next;
  }
  return processed;
}
