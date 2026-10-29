// SPDX-License-Identifier: Apache-2.0
// What the user sees at every vsync: which camera frame is the background and where the overlay sits. Compositor
// modes (design doc §3.8):
//   async         background = native video (newest frame after its display latency); overlay = the newest
//                 result's display pose, applied when the result arrives (baseline CSS behaviour).
//   predicted     background as in async; overlay = the newest result extrapolated to the background frame's
//                 capture time (F2 late binding; falls back to async without a predictor).
//   frame-locked  background = the newest processed frame; overlay = that frame's own display pose (F1).

import type { Corners, FrameOutput, PoseEstimate } from '@livemira-next/contracts';
import { cornersOf } from '@livemira-next/contracts';

import type { GroundTruthFrame } from '../scene/suites.ts';
import type { ProcessedFrame } from './realtime.ts';

export type CompositorMode = 'async' | 'predicted' | 'frame-locked';

export interface DisplayOptions {
  readonly mode: CompositorMode;
  readonly vsyncUs: number;
  /** Capture → on screen for the native video background. */
  readonly nativeLatencyUs: number;
  /** Result → visible overlay (message, style or draw, composite). */
  readonly presentUs: number;
  readonly targetWidthPx: number;
  readonly targetHeightPx: number;
}

/**
 * Frame times are when a frame becomes available to the page (rVFC / MSTP delivery); the native video shows it at the
 * next composite, about 12 ms later. Pipeline arrival costs (PipelineCosts.arrivalUs) count from the same moment.
 */
export const DEFAULT_DISPLAY: Omit<DisplayOptions, 'mode'> = {
  vsyncUs: 1e6 / 60,
  nativeLatencyUs: 12_000,
  presentUs: 4000,
  targetWidthPx: 640,
  targetHeightPx: 480,
};

export interface DisplaySample {
  readonly timeUs: number;
  /** Index of the camera frame shown as background. */
  readonly background: number;
  /** Index of the frame a native video background would show at this vsync. */
  readonly native: number;
  /** Ground-truth corners of the target in the background frame, when visible enough to judge. */
  readonly truth: Corners | null;
  readonly visible: number;
  readonly overlay: Corners | null;
  /** Capture time of the frame the overlay pose was measured in. */
  readonly overlaySourceUs: number | null;
}

function poseFor(poses: readonly PoseEstimate[], targetId: string | null): PoseEstimate | null {
  if (!poses.length) return null;
  return poses.find((p) => p.targetId === targetId) ?? poses[0]!;
}

export function simulateDisplay(
  frames: readonly GroundTruthFrame[],
  processed: readonly ProcessedFrame[],
  options: DisplayOptions,
): DisplaySample[] {
  const samples: DisplaySample[] = [];
  const start = frames[0]!.timeUs + options.nativeLatencyUs;
  const end = frames.at(-1)!.timeUs + options.nativeLatencyUs;
  let nat = 0;
  let done = -1;
  for (let t = start; t <= end; t += options.vsyncUs) {
    while (nat + 1 < frames.length && frames[nat + 1]!.timeUs + options.nativeLatencyUs <= t) nat++;
    while (done + 1 < processed.length && processed[done + 1]!.endUs + options.presentUs <= t) done++;
    const result: ProcessedFrame | null = done >= 0 ? processed[done]! : null;
    let background = nat;
    let overlay: PoseEstimate | null = null;
    if (options.mode === 'frame-locked') {
      background = result ? result.index : 0;
      overlay = result ? poseFor(result.output.display, frames[background]!.targetId) : null;
    } else if (result) {
      const output: FrameOutput = result.output;
      if (options.mode === 'predicted' && output.predict) {
        overlay = poseFor(output.predict(frames[background]!.timeUs), frames[background]!.targetId);
      } else overlay = poseFor(output.display, frames[background]!.targetId);
    }
    const gt = frames[background]!;
    samples.push({
      timeUs: t,
      background,
      native: nat,
      truth: gt.H ? cornersOf(gt.H, options.targetWidthPx, options.targetHeightPx) : null,
      visible: gt.visible,
      overlay: overlay ? overlay.corners : null,
      overlaySourceUs: overlay ? (result ? frames[result.index]!.timeUs : null) : null,
    });
  }
  return samples;
}
