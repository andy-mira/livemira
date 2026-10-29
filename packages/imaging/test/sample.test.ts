// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inside, sample, sampleField, sampleGradient, scharr } from '../src/index.ts';

test('point-wise Scharr sampling equals sampling the Scharr gradient images', () => {
  const width = 37;
  const height = 29;
  const stride = 41;
  const data = new Uint8Array(stride * height);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data[i] = seed >>> 24;
  }
  const image = { width, height, stride, data };
  const g = scharr(image);
  const out = new Float64Array(3);
  let checked = 0;
  for (let k = 0; k < 500; k++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const x = (seed / 2 ** 32) * width;
    seed = (seed * 1103515245 + 12345) >>> 0;
    const y = (seed / 2 ** 32) * height;
    if (!inside(width, height, x, y, 1.5)) continue;
    sampleGradient(image, x, y, out);
    assert.ok(Math.abs(out[0]! - sample(image, x, y)) < 1e-9);
    assert.ok(Math.abs(out[1]! - sampleField(g.gx, width, x, y)) < 1e-4);
    assert.ok(Math.abs(out[2]! - sampleField(g.gy, width, x, y)) < 1e-4);
    checked++;
  }
  assert.ok(checked > 200);
});
