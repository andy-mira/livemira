/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { MAX_MATCHED_POINTS, type Point2, type TrackingResult } from '@livemira/contracts';

/**
 * The measured inlier points of `result`, or null. Valid only for a measured, non-degenerate TRACKING or LIMITED result
 * whose points carry the same session, frame and target, with 1..MAX_MATCHED_POINTS finite pairs.
 */
export function matchedPointsForResult(result: TrackingResult): readonly Point2[] | null {
  const m = result?.matchedPoints;
  if (
    !m ||
    typeof m !== 'object' ||
    (result.state !== 'TRACKING' && result.state !== 'LIMITED') ||
    !result.quality?.isMeasured ||
    result.quality.isDegenerate
  ) {
    return null;
  }
  if (
    !result.targetId ||
    m.sessionId !== result.sessionId ||
    m.frameId !== result.frameId ||
    m.targetId !== result.targetId
  ) {
    return null;
  }
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p) {
    if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))
      return null;
  }
  return p;
}

/** Removes matched points unless collection was requested and they are valid for this result. Returns the same object. */
export function sanitizeMatchedPoints<T extends TrackingResult>(result: T, isAllowed: boolean): T {
  if (result.matchedPoints !== undefined && (!isAllowed || !matchedPointsForResult(result))) {
    delete (result as { matchedPoints?: unknown }).matchedPoints;
  }
  return result;
}
