/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOwnedImage } from '@livemira/camera';
import { EngineError } from '@livemira/contracts';

test('an owned image releases exactly once and refuses access afterwards', () => {
  let closed = 0;
  const pixels = new Uint8Array([1, 2, 3]);
  const image = createOwnedImage('gray8', pixels, () => closed++);
  assert.equal(image.format, 'gray8');
  assert.equal(image.isReleased, false);
  assert.equal(image.data(), pixels);
  image.release();
  image.release();
  assert.equal(closed, 1);
  assert.equal(image.isReleased, true);
  assert.throws(
    () => image.data(),
    (e) => e instanceof EngineError && e.code === 'RESOURCE_FAILED',
  );
});

test('by default a native picture is closed on release', () => {
  let closed = 0;
  const frame = { close: () => closed++ } as unknown as VideoFrame;
  const image = createOwnedImage('video-frame', frame);
  image.release();
  assert.equal(closed, 1);
});
