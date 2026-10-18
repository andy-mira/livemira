/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Corners } from '@livemira/contracts';

import { MotionModel } from '../src/engine/motion-model.ts';

/** A 100 × 100 px square (diagonal about 141 px) whose left edge is at `x`. */
const square = (x: number): Corners => [
  [x, 100],
  [x + 100, 100],
  [x + 100, 200],
  [x, 200],
];

test('speed is in target diagonals per second, from the larger of the fit and the latest step', () => {
  const m = new MotionModel();
  m.add(0, square(100));
  assert.equal(m.mode, 'unknown');
  m.add(33_000, square(110));
  m.add(66_000, square(120));
  // 10 px per 33 ms on a 141 px diagonal.
  assert.ok(Math.abs(m.speed! - 10 / 0.033 / 141.42) < 0.05);
  assert.equal(m.mode, 'fast');
  // A sudden stop: the step says still, the fit still sees the motion, so it stays fast.
  m.add(99_000, square(120));
  assert.equal(m.mode, 'fast');
});

test('fast turns slow only after three slow measurements in a row over 50 ms; an unknown gap restarts the count', () => {
  const m = new MotionModel();
  m.add(0, square(100));
  m.add(33_000, square(110));
  m.add(66_000, square(120));
  assert.equal(m.mode, 'fast');
  // Still from here on: the fit window first has to lose the moving poses.
  for (const t of [99_000, 132_000, 165_000]) m.add(t, square(120));
  const slowSoFar = m.mode;
  // A gap of more than 100 ms leaves no history: unknown, and the slow run starts over.
  m.add(400_000, square(120));
  assert.equal(m.speed, null);
  assert.equal(m.mode, 'fast');
  m.add(433_000, square(120));
  assert.equal(m.mode, 'fast', 'one slow measurement after the gap is not enough');
  m.add(466_000, square(120));
  m.add(499_000, square(120));
  assert.equal(m.mode, 'slow');
  assert.ok(['fast', 'slow'].includes(slowSoFar));
});

test('reset forgets everything; repeated or older times are ignored', () => {
  const m = new MotionModel();
  m.add(0, square(100));
  m.add(33_000, square(100));
  m.add(66_000, square(100));
  assert.equal(m.mode, 'slow');
  m.add(66_000, square(500));
  assert.equal(m.speed, 0);
  m.reset();
  assert.equal(m.mode, 'unknown');
  assert.equal(m.speed, null);
});
