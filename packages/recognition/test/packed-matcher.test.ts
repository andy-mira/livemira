/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractFeatures,
  hamming,
  matchPacked,
  packDescriptors,
  type DescribedPoint,
  type PointPair,
} from '@livemira/recognition';

import { rects, rng } from './images.ts';

/** Byte-wise oracle written from the contract: best ≤ 64, best < 0.75 second, unique mutual nearest. */
function byteOracle(
  target: readonly DescribedPoint[],
  frame: readonly DescribedPoint[],
): PointPair[] {
  const reverse = Array<number>(frame.length).fill(-1);
  const reverseDistance = Array<number>(frame.length).fill(257);
  const nearest: { index: number; best: number; second: number }[] = [];
  for (let i = 0; i < target.length; i++) {
    let best = 257;
    let second = 257;
    let index = -1;
    for (let j = 0; j < frame.length; j++) {
      const distance = hamming(target[i]!.descriptor, frame[j]!.descriptor);
      if (distance < best) {
        second = best;
        best = distance;
        index = j;
      } else if (distance < second) second = distance;
      if (distance < reverseDistance[j]!) {
        reverseDistance[j] = distance;
        reverse[j] = i;
      } else if (distance === reverseDistance[j]) reverse[j] = -1;
    }
    nearest.push({ index, best, second });
  }
  return nearest.flatMap(({ index, best, second }, i) =>
    index >= 0 && best <= 64 && best < 0.75 * second && reverse[index] === i
      ? [
          {
            target: [target[i]!.x, target[i]!.y] as const,
            image: [frame[index]!.x, frame[index]!.y] as const,
            distance: best,
          },
        ]
      : [],
  );
}

const point = (i: number, descriptor: number[]): DescribedPoint => ({
  x: i * 3 + 0.25,
  y: i * 7 + 0.5,
  descriptor,
});
const zero = (): number[] => Array<number>(32).fill(0);
const ones = (bits: number): number[] => {
  const d = zero();
  for (let k = 0; k < bits; k++) d[k >> 3]! |= 1 << (k & 7);
  return d;
};
const randomDescriptor = (r: () => number, alphabet?: readonly number[]): number[] =>
  Array.from({ length: 32 }, () =>
    alphabet ? alphabet[Math.floor(r() * alphabet.length)]! : Math.floor(r() * 256),
  );
function flipBits(descriptor: readonly number[], count: number, r: () => number): number[] {
  const out = [...descriptor];
  const used = new Set<number>();
  while (used.size < count) {
    const bit = Math.floor(r() * 256);
    if (used.has(bit)) continue;
    used.add(bit);
    out[bit >> 3]! ^= 1 << (bit & 7);
  }
  return out;
}

function same(target: DescribedPoint[], frame: DescribedPoint[], label: string): PointPair[] {
  const expected = byteOracle(target, frame);
  assert.deepStrictEqual(matchPacked(target, frame), expected, label);
  assert.deepStrictEqual(
    matchPacked(target, frame, packDescriptors(target), packDescriptors(frame)),
    expected,
    label,
  );
  return expected;
}

test('packing and hamming agree on high bits and every byte lane', () => {
  const r = rng(3);
  for (let round = 0; round < 200; round++) {
    const a = randomDescriptor(r);
    const b = randomDescriptor(r);
    let bits = 0;
    for (let i = 0; i < 32; i++) for (let v = a[i]! ^ b[i]!; v; v &= v - 1) bits++;
    assert.equal(hamming(a, b), bits);
    const pa = packDescriptors([point(0, a)]);
    assert.equal(pa.length, 8);
    for (let k = 0; k < 8; k++)
      assert.equal(
        pa[k],
        (a[4 * k]! | (a[4 * k + 1]! << 8) | (a[4 * k + 2]! << 16) | (a[4 * k + 3]! << 24)) >>> 0,
      );
  }
});

test('empty and single inputs', () => {
  assert.deepEqual(same([], [], 'empty'), []);
  assert.deepEqual(same([point(0, zero())], [], 'empty frame'), []);
  assert.deepEqual(same([], [point(0, zero())], 'empty target'), []);
  assert.equal(same([point(0, zero())], [point(0, ones(3))], 'single').length, 1);
});

test('the distance-64 boundary, ratio equality, forward ties and reverse ties', () => {
  assert.equal(same([point(0, zero())], [point(0, ones(64))], '64').length, 1);
  assert.equal(same([point(0, zero())], [point(0, ones(65))], '65').length, 0);
  assert.equal(
    same([point(0, zero())], [point(0, ones(30)), point(1, ones(40))], '30/40 equality').length,
    0,
  );
  assert.equal(
    same([point(0, zero())], [point(0, ones(30)), point(1, ones(41))], '30/41').length,
    1,
  );
  assert.equal(
    same([point(0, zero())], [point(0, ones(5)), point(1, ones(5))], 'forward tie').length,
    0,
  );
  assert.equal(
    same([point(0, ones(5)), point(1, ones(5))], [point(0, zero())], 'reverse tie').length,
    0,
  );
  assert.equal(
    same(
      [point(0, ones(20)), point(1, ones(20)), point(2, ones(3))],
      [point(0, zero())],
      'reverse tie broken later',
    ).length,
    1,
  );
});

test('random and tie-heavy descriptor sets, with deterministic order', () => {
  const r = rng(17);
  for (let round = 0; round < 60; round++) {
    const alphabet = round % 3 === 0 ? [0, 255, 15, 240] : undefined;
    const n = 1 + Math.floor(r() * 80);
    const m = 1 + Math.floor(r() * 80);
    const target = Array.from({ length: n }, (_, i) => point(i, randomDescriptor(r, alphabet)));
    const frame = Array.from({ length: m }, (_, j) =>
      j % 2
        ? point(j, flipBits(target[Math.floor(r() * n)]!.descriptor, Math.floor(r() * 40), r))
        : point(j, randomDescriptor(r, alphabet)),
    );
    const pairs = same(target, frame, `round ${round}`);
    assert.ok(
      pairs.every((p, i) => !i || pairs[i - 1]!.target[0] < p.target[0]),
      'ascending target order',
    );
  }
});

test('word views with offsets and non-word packed arrays give the same pairs', () => {
  const r = rng(29);
  const target = Array.from({ length: 30 }, (_, i) => point(i, randomDescriptor(r)));
  const frame = target.map((t, j) => point(j, flipBits(t.descriptor, j % 20, r)));
  const expected = byteOracle(target, frame);
  const tp = packDescriptors(target);
  const fp = packDescriptors(frame);
  const offset = new Uint32Array(fp.length + 8);
  offset.set(fp, 8);
  assert.deepStrictEqual(matchPacked(target, frame, tp, offset.subarray(8)), expected);
  assert.deepStrictEqual(
    matchPacked(target, frame, new Int32Array(tp.buffer), new Int32Array(fp.buffer)),
    expected,
  );
  assert.deepStrictEqual(
    matchPacked(target, frame, Array.from(tp), Array.from(fp)),
    expected,
    'generic path',
  );
});

test('real extracted features match the byte oracle, including the full pair order', () => {
  const image = rects(41);
  const { features: target } = extractFeatures(image, { maxFeatures: 384, levels: 3 });
  const { features: frame } = extractFeatures(rects(41, 512, 384, 950), {
    maxFeatures: 512,
    levels: 3,
  });
  const pairs = same(target, frame, 'extracted');
  assert.ok(pairs.length > 20, `${pairs.length} pairs`);
});
