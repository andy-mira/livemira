/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Point2 } from '@livemira/contracts';
import { project, validateHomography, verifyGeometry, type PointPair } from '@livemira/recognition';

test('normalized geometry recovers perspective with 30 percent adversarial outliers, deterministically', () => {
  const h = [1.04, 0.08, 23, -0.04, 0.96, 17, 0.0002, -0.0001, 1];
  const pairs: PointPair[] = [];
  for (let y = 20; y <= 220; y += 25) {
    for (let x = 20; x <= 300; x += 35) {
      const target: Point2 = [x, y];
      const i = pairs.length;
      let [u, v] = project(h, target);
      u += Math.sin(i) * 0.2;
      v += Math.cos(i) * 0.2;
      if (i % 10 < 3) {
        u = (i * 71) % 320;
        v = (i * 43) % 240;
      }
      pairs.push({ target, image: [u, v], distance: 0 });
    }
  }
  const r = verifyGeometry(pairs, 320, 240);
  assert.ok(r.accepted, r.reason);
  assert.ok(r.inlierRatio > 0.65);
  assert.ok(r.rmsErrorPx < 0.4);
  for (const p of [
    [0, 0],
    [319, 0],
    [319, 239],
    [0, 239],
  ] as const) {
    const got = project(r.H, p);
    const want = project(h, p);
    assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 0.5);
  }
  assert.deepEqual(r, verifyGeometry(pairs, 320, 240));
});

test('collinear and localized support, singularity, reflection and the horizon are rejected', () => {
  const line = Array.from({ length: 30 }, (_, i): PointPair => ({
    target: [i * 5, 100],
    image: [i * 5 + 10, 120],
    distance: 0,
  }));
  assert.equal(verifyGeometry(line, 320, 240).accepted, false);
  const cluster = Array.from({ length: 30 }, (_, i): PointPair => ({
    target: [100 + (i % 6), 100 + Math.floor(i / 6)],
    image: [110 + (i % 6), 120 + Math.floor(i / 6)],
    distance: 0,
  }));
  assert.equal(verifyGeometry(cluster, 320, 240).reason, 'LOW_SPATIAL_COVERAGE');
  for (const h of [
    [0, 0, 0, 0, 0, 0, 0, 0, 1],
    [-1, 0, 319, 0, 1, 0, 0, 0, 1],
    [1, 0, 0, 0, 1, 0, -0.01, 0, 1],
  ]) {
    assert.equal(validateHomography(h, 320, 240), false);
  }
  assert.equal(verifyGeometry(line.slice(0, 5), 320, 240).reason, 'INSUFFICIENT_MATCHES');
  assert.throws(() => verifyGeometry([{ target: [NaN, 0], image: [0, 0], distance: 0 }], 320, 240));
  assert.throws(() => verifyGeometry(line, 320, 240, { iterations: 0 }));
});
