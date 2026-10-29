// SPDX-License-Identifier: Apache-2.0
// The engine's one Worker script. Its first message names the role (vision, relocalizer or compiler); the role then
// installs its own message handling, so every later message reaches it in order.

import { startRelocalizer } from '@livemira-next/web/relocalizer';
import { startVisionWorker } from '@livemira-next/web/vision';

import { startCompiler } from './compile-worker.ts';

const scope = globalThis as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
};

function chooseRole(event: MessageEvent): void {
  const message = event.data as { type?: string; role?: string } | null;
  if (message?.type !== 'role') return;
  scope.removeEventListener('message', chooseRole);
  if (message.role === 'vision') startVisionWorker(scope as never);
  else if (message.role === 'relocalizer') startRelocalizer(scope as never);
  else startCompiler(scope as never);
}

scope.addEventListener('message', chooseRole);
