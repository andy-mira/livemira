/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { VisionWorkerRequest, VisionWorkerResponse } from '@livemira/contracts';
import { createVisionWorkerRuntime, type VisionWorkerAssets } from './worker-runtime.js';

export interface VisionWorkerScope {
  postMessage(message: VisionWorkerResponse): void;
  addEventListener(type: 'message', listener: (event: { data: VisionWorkerRequest }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: VisionWorkerRequest }) => void): void;
}
/**
 * Connects one vision runtime to a Worker scope. Importing this module has no side effect; the file-backed worker and the embedded
 * single-file worker both call it. `assets` lets the host provide the WASM module factory and Hamming shader source so nothing is fetched.
 * Returns a function that stops listening (the scope itself is terminated by its owner).
 */
export function startVisionWorker(scope: VisionWorkerScope = globalThis as unknown as VisionWorkerScope, assets?: VisionWorkerAssets): () => void {
  const handle = createVisionWorkerRuntime(message => scope.postMessage(message), undefined, assets);
  const listener = (event: { data: VisionWorkerRequest }) => { void handle(event.data); };
  scope.addEventListener('message', listener);
  return () => scope.removeEventListener?.('message', listener);
}
