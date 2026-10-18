/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Exact BRIEF Hamming matching, contract hamming32-mutual-ratio075-max64/1:
//   distance = popcount(target XOR frame) over 32 bytes; best and second start at 257 and are updated by strict "<" in
//   frame order; target i is accepted when best <= 64, 4 * best < 3 * second, and i is the unique reverse nearest target
//   of its best frame descriptor (an equal reverse distance from a later target clears the reverse winner).
// This is the JavaScript reference the WebAssembly matchers are checked against.

import { EngineError } from '@livemira/contracts';

export const EXACT_MATCHING_VERSION = 'hamming32-mutual-ratio075-max64/1';

/** Bytes of one BRIEF-256 descriptor. */
export const DESCRIPTOR_BYTES = 32;

/** Most descriptors per target or per frame. */
export const MAX_DESCRIPTORS = 512;

/** An accepted correspondence between target descriptor `targetIndex` and frame descriptor `frameIndex`. */
export interface MatchPair {
  readonly targetIndex: number;
  readonly frameIndex: number;
  readonly distance: number;
}

const NONE = 0xffffffff;

function descriptorCount(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length % 32 || bytes.length > 512 * 32) {
    throw new EngineError('INVALID_CONFIG', 'Expected at most 512 packed 32-byte descriptors', {
      isRecoverable: false,
    });
  }
  return bytes.length / 32;
}

function pack(bytes: Uint8Array): Uint32Array {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] =
      (bytes[4 * i]! |
        (bytes[4 * i + 1]! << 8) |
        (bytes[4 * i + 2]! << 16) |
        (bytes[4 * i + 3]! << 24)) >>>
      0;
  }
  return words;
}

function popcount(v: number): number {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function pairsFromResults(data: Uint32Array, n: number, m: number): MatchPair[] {
  const pairs: MatchPair[] = [];
  for (let t = 0; t < n; t++) {
    const f = data[t * 4]!;
    const best = data[t * 4 + 1]!;
    const second = data[t * 4 + 2]!;
    if (f < m && best <= 64 && 4 * best < 3 * second && data[(n + f) * 4] === t) {
      pairs.push({ targetIndex: t, frameIndex: f, distance: best });
    }
  }
  return pairs;
}

/** Accepted pairs in ascending target index. Throws `INVALID_CONFIG` for input that is not packed 32-byte descriptors. */
export function matchHammingReference(target: Uint8Array, frame: Uint8Array): MatchPair[] {
  const n = descriptorCount(target);
  const m = descriptorCount(frame);
  if (!n || !m) return [];
  const a = pack(target);
  const b = pack(frame);
  const out = new Uint32Array((n + m) * 4);
  for (let f = 0; f < m; f++) {
    out[(n + f) * 4] = NONE;
    out[(n + f) * 4 + 1] = 257;
  }
  for (let t = 0; t < n; t++) {
    let index = NONE;
    let best = 257;
    let second = 257;
    for (let f = 0; f < m; f++) {
      let d = 0;
      for (let w = 0; w < 8; w++) d += popcount(a[t * 8 + w]! ^ b[f * 8 + w]!);
      if (d < best) {
        second = best;
        best = d;
        index = f;
      } else if (d < second) second = d;
      const r = (n + f) * 4;
      if (d < out[r + 1]!) {
        out[r] = t;
        out[r + 1] = d;
      } else if (d === out[r + 1]) out[r] = NONE;
    }
    out.set([index, best, second, 0], t * 4);
  }
  return pairsFromResults(out, n, m);
}
