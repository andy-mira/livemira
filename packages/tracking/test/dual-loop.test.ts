// SPDX-License-Identifier: Apache-2.0
// D4 state machine with a scripted detector: immediate display after one refined detection, tracking without the
// detector, coasting and loss when the target leaves, and relocalisation when it returns.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Detector, FrameHandle, GrayImage, PoseEstimate, TargetImage } from '@livemira-next/contracts';

import { DualLoopPipeline, TemplateTracker, upscaleFor } from '../src/index.ts';
import { cornerError, frame, H_TRUE, INFO, poseOf, render, TARGET } from './support.ts';

class ScriptedDetector implements Detector {
  readonly info = { id: 'scripted', layer: 'L2', route: 'light', determinism: 'bit-exact', requires: [] } as const;
  calls = 0;
  visible = true;
  probe() {
    return { isAvailable: true };
  }
  async load(targets: readonly TargetImage[]) {
    return { targets: targets.map((t) => ({ id: t.info.id, compileUs: 0, serialized: new Uint8Array(0) })) };
  }
  async detect(f: FrameHandle): Promise<readonly PoseEstimate[]> {
    this.calls++;
    if (!this.visible) return [];
    // A detection a few pixels off, as a real detector delivers.
    const H = Float64Array.from(H_TRUE);
    H[2] = H_TRUE[2]! + 2.5;
    return [
      {
        ...poseOf(H, f.frameId),
        origin: 'detector',
        quality: { support: 40, ratio: 1, residual: 1, residualKind: 'px', coverage: 0.5 },
      },
    ];
  }
}

const blank: GrayImage = { width: 640, height: 360, stride: 640, data: new Uint8Array(640 * 360).fill(100) };

test('dual loop shows the first refined detection, tracks without the detector, coasts, loses and relocalises', async () => {
  const detector = new ScriptedDetector();
  const pipeline = new DualLoopPipeline(
    { id: 'test', detector, tracker: new TemplateTracker({ mode: 'esm' }) },
    { relocalizeEvery: 0, coastUs: 100_000 },
  );
  await pipeline.load([{ info: INFO, image: TARGET }]);
  pipeline.reset('s');
  const image = render(TARGET, H_TRUE);
  const first = await pipeline.process(frame(0, image));
  assert.equal(first.state, 'TRACKING');
  assert.equal(first.display.length, 1);
  assert.ok(cornerError(first.display[0]!.H_imageFromTarget, H_TRUE) < 0.3, 'refined, not the raw detection');
  for (let i = 1; i < 5; i++) assert.equal((await pipeline.process(frame(i, image))).state, 'TRACKING');
  assert.equal(detector.calls, 1, 'no detection while tracking with relocalisation off');
  detector.visible = false;
  const gone1 = await pipeline.process(frame(5, blank));
  assert.equal(gone1.state, 'COASTING');
  assert.equal(gone1.display[0]?.origin, 'predicted');
  await pipeline.process(frame(6, blank));
  await pipeline.process(frame(7, blank));
  const gone4 = await pipeline.process(frame(8, blank));
  assert.ok(gone4.state === 'LOST' || gone4.state === 'SEARCHING');
  assert.equal(gone4.display.length, 0);
  detector.visible = true;
  const back = await pipeline.process(frame(9, image));
  assert.equal(back.state, 'TRACKING');
});

test('after a loss a small target is searched around its last pose, enlarged, then in the whole frame', async () => {
  // A 100 × 75 px target: small enough to be searched in an enlarged region.
  const H_SMALL = Float64Array.from([0.25, 0, 250, 0, 0.25, 140, 0, 0, 1]);
  const calls: { frameId: number; roi: boolean; upscale: number }[] = [];
  let visible = true;
  const detector: Detector = {
    info: { id: 'recording', layer: 'L2', route: 'light', determinism: 'bit-exact', requires: [] },
    probe: () => ({ isAvailable: true }),
    load: async (targets) => ({
      targets: targets.map((t) => ({ id: t.info.id, compileUs: 0, serialized: new Uint8Array(0) })),
    }),
    detect: async (f, options) => {
      calls.push({ frameId: f.frameId, roi: !!options?.roi, upscale: options?.upscale ?? 1 });
      return visible ? [{ ...poseOf(H_SMALL, f.frameId), origin: 'detector' }] : [];
    },
  };
  const pipeline = new DualLoopPipeline(
    { id: 'test', detector, tracker: new TemplateTracker({ mode: 'esm' }) },
    { relocalizeEvery: 0, coastUs: 100_000, lostSearchUs: 1_000_000 },
  );
  await pipeline.load([{ info: INFO, image: TARGET }]);
  pipeline.reset('s');
  const image = render(TARGET, H_SMALL);
  for (let i = 0; i < 3; i++) await pipeline.process(frame(i, image));
  visible = false;
  calls.length = 0;
  // 2 s without the target (33 ms frames): coasting, the search around the last pose, then the whole frame.
  for (let i = 3; i < 63; i++) await pipeline.process(frame(i, blank));
  const near = calls.filter((c) => c.frameId < 3 + 30);
  const later = calls.filter((c) => c.frameId > 3 + 33);
  assert.ok(near.filter((c) => c.roi).length >= 15, 'mostly the region around the last pose');
  assert.ok(
    near.some((c) => !c.roi),
    'every third frame the whole frame',
  );
  assert.ok(
    near.filter((c) => c.roi).every((c) => Math.abs(c.upscale - 2.4) < 0.01),
    'enlarged towards 240 px',
  );
  assert.ok(later.length > 0 && later.every((c) => !c.roi && c.upscale === 1), 'the whole frame after a second');
  assert.equal(upscaleFor(poseOf(H_TRUE, 0)), 1, 'a target near 240 px is searched at its own size');
});
