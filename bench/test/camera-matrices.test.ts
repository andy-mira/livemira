// SPDX-License-Identifier: Apache-2.0
// 3D content placed with the F3 matrices must land where the 2D homography puts the target in the viewport.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { multiply3, poseFromHomography } from '@livemira-next/geometry';

import { viewportFromStandard } from '@livemira-next/web';

import { projectionMatrix, viewMatrix } from '../prototype/camera-matrices.ts';

test('projection · view reproduces the homography in viewport pixels', () => {
  const [f, cx, cy, s] = [502.3, 320, 180, 0.2 / 640];
  const p = (30 * Math.PI) / 180;
  const R = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  const t = [-0.1, -0.06, 0.45];
  const H = multiply3(
    multiply3([f, 0, cx, 0, f, cy, 0, 0, 1], [R[0]!, R[1]!, t[0]!, R[3]!, R[4]!, t[1]!, R[6]!, R[7]!, t[2]!]),
    [s, 0, 0, 0, s, 0, 0, 0, 1],
  );
  const pose = poseFromHomography(H, f, cx, cy, s)!;
  const [vw, vh] = [390, 844];
  const fit = viewportFromStandard(640, 360, vw, vh, 'cover');
  const P = projectionMatrix(f, cx, cy, fit, vw, vh);
  const V = viewMatrix(pose.R, pose.t);
  for (const [u, v] of [
    [0, 0],
    [640, 0],
    [640, 480],
    [123, 321],
  ] as const) {
    const world = [u * s, v * s, 0, 1];
    const mul = (m: Float32Array, x: number[]): number[] =>
      [0, 1, 2, 3].map((r) => [0, 1, 2, 3].reduce((acc, c) => acc + m[c * 4 + r]! * x[c]!, 0));
    const clip = mul(P, mul(V, world));
    const vx = ((clip[0]! / clip[3]! + 1) / 2) * vw;
    const vy = ((1 - clip[1]! / clip[3]!) / 2) * vh;
    const w = H[6]! * u + H[7]! * v + H[8]!;
    const ex = fit.scale * ((H[0]! * u + H[1]! * v + H[2]!) / w) + fit.offsetX;
    const ey = fit.scale * ((H[3]! * u + H[4]! * v + H[5]!) / w) + fit.offsetY;
    assert.ok(Math.hypot(vx - ex, vy - ey) < 1e-2, `(${u},${v}) → ${vx},${vy} vs ${ex},${ey}`);
  }
});
