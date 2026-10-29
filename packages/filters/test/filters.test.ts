// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cornersOf, type PoseEstimate } from '@livemira-next/contracts';

import { homographyFromCorners, KalmanPoseFilter, OneEuroPoseFilter } from '../src/index.ts';

const INFO = { id: 't', width: 400, height: 300, physicalWidthMeters: null };

function pose(dx: number, timeUs: number, noise = 0): PoseEstimate {
  const H = Float64Array.from([0.5, 0, 100 + dx + noise, 0, 0.5, 50 - noise, 0, 0, 1]);
  return {
    targetId: 't',
    frameId: Math.round(timeUs / 33_333),
    timeUs,
    H_imageFromTarget: H,
    corners: cornersOf(H, 400, 300),
    covariance: null,
    quality: { support: 1, ratio: 1, residual: 0, residualKind: 'gray', coverage: 1 },
    origin: 'tracker',
  };
}

test('the corner homography reproduces the corners it was built from', () => {
  const p = pose(7, 0);
  const H = homographyFromCorners(INFO, p.corners.flat())!;
  cornersOf(H, 400, 300).forEach((c, i) =>
    assert.ok(Math.hypot(c[0] - p.corners[i]![0], c[1] - p.corners[i]![1]) < 1e-6),
  );
});

for (const [name, make] of [
  ['One Euro', () => new OneEuroPoseFilter([INFO])],
  ['Kalman', () => new KalmanPoseFilter([INFO])],
] as const) {
  test(`${name}: noise is smoothed at rest and constant motion is predicted ahead`, () => {
    const f = make();
    let spread = 0;
    for (let i = 0; i < 60; i++) {
      const out = f.update(pose(0, i * 33_333, i % 2 ? 0.3 : -0.3));
      if (i > 30) spread = Math.max(spread, Math.abs(out.corners[0][0] - 100));
    }
    assert.ok(spread < 0.3, `${name} spread ${spread}`);
    f.reset();
    for (let i = 0; i < 30; i++) f.update(pose(i * 6, i * 33_333)); // 180 px/s
    const ahead = f.predict('t', 29 * 33_333 + 50_000)!;
    const expected = 100 + 29 * 6 + 9;
    assert.ok(Math.abs(ahead.corners[0][0] - expected) < 2, `${name} predicted ${ahead.corners[0][0]} vs ${expected}`);
    const snap = f.snapshot('t')!;
    f.update(pose(500, 30 * 33_333));
    assert.ok(Math.abs(snap(29 * 33_333 + 50_000)!.corners[0][0] - ahead.corners[0][0]) < 1e-9, 'snapshot is frozen');
  });
}
