/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Independent test oracles and descriptor fixtures for exact Hamming matching.

import type { MatchPair } from '@livemira/compute';

const BITS = Uint8Array.from({ length: 256 }, (_, v) => {
  let c = 0;
  for (let x = v; x; x >>= 1) c += x & 1;
  return c;
});

/**
 * Definition-level oracle, independent of every implementation under test: full distance matrix from a byte popcount
 * table; best = minimum, index = first frame at the minimum, second = second smallest of the multiset (257 when absent);
 * reverse winner = the unique target at a frame's minimum distance; accept best <= 64, 4 best < 3 second, reverse winner = target.
 */
export function definitionOracle(target: Uint8Array, frame: Uint8Array): MatchPair[] {
  const n = target.length / 32;
  const m = frame.length / 32;
  const d: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let k = 0; k < 32; k++) s += BITS[target[i * 32 + k]! ^ frame[j * 32 + k]!]!;
      row.push(s);
    }
    d.push(row);
  }
  const out: MatchPair[] = [];
  for (let i = 0; i < n && m; i++) {
    const row = d[i]!;
    const sorted = [...row].sort((a, b) => a - b);
    const best = sorted[0]!;
    const second = sorted[1] ?? 257;
    const index = row.indexOf(best);
    const column = d.map((r) => r[index]!);
    const min = Math.min(...column);
    const winners = column.flatMap((v, t) => (v === min ? [t] : []));
    if (best <= 64 && 4 * best < 3 * second && winners.length === 1 && winners[0] === i) {
      out.push({ targetIndex: i, frameIndex: index, distance: best });
    }
  }
  return out;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
}

export const join = (list: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(list.reduce((s, d) => s + d.length, 0));
  let o = 0;
  for (const d of list) {
    out.set(d, o);
    o += d.length;
  }
  return out;
};

/** One descriptor with the lowest `bits` bits set. */
export const ones = (bits: number): Uint8Array => {
  const d = new Uint8Array(32);
  for (let k = 0; k < bits; k++) d[k >> 3]! |= 1 << (k & 7);
  return d;
};

export const randomDescriptors = (r: () => number, n: number): Uint8Array =>
  Uint8Array.from({ length: n * 32 }, () => r() & 255);

/** Frame with planted noisy copies of target descriptors among random ones. */
export function planted(
  r: () => number,
  target: Uint8Array,
  m: number,
  plantedShare = 0.6,
  maxFlips = 90,
): Uint8Array {
  const n = target.length / 32;
  const frame = randomDescriptors(r, m);
  for (let j = 0; j < m; j++) {
    if (n && r() % 100 < plantedShare * 100) {
      const source = r() % n;
      frame.set(target.subarray(source * 32, source * 32 + 32), j * 32);
      for (let f = r() % maxFlips; f > 0; f--) frame[j * 32 + (r() % 32)]! ^= 1 << (r() % 8);
    }
  }
  return frame;
}
