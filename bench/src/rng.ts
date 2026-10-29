// SPDX-License-Identifier: Apache-2.0
// Seeded generators for the test side. Everything generated from the same seed is identical across runs and engines.

/** xorshift32 integers in [0, 2³²). */
export function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

/** Uniform floats in [0, 1). */
export function uniform(seed: number): () => number {
  const next = xorshift32(seed);
  return () => next() / 4294967296;
}

/** Standard normal samples (Box–Muller over the uniform stream). */
export function normal(seed: number): () => number {
  const u = uniform(seed);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const a = Math.max(u(), 1e-12);
    const b = u();
    const r = Math.sqrt(-2 * Math.log(a));
    spare = r * Math.sin(2 * Math.PI * b);
    return r * Math.cos(2 * Math.PI * b);
  };
}

/** Stable 32-bit hash of a string, for deriving seeds from names. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
