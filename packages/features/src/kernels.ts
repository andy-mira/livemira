// SPDX-License-Identifier: Apache-2.0
// The embedded WASM SIMD kernels (kernels/vision): compiled once, instantiated per user so each owns its linear
// memory. Users keep a JavaScript reference with identical results and self-test the kernel before using it.

import { KERNELS_WASM } from './generated/kernels-wasm.ts';

export interface KernelExports {
  readonly memory: WebAssembly.Memory;
  reserve(bytes: number): number;
  reset_heap(): void;
  nearest2(queries: number, m: number, refs: number, n: number, out: number): void;
  nearest2_grouped(queries: number, m: number, refs: number, groups: number, n: number, out: number): void;
  fast9(
    img: number,
    stride: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    t: number,
    scores: number,
    w: number,
    found: number,
  ): number;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

let compiled: WebAssembly.Module | null | undefined;

/** A fresh instance of the kernels (synchronous; the module is a few KB), or null where WASM SIMD is unavailable. */
export function instantiateKernels(): KernelExports | null {
  if (typeof WebAssembly === 'undefined') return null;
  try {
    if (compiled === undefined) {
      const bytes = decode(KERNELS_WASM.base64);
      compiled = WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
    }
    return compiled ? (new WebAssembly.Instance(compiled, {}).exports as unknown as KernelExports) : null;
  } catch {
    compiled = null;
    return null;
  }
}
