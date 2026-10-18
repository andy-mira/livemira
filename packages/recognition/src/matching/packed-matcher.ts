/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The recognizer's built-in exact matcher over descriptors packed into 32-bit words, contract
// hamming32-mutual-ratio075-max64/1 (the same as the compute package's reference and WebAssembly matchers).

import type { Point2 } from '@livemira/contracts';

export interface DescribedPoint {
  readonly x: number;
  readonly y: number;
  readonly descriptor: readonly number[];
}

/** A correspondence between a target point and an image point. */
export interface PointPair {
  readonly target: Point2;
  readonly image: Point2;
  readonly distance: number;
}

/** Eight little-endian 32-bit words per 32-byte descriptor. */
export function packDescriptors(features: readonly DescribedPoint[]): Uint32Array {
  const packed = new Uint32Array(features.length * 8);
  for (let i = 0; i < features.length; i++) {
    for (let k = 0; k < 8; k++) {
      const d = features[i]!.descriptor;
      const j = k * 4;
      packed[i * 8 + k] = (d[j]! | (d[j + 1]! << 8) | (d[j + 2]! << 16) | (d[j + 3]! << 24)) >>> 0;
    }
  }
  return packed;
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function packedDistance(
  a: ArrayLike<number>,
  ai: number,
  b: ArrayLike<number>,
  bi: number,
): number {
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcount(a[ai * 8 + k]! ^ b[bi * 8 + k]!);
  return d;
}

/** Per-word popcount reduced to 4-bit lanes (each at most 4); the lanes of two words add without overflow. */
function nibbles(x: number): number {
  x = (x - ((x >>> 1) & 0x55555555)) | 0;
  return ((x & 0x33333333) + ((x >>> 2) & 0x33333333)) | 0;
}

function byteLanes(v: number): number {
  return ((v & 0x0f0f0f0f) + ((v >>> 4) & 0x0f0f0f0f)) | 0;
}

const isWords = (a: ArrayLike<number>, n: number): boolean =>
  (a instanceof Uint32Array || a instanceof Int32Array) && a.length >= n;

function pairAt(
  target: readonly DescribedPoint[],
  frame: readonly DescribedPoint[],
  i: number,
  index: number,
  distance: number,
): PointPair {
  return {
    target: [target[i]!.x, target[i]!.y],
    image: [frame[index]!.x, frame[index]!.y],
    distance,
  };
}

function matchWords(
  target: readonly DescribedPoint[],
  frame: readonly DescribedPoint[],
  tp: Uint32Array | Int32Array,
  fp: Uint32Array | Int32Array,
  nt: number,
  nf: number,
): PointPair[] {
  const reverse = new Int32Array(nf).fill(-1);
  const rd = new Uint16Array(nf).fill(257);
  const bests = new Uint16Array(nt);
  const seconds = new Uint16Array(nt);
  const indices = new Int32Array(nt);
  for (let i = 0; i < nt; i++) {
    const o = i * 8;
    const t0 = tp[o]! | 0;
    const t1 = tp[o + 1]! | 0;
    const t2 = tp[o + 2]! | 0;
    const t3 = tp[o + 3]! | 0;
    const t4 = tp[o + 4]! | 0;
    const t5 = tp[o + 5]! | 0;
    const t6 = tp[o + 6]! | 0;
    const t7 = tp[o + 7]! | 0;
    let best = 257;
    let second = 257;
    let index = -1;
    for (let j = 0, p = 0; j < nf; j++, p += 8) {
      const a = nibbles(t0 ^ fp[p]!) + nibbles(t1 ^ fp[p + 1]!);
      const b = nibbles(t2 ^ fp[p + 2]!) + nibbles(t3 ^ fp[p + 3]!);
      const c = nibbles(t4 ^ fp[p + 4]!) + nibbles(t5 ^ fp[p + 5]!);
      const e = nibbles(t6 ^ fp[p + 6]!) + nibbles(t7 ^ fp[p + 7]!);
      let s = (byteLanes(a) + byteLanes(b) + byteLanes(c) + byteLanes(e)) | 0;
      s = ((s & 0x00ff00ff) + ((s >>> 8) & 0x00ff00ff)) | 0;
      const d = (s & 0xffff) + (s >>> 16);
      if (d < best) {
        second = best;
        best = d;
        index = j;
      } else if (d < second) second = d;
      const r = rd[j]!;
      if (d < r) {
        rd[j] = d;
        reverse[j] = i;
      } else if (d === r) reverse[j] = -1;
    }
    bests[i] = best;
    seconds[i] = second;
    indices[i] = index;
  }
  const out: PointPair[] = [];
  for (let i = 0; i < nt; i++) {
    const index = indices[i]!;
    const best = bests[i]!;
    if (index >= 0 && best <= 64 && 4 * best < 3 * seconds[i]! && reverse[index] === i) {
      out.push(pairAt(target, frame, i, index, best));
    }
  }
  return out;
}

/** Fallback for inputs that are not word arrays of sufficient length; keeps the original coercion semantics. */
function matchGeneric(
  target: readonly DescribedPoint[],
  frame: readonly DescribedPoint[],
  tp: ArrayLike<number>,
  fp: ArrayLike<number>,
): PointPair[] {
  const reverse = new Int32Array(frame.length).fill(-1);
  const rd = new Uint16Array(frame.length).fill(257);
  const nearest: { best: number; second: number; index: number }[] = [];
  for (let i = 0; i < target.length; i++) {
    let best = 257;
    let second = 257;
    let index = -1;
    for (let j = 0; j < frame.length; j++) {
      const d = packedDistance(tp, i, fp, j);
      if (d < best) {
        second = best;
        best = d;
        index = j;
      } else if (d < second) second = d;
      if (d < rd[j]!) {
        rd[j] = d;
        reverse[j] = i;
      } else if (d === rd[j]) reverse[j] = -1;
    }
    nearest.push({ best, second, index });
  }
  return nearest.flatMap(({ best, second, index }, i) =>
    index >= 0 && best <= 64 && 4 * best < 3 * second && reverse[index] === i
      ? [pairAt(target, frame, i, index, best)]
      : [],
  );
}

/** Accepted target/image point pairs in ascending target order. */
export function matchPacked(
  target: readonly DescribedPoint[],
  frame: readonly DescribedPoint[],
  tp: ArrayLike<number> = packDescriptors(target),
  fp: ArrayLike<number> = packDescriptors(frame),
): PointPair[] {
  const nt = target.length;
  const nf = frame.length;
  if (
    Number.isInteger(nt) &&
    Number.isInteger(nf) &&
    nt >= 0 &&
    nf >= 0 &&
    isWords(tp, nt * 8) &&
    isWords(fp, nf * 8)
  ) {
    return matchWords(
      target,
      frame,
      tp as Uint32Array | Int32Array,
      fp as Uint32Array | Int32Array,
      nt,
      nf,
    );
  }
  return matchGeneric(target, frame, tp, fp);
}

const BIT_COUNTS = Uint8Array.from({ length: 256 }, (_, value) => {
  let n = 0;
  while (value) {
    value &= value - 1;
    n++;
  }
  return n;
});

/** Hamming distance of two 32-byte descriptors. */
export function hamming(a: readonly number[], b: readonly number[]): number {
  let n = 0;
  for (let i = 0; i < 32; i++) n += BIT_COUNTS[a[i]! ^ b[i]!]!;
  return n;
}
