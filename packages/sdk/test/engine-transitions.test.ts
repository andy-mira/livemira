/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Viewport transitions as the engine core sees them: what a begin does to the overlay and the target.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Frame, ViewportTransition } from '@livemira/contracts';

import { EngineCore } from '../src/engine/engine-core.ts';
import { flush, makeFrame, makeResult } from './core-harness.ts';

const container = {} as HTMLElement;

test('a transition begin hides the overlay at once, without the loss grace, and reports the loss', async () => {
  let deliver: ((frame: Frame) => void) | null = null;
  let transition: ((t: ViewportTransition) => void) | null = null;
  let isVisible = false;
  const holds: number[] = [];
  const core = new EngineCore({
    source: {
      start: async (_session, onFrame) => {
        deliver = onFrame;
      },
      stop: async () => {},
      dispose: async () => {},
      onViewportTransition: (listener) => {
        transition = listener;
        return () => {
          transition = null;
        };
      },
    },
    pipeline: {
      loadTargets: async () => {},
      reset: async () => {},
      process: async (frame) => makeResult(frame, 'bird-01'),
      dispose: async () => {},
    },
    overlay: {
      start: async () => {},
      update: async () => {
        isVisible = true;
      },
      hide: () => {
        isVisible = false;
      },
      holdAfterLoss: (graceMs) => {
        holds.push(graceMs);
        return true;
      },
      stop: async () => {},
      dispose: async () => {},
    },
    capability: () => ({}) as never,
    lossDisplayGraceMs: 500,
  });
  const lost: string[] = [];
  core.on('targetLost', (e) => lost.push(e.reason));
  await core.start(container);
  deliver!(makeFrame(core.sessionId!, 1));
  await flush();
  assert.equal(isVisible, true);
  transition!({ phase: 'begin', epoch: 1, reason: 'orientation' });
  assert.equal(isVisible, false, 'hidden synchronously at the begin');
  assert.deepEqual(holds, [], 'the visual grace is for tracking losses only');
  assert.deepEqual(lost, ['viewport-transition']);
  await core.stop();
  await core.dispose();
});
