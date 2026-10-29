// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cornerCovariance, estimateHomography, fitHomography, isPlausible, solve4 } from '../src/index.ts';

const TRUTH = Float64Array.from([0.62, 0.18, 120, -0.11, 0.55, 60, 0.0004, -0.0002, 1]);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

function project(h: ArrayLike<number>, x: number, y: number): [number, number] {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

function correspondences(
  count: number,
  outlierRatio: number,
  noisePx: number,
  seed: number,
): { target: Float64Array; image: Float64Array } {
  const r = rng(seed);
  const target = new Float64Array(2 * count);
  const image = new Float64Array(2 * count);
  for (let i = 0; i < count; i++) {
    const x = r() * 640;
    const y = r() * 480;
    target[2 * i] = x;
    target[2 * i + 1] = y;
    const [u, v] = project(TRUTH, x, y);
    // Outliers are spread over the list (not only at the end), like real matches.
    const outlier = r() < outlierRatio;
    const g = (): number => (r() + r() + r() - 1.5) * 2 * noisePx;
    image[2 * i] = outlier ? r() * 640 : u + g();
    image[2 * i + 1] = outlier ? r() * 360 : v + g();
  }
  return { target, image };
}

function cornerError(h: ArrayLike<number>): number {
  let e = 0;
  for (const [x, y] of [
    [0, 0],
    [640, 0],
    [640, 480],
    [0, 480],
  ] as const) {
    const a = project(h, x, y);
    const b = project(TRUTH, x, y);
    e += Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
  return e / 4;
}

test('the minimal and least-squares solvers recover an exact homography', () => {
  const { target, image } = correspondences(40, 0, 0, 1);
  const h4 = solve4(target, image, [0, 1, 2, 3])!;
  assert.ok(cornerError(h4) < 1e-6);
  const all = Int32Array.from({ length: 40 }, (_, i) => i);
  assert.ok(cornerError(fitHomography(target, image, all, 40)!) < 1e-6);
  assert.ok(isPlausible(TRUTH, 640, 480));
});

test('robust estimation is accurate with 50% outliers and sub-pixel noise', () => {
  const { target, image } = correspondences(200, 0.5, 0.5, 2);
  const result = estimateHomography(target, image, 200, 640, 480);
  assert.ok(result.accepted);
  if (!result.accepted) return;
  assert.ok(cornerError(result.H) < 0.35, `corner error ${cornerError(result.H)}`);
  assert.ok(result.inliers > 80 && result.inliers < 120);
  assert.ok(result.iterations < 200, `iterations ${result.iterations}`);
});

test('robust estimation survives 80% outliers when the good matches come first', () => {
  const { target, image } = correspondences(250, 0.8, 0.5, 3);
  // PROSAC order: true matches sorted ahead, as a descriptor-distance ordering roughly does.
  const order = Array.from({ length: 250 }, (_, i) => i).sort((a, b) => {
    const ea = Math.hypot(
      image[2 * a]! - project(TRUTH, target[2 * a]!, target[2 * a + 1]!)[0],
      image[2 * a + 1]! - project(TRUTH, target[2 * a]!, target[2 * a + 1]!)[1],
    );
    const eb = Math.hypot(
      image[2 * b]! - project(TRUTH, target[2 * b]!, target[2 * b + 1]!)[0],
      image[2 * b + 1]! - project(TRUTH, target[2 * b]!, target[2 * b + 1]!)[1],
    );
    return (ea > 5 ? 1 : 0) - (eb > 5 ? 1 : 0) || a - b;
  });
  const t = Float64Array.from(order.flatMap((i) => [target[2 * i]!, target[2 * i + 1]!]));
  const im = Float64Array.from(order.flatMap((i) => [image[2 * i]!, image[2 * i + 1]!]));
  const result = estimateHomography(t, im, 250, 640, 480, { minInlierRatio: 0.1 });
  assert.ok(result.accepted);
  if (result.accepted) assert.ok(cornerError(result.H) < 0.5);
});

test('results are identical for identical input and seed', () => {
  const { target, image } = correspondences(150, 0.4, 0.7, 4);
  const a = estimateHomography(target, image, 150, 640, 480, { seed: 9 });
  const b = estimateHomography(target, image, 150, 640, 480, { seed: 9 });
  assert.ok(a.accepted && b.accepted);
  if (a.accepted && b.accepted) assert.deepEqual([...a.H], [...b.H]);
});

test('pure outliers and degenerate input are rejected', () => {
  const r = rng(5);
  const target = Float64Array.from({ length: 200 }, () => r() * 600);
  const image = Float64Array.from({ length: 200 }, () => r() * 600);
  assert.equal(estimateHomography(target, image, 100, 640, 480).accepted, false);
  const line = Float64Array.from({ length: 80 }, (_, i) => (i % 2 ? 100 : i * 5));
  assert.equal(estimateHomography(line, line, 40, 640, 480).accepted, false);
});

test('corner covariance grows with noise', () => {
  const quiet = correspondences(150, 0, 0.2, 6);
  const noisy = correspondences(150, 0, 2, 6);
  const a = estimateHomography(quiet.target, quiet.image, 150, 640, 480);
  const b = estimateHomography(noisy.target, noisy.image, 150, 640, 480, { thresholdPx: 8 });
  assert.ok(a.accepted && b.accepted && a.paramCovariance && b.paramCovariance);
  if (!a.accepted || !b.accepted || !a.paramCovariance || !b.paramCovariance) return;
  const ca = cornerCovariance(a.H, 640, 480, a.paramCovariance);
  const cb = cornerCovariance(b.H, 640, 480, b.paramCovariance);
  const trace = (c: Float64Array): number => [0, 1, 2, 3, 4, 5, 6, 7].reduce((s, i) => s + c[i * 9]!, 0);
  assert.ok(trace(cb) > 10 * trace(ca));
});
