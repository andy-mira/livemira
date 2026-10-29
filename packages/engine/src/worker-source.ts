// SPDX-License-Identifier: Apache-2.0
// The engine's Workers. The release embeds the Worker bundle (one classic script with three roles: vision,
// relocaliser, compiler) as text and starts every Worker from one `blob:` URL; a page whose CSP forbids that passes
// the Worker file's URL instead.

import { EngineError } from './errors.ts';

declare const __LIVEMIRA_WORKER_CODE__: string | undefined;

export type WorkerRole = 'vision' | 'relocalizer' | 'compiler';

let blobUrl: string | null = null;

function embeddedUrl(): string {
  if (blobUrl) return blobUrl;
  if (typeof __LIVEMIRA_WORKER_CODE__ !== 'string')
    throw new EngineError('INVALID_CONFIG', 'This engine build has no embedded Worker: pass `workerUrl`');
  blobUrl = URL.createObjectURL(new Blob([__LIVEMIRA_WORKER_CODE__], { type: 'text/javascript' }));
  return blobUrl;
}

/** Starts a Worker in `role`; its first message tells it which. */
export function spawnWorker(role: WorkerRole, workerUrl?: string | URL): Worker {
  let worker: Worker;
  try {
    worker = new Worker(workerUrl ?? embeddedUrl(), { name: `LiveMira ${role}` });
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError('WORKER_FAILED', `Cannot start the ${role} Worker (a CSP may forbid blob: Workers)`, {
      cause,
    });
  }
  worker.postMessage({ type: 'role', role });
  return worker;
}
