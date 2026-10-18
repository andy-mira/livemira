/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import { rgbaToGray } from '@livemira/compute';

test('known colors, alpha ignored, padded rows', () => {
  assert.deepEqual(
    [...rgbaToGray(Uint8Array.of(255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 128), 3, 1).data],
    [77, 149, 29],
  );
  assert.deepEqual(
    [...rgbaToGray(Uint8Array.of(255, 255, 255, 0, 99, 0, 0, 0, 255), 1, 2, 5).data],
    [255, 0],
  );
});

test('the result has tight rows and the requested size', () => {
  const gray = rgbaToGray(new Uint8Array(3 * 2 * 4).fill(200), 3, 2);
  assert.equal(gray.widthPx, 3);
  assert.equal(gray.heightPx, 2);
  assert.equal(gray.data.length, 6);
});

test('layout is rejected before allocation', () => {
  for (const [data, width, height, stride] of [
    [new Uint8Array(), 0, 1, undefined],
    [new Uint8Array(4), 2, 1, undefined],
    [new Uint8Array(4), 1, 1, 3],
    [new Uint8Array(), Infinity, 1, undefined],
  ] as const) {
    assert.throws(
      () => rgbaToGray(data, width, height, stride),
      (error) => error instanceof EngineError && error.code === 'FRAME_FAILED',
    );
  }
});
