/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// WebAssembly exact Hamming matcher (same contract and results as matchHammingReference). ABI 1 layout of the WAT
// sources: one non-growable 4-page memory, ten resident target slots, one frame slot, and u16
// {targetIndex, frameIndex, distance} output triples per batch entry. Nothing is allocated per call.

import { EngineError } from '@livemira/contracts';

import { EXACT_MATCHING_WASM } from './generated/exact-matching-wasm.ts';
import {
  EXACT_MATCHING_VERSION,
  matchHammingReference,
  type MatchPair,
} from './hamming-reference.ts';

const ABI = 1;
const MEMORY_BYTES = 4 * 65536;
const SLOT_BYTES = 512 * 32;
const FRAME = 163840;
const OUT = 194560;
const OUT_SLOT = 512 * 6;
const MAX_TARGETS = 10;

export type WasmMatcherVariant = 'simd' | 'scalar';

/** Selection order: SIMD only when the engine validates it and it passes the self-test, then scalar; otherwise JavaScript. */
export const WASM_MATCHER_VARIANTS: readonly WasmMatcherVariant[] = Object.freeze([
  'simd',
  'scalar',
]);

export interface ResidentTarget {
  readonly id: string;
  /** Packed 32-byte descriptors, at most 512. */
  readonly descriptors: Uint8Array;
}

export interface TargetMatches {
  readonly targetId: string;
  readonly pairs: readonly MatchPair[];
}

export interface WasmMatchBatch {
  readonly backend: 'wasm';
  readonly variant: WasmMatcherVariant;
  readonly matchingVersion: string;
  /** In request order; each target's pairs in ascending target index. */
  readonly matches: readonly TargetMatches[];
  readonly timing: { readonly totalMs: number };
}

export interface WasmMatcherDiagnostics {
  readonly matchingVersion: string;
  readonly backend: 'wasm' | 'cpu';
  readonly variant: WasmMatcherVariant;
  readonly fallbackReason: string | null;
  readonly targetCount: number;
}

/** Exports of an instantiated ABI-1 module. */
interface MatcherExports {
  readonly memory: WebAssembly.Memory;
  abi(): number;
  match(targetOffset: number, targetCount: number, output: number, frameCount: number): number;
}

const aborted = (): EngineError =>
  new EngineError('ABORTED', 'Matching aborted', { isRecoverable: true });

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw aborted();
}

const invalidRequest = (message: string): EngineError =>
  new EngineError('INVALID_CONFIG', message, { isRecoverable: false });

/** Descriptor count of packed 32-byte descriptors within one slot, or -1. */
function descriptorCount(bytes: unknown): number {
  return bytes instanceof Uint8Array && bytes.length % 32 === 0 && bytes.length <= SLOT_BYTES
    ? bytes.length / 32
    : -1;
}

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

/** Exact matcher over one instantiated ABI-1 module. Synchronous; targets stay resident in its memory until replaced. */
export class WasmExactMatcher {
  #match: MatcherExports['match'] | null;
  #u8: Uint8Array | null;
  #u16: Uint16Array | null;
  readonly #variant: WasmMatcherVariant;
  #targets = new Map<string, { offset: number; count: number }>();
  #failure: string | null = null;

  constructor(instance: WebAssembly.Instance, variant: WasmMatcherVariant) {
    const e = instance?.exports as Partial<MatcherExports> | undefined;
    if (
      !WASM_MATCHER_VARIANTS.includes(variant) ||
      !(e?.memory instanceof WebAssembly.Memory) ||
      e.memory.buffer.byteLength !== MEMORY_BYTES ||
      typeof e.match !== 'function' ||
      typeof e.abi !== 'function' ||
      e.abi() !== ABI
    ) {
      throw new EngineError('UNSUPPORTED', 'Invalid exact matching module', {
        isRecoverable: false,
      });
    }
    this.#match = e.match;
    this.#variant = variant;
    // The memory cannot grow (minimum equals maximum), so these views never detach.
    this.#u8 = new Uint8Array(e.memory.buffer);
    this.#u16 = new Uint16Array(e.memory.buffer);
  }

  get variant(): WasmMatcherVariant {
    return this.#variant;
  }

  get isAvailable(): boolean {
    return this.#match !== null;
  }

  get diagnostics(): WasmMatcherDiagnostics {
    return {
      matchingVersion: EXACT_MATCHING_VERSION,
      backend: this.#match ? 'wasm' : 'cpu',
      variant: this.#variant,
      fallbackReason: this.#failure,
      targetCount: this.#targets.size,
    };
  }

  #live(): { match: MatcherExports['match']; u8: Uint8Array; u16: Uint16Array } {
    if (!this.#match || !this.#u8 || !this.#u16) {
      throw new EngineError('RESOURCE_FAILED', 'WASM exact matcher unavailable', {
        isRecoverable: false,
      });
    }
    return { match: this.#match, u8: this.#u8, u16: this.#u16 };
  }

  /** Replaces the resident roster: at most ten unique targets of at most 512 descriptors; fully validated before any byte is written. */
  setTargets(targets: readonly ResidentTarget[]): void {
    const { u8 } = this.#live();
    if (
      !Array.isArray(targets) ||
      targets.length > MAX_TARGETS ||
      new Set(targets.map((t) => t?.id)).size !== targets.length
    ) {
      throw invalidRequest('Expected at most ten unique targets');
    }
    const counts = targets.map((t) => {
      if (typeof t.id !== 'string' || !t.id || t.id.length > 256)
        throw invalidRequest('Invalid target ID');
      const n = descriptorCount(t.descriptors);
      if (n < 0) throw invalidRequest('Expected at most 512 packed 32-byte descriptors');
      return n;
    });
    const next = new Map<string, { offset: number; count: number }>();
    targets.forEach((t, slot) => {
      u8.set(t.descriptors, slot * SLOT_BYTES);
      next.set(t.id, { offset: slot * SLOT_BYTES, count: counts[slot]! });
    });
    this.#targets = next;
  }

  /** One frame upload, then one exact pass per requested resident target. */
  matchBatch(
    targetIds: readonly string[],
    frame: Uint8Array,
    signal?: AbortSignal,
  ): WasmMatchBatch {
    const { match, u8, u16 } = this.#live();
    throwIfAborted(signal);
    if (
      !Array.isArray(targetIds) ||
      targetIds.length > MAX_TARGETS ||
      new Set(targetIds).size !== targetIds.length ||
      targetIds.some((id) => !this.#targets.has(id))
    ) {
      throw invalidRequest('Expected at most ten loaded targets');
    }
    const m = descriptorCount(frame);
    if (m < 0) throw invalidRequest('Expected at most 512 packed 32-byte descriptors');
    const start = performance.now();
    const matches: TargetMatches[] = [];
    u8.set(frame, FRAME);
    for (let k = 0; k < targetIds.length; k++) {
      throwIfAborted(signal);
      const targetId = targetIds[k]!;
      const target = this.#targets.get(targetId)!;
      const out = OUT + k * OUT_SLOT;
      const count = match(target.offset, target.count, out, m);
      if (!Number.isInteger(count) || count < 0 || count > Math.min(target.count, m)) {
        throw new EngineError('RESOURCE_FAILED', 'WASM exact matching failed', {
          isRecoverable: false,
        });
      }
      const pairs = new Array<MatchPair>(count);
      for (let q = 0, p = out >>> 1; q < count; q++, p += 3) {
        pairs[q] = { targetIndex: u16[p]!, frameIndex: u16[p + 1]!, distance: u16[p + 2]! };
      }
      matches.push({ targetId, pairs });
    }
    throwIfAborted(signal);
    return {
      backend: 'wasm',
      variant: this.#variant,
      matchingVersion: EXACT_MATCHING_VERSION,
      matches,
      timing: { totalMs: performance.now() - start },
    };
  }

  /** Permanently disables this instance (the caller then keeps the JavaScript matcher) and records why. */
  fail(reason: string): void {
    this.#failure = reason;
    this.dispose();
  }

  /** Drops every reference to the instance and its memory; later calls throw. */
  dispose(): void {
    this.#match = null;
    this.#u8 = null;
    this.#u16 = null;
    this.#targets.clear();
  }
}

// Deterministic self-test cases checked against matchHammingReference before a variant is selected: random planted
// matches (including counts that are not multiples of 4), duplicate targets (reverse tie), identical descriptors,
// distance 64/65 and ratio equality boundaries, a single frame descriptor, and full 512 × 512 capacity.
function selfTestCases(): [Uint8Array, Uint8Array][] {
  let seed = 0x2545f491;
  const rnd = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const random = (n: number): Uint8Array => {
    const b = new Uint8Array(n * 32);
    for (let i = 0; i < b.length; i++) b[i] = rnd() & 255;
    return b;
  };
  const flip = (src: Uint8Array, i: number, bits: number): Uint8Array => {
    const d = src.slice(i * 32, i * 32 + 32);
    for (let k = 0; k < bits; k++) d[k % 32]! ^= 1 << (k >> 5);
    return d;
  };
  const join = (list: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(list.reduce((s, d) => s + d.length, 0));
    let o = 0;
    for (const d of list) {
      out.set(d, o);
      o += d.length;
    }
    return out;
  };
  const target = random(37);
  const frameList: Uint8Array[] = [];
  for (let j = 0; j < 41; j++)
    frameList.push(j % 3 === 0 ? flip(target, (j * 7) % 37, j % 70) : random(1));
  const zero = new Uint8Array(32);
  const ones = (bits: number): Uint8Array => {
    const d = new Uint8Array(32);
    for (let k = 0; k < bits; k++) d[k >> 3]! |= 1 << (k & 7);
    return d;
  };
  const big = random(512);
  return [
    [target, join(frameList)],
    [
      join([target.slice(0, 32), target.slice(0, 32), target.slice(32, 64)]),
      join([target.slice(0, 32), target.slice(32, 96)]),
    ],
    [join([zero, ones(256)]), join([ones(64), ones(65)])],
    [join([zero]), join([ones(64)])],
    [join([zero]), join([ones(65)])],
    [join([zero]), join([ones(30), ones(40)])],
    [join([zero]), join([ones(30), ones(41)])],
    [join([zero]), join([ones(30), ones(39), ones(200)])],
    [big, join([big.slice(0, 32 * 300), random(212)])],
  ];
}

function passesSelfTest(matcher: WasmExactMatcher): boolean {
  try {
    for (const [target, frame] of selfTestCases()) {
      matcher.setTargets([{ id: 'self-test', descriptors: target }]);
      const got = matcher.matchBatch(['self-test'], frame).matches[0]!.pairs;
      const want = matchHammingReference(target, frame);
      if (
        got.length !== want.length ||
        got.some(
          (p, i) =>
            p.targetIndex !== want[i]!.targetIndex ||
            p.frameIndex !== want[i]!.frameIndex ||
            p.distance !== want[i]!.distance,
        )
      ) {
        return false;
      }
    }
    matcher.setTargets([]);
    return true;
  } catch {
    return false;
  }
}

export interface WasmMatcherAttempt {
  readonly variant: WasmMatcherVariant | '*';
  readonly outcome: string;
}

export interface WasmMatcherSelection {
  readonly matcher: WasmExactMatcher | null;
  readonly variant: WasmMatcherVariant | null;
  /** Null when the first requested variant was selected; otherwise the first rejection (with `matcher` null, JavaScript stays). */
  readonly fallbackReason: string | null;
  readonly attempts: readonly WasmMatcherAttempt[];
}

/** The parts of the WebAssembly API the selection uses; injectable for tests. */
export interface WebAssemblyApi {
  validate(bytes: BufferSource): boolean;
  instantiate(
    bytes: BufferSource,
    imports: WebAssembly.Imports,
  ): Promise<WebAssembly.WebAssemblyInstantiatedSource>;
}

export interface WasmMatcherSelectionOptions {
  readonly variants?: readonly WasmMatcherVariant[];
  readonly signal?: AbortSignal;
  /** Null means no WebAssembly API. */
  readonly webAssembly?: WebAssemblyApi | null;
  readonly binaries?: Readonly<Record<WasmMatcherVariant, { readonly base64: string }>>;
}

/**
 * Selects the first variant that the engine validates, instantiates and that reproduces the JavaScript reference on
 * the self-test. Never throws for an unsupported engine; rejects with `ABORTED` when `signal` aborts and with
 * `INVALID_CONFIG` for an unknown variant.
 */
export async function selectWasmExactMatcher(
  options: WasmMatcherSelectionOptions = {},
): Promise<WasmMatcherSelection> {
  const {
    variants = WASM_MATCHER_VARIANTS,
    signal,
    webAssembly = globalThis.WebAssembly as WebAssemblyApi | undefined,
    binaries = EXACT_MATCHING_WASM,
  } = options;
  throwIfAborted(signal);
  if (
    !Array.isArray(variants) ||
    !variants.length ||
    variants.some((v) => !WASM_MATCHER_VARIANTS.includes(v))
  ) {
    throw invalidRequest('Unknown WASM exact matching variant');
  }
  const attempts: WasmMatcherAttempt[] = [];
  if (
    typeof webAssembly?.instantiate !== 'function' ||
    typeof webAssembly.validate !== 'function'
  ) {
    return {
      matcher: null,
      variant: null,
      fallbackReason: 'WASM_UNAVAILABLE',
      attempts: [{ variant: '*', outcome: 'WASM_UNAVAILABLE' }],
    };
  }
  for (const variant of variants as readonly WasmMatcherVariant[]) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = decode(binaries[variant].base64);
    } catch {
      attempts.push({ variant, outcome: 'WASM_MODULE_MISSING' });
      continue;
    }
    if (!webAssembly.validate(bytes)) {
      attempts.push({
        variant,
        outcome: variant === 'simd' ? 'WASM_SIMD_UNSUPPORTED' : 'WASM_MODULE_INVALID',
      });
      continue;
    }
    let matcher: WasmExactMatcher;
    try {
      const { instance } = await webAssembly.instantiate(bytes, {});
      throwIfAborted(signal);
      matcher = new WasmExactMatcher(instance, variant);
    } catch (error) {
      if (error instanceof EngineError && error.code === 'ABORTED') throw error;
      attempts.push({ variant, outcome: 'WASM_INIT_FAILED' });
      continue;
    }
    if (!passesSelfTest(matcher)) {
      matcher.dispose();
      attempts.push({ variant, outcome: 'WASM_SELFTEST_MISMATCH' });
      continue;
    }
    attempts.push({ variant, outcome: 'selected' });
    return {
      matcher,
      variant,
      fallbackReason: attempts.length > 1 ? attempts[0]!.outcome : null,
      attempts,
    };
  }
  return {
    matcher: null,
    variant: null,
    fallbackReason: attempts[0]?.outcome ?? 'WASM_UNAVAILABLE',
    attempts,
  };
}

export interface ExactMatchRequest {
  readonly targetId: string;
  readonly descriptors: Uint8Array;
}

/** Same exact matching as the recognizer's built-in matcher; resolves null when the recognizer must match in JavaScript. */
export type ExactMatchOperator = (
  targets: readonly ExactMatchRequest[],
  frameDescriptors: Uint8Array,
  signal?: AbortSignal,
) => Promise<WasmMatchBatch | null>;

/**
 * Exact matching operator over a WasmExactMatcher with a bounded resident roster (keyed by the identity of each
 * target's descriptor bytes). Resolves null, so the recognizer matches that frame in JavaScript, when the matcher is
 * unavailable or a request exceeds the fixed capacity. An execution failure disables the matcher permanently
 * (reported once through `onFailure`) and also resolves null: the same frame is then matched in JavaScript with
 * identical results. Aborts reject.
 */
export function createWasmMatchOperator(
  matcher: WasmExactMatcher,
  options: { readonly onFailure?: (reason: string) => void } = {},
): ExactMatchOperator {
  let roster = new Map<string, Uint8Array>();
  return async (targets, frameDescriptors, signal) => {
    if (!matcher.isAvailable) return null;
    throwIfAborted(signal);
    if (
      targets.length > MAX_TARGETS ||
      descriptorCount(frameDescriptors) < 0 ||
      targets.some((t) => descriptorCount(t.descriptors) < 0)
    ) {
      return null;
    }
    try {
      let changed = false;
      let next = new Map(roster);
      for (const t of targets) {
        if (next.get(t.targetId) !== t.descriptors) {
          changed = true;
          next.set(t.targetId, t.descriptors);
        }
      }
      if (next.size > MAX_TARGETS) {
        next = new Map(targets.map((t) => [t.targetId, t.descriptors]));
        changed = true;
      }
      if (changed) {
        roster = new Map();
        matcher.setTargets([...next].map(([id, descriptors]) => ({ id, descriptors })));
        roster = next;
      }
      return matcher.matchBatch(
        targets.map((t) => t.targetId),
        frameDescriptors,
        signal,
      );
    } catch (error) {
      if ((error instanceof EngineError && error.code === 'ABORTED') || signal?.aborted)
        throw error;
      roster = new Map();
      matcher.fail('WASM_EXECUTION_FAILED');
      try {
        options.onFailure?.('WASM_EXECUTION_FAILED');
      } catch {
        // Observers cannot block the JavaScript fallback.
      }
      return null;
    }
  };
}
