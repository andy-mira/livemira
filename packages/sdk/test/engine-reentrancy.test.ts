/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Stopping or disposing from inside an event listener, and switching targets while measured.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { harness, makeFrame, makeResult } from './core-harness.ts';

const container = {} as HTMLElement;

test('stop from a targetFound listener emits no targetUpdated and arms no expiry', async () => {
  const h = harness();
  const events: string[] = [];
  let stopped: Promise<void> | undefined;
  h.core.on('targetFound', () => {
    events.push('found');
    stopped = h.core.stop();
    events.push('stop-requested');
  });
  h.core.on('targetUpdated', () => events.push('updated'));
  h.core.on('targetLost', () => events.push('lost'));
  await h.core.start(container);
  await h.push(makeFrame(h.core.sessionId!, 1));
  await stopped;
  assert.deepEqual(events, ['found', 'stop-requested', 'lost']);
  assert.equal(h.isVisible, false);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(events, ['found', 'stop-requested', 'lost']);
  await h.core.start(container);
  assert.equal(h.core.sessionId, 'session-2');
  await h.core.dispose();
});

test('stop from a targetUpdated listener prevents the expiry timer and restarts cleanly', async () => {
  const h = harness({ maxPredictionMs: 30 });
  const events: string[] = [];
  let stopped: Promise<void> | undefined;
  h.core.on('targetFound', () => events.push('found'));
  h.core.on('targetUpdated', () => {
    events.push('updated');
    stopped = h.core.stop();
    events.push('stop-requested');
  });
  h.core.on('targetLost', () => events.push('lost'));
  await h.core.start(container);
  await h.push(makeFrame(h.core.sessionId!, 1));
  await stopped;
  assert.deepEqual(events, ['found', 'updated', 'stop-requested', 'lost']);
  assert.equal(h.isVisible, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ['found', 'updated', 'stop-requested', 'lost']);
  await h.core.start(container);
  assert.equal(h.core.sessionId, 'session-2');
  await h.core.dispose();
});

test('dispose from a targetFound listener settles without targetUpdated', async () => {
  const h = harness();
  const events: string[] = [];
  let disposed: Promise<void> | undefined;
  h.core.on('targetFound', () => {
    events.push('found');
    disposed = h.core.dispose();
    events.push('dispose-requested');
  });
  h.core.on('targetUpdated', () => events.push('updated'));
  await h.core.start(container);
  await h.push(makeFrame(h.core.sessionId!, 1));
  await disposed;
  assert.deepEqual(events, ['found', 'dispose-requested']);
  assert.equal(h.isVisible, false);
});

test('stop from targetLost on a target switch shows nothing of the new target; a restart works', async () => {
  const h = harness();
  h.respond = (frame) => makeResult(frame, frame.frameId === 1 ? 'one' : 'two');
  const events: string[] = [];
  let stopping: Promise<void> | undefined;
  h.core.on('targetLost', (e) => {
    events.push(`lost:${e.reason}`);
    stopping = h.core.stop();
  });
  h.core.on('targetFound', (e) => events.push(`found:${e.result.targetId}`));
  h.core.on('targetUpdated', (e) => events.push(`updated:${e.result.targetId}`));
  try {
    await h.core.start(container);
    await h.push(makeFrame(h.core.sessionId!, 1));
    await h.push(makeFrame(h.core.sessionId!, 2));
    await stopping;
    assert.deepEqual(h.updates, ['one']);
    assert.deepEqual(events, ['found:one', 'updated:one', 'lost:target-changed']);
    assert.equal(h.isVisible, false);
    await h.core.start(container);
    assert.equal(h.core.sessionId, 'session-2');
  } finally {
    await h.core.dispose();
  }
});

test('a measured target switch without cancellation loses one and finds two', async () => {
  const h = harness();
  h.respond = (frame) => makeResult(frame, frame.frameId === 1 ? 'one' : 'two');
  const events: string[] = [];
  h.core.on('targetLost', (e) => events.push(`lost:${e.reason}`));
  h.core.on('targetFound', (e) => events.push(`found:${e.result.targetId}`));
  try {
    await h.core.start(container);
    await h.push(makeFrame(h.core.sessionId!, 1));
    await h.push(makeFrame(h.core.sessionId!, 2));
    assert.deepEqual(h.updates, ['one', 'two']);
    assert.deepEqual(events, ['found:one', 'lost:target-changed', 'found:two']);
  } finally {
    await h.core.dispose();
  }
});

test('stop from capabilityChanged or sessionConfigUpdated never announces ready; a restart does once', async () => {
  for (const name of ['capabilityChanged', 'sessionConfigUpdated'] as const) {
    const h = harness();
    const events: string[] = [];
    let stopping: Promise<void> | undefined;
    let isArmed = true;
    h.core.on(name, () => {
      if (isArmed) {
        isArmed = false;
        stopping = h.core.stop();
      }
    });
    h.core.on('ready', () => events.push('ready'));
    h.core.on('sessionEnded', (e) => events.push(`ended:${e.reason}`));
    try {
      await h.core.start(container);
      await stopping;
      assert.ok(stopping, `${name} observer ran`);
      assert.deepEqual(
        events.filter((e) => e === 'ready'),
        [],
        `${name}: no ready after cancellation`,
      );
      assert.equal(h.isSourceActive, false, `${name}: source quiesced`);
      await h.core.start(container);
      assert.equal(h.core.sessionId, 'session-2');
      assert.deepEqual(
        events.filter((e) => e === 'ready'),
        ['ready'],
        `${name}: ready once`,
      );
    } finally {
      await h.core.dispose();
    }
  }
});
