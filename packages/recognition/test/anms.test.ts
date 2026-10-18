/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import {
  ANMS_POOL_LIMIT,
  ANMS_ROBUSTNESS,
  anmsRadiiSquared,
  selectAnms,
  type CornerCandidate,
} from '@livemira/recognition';

import { rng } from './images.ts';

/** Independent O(n²) reference written straight from the paper: no sorting tricks, no pointer, no pool. */
function referenceSelect(
  candidates: readonly CornerCandidate[],
  count: number,
  c = 0.9,
): CornerCandidate[] {
  const radius = candidates.map((i) => {
    let best = Infinity;
    for (const j of candidates)
      if (i.score < c * j.score) best = Math.min(best, (i.x - j.x) ** 2 + (i.y - j.y) ** 2);
    return best;
  });
  return candidates
    .map((candidate, k) => ({ candidate, r: radius[k]! }))
    .sort(
      (a, b) =>
        (a.r === b.r ? 0 : b.r - a.r) ||
        b.candidate.score - a.candidate.score ||
        a.candidate.y - b.candidate.y ||
        a.candidate.x - b.candidate.x,
    )
    .slice(0, count)
    .map((e) => e.candidate);
}

const key = (c: CornerCandidate): string => `${c.x},${c.y},${c.score}`;

function randomCandidates(
  seed: number,
  n: number,
  { w = 200, h = 150, levels = 40 } = {},
): CornerCandidate[] {
  const random = rng(seed);
  const seen = new Set<string>();
  const out: CornerCandidate[] = [];
  while (out.length < n) {
    const x = Math.floor(random() * w);
    const y = Math.floor(random() * h);
    if (seen.has(`${x},${y}`)) continue;
    seen.add(`${x},${y}`);
    // Coarse strength levels force many exact ties.
    out.push({ x, y, score: 1e6 * (1 + Math.floor(random() * levels)) });
  }
  return out;
}

const isInvalidConfig = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'INVALID_CONFIG';

test('constants follow the paper: robustness 0.9, bounded pool', () => {
  assert.equal(ANMS_ROBUSTNESS, 0.9);
  assert.equal(ANMS_POOL_LIMIT, 1024);
});

test('matches an independent brute-force reference on random inputs, including heavy strength ties', () => {
  for (const [seed, n, count] of [
    [1, 1, 1],
    [2, 5, 3],
    [3, 60, 10],
    [4, 200, 50],
    [5, 300, 300],
    [6, 500, 120],
    [7, 800, 64],
  ] as const) {
    const candidates = randomCandidates(seed, n);
    assert.deepEqual(
      selectAnms(candidates, count).map(key),
      referenceSelect(candidates, count).map(key),
      `seed ${seed}`,
    );
  }
});

test('input order does not matter and the input array is not modified', () => {
  const candidates = randomCandidates(11, 150);
  const before = JSON.stringify(candidates);
  const expected = selectAnms(candidates, 40).map(key);
  const random = rng(99);
  for (let round = 0; round < 5; round++) {
    const shuffled = candidates.slice().sort(() => random() - 0.5);
    assert.deepEqual(selectAnms(shuffled, 40).map(key), expected);
  }
  assert.equal(JSON.stringify(candidates), before);
});

test('a distant weak corner beats a near-duplicate of a strong corner; plain strength order would not', () => {
  const A = { x: 10, y: 10, score: 100e6 };
  const B = { x: 11, y: 10, score: 50e6 };
  const C = { x: 100, y: 100, score: 40e6 };
  const D = { x: 60, y: 10, score: 30e6 };
  assert.deepEqual(
    selectAnms([B, D, A, C], 3),
    [A, C, D],
    'A (no stronger neighbour), C (radius ~126), D (radius 49); B (radius 1) is dropped',
  );
  const radii = anmsRadiiSquared([A, B, C, D]);
  assert.equal(radii[0], Infinity);
  assert.equal(radii[1], 1);
  assert.equal(radii[2], Math.min((100 - 10) ** 2 + 90 ** 2, 89 ** 2 + 90 ** 2));
  assert.equal(radii[3], Math.min(50 ** 2, 49 ** 2, 40 ** 2 + 90 ** 2));
});

test('the robustness boundary is strict: exactly 0.9 × stronger is not suppressed, below it is', () => {
  const strong = { x: 0, y: 0, score: 100e6 };
  assert.equal(anmsRadiiSquared([strong, { x: 3, y: 4, score: 90e6 }])[1], Infinity);
  assert.equal(anmsRadiiSquared([strong, { x: 3, y: 4, score: 89.9e6 }])[1], 25);
});

test('missing stronger neighbours, flat and repeated inputs are deterministic', () => {
  assert.deepEqual(selectAnms([], 5), []);
  assert.deepEqual(selectAnms([{ x: 3, y: 4, score: 2e6 }], 0), []);
  assert.deepEqual(selectAnms([{ x: 3, y: 4, score: 2e6 }], 9), [{ x: 3, y: 4, score: 2e6 }]);
  // All strengths equal: every radius is Infinity, so the strength/y/x order decides.
  const flat: CornerCandidate[] = [];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++) flat.push({ x: x * 7, y: y * 5, score: 3e6 });
  assert.deepEqual(
    selectAnms(flat, 8).map((c) => [c.y, c.x]),
    [
      [0, 0],
      [0, 7],
      [0, 14],
      [0, 21],
      [0, 28],
      [0, 35],
      [5, 0],
      [5, 7],
    ],
  );
  assert.deepEqual(selectAnms(flat.slice().reverse(), 8), selectAnms(flat, 8));
  assert.equal(
    selectAnms(flat, 100).length,
    36,
    'fewer candidates than the budget returns them all',
  );
  // Duplicate positions with different strength: the weaker one has radius 0 and is selected last.
  const dup = selectAnms(
    [
      { x: 5, y: 5, score: 10e6 },
      { x: 5, y: 5, score: 4e6 },
      { x: 50, y: 5, score: 3e6 },
    ],
    3,
  );
  assert.deepEqual(
    dup.map((c) => c.score),
    [10e6, 3e6, 4e6],
  );
});

test('validation rejects malformed candidates and options', () => {
  assert.throws(() => selectAnms('x' as unknown as CornerCandidate[], 1), isInvalidConfig);
  for (const bad of [
    { x: 1, y: 1, score: 0 },
    { x: 1, y: 1, score: -5 },
    { x: NaN, y: 1, score: 5 },
    { x: 1, y: 1, score: Infinity },
    null,
  ]) {
    assert.throws(() => selectAnms([bad as unknown as CornerCandidate], 1), isInvalidConfig);
  }
  for (const count of [-1, 1.5, NaN, '3'])
    assert.throws(() => selectAnms([], count as number), isInvalidConfig);
  for (const options of [
    { robustness: 1 },
    { robustness: 0 },
    { robustness: NaN },
    { poolLimit: 0 },
    { poolLimit: 4097 },
    { poolLimit: 1.5 },
  ]) {
    assert.throws(() => selectAnms([], 1, options), isInvalidConfig);
  }
});

test('the pool bounds the work and radii of pool members stay exact', () => {
  const huge = randomCandidates(21, 20000, { w: 1000, h: 1000, levels: 5000 });
  const started = performance.now();
  const chosen = selectAnms(huge, 128);
  assert.ok(performance.now() - started < 3000, 'bounded runtime for 20,000 candidates');
  assert.equal(chosen.length, 128);
  const strongest = huge
    .slice()
    .sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x)
    .slice(0, 256);
  assert.deepEqual(
    selectAnms(huge, 64, { poolLimit: 256 }).map(key),
    referenceSelect(strongest, 64).map(key),
    'equals the paper algorithm run on exactly the pool',
  );
  const floor = strongest.at(-1)!.score;
  assert.ok(
    selectAnms(huge, 64, { poolLimit: 256 }).every((c) => c.score >= floor),
    'weaker-than-pool candidates are never selected',
  );
});

test('ANMS spreads selection over the image: a strong cluster cannot take the whole budget', () => {
  const candidates: CornerCandidate[] = [];
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 6; x++)
      candidates.push({ x: 20 + x * 7, y: 20 + y * 7, score: 1e9 * 0.93 ** (x + y * 6) });
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++)
      candidates.push({ x: 120 + x * 40, y: 10 + y * 40, score: 2e6 + (x + y * 4) * 1e4 });
  const chosen = selectAnms(candidates, 12);
  assert.ok(chosen.filter((c) => c.x >= 120).length >= 8, 'far weak corners are selected');
  assert.ok(
    candidates
      .slice()
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .every((c) => c.x < 120),
    'strongest-first would take only the cluster',
  );
  assert.ok(
    chosen.filter((c) => c.x < 120).length <= 4,
    'the cluster keeps only its few least-suppressed members',
  );
});
