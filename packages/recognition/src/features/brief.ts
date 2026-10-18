/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// BRIEF-256 (upright): 256 intensity comparisons between two smoothed pixels around the feature centre. The sample
// pattern is generated once from a fixed xorshift seed; offsets lie in [-8, 8].

function generatePattern(): readonly (readonly [number, number, number, number])[] {
  let seed = 0x9e3779b9;
  const offset = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 17) - 8;
  };
  return Array.from({ length: 256 }, () => [offset(), offset(), offset(), offset()] as const);
}

/** Sample pairs [ax, ay, bx, by]; bit k is set when pixel a is darker than pixel b. */
export const BRIEF_PATTERN = generatePattern();

/**
 * Flat [a0, b0, a1, b1, …] index offsets of the pattern for a layer of width `widthPx`.
 * (y + ay) · w + x + ax equals (y · w + x) + (ay · w + ax) for the small integers involved (|index| < 2^23), so each
 * comparison reads the same two pixels as sampling by coordinates.
 */
export function briefOffsetTable(widthPx: number): Int32Array {
  const table = new Int32Array(512);
  for (let bit = 0; bit < 256; bit++) {
    const p = BRIEF_PATTERN[bit]!;
    table[2 * bit] = p[1] * widthPx + p[0];
    table[2 * bit + 1] = p[3] * widthPx + p[2];
  }
  return table;
}

/**
 * Descriptor of the feature at pixel index `center` of a smoothed layer. Centres lie in [10, w - 10) × [10, h - 10),
 * so every read stays inside the layer.
 */
export function describe(data: Uint8Array, center: number, table: Int32Array): number[] {
  const descriptor = Array<number>(32).fill(0);
  for (let bit = 0, k = 0; bit < 256; bit++, k += 2) {
    if (data[center + table[k]!]! < data[center + table[k + 1]!]!)
      descriptor[bit >> 3]! |= 1 << (bit & 7);
  }
  return descriptor;
}
