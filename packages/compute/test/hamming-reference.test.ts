/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchHammingReference, type MatchPair } from '@livemira/compute';
import { EngineError } from '@livemira/contracts';

import { definitionOracle } from './matching-oracles.ts';

function distance(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < 32; i++) {
    let v = a[i]! ^ b[i]!;
    while (v) {
      v &= v - 1;
      n++;
    }
  }
  return n;
}

/** Independent byte-wise reference written from the contract text. */
function brute(a: Uint8Array, b: Uint8Array): MatchPair[] {
  const n = a.length / 32;
  const m = b.length / 32;
  const pairs: MatchPair[] = [];
  for (let t = 0; t < n; t++) {
    const row = Array.from({ length: m }, (_, f) => ({
      f,
      d: distance(a.subarray(32 * t, 32 * t + 32), b.subarray(32 * f, 32 * f + 32)),
    })).sort((x, y) => x.d - y.d);
    const first = row[0];
    if (!first || first.d > 64 || 4 * first.d >= 3 * (row[1]?.d ?? 257)) continue;
    const reverse = Array.from({ length: n }, (_, j) => ({
      j,
      d: distance(a.subarray(32 * j, 32 * j + 32), b.subarray(32 * first.f, 32 * first.f + 32)),
    })).sort((x, y) => x.d - y.d);
    if (reverse[0]!.j === t && reverse[0]!.d !== (reverse[1]?.d ?? 257)) {
      pairs.push({ targetIndex: t, frameIndex: first.f, distance: first.d });
    }
  }
  return pairs;
}

function descriptorFixture(count = 64): Uint8Array {
  let seed = 123;
  return Uint8Array.from({ length: count * 32 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  });
}

test('the reference equals an independent byte reference and the definition oracle; ties and empty sets', () => {
  const a = descriptorFixture();
  const b = a.slice();
  for (let i = 0; i < b.length; i += 11) b[i]! ^= 7;
  assert.deepEqual(matchHammingReference(a, b), brute(a, b));
  assert.deepEqual(matchHammingReference(a, b), definitionOracle(a, b));
  assert.ok(matchHammingReference(a, b).length > 0);
  assert.deepEqual(matchHammingReference(new Uint8Array(64), new Uint8Array(32)), []);
  assert.deepEqual(matchHammingReference(new Uint8Array(32), new Uint8Array(64)), []);
  assert.deepEqual(matchHammingReference(a, new Uint8Array()), []);
});

test('input that is not packed 32-byte descriptors is rejected', () => {
  const isInvalid = (error: unknown): boolean =>
    error instanceof EngineError && error.code === 'INVALID_CONFIG';
  assert.throws(() => matchHammingReference(new Uint8Array(31), new Uint8Array(32)), isInvalid);
  assert.throws(
    () => matchHammingReference(new Uint8Array(513 * 32), new Uint8Array(32)),
    isInvalid,
  );
});
