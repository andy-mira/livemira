/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Chooses the exact matcher for a vision core and describes what really runs.

import {
  createWasmMatchOperator,
  selectWasmExactMatcher,
  type WasmExactMatcher,
} from '@livemira/compute';
import { ALGORITHM_VERSION, type ExactMatcher } from '@livemira/recognition';

import type { VisionCapability, VisionOptions } from './protocol.ts';

export class MatchingSelection {
  private matcher: WasmExactMatcher | null = null;
  private selection: { fallbackReason: string | null; attempts: string } | null = null;
  /** True after a mid-run WebAssembly failure until the changed capability has been announced. */
  private hasUnannouncedChange = false;
  private readonly mode: VisionOptions['exactMatching'];

  constructor(mode: VisionOptions['exactMatching']) {
    this.mode = mode;
  }

  /** Selects SIMD, then scalar WebAssembly; any failure keeps the JavaScript matcher. */
  async initialize(): Promise<void> {
    if (this.mode !== 'wasm') return;
    try {
      const selected = await selectWasmExactMatcher();
      this.matcher = selected.matcher;
      this.selection = {
        fallbackReason: selected.fallbackReason,
        attempts: selected.attempts.map((a) => `${a.variant}:${a.outcome}`).join(','),
      };
    } catch {
      this.matcher = null;
      this.selection = { fallbackReason: 'WASM_INIT_FAILED', attempts: '*:WASM_INIT_FAILED' };
    }
  }

  /** The operator for the recognizer; undefined keeps the built-in JavaScript matcher. */
  operator(): ExactMatcher | undefined {
    if (!this.matcher) return undefined;
    return createWasmMatchOperator(this.matcher, {
      onFailure: () => {
        this.hasUnannouncedChange = true;
      },
    });
  }

  get hasChangedSinceAnnounced(): boolean {
    return this.hasUnannouncedChange;
  }

  /** The current capability; describing it counts as announcing any pending change. */
  describe(execution: VisionCapability['execution'], generation: number): VisionCapability {
    this.hasUnannouncedChange = false;
    if (this.mode !== 'wasm') {
      return {
        execution,
        generation,
        algorithmVersion: ALGORITHM_VERSION,
        matching: 'cpu',
        matchingSelection: 'none',
        matchingFallback: 'none',
        fallbackReason: null,
      };
    }
    const live = this.matcher?.isAvailable === true;
    const reason =
      this.matcher?.diagnostics.fallbackReason ??
      this.selection?.fallbackReason ??
      (live ? null : 'WASM_UNAVAILABLE');
    return {
      execution,
      generation,
      algorithmVersion: ALGORITHM_VERSION,
      matching: live ? `wasm-${this.matcher!.variant}` : 'cpu',
      matchingSelection: this.selection?.attempts ?? 'none',
      matchingFallback: reason ?? 'none',
      fallbackReason: live ? null : 'WASM_MATCHING_JS_FALLBACK',
    };
  }

  dispose(): void {
    this.matcher?.dispose();
    this.matcher = null;
    this.selection = null;
    this.hasUnannouncedChange = false;
  }
}
