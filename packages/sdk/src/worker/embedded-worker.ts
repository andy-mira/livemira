/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

import type { WorkerEndpoint } from './vision-client.ts';

// Defined by the single-file build only: the bundled Worker source.
declare const __LIVEMIRA_WORKER_SOURCE__: string | undefined;

/** The browser globals the embedded factory uses; injectable for tests. */
export interface EmbeddedWorkerEnvironment {
  Worker: new (url: string, options?: { type?: 'module'; name?: string }) => WorkerEndpoint;
  Blob: new (parts: string[], options?: { type?: string }) => unknown;
  URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
}

/**
 * A Worker factory for a fully bundled module Worker source. The Blob URL lives exactly as long as its Worker:
 * terminate() (or a failed construction) revokes it. The page CSP must allow `worker-src blob:`.
 */
export function createEmbeddedWorkerFactory(
  source: string,
  env: EmbeddedWorkerEnvironment = globalThis as unknown as EmbeddedWorkerEnvironment,
): () => WorkerEndpoint {
  if (typeof source !== 'string' || !source) {
    throw new EngineError('INVALID_CONFIG', 'Embedded worker source required', {
      isRecoverable: false,
    });
  }
  return () => {
    const url = env.URL.createObjectURL(new env.Blob([source], { type: 'text/javascript' }));
    let worker: WorkerEndpoint;
    try {
      worker = new env.Worker(url, { type: 'module', name: 'LiveMira vision' });
    } catch (error) {
      env.URL.revokeObjectURL(url);
      throw error;
    }
    let isRevoked = false;
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate() {
        try {
          worker.terminate();
        } finally {
          if (!isRevoked) {
            isRevoked = true;
            env.URL.revokeObjectURL(url);
          }
        }
      },
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
  };
}

/** The embedded Worker of the single-file build; workspace sources have none and need an explicit factory. */
export function defaultWorkerFactory(): () => WorkerEndpoint {
  const source = typeof __LIVEMIRA_WORKER_SOURCE__ === 'string' ? __LIVEMIRA_WORKER_SOURCE__ : '';
  if (!source) {
    return () => {
      throw new EngineError(
        'UNSUPPORTED',
        'No embedded Worker in this build; provide a workerFactory',
        { isRecoverable: false },
      );
    };
  }
  return createEmbeddedWorkerFactory(source);
}
