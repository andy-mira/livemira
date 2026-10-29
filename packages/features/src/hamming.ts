// SPDX-License-Identifier: Apache-2.0
// Nearest-two Hamming search over 256-bit descriptors: the JavaScript reference and the WASM SIMD kernel
// (kernels/vision), which must agree exactly; a self-test on construction decides whether the kernel is used.

import { instantiateKernels, type KernelExports } from './kernels.ts';

/** For each query: (index of the nearest reference, best distance, second-best distance), u32 triples. */
export function nearest2Reference(queries: Uint8Array, refs: Uint8Array): Uint32Array {
  const m = queries.length / 32;
  const n = refs.length / 32;
  const out = new Uint32Array(3 * m);
  const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
  const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
  for (let q = 0; q < m; q++) {
    let best = 257;
    let second = 257;
    let index = 0xffffffff;
    const a = 8 * q;
    for (let r = 0; r < n; r++) {
      const b = 8 * r;
      let d = 0;
      for (let k = 0; k < 8; k++) {
        let v = (q32[a + k]! ^ r32[b + k]!) >>> 0;
        v -= (v >>> 1) & 0x55555555;
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        d += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
      }
      if (d < best) {
        second = best;
        best = d;
        index = r;
      } else if (d < second) second = d;
    }
    out[3 * q] = index;
    out[3 * q + 1] = best;
    out[3 * q + 2] = second;
  }
  return out;
}

/** Grouped variant: the second distance comes from a reference of a different group than the nearest one. */
export function nearest2GroupedReference(queries: Uint8Array, refs: Uint8Array, groups: Uint32Array): Uint32Array {
  const m = queries.length / 32;
  const n = refs.length / 32;
  const out = new Uint32Array(3 * m);
  const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
  const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
  for (let q = 0; q < m; q++) {
    let best = 257;
    let bestGroup = 0xffffffff;
    let second = 257;
    let index = 0xffffffff;
    const a = 8 * q;
    for (let r = 0; r < n; r++) {
      const b = 8 * r;
      let d = 0;
      for (let k = 0; k < 8; k++) {
        let v = (q32[a + k]! ^ r32[b + k]!) >>> 0;
        v -= (v >>> 1) & 0x55555555;
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        d += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
      }
      const g = groups[r]!;
      if (g === bestGroup) {
        if (d < best) {
          best = d;
          index = r;
        }
      } else if (d < best) {
        second = best;
        best = d;
        bestGroup = g;
        index = r;
      } else if (d < second) second = d;
    }
    out[3 * q] = index;
    out[3 * q + 1] = best;
    out[3 * q + 2] = second;
  }
  return out;
}

/** Nearest-two search backed by the WASM SIMD kernel when it validates and passes the self-test, else JavaScript. */
export class HammingMatcher {
  readonly backend: 'wasm-simd' | 'js';
  private readonly kernel: KernelExports | null;

  private constructor(kernel: KernelExports | null) {
    this.kernel = kernel;
    this.backend = kernel ? 'wasm-simd' : 'js';
  }

  /** Synchronous instantiation (the module is ~1 KB); `allowWasm: false` forces the reference. */
  static create(options: { readonly allowWasm?: boolean } = {}): HammingMatcher {
    const kernel = options.allowWasm === false ? null : instantiateKernels();
    if (!kernel) return new HammingMatcher(null);
    try {
      const matcher = new HammingMatcher(kernel);
      return matcher.selfTest() ? matcher : new HammingMatcher(null);
    } catch {
      return new HammingMatcher(null);
    }
  }

  private selfTest(): boolean {
    let s = 0x1234567;
    const random = (n: number): Uint8Array =>
      Uint8Array.from({ length: n }, () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s & 255;
      });
    const refs = random(32 * 37);
    const queries = new Uint8Array(32 * 11);
    queries.set(random(32 * 10));
    queries.set(refs.subarray(32 * 5, 32 * 6), 32 * 10);
    const want = nearest2Reference(queries, refs);
    const got = this.nearest2(queries, refs);
    const groups = Uint32Array.from({ length: 37 }, (_, i) => i >> 1);
    const wantG = nearest2GroupedReference(queries, refs, groups);
    const gotG = this.nearest2Grouped(queries, refs, groups);
    return (
      got.length === want.length &&
      got.every((v, i) => v === want[i]) &&
      gotG.length === wantG.length &&
      gotG.every((v, i) => v === wantG[i])
    );
  }

  nearest2(queries: Uint8Array, refs: Uint8Array): Uint32Array {
    const k = this.kernel;
    if (!k) return nearest2Reference(queries, refs);
    const m = queries.length / 32;
    const n = refs.length / 32;
    k.reset_heap();
    const q = k.reserve(queries.length);
    const r = k.reserve(refs.length);
    const o = k.reserve(12 * m);
    if (!q || !r || !o) return nearest2Reference(queries, refs);
    new Uint8Array(k.memory.buffer).set(queries, q);
    new Uint8Array(k.memory.buffer).set(refs, r);
    k.nearest2(q, m, r, n, o);
    return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
  }

  nearest2Grouped(queries: Uint8Array, refs: Uint8Array, groups: Uint32Array): Uint32Array {
    const k = this.kernel;
    if (!k) return nearest2GroupedReference(queries, refs, groups);
    const m = queries.length / 32;
    k.reset_heap();
    const q = k.reserve(queries.length);
    const r = k.reserve(refs.length);
    const g = k.reserve(groups.byteLength);
    const o = k.reserve(12 * m);
    if (!q || !r || !g || !o) return nearest2GroupedReference(queries, refs, groups);
    const mem = k.memory.buffer;
    new Uint8Array(mem).set(queries, q);
    new Uint8Array(mem).set(refs, r);
    new Uint8Array(mem).set(new Uint8Array(groups.buffer, groups.byteOffset, groups.byteLength), g);
    k.nearest2_grouped(q, m, r, g, refs.length / 32, o);
    return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
  }
}
