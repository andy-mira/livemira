/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Normalized least-squares homography and deterministic bounded RANSAC.
export function project(h, [x, y]) {
  const z = h[6] * x + h[7] * y + h[8];
  return Math.abs(z) < 1e-10 ? [Infinity, Infinity] : [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];
}
function multiply(a, b) { return Array.from({ length: 9 }, (_, i) => [0, 1, 2].reduce((s, k) => s + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + i % 3], 0)); }
function normalize(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length, cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const radius = Math.sqrt(points.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / points.length);
  if (radius < 1e-8) return null;
  const s = Math.SQRT2 / radius;
  return { points: points.map(([x, y]) => [(x - cx) * s, (y - cy) * s]), t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}
function solve(a, b) {
  const m = a.map((row, i) => [...row, b[i]]), n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    if (Math.abs(m[pivot][i]) < 1e-9) return null;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const divisor = m[i][i];
    for (let k = i; k <= n; k++) m[i][k] /= divisor;
    for (let j = 0; j < n; j++) if (j !== i) {
      const f = m[j][i];
      for (let k = i; k <= n; k++) m[j][k] -= f * m[i][k];
    }
  }
  return m.map(row => row[n]);
}
export function fitHomography(pairs) {
  if (pairs.length < 4) return null;
  const a = normalize(pairs.map(p => p.target)), b = normalize(pairs.map(p => p.image));
  if (!a || !b) return null;
  const ata = Array.from({ length: 8 }, () => Array(8).fill(0)), atb = Array(8).fill(0);
  for (let i = 0; i < pairs.length; i++) {
    const [x, y] = a.points[i], [u, v] = b.points[i];
    for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
      for (let j = 0; j < 8; j++) { atb[j] += row[j] * rhs; for (let k = 0; k < 8; k++) ata[j][k] += row[j] * row[k]; }
    }
  }
  const h = solve(ata, atb);
  if (!h) return null;
  const denormalized = multiply(multiply(b.inv, [...h, 1]), a.t), z = denormalized[8];
  if (Math.abs(z) < 1e-10) return null;
  const result = denormalized.map(v => v / z);
  return result.every(Number.isFinite) ? result : null;
}
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
export function hullArea(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const half = values => { const h = []; for (const p of values) { while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop(); h.push(p); } return h.slice(0, -1); };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(hull.reduce((s, p, i) => { const q = hull[(i + 1) % hull.length]; return s + p[0] * q[1] - p[1] * q[0]; }, 0)) / 2;
}
export function validateHomography(h, width, height) {
  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return false;
  const det = h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (Math.abs(det) < 1e-10) return false;
  const corners = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
  const denominators = corners.map(([x, y]) => h[6] * x + h[7] * y + h[8]);
  if (!(denominators.every(v => v > 1e-7) || denominators.every(v => v < -1e-7))) return false;
  const projected = corners.map(p => project(h, p));
  return projected.every(p => p.every(Number.isFinite)) && projected.every((p, i) => cross(p, projected[(i + 1) % 4], projected[(i + 2) % 4]) > 1e-6);
}
export function verifyGeometry(pairs, width, height, { iterations = 256, threshold = 3, minInliers = 12, minCoverage = 0.08, seed = 12345, adaptive = false } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 4096 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 20 ||
      !Number.isInteger(minInliers) || minInliers < 4 || !Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) throw new Error('INVALID_GEOMETRY_OPTIONS');
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || pairs.length > 512 ||
      pairs.some(p => ![p.target, p.image].every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)))) throw new Error('INVALID_PAIRS');
  const reject = reason => ({ accepted: false, reason, H: null, pairs, inlierMask: pairs.map(() => false) });
  if (pairs.length < minInliers) return reject('INSUFFICIENT_MATCHES');
  const errors = h => pairs.map(p => { const q = project(h, p.target); return Math.hypot(q[0] - p.image[0], q[1] - p.image[1]); });
  let best = [], bestError = Infinity;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0); };
  if (!(seed >>> 0)) seed = 12345;
  let iterationLimit = iterations;
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    const indices = new Set();
    while (indices.size < 4) indices.add(random() % pairs.length);
    const h = fitHomography([...indices].map(i => pairs[i]));
    if (!validateHomography(h, width, height)) continue;
    const e = errors(h), indicesIn = e.flatMap((v, i) => v <= threshold ? [i] : []), total = indicesIn.reduce((s, i) => s + e[i] ** 2, 0);
    if (indicesIn.length > best.length || (indicesIn.length === best.length && total < bestError)) {
      best = indicesIn; bestError = total;
      if (adaptive && best.length >= minInliers) {
        const miss = 1 - (best.length / pairs.length) ** 4;
        iterationLimit = Math.min(iterationLimit, Math.max(16, miss <= 0 ? 16 : Math.ceil(Math.log(.001) / Math.log(miss))));
      }
    }
  }
  if (best.length < minInliers) return reject('NO_ROBUST_MODEL');
  let h = fitHomography(best.map(i => pairs[i]));
  if (!validateHomography(h, width, height)) return reject('DEGENERATE_MODEL');
  let e = errors(h), mask = e.map(v => v <= threshold);
  h = fitHomography(pairs.filter((_, i) => mask[i]));
  if (!validateHomography(h, width, height)) return reject('DEGENERATE_REFINEMENT');
  e = errors(h); mask = e.map(v => v <= threshold);
  const selected = pairs.filter((_, i) => mask[i]), inlierCount = selected.length, ratio = inlierCount / pairs.length;
  const coverage = hullArea(selected.map(p => p.target)) / ((width - 1) * (height - 1));
  if (inlierCount < minInliers || ratio < 0.35) return reject('LOW_INLIER_SUPPORT');
  if (coverage < minCoverage) return reject('LOW_SPATIAL_COVERAGE');
  const inlierErrors = e.filter((_, i) => mask[i]);
  return { accepted: true, reason: 'GEOMETRY_VERIFIED', H: h, pairs, inlierMask: mask, inlierCount, inlierRatio: ratio, coverage,
    rmsErrorPx: Math.sqrt(inlierErrors.reduce((s, v) => s + v * v, 0) / inlierCount), maxErrorPx: Math.max(...inlierErrors), degenerate: false };
}
