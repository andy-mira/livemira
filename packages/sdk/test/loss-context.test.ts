/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Where a lost target was, in captured camera pixels: each frame's own transform, crop, rotation and mirroring;
// unknown when the geometry is missing or singular; never clipped; never inherited across sessions or targets.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGeometry } from '@livemira/camera';
import type { Corners, FrameGeometry, Mat3 } from '@livemira/contracts';
import { DiagnosticLog } from '@livemira/diagnostics';

import { captureTargetFrame, describeTargetFrame } from '../src/engine/loss-context.ts';
import type { TargetLossContext } from '../src/engine/engine-types.ts';
import { harness, makeFrame, makeResult, portraitGeometry } from './core-harness.ts';

const container = {} as HTMLElement;
const close = (actual: number | null | undefined, expected: number): void =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

const apply = (m: Mat3, [x, y]: readonly [number, number]): [number, number] => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

test('a portrait extent converts processing corners to camera pixels, whatever the CSS letterboxing', () => {
  const frame = makeFrame('s', 1, {
    geometry: { ...portraitGeometry(), viewportWidthCss: 392, viewportHeightCss: 407 },
  });
  const extent = describeTargetFrame(captureTargetFrame(frame, makeResult(frame, 'bird-01')))!;
  assert.deepEqual([extent.inputWidthPx, extent.inputHeightPx], [720, 1280]);
  assert.deepEqual(
    [extent.geometry!.standardWidthPx, extent.geometry!.standardHeightPx],
    [180, 320],
  );
  assert.deepEqual(extent.boundingBoxInputPx, { x: 120, y: 320, width: 360, height: 200 });
  assert.deepEqual(extent.cornersInputPx, [
    [120, 320],
    [480, 320],
    [480, 520],
    [120, 520],
  ]);
  assert.equal(extent.widthFraction, 0.5);
  assert.equal(extent.edgeWidthInputPx, 360);
  assert.equal(extent.edgeHeightInputPx, 200);
  close(extent.areaFraction, (360 * 200) / (720 * 1280));
  assert.equal(extent.isFullyInsideInput, true);
});

test('the camera-space extent handles crop, every rotation and mirroring through the inverse transform', () => {
  const input: Corners = [
    [120, 90],
    [360, 90],
    [360, 210],
    [120, 210],
  ];
  for (const rotationDeg of [0, 90, 180, 270] as const) {
    for (const isMirrored of [false, true]) {
      const geometry = createGeometry({
        widthPx: 1000,
        heightPx: 800,
        crop: { x: 100, y: 50, width: 600, height: 500 },
        rotationDeg,
        isMirrored,
        longEdge: 320,
      });
      const frame = makeFrame('s', 1, { widthPx: 1000, heightPx: 800, geometry });
      const result = {
        ...makeResult(frame, 'bird-01'),
        cornersPx: input.map((p) => apply(geometry.H_standardFromInput, p)) as unknown as Corners,
      };
      const extent = describeTargetFrame(captureTargetFrame(frame, result))!;
      extent.cornersInputPx!.forEach((p, i) => p.forEach((v, k) => close(v, input[i]![k]!)));
      close(extent.boundingBoxInputPx?.width, 240);
      close(extent.boundingBoxInputPx?.height, 120);
      close(extent.widthFraction, 0.24);
      close(extent.edgeWidthInputPx, 240);
      close(extent.edgeHeightInputPx, 120);
    }
  }
});

test('a missing or singular geometry stays unknown and targets outside the picture are not clipped', () => {
  const missingFrame = makeFrame('s', 1, { geometry: null });
  const missing = describeTargetFrame(
    captureTargetFrame(missingFrame, makeResult(missingFrame, 'bird-01')),
  )!;
  assert.equal(missing.inputWidthPx, 720);
  assert.equal(missing.cornersInputPx, null);
  assert.equal(missing.widthFraction, null);
  assert.equal(missing.unavailableReason, 'frame-geometry-unavailable');
  const singular: FrameGeometry = {
    ...portraitGeometry(),
    H_standardFromInput: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  };
  const singularFrame = makeFrame('s', 1, { geometry: singular });
  assert.equal(
    describeTargetFrame(captureTargetFrame(singularFrame, makeResult(singularFrame, 'bird-01')))!
      .unavailableReason,
    'invalid-frame-geometry',
  );
  const frame = makeFrame('s', 1);
  const outside = {
    ...makeResult(frame, 'bird-01'),
    cornersPx: [
      [-20, 80],
      [200, 80],
      [200, 130],
      [-20, 130],
    ] as unknown as Corners,
  };
  const extent = describeTargetFrame(captureTargetFrame(frame, outside))!;
  close(extent.boundingBoxInputPx?.width, 880);
  close(extent.widthFraction, 880 / 720);
  assert.equal(extent.isFullyInsideInput, false);
  assert.equal(
    describeTargetFrame(captureTargetFrame(frame, makeResult(frame, 'bird-01', 'LOST')))!
      .unavailableReason,
    'no-target-corners',
  );
});

function lossSetup() {
  const log = new DiagnosticLog({ level: 'key' });
  const h = harness({ telemetry: log });
  const states = new Map<number, 'TRACKING' | 'LIMITED' | 'LOST' | 'SEARCHING'>();
  h.respond = (frame) => makeResult(frame, 'bird-01', states.get(frame.frameId) ?? 'TRACKING');
  const losses = (): TargetLossContext[] =>
    log
      .export()
      .events.filter((e) => e.type === 'targetLost')
      .map((e) => (e as unknown as { lossContext: TargetLossContext }).lossContext);
  const push = async (
    frameId: number,
    state: 'TRACKING' | 'LIMITED' | 'LOST' | 'SEARCHING' = 'TRACKING',
    size: [number, number] = [720, 1280],
    geometry?: FrameGeometry,
  ) => {
    states.set(frameId, state);
    await h.push(
      makeFrame(h.core.sessionId!, frameId, {
        widthPx: size[0],
        heightPx: size[1],
        geometry: geometry ?? portraitGeometry(size[0], size[1]),
      }),
    );
  };
  return { h, log, losses, push };
}

test('a loss keeps the adjacent predicted frame and the earlier reliable one, each with its own geometry', async () => {
  const { h, log, losses, push } = lossSetup();
  let event: { lossContext: TargetLossContext } | undefined;
  h.core.on('targetLost', (e) => (event = e as never));
  await h.core.start(container);
  const reliableGeometry = portraitGeometry();
  await push(10, 'TRACKING', [720, 1280], reliableGeometry);
  // The cache holds its own copy: changing the frame's geometry afterwards changes nothing.
  (reliableGeometry.H_standardFromInput as unknown as number[])[0] = 999;
  await push(11, 'LIMITED', [1440, 2560]);
  await push(12, 'LOST', [1440, 2560]);
  const loss = losses()[0]!;
  assert.equal(loss.isPrecedingInputFrameRecorded, true);
  assert.equal(loss.triggerFrame!.frameId, 12);
  assert.equal(loss.triggerFrame!.cornersInputPx, null);
  assert.equal(loss.precedingFrame!.frameId, 11);
  assert.equal(loss.precedingFrame!.isMeasured, false);
  assert.equal(loss.precedingFrame!.predictionAgeUs, 33000);
  assert.equal(loss.lastReliableFrame!.frameId, 10);
  assert.equal(loss.lastReliableFrame!.isMeasured, true);
  assert.deepEqual(
    [
      loss.lastReliableFrame!.inputWidthPx,
      loss.precedingFrame!.inputWidthPx,
      loss.triggerFrame!.inputWidthPx,
    ],
    [720, 1440, 1440],
  );
  assert.equal(loss.lastReliableFrame!.widthFraction, 0.5);
  assert.equal(loss.precedingFrame!.widthFraction, 0.5);
  assert.equal(loss.lastReliableFrame!.boundingBoxInputPx!.width, 360);
  assert.equal(loss.precedingFrame!.boundingBoxInputPx!.width, 720);
  assert.equal(loss.lastReliableFrame!.pictureKey, `${h.core.sessionId}:10`);
  assert.equal(loss.lastReliableFrame!.geometry!.H_standardFromInput[0], 0.25);
  assert.equal(JSON.stringify(log.export()).includes('isReleased'), false, 'no image handles');
  (event!.lossContext.lastReliableFrame!.boundingBoxInputPx as { width: number }).width = 999;
  assert.equal(losses()[0]!.lastReliableFrame!.boundingBoxInputPx!.width, 360);
  await h.core.dispose();
});

test('a timer loss has no trigger frame; skipped input frames are reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let nowUs = 0;
  const log = new DiagnosticLog({ level: 'key' });
  const h = harness({ telemetry: log, nowUs: () => nowUs });
  const states = new Map<number, 'TRACKING' | 'LOST'>();
  h.respond = (frame) => makeResult(frame, 'bird-01', states.get(frame.frameId) ?? 'TRACKING');
  const losses = (): TargetLossContext[] =>
    log
      .export()
      .events.filter((e) => e.type === 'targetLost')
      .map((e) => (e as unknown as { lossContext: TargetLossContext }).lossContext);
  const push = async (frameId: number, state: 'TRACKING' | 'LOST' = 'TRACKING') => {
    nowUs += 1000;
    states.set(frameId, state);
    await h.push(makeFrame(h.core.sessionId!, frameId));
  };
  await h.core.start(container);
  await push(1);
  nowUs = 101000;
  t.mock.timers.tick(100);
  const timed = losses()[0]!;
  assert.equal(timed.triggerFrame, null);
  assert.equal(timed.isPrecedingInputFrameRecorded, null);
  assert.equal(timed.precedingFrame!.frameId, 1);
  await push(10);
  await push(12, 'LOST');
  const skipped = losses()[1]!;
  assert.equal(skipped.isPrecedingInputFrameRecorded, false);
  assert.equal(skipped.precedingFrame!.frameId, 10);
  await h.core.dispose();
});

test('new sessions and changed targets never inherit the earlier reliable measurement', async () => {
  const { h, log, losses, push } = lossSetup();
  await h.core.start(container);
  await push(1);
  await h.core.stop();
  await h.core.start(container);
  await push(1, 'SEARCHING');
  await push(2);
  await push(3, 'LOST');
  const second = losses()[1]!;
  assert.equal(second.lastReliableFrame!.sessionId, h.core.sessionId);
  assert.equal(second.lastReliableFrame!.frameId, 2);
  await push(4);
  h.respond = (frame) => makeResult(frame, 'bird-03');
  await push(5);
  const changedEvent = log.export().events.filter((e) => e.type === 'targetLost')[2] as unknown as {
    reason: string;
    targetId: string;
  };
  assert.equal(changedEvent.reason, 'target-changed');
  assert.equal(changedEvent.targetId, 'bird-01');
  const changed = losses()[2]!;
  assert.equal(changed.lastReliableFrame!.targetId, 'bird-01');
  assert.equal(changed.triggerFrame!.targetId, 'bird-03');
  await h.core.dispose();
});

test('an unavailable frame geometry neither breaks recognition nor guesses a camera-space size', async () => {
  const { h, losses } = lossSetup();
  const states = new Map<number, 'TRACKING' | 'LOST'>([[2, 'LOST']]);
  h.respond = (frame) => makeResult(frame, 'bird-01', states.get(frame.frameId) ?? 'TRACKING');
  await h.core.start(container);
  await h.push(makeFrame(h.core.sessionId!, 1, { geometry: null }));
  await h.push(makeFrame(h.core.sessionId!, 2, { geometry: null }));
  const reliable = losses()[0]!.lastReliableFrame!;
  assert.equal(reliable.inputWidthPx, 720);
  assert.equal(reliable.unavailableReason, 'frame-geometry-unavailable');
  assert.equal(reliable.widthFraction, null);
  await h.core.dispose();
});
