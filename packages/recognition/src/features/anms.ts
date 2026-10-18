/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Adaptive non-maximal suppression (ANMS), Brown, Szeliski and Winder, "Multi-Image Matching using Multi-Scale
// Oriented Patches", CVPR 2005, section 3. Each corner i gets the minimal suppression radius
// r_i = min |x_i − x_j| over corners j that are significantly stronger (strength_i < ROBUSTNESS · strength_j); the
// corners with the largest radii are kept, which spreads the budget over the image instead of keeping the strongest
// cluster.
//
// Deliberate, bounded deviations from the paper:
//  * Only the POOL_LIMIT strongest candidates take part. Radii of pool members are still exact, because every
//    candidate stronger than a pool member is itself in the pool; weaker candidates are never selected. This bounds
//    the work at POOL_LIMIT² / 2 distance evaluations.
//  * The caller applies the budget per pyramid level, not once over all levels.
//  * Candidates without a significantly stronger neighbour have radius Infinity.
//  * Total order: radius descending, then strength descending, then y, then x.
// Only comparisons, + − × on integers and one multiplication by the robustness constant are used, so results are
// identical across JavaScript engines.

import { EngineError } from '@livemira/contracts';

import type { CornerCandidate } from './harris.ts';

export const ANMS_ROBUSTNESS = 0.9;
export const ANMS_POOL_LIMIT = 1024;
const MAX_POOL_LIMIT = 4096;

/** Recorded in compiled bundles (`preprocessing.selection`) so the exact variant is part of the bundle identity. */
export const ANMS_SELECTION_ID = `anms-c${ANMS_ROBUSTNESS}-pool${ANMS_POOL_LIMIT}-per-level`;

const byStrength = (a: CornerCandidate, b: CornerCandidate): number =>
  b.score - a.score || a.y - b.y || a.x - b.x;

/** Squared suppression radius per candidate, for candidates in strength order; Infinity without a significantly stronger one. */
export function anmsRadiiSquared(
  sorted: readonly CornerCandidate[],
  robustness = ANMS_ROBUSTNESS,
): number[] {
  const n = sorted.length;
  const radii = new Array<number>(n);
  let stronger = 0;
  for (let i = 0; i < n; i++) {
    // Candidates 0..stronger−1 are significantly stronger than i; the set only grows because strengths do not increase.
    while (stronger < i && sorted[i]!.score < robustness * sorted[stronger]!.score) stronger++;
    let best = Infinity;
    for (let j = 0; j < stronger; j++) {
      const dx = sorted[j]!.x - sorted[i]!.x;
      const dy = sorted[j]!.y - sorted[i]!.y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    radii[i] = best;
  }
  return radii;
}

export interface AnmsOptions {
  readonly robustness?: number;
  readonly poolLimit?: number;
}

/** At most `count` candidates chosen by ANMS, largest radius first. Input order is irrelevant; the input is not modified. */
export function selectAnms(
  candidates: readonly CornerCandidate[],
  count: number,
  { robustness = ANMS_ROBUSTNESS, poolLimit = ANMS_POOL_LIMIT }: AnmsOptions = {},
): CornerCandidate[] {
  const invalid = (message: string): EngineError =>
    new EngineError('INVALID_CONFIG', message, { isRecoverable: false });
  if (!Array.isArray(candidates)) throw invalid('INVALID_ANMS_CANDIDATES');
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    !Number.isInteger(poolLimit) ||
    poolLimit < 1 ||
    poolLimit > MAX_POOL_LIMIT ||
    !(robustness > 0 && robustness < 1)
  ) {
    throw invalid('INVALID_ANMS_OPTIONS');
  }
  for (const c of candidates) {
    if (
      !c ||
      !Number.isFinite(c.x) ||
      !Number.isFinite(c.y) ||
      !Number.isFinite(c.score) ||
      c.score <= 0
    ) {
      throw invalid('INVALID_ANMS_CANDIDATE');
    }
  }
  if (!count || !candidates.length) return [];
  const pool = candidates.slice().sort(byStrength).slice(0, poolLimit);
  const radii = anmsRadiiSquared(pool, robustness);
  return pool
    .map((candidate, rank) => ({ candidate, rank, radius: radii[rank]! }))
    .sort((a, b) => (a.radius === b.radius ? 0 : b.radius - a.radius) || a.rank - b.rank)
    .slice(0, count)
    .map((entry) => entry.candidate);
}
