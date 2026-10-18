/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Matched points cross the Worker boundary only when requested, only for the frame and target they describe, and the
// page side never trusts the Worker about them.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type TrackingResult } from '@livemira/contracts';
import { compileGrayTarget } from '@livemira/target-compiler';

import { prepareTransfer } from '../src/worker/frame-transfer.ts';
import type { VisionResponse } from '../src/worker/protocol.ts';
import { VisionClient } from '../src/worker/vision-client.ts';
import { createVisionRuntime } from '../src/worker/vision-runtime.ts';
import { grayFrame, InProcessWorker, texture } from './support.ts';

type Tamper = (response: VisionResponse) => VisionResponse;

async function track(
  collectMatchedPoints: boolean,
  tamper: Tamper | null = null,
): Promise<{ result: TrackingResult; worker: InProcessWorker }> {
  const image = texture();
  const worker = new InProcessWorker();
  worker.tamper = tamper;
  const pipeline = new VisionClient({
    options: { collectMatchedPoints },
    prepareFrame: (frame, signal) => prepareTransfer(frame, signal, null),
    workerFactory: () => worker,
  });
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 'worker' })]);
  await pipeline.reset('s');
  let result: TrackingResult | undefined;
  for (let i = 1; i <= 3; i++)
    result = await pipeline.process(grayFrame('s', i, image), new AbortController().signal);
  await pipeline.dispose();
  return { result: result!, worker };
}

/** Rewrites the matched points of every result response. */
const onResult =
  (rewrite: (result: TrackingResult) => void): Tamper =>
  (response) => {
    if (response.type === 'result') rewrite(response.result as TrackingResult);
    return response;
  };

test('by default no points cross the boundary; requested, the current inliers arrive for the same frame', async () => {
  const off = await track(false);
  assert.equal(off.result.state, 'TRACKING');
  assert.equal('matchedPoints' in off.result, false);
  const init = (w: InProcessWorker) =>
    w.posted.find((p) => p.type === 'init') as { options: { collectMatchedPoints: boolean } };
  assert.equal(init(off.worker).options.collectMatchedPoints, false);
  const on = await track(true);
  assert.equal(init(on.worker).options.collectMatchedPoints, true);
  const points = on.result.matchedPoints!;
  assert.ok(points);
  assert.equal(points.frameId, on.result.frameId);
  assert.equal(points.sessionId, 's');
  assert.equal(points.targetId, 'worker');
  assert.equal(points.pointsPx.length, on.result.quality.inlierCount);
});

test('the page side strips points that were not requested, describe another frame or are not finite', async () => {
  const forged = onResult((result) => {
    (result as { matchedPoints?: unknown }).matchedPoints = {
      sessionId: 's',
      frameId: result.frameId,
      targetId: 'worker',
      pointsPx: [[1, 1]],
    };
  });
  assert.equal('matchedPoints' in (await track(false, forged)).result, false);
  const wrongFrame = onResult((result) => {
    (result as { matchedPoints?: unknown }).matchedPoints = {
      sessionId: 's',
      frameId: result.frameId + 1,
      targetId: 'worker',
      pointsPx: [[1, 1]],
    };
  });
  assert.equal('matchedPoints' in (await track(true, wrongFrame)).result, false);
  const nonFinite = onResult((result) => {
    const points = result.matchedPoints?.pointsPx as [number, number][] | undefined;
    if (points) points[0] = [Infinity, 1];
  });
  assert.equal('matchedPoints' in (await track(true, nonFinite)).result, false);
});

test('an invalid point request is rejected before a Worker exists and by the Worker runtime', async () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(
      () =>
        new VisionClient({
          options: { collectMatchedPoints: bad as never },
          workerFactory: () => {
            throw new Error('no Worker may be created');
          },
        }),
      (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
    );
  }
  const out: VisionResponse[] = [];
  const run = createVisionRuntime((message) => out.push(message));
  await run({
    protocol: 1,
    requestId: 1,
    generation: 1,
    type: 'init',
    options: {
      collectMatchedPoints: 'yes',
      observeRecognition: false,
      exactMatching: 'js',
      scaleRetry: true,
    } as never,
  });
  assert.equal(out[0]!.type, 'error');
  assert.equal((out[0] as { code?: string }).code, 'INVALID_CONFIG');
});
