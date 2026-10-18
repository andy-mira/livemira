/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';

import { harness, makeFrame } from './core-harness.ts';

const container = {} as HTMLElement;

test('event edges, duplicate frames, repeated lifecycle, unsubscribe and listener isolation', async () => {
  const listenerErrors: unknown[] = [];
  const h = harness({ onListenerError: (error) => listenerErrors.push(error) });
  const events: string[] = [];
  for (const type of ['ready', 'targetFound', 'targetUpdated', 'targetLost'] as const)
    h.core.on(type, () => events.push(type));
  const off = h.core.on('ready', () => {
    throw new Error('listener isolation');
  });
  await Promise.all([h.core.start(container), h.core.start(container)]);
  off();
  assert.equal(listenerErrors.length, 1, 'a failing listener is reported, not thrown');
  let released = 0;
  const session = h.core.sessionId!;
  await h.push(makeFrame(session, 1, { onRelease: () => released++ }));
  await h.push(makeFrame(session, 1, { onRelease: () => released++ }));
  await h.push(makeFrame(session, 2, { onRelease: () => released++ }));
  await h.core.stop();
  await h.core.stop();
  assert.deepEqual(events, [
    'ready',
    'targetFound',
    'targetUpdated',
    'targetUpdated',
    'targetLost',
  ]);
  assert.equal(released, 3, 'every frame is released, the duplicate too');
  assert.equal(h.isVisible, false);
  await h.core.start(container);
  assert.equal(h.core.sessionId, 'session-2');
  await h.core.dispose();
  await h.core.dispose();
  assert.throws(
    () => h.core.start(container),
    (e) => e instanceof EngineError && e.code === 'DISPOSED',
  );
});
