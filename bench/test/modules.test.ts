// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Capability } from '@livemira-next/contracts';

import {
  decodeCombination,
  encodeCombination,
  engineSettings,
  fit,
  PRESETS,
  verdict,
  violations,
} from '../device/modules.ts';

const ALL = new Set<Capability>(['mstp-window', 'mstp-worker', 'videoframe', 'rvfc', 'webgl2', 'wasm-simd']);
const R1 = PRESETS.find((p) => p.id === 'R1')!.combination;

test('the presets are runnable where every capability exists', () => {
  for (const p of PRESETS) assert.deepEqual(violations(p.combination, ALL), [], p.id);
});

test('§3.12 rules block the combinations they forbid', () => {
  // D2 needs a prior (D1, E2 or E3): ESM alone with E1 is refused from both sides.
  assert.ok(verdict('filter', 'E1', R1, ALL).blocked);
  assert.ok(verdict('tracker', 'D2', { ...R1, tracker: 'D3', filter: 'E1' }, ALL).blocked);
  assert.equal(verdict('filter', 'E1', { ...R1, tracker: 'D1+D2' }, ALL).blocked, null);
  // F1 needs frames paired with poses: no canvas readback; F2 needs E2's prediction.
  assert.ok(verdict('capture', 'canvas', R1, ALL).blocked);
  assert.equal(verdict('capture', 'canvas', { ...R1, render: 'F4' }, ALL).blocked, null);
  assert.ok(verdict('render', 'F2', { ...R1, tracker: 'D3', filter: 'E1' }, ALL).blocked);
  // Soft rules only warn.
  assert.ok(verdict('compute', 'js', R1, ALL).warning);
  assert.equal(verdict('compute', 'js', R1, ALL).blocked, null);
});

test('a preset falls back to what the device has', () => {
  const noMstp = new Set<Capability>(['videoframe', 'rvfc', 'webgl2', 'wasm-simd']);
  const r = fit(R1, noMstp);
  assert.equal(r.combination.capture, 'A2');
  assert.equal(r.changes.length, 1);
  assert.deepEqual(violations(r.combination, noMstp), []);
  // Without WebGL2 the frame-locked compositor goes, and the CSS path takes over.
  const noGl = new Set<Capability>(['mstp-worker', 'videoframe', 'rvfc', 'wasm-simd']);
  assert.notEqual(fit(R1, noGl).combination.render, 'F1');
});

test('combinations survive the URL round trip and map to engine options', () => {
  const c = { ...R1, tracker: 'D1+D2' as const, esm: 'lite' as const, slowRate: '3' as const };
  assert.deepEqual(decodeCombination(encodeCombination(c)), c);
  const s = engineSettings(c);
  assert.deepEqual(s.pipeline, {
    tracker: 'klt+esm',
    esmIterations: [5, 4, 3],
    filter: 'E2',
    relocalizeEvery: 10,
    wasm: true,
  });
  assert.equal(s.compositor, 'frame-locked');
  assert.equal(engineSettings({ ...c, render: 'F4' }).cssPrediction, false);
});
