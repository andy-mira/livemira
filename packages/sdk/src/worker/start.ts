/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { VisionRequest, VisionResponse } from './protocol.ts';
import { createVisionRuntime } from './vision-runtime.ts';

/** The parts of a Worker global scope the vision runtime uses. */
export interface VisionWorkerScope {
  postMessage(message: VisionResponse): void;
  addEventListener(type: 'message', listener: (event: { data: VisionRequest }) => void): void;
  removeEventListener?(type: 'message', listener: (event: { data: VisionRequest }) => void): void;
}

/** Connects one vision runtime to a Worker scope. Returns a function that stops listening; the owner terminates the scope. */
export function startVisionWorker(scope: VisionWorkerScope): () => void {
  const handle = createVisionRuntime((message) => scope.postMessage(message));
  const listener = (event: { data: VisionRequest }): void => {
    void handle(event.data);
  };
  scope.addEventListener('message', listener);
  return () => scope.removeEventListener?.('message', listener);
}
