// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FocalEstimator, multiply3, poseFromHomography } from '../src/index.ts';

const F = 502.3;
const CX = 320;
const CY = 180;
const S = 0.2 / 640; // metres per target pixel

function rotation(pitch: number, yaw: number, roll: number): number[] {
  const [p, y, r] = [pitch, yaw, roll].map((d) => (d * Math.PI) / 180) as [number, number, number];
  const rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  const ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
  const rz = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  return [...multiply3(rz, multiply3(ry, rx))];
}

/** H (image px from target px) of a plane at rotation R and translation t (plane origin at the target top-left). */
function homography(R: number[], t: number[]): Float64Array {
  const K = [F, 0, CX, 0, F, CY, 0, 0, 1];
  const Rt = [R[0]!, R[1]!, t[0]!, R[3]!, R[4]!, t[1]!, R[6]!, R[7]!, t[2]!];
  const h = multiply3(multiply3(K, Rt), [S, 0, 0, 0, S, 0, 0, 0, 1]);
  return h.map((v) => v / h[8]!);
}

test('the focal length converges from a handful of tilted views and is null for frontal ones', () => {
  const frontal = new FocalEstimator(CX, CY);
  for (let i = 0; i < 10; i++) frontal.add(homography(rotation(0, 0, 3 * i), [-0.1, -0.07, 0.4]));
  assert.equal(frontal.estimate().focalPx, null);
  const tilted = new FocalEstimator(CX, CY);
  for (let i = 0; i < 12; i++)
    tilted.add(homography(rotation(20 + 3 * i, -15 + 2 * i, 5 * i), [-0.1 + 0.01 * i, -0.07, 0.35 + 0.01 * i]));
  const e = tilted.estimate();
  assert.ok(e.focalPx !== null && Math.abs(e.focalPx - F) / F < 0.01, `focal ${e.focalPx}`);
});

test('pose from homography recovers rotation and metric translation', () => {
  const R = rotation(35, -20, 50);
  const t = [-0.08, -0.05, 0.42];
  const pose = poseFromHomography(homography(R, t), F, CX, CY, S)!;
  pose.R.forEach((v, i) => assert.ok(Math.abs(v - R[i]!) < 1e-6, `R[${i}] ${v} vs ${R[i]}`));
  pose.t.forEach((v, i) => assert.ok(Math.abs(v - t[i]!) < 1e-6, `t[${i}] ${v} vs ${t[i]}`));
});
