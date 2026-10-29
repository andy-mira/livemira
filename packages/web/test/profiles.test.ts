// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Capability } from '@livemira-next/contracts';

import { resolveProfile } from '../src/profiles.ts';

const caps = (...c: Capability[]): Set<Capability> => new Set(c);
const FULL = caps('webgl2', 'videoframe', 'rvfc', 'mstp-worker', 'wasm-simd');

test('Swift by default; Hawk when asked; both fall back to Wren without Worker capture', () => {
  assert.equal(resolveProfile('swift', FULL)?.profile.id, 'swift');
  assert.equal(resolveProfile('hawk', FULL)?.profile.id, 'hawk');
  const noMstp = caps('webgl2', 'videoframe', 'rvfc');
  const hawk = resolveProfile('hawk', noMstp)!;
  assert.equal(hawk.profile.id, 'wren');
  assert.deepEqual(
    hawk.skipped.map((s) => s.id),
    ['hawk', 'swift'],
  );
  assert.equal(resolveProfile('swift', noMstp)?.profile.id, 'wren');
  // Window-side MSTP (Chromium) counts as Worker capture too.
  assert.equal(resolveProfile('swift', caps('webgl2', 'videoframe', 'mstp-window'))?.profile.id, 'swift');
});

test('no profile runs without WebGL2 + VideoFrame, or without any way to read frames', () => {
  assert.equal(resolveProfile('swift', caps('videoframe', 'rvfc', 'mstp-worker')), null);
  assert.equal(resolveProfile('swift', caps('webgl2', 'rvfc', 'mstp-worker')), null);
  assert.equal(resolveProfile('wren', caps('webgl2', 'videoframe')), null);
});
