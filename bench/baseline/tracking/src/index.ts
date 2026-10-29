/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/tracking. Only re-exports belong here.
export { checkObservation, type CheckedObservation } from './observation-check.ts';
export {
  PREDICTION_LIMIT_US,
  Tracker,
  type GrayFrame,
  type RecognizeFrame,
  type TrackerOptions,
} from './tracker.ts';
