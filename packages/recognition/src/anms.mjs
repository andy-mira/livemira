/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Adaptive non-maximal suppression (ANMS), Brown, Szeliski and Winder, "Multi-Image Matching using Multi-Scale Oriented Patches", CVPR 2005, section 3.
// Each corner i gets the minimal suppression radius r_i = min |x_i - x_j| over corners j that are significantly stronger: strength_i < ROBUSTNESS * strength_j.
// The corners with the largest radii are kept, which spreads the budget over the image instead of keeping the strongest cluster.
//
// Deviations from the paper, all deliberate and bounded:
//  * Only the POOL_LIMIT strongest candidates take part (default 1024). Radii of pool members are still EXACT, because every candidate stronger than a pool member is itself in the
//    pool; weaker candidates are simply never selected. This bounds the work at POOL_LIMIT^2 / 2 distance evaluations instead of O(N^2) for N detector peaks.
//  * The caller applies the budget per pyramid level (the engine's existing quota), not once over all levels as in the paper.
//  * Candidates without any significantly stronger neighbor (the global maximum and everything within the robustness band of it) have radius Infinity.
//  * Total order, so the result is deterministic: radius descending, then strength descending, then y, then x.
// Only comparisons, + - * on integers and one multiplication by the robustness constant are used, so results are identical across JS engines.
export const ANMS_ROBUSTNESS = 0.9;
export const ANMS_POOL_LIMIT = 1024;
const MAX_POOL_LIMIT = 4096;

const byStrength = (a, b) => b.score - a.score || a.y - b.y || a.x - b.x;

/** Suppression radius (squared, in pixels) per candidate, for candidates in strength order. Infinity when no significantly stronger candidate exists. */
export function anmsRadiiSquared(sorted, robustness = ANMS_ROBUSTNESS) {
  const n = sorted.length, radii = new Array(n);
  let stronger = 0;
  for (let i = 0; i < n; i++) {
    // Candidates 0..stronger-1 are significantly stronger than i; the set only grows because strengths are non-increasing.
    while (stronger < i && sorted[i].score < robustness * sorted[stronger].score) stronger++;
    let best = Infinity;
    for (let j = 0; j < stronger; j++) {
      const dx = sorted[j].x - sorted[i].x, dy = sorted[j].y - sorted[i].y, d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    radii[i] = best;
  }
  return radii;
}

/**
 * Selects at most `count` candidates ({x, y, score}) by ANMS. Input order is irrelevant and the input is not modified.
 * Returns the chosen candidates, largest radius first.
 */
export function selectAnms(candidates, count, { robustness = ANMS_ROBUSTNESS, poolLimit = ANMS_POOL_LIMIT } = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('INVALID_ANMS_CANDIDATES');
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > MAX_POOL_LIMIT ||
      !(robustness > 0 && robustness < 1)) throw new RangeError('INVALID_ANMS_OPTIONS');
  for (const c of candidates) if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.score) || c.score <= 0) throw new TypeError('INVALID_ANMS_CANDIDATE');
  if (!count || !candidates.length) return [];
  const pool = candidates.slice().sort(byStrength).slice(0, poolLimit), radii = anmsRadiiSquared(pool, robustness);
  return pool.map((candidate, rank) => ({ candidate, rank, radius: radii[rank] }))
    .sort((a, b) => (a.radius === b.radius ? 0 : b.radius - a.radius) || a.rank - b.rank)
    .slice(0, count).map(entry => entry.candidate);
}
