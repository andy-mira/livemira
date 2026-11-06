// SPDX-License-Identifier: Apache-2.0
// Engine-level suspend/resume: the request is remembered until a session applies it, and every end clears it. The
// camera, Worker and renderer side needs a browser (device kit); here only the engine's own bookkeeping is checked.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEngine } from '../src/engine.ts';

class FakeContainer {}
Object.assign(globalThis, { HTMLElement: FakeContainer });

const engine = () => createEngine({ container: new FakeContainer() as unknown as HTMLElement });

test('suspend is remembered, idempotent and undone by resume', () => {
  const e = engine();
  assert.equal(e.isSuspended, false);
  e.suspend();
  e.suspend();
  assert.equal(e.isSuspended, true);
  e.resume();
  e.resume();
  assert.equal(e.isSuspended, false);
});

test('a stop clears a suspend request, so the next start is not suspended', async () => {
  const e = engine();
  e.suspend();
  await e.stop();
  assert.equal(e.isSuspended, false);
});

test('after dispose suspend and resume do nothing', async () => {
  const e = engine();
  await e.dispose();
  e.suspend();
  assert.equal(e.isSuspended, false);
  e.resume();
  assert.equal(e.state, 'disposed');
});
