// SPDX-License-Identifier: Apache-2.0
// Public entry of @livemira-next/geometry. Only re-exports belong here.

export {
  fitHomography,
  hullArea,
  invert3,
  isPlausible,
  multiply3,
  normalizeH,
  projectInto,
  solve4,
} from './homography.ts';
export { FocalEstimator, poseFromHomography, type FocalEstimate, type PlanePose } from './intrinsics.ts';
export { invertSymmetric, smallestEigenvector, solveInPlace } from './linalg.ts';
export { cornerCovariance, refineHomography, type RefineResult } from './refine.ts';
export { estimateHomography, type RobustOptions, type RobustRejection, type RobustResult } from './robust.ts';
