/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EngineError,
  IDENTITY_3,
  normalizeHomography,
  validateTargetBundle,
} from '@livemira/contracts';

const bundle = (): Record<string, unknown> => ({
  schemaVersion: 1,
  compilerVersion: 'test',
  algorithmVersion: 'test',
  targetId: 'test',
  imageHash: 'a'.repeat(64),
  widthPx: 4,
  heightPx: 4,
  physicalWidthMeters: null,
  orientation: 'top-left',
  pyramid: [],
  features: { points: [], descriptorType: 'test', descriptorLength: 32, descriptors: [] },
  preprocessing: {},
  diagnostics: [],
});

const isInvalidTarget = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'INVALID_TARGET';

test('homography normalization and singular or non-finite rejection', () => {
  assert.deepEqual(normalizeHomography(IDENTITY_3.map((x) => 2 * x)), IDENTITY_3);
  for (const bad of [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 0, 0, 0, NaN],
    [1, 0, 0, 0, 1, 0, 0, 0],
  ]) {
    assert.throws(() => normalizeHomography(bad), isInvalidTarget);
  }
});

test('a near-zero last element normalizes by the largest magnitude', () => {
  assert.deepEqual(
    normalizeHomography([1, 0, 0, 0, 0, 2, 0, 4, 0]),
    [0.25, 0, 0, 0, 0, 0.5, 0, 1, 0],
  );
});

test('target structural validation rejects versions, missing metric values, lengths and bounds', () => {
  validateTargetBundle(bundle());
  for (const change of [
    { schemaVersion: 2 },
    { widthPx: Infinity },
    { physicalWidthMeters: 0 },
    { imageHash: 'bad' },
    { pyramid: [{ width: 2, height: 2, scale: 1, pixels: [1] }] },
    {
      features: { points: [[0, 0]], descriptorLength: 32, descriptorType: 'test', descriptors: [] },
    },
  ]) {
    assert.throws(() => validateTargetBundle({ ...bundle(), ...change }), isInvalidTarget);
  }
  assert.throws(() => validateTargetBundle(null), isInvalidTarget);
});

test('engine errors carry a code, recoverability and an optional cause', () => {
  const cause = new Error('inner');
  const error = new EngineError('FRAME_FAILED', 'Frame failed', { isRecoverable: true, cause });
  assert.equal(error.name, 'EngineError');
  assert.equal(error.code, 'FRAME_FAILED');
  assert.equal(error.isRecoverable, true);
  assert.equal(error.message, 'Frame failed');
  assert.equal(error.cause, cause);
  assert.equal('cause' in new EngineError('DISPOSED', 'Disposed', { isRecoverable: false }), false);
});
