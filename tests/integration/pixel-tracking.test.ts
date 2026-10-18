/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Real pixel recognition driving the tracker, and the half-octave scale retry on natural photographs (the CC0 demo
// samples). These combine packages that the package tests exercise separately.

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import type { TargetBundle } from '@livemira/contracts';
import { Recognizer, project, type GrayImage } from '@livemira/recognition';
import { compileGrayTarget, parseTarget, serializeTarget } from '@livemira/target-compiler';
import { Tracker, type GrayFrame } from '@livemira/tracking';

import { texture, warp } from '../../packages/recognition/test/images.ts';
import { readPngGray } from './support/png.ts';

const sample = (name: string): GrayImage =>
  readPngGray(new URL(`../../apps/demo/assets/${name}.png`, import.meta.url));

async function trackerFor(
  target: TargetBundle,
  slowMs: readonly number[] = [],
): Promise<{ tracker: Tracker; recognizer: Recognizer }> {
  const recognizer = new Recognizer();
  await recognizer.loadTargets([target]);
  const tracker = new Tracker({
    recognize: async (frame, _targets, signal) => {
      const wait = slowMs[frame.frameId];
      if (wait !== undefined) await delay(wait, undefined, { signal });
      return (await recognizer.recognize(frame.image, frame, { signal })).observations;
    },
  });
  await tracker.loadTargets([target]);
  return { tracker, recognizer };
}

const frame = (
  sessionId: string,
  frameId: number,
  timeUs: number,
  image: GrayImage,
): GrayFrame => ({
  sessionId,
  frameId,
  pictureKey: `${sessionId}-${frameId}`,
  observationTimeUs: timeUs,
  image,
});

test('real pixel recognition drives confirmation, prediction, loss and reacquisition with accurate corners', async () => {
  const image = texture();
  const target = await compileGrayTarget(image, { targetId: 'cd-target' });
  const { tracker, recognizer } = await trackerFor(target);
  await tracker.reset('cd');
  const step = async (frameId: number, timeUs: number, isBlank = false) => {
    const dx = 10 + frameId;
    const dy = 8;
    const pixels = isBlank
      ? { ...image, data: new Uint8Array(image.data.length) }
      : warp(image, [1, 0, dx, 0, 1, dy, 0, 0, 1]);
    const result = await tracker.process(
      frame('cd', frameId, timeUs, pixels),
      new AbortController().signal,
    );
    if (result.quality.isMeasured) {
      const corners = [
        [0, 0],
        [image.widthPx, 0],
        [image.widthPx, image.heightPx],
        [0, image.heightPx],
      ];
      corners.forEach(([x, y], i) => {
        const [cx, cy] = result.cornersPx![i]!;
        assert.ok(
          Math.hypot(cx - x! - dx, cy - y! - dy) < 3,
          'corner error against the independent warp',
        );
      });
    }
    return result.state;
  };
  assert.equal(await step(1, 0), 'ACQUIRING');
  assert.equal(await step(2, 30000), 'ACQUIRING');
  assert.equal(await step(3, 60000), 'TRACKING');
  assert.equal(await step(4, 90000, true), 'LIMITED');
  assert.equal(await step(5, 160000, true), 'LOST');
  assert.equal(await step(6, 190000), 'ACQUIRING');
  await step(7, 220000);
  assert.equal(await step(8, 250000), 'TRACKING');
  await tracker.dispose();
  recognizer.dispose();
});

test('slow real recognition still acquires, and a confirmed pose expires from its own observation time', async () => {
  const image = texture();
  const target = await compileGrayTarget(image, { targetId: 'slow-real' });
  const { tracker, recognizer } = await trackerFor(target, [160, 240, 320]);
  await tracker.reset('slow');
  const start = performance.now();
  const states: string[] = [];
  let last = null;
  for (let id = 0; id < 3; id++) {
    const timeUs = (performance.now() - start) * 1000;
    last = await tracker.process(
      frame('slow', id, timeUs, warp(image, [1, 0, 8 + id, 0, 1, 8, 0, 0, 1])),
      new AbortController().signal,
    );
    states.push(last.state);
  }
  assert.deepEqual(states, ['ACQUIRING', 'ACQUIRING', 'TRACKING']);
  assert.equal(last!.prediction.expiresAtUs, last!.observationTimeUs + 100000);
  assert.ok(
    (performance.now() - start) * 1000 >= last!.prediction.expiresAtUs!,
    'recognition success does not refresh pose freshness',
  );
  await tracker.dispose();
  recognizer.dispose();
});

test('distinct real frames at low throughput (0, 250, 800 ms) are confirmed', async () => {
  const image = texture();
  const target = await compileGrayTarget(image, { targetId: 'slow-rate' });
  const { tracker, recognizer } = await trackerFor(target);
  await tracker.reset('rate');
  const states: string[] = [];
  for (const [id, timeUs] of [0, 250000, 800000].entries()) {
    const image2 = warp(image, [1, 0, 8 + id, 0, 1, 8, 0, 0, 1]);
    states.push(
      (await tracker.process(frame('rate', id, timeUs, image2), new AbortController().signal))
        .state,
    );
  }
  assert.deepEqual(states, ['ACQUIRING', 'ACQUIRING', 'TRACKING']);
  await tracker.dispose();
  recognizer.dispose();
});

test('the half-octave retry rescues a natural photograph between pyramid octaves without recompiling', async () => {
  const image = sample('forest-03');
  const target = await compileGrayTarget(image, { targetId: 'forest-03' });
  const serialized = await serializeTarget(target);
  const without = new Recognizer({ scaleRetry: false });
  const withRetry = new Recognizer();
  await without.loadTargets([await parseTarget(serialized)]);
  await withRetry.loadTargets([await parseTarget(serialized)]);
  try {
    // The picture at 42 % of a 640 × 480 frame's width, centred: between two pyramid octaves of the target.
    const s = (0.42 * 640) / image.widthPx;
    const h = [s, 0, 320 - (s * image.widthPx) / 2, 0, s, 240 - (s * image.heightPx) / 2, 0, 0, 1];
    const scene = warp(image, h, 640, 480);
    const identity = { sessionId: 'scale', frameId: 42 };
    assert.equal((await without.recognize(scene, identity)).observations.length, 0);
    const rescued = await withRetry.recognize(scene, identity);
    assert.equal(rescued.facts.scalePasses, 2);
    const observation = rescued.observations[0];
    assert.equal(observation?.targetId, 'forest-03');
    for (const p of [
      [0, 0],
      [image.widthPx, 0],
      [image.widthPx, image.heightPx],
      [0, image.heightPx],
    ] as const) {
      const [ax, ay] = project(observation!.H_imageFromTarget, p);
      const [bx, by] = project(h, p);
      assert.ok(Math.hypot(ax - bx, ay - by) < 3, 'corner error against the scene transform');
    }
    for (let i = 0; i < observation!.inliers.length; i++) {
      if (!observation!.inliers[i]) continue;
      const [qx, qy] = project(observation!.H_imageFromTarget, observation!.targetPoints[i]!);
      const [ix, iy] = observation!.imagePoints[i]!;
      assert.ok(
        Math.hypot(qx - ix, qy - iy) <= 3,
        'every inlier lies within the reprojection threshold',
      );
    }
    assert.equal(await serializeTarget(target), serialized, 'the stored target is unchanged');
  } finally {
    without.dispose();
    withRetry.dispose();
  }
});

test('other photographs and a flat picture are still rejected after the retry', async () => {
  const target = await compileGrayTarget(sample('bird-01'), { targetId: 'bird-01' });
  const recognizer = new Recognizer();
  await recognizer.loadTargets([target]);
  try {
    const direct = await recognizer.recognize(sample('bird-01'), { sessionId: 's', frameId: 1 });
    assert.equal(direct.facts.scalePasses, 1);
    assert.equal(direct.observations[0]?.targetId, 'bird-01');
    const other = sample('mountain-01');
    for (const [i, image] of [
      other,
      sample('ship-01'),
      { ...other, data: new Uint8Array(other.data.length).fill(100) },
    ].entries()) {
      const result = await recognizer.recognize(image, { sessionId: 's', frameId: 2 + i });
      assert.equal(result.observations.length, 0);
      assert.equal(result.facts.scalePasses, 2);
    }
  } finally {
    recognizer.dispose();
  }
});
