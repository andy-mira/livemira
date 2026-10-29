// SPDX-License-Identifier: Apache-2.0
// Public entry of @livemira-next/web. Only re-exports belong here. The Worker roles are separate entries:
// './vision-worker.ts', './relocalize-worker.ts' (exported as '/vision', '/relocalizer'); pictures to targets:
// './picture.ts' ('/picture').

export { probeMainThread, probeWorkerTrackProcessor } from './capabilities.ts';
export { DIAGNOSTICS } from './diagnostics.ts';
export { viewportFromStandard, type FitTransform } from './fit.ts';
export { lumaFromVideoFrame, resampleOriented, type LumaPath } from './luma.ts';
export { cornerUvs, frameOrientation, UPRIGHT, type Orientation } from './orientation.ts';
export {
  HAWK_BUDGET,
  PROFILE_ORDER,
  PROFILES,
  resolveProfile,
  type CapturePath,
  type Profile,
  type ProfileChoice,
  type ProfileId,
} from './profiles.ts';
export { DEFAULT_PIPELINE } from './protocol.ts';
export type {
  DisplayPose,
  FrameTrace,
  FromWorker,
  PipelineConfig,
  ToWorker,
  WorkerStats,
  WorkerTarget,
} from './protocol.ts';
