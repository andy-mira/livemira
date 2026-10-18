/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createOwnedImage } from '@livemira/camera';
import { EngineError, type TrackingResult } from '@livemira/contracts';
import { compileGrayTarget } from '@livemira/target-compiler';

import { createEmbeddedWorkerFactory } from '../src/worker/embedded-worker.ts';
import { prepareTransfer } from '../src/worker/frame-transfer.ts';
import {
  WORKER_GENERIC_REASON,
  type VisionCapability,
  type VisionResponse,
} from '../src/worker/protocol.ts';
import { VisionClient, type VisionClientConfig } from '../src/worker/vision-client.ts';
import { createVisionRuntime } from '../src/worker/vision-runtime.ts';
import { grayFrame, InProcessWorker, texture } from './support.ts';

const hasCode = (code: string, pattern?: RegExp) => (error: unknown) =>
  error instanceof EngineError && error.code === code && (!pattern || pattern.test(error.message));

function client(
  endpoints: InProcessWorker[],
  config: Partial<VisionClientConfig> = {},
): VisionClient {
  return new VisionClient({
    prepareFrame: (frame, signal) => prepareTransfer(frame, signal, null),
    workerFactory: () => {
      const endpoint = new InProcessWorker();
      endpoints.push(endpoint);
      return endpoint;
    },
    ...config,
  });
}

test('the Worker receives a copy, the original stays borrowed, and recognition and tracking really run', async () => {
  const endpoints: InProcessWorker[] = [];
  const results: TrackingResult[] = [];
  const pipeline = client(endpoints, { onResult: (r) => results.push(r) });
  const image = texture();
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 'worker' })]);
  await pipeline.reset('s');
  let result: TrackingResult | undefined;
  for (let i = 1; i <= 3; i++) {
    const frame = grayFrame('s', i, image);
    result = await pipeline.process(frame, new AbortController().signal);
    assert.equal(frame.image.isReleased, false);
    assert.equal(
      (frame.image.data() as Uint8Array).byteLength,
      image.data.byteLength,
      'the original is not detached',
    );
  }
  assert.equal(result!.state, 'TRACKING');
  assert.equal(result!.targetId, 'worker');
  assert.equal(results.length, 3);
  assert.notEqual(results[2], result, 'observers receive a copy');
  await pipeline.dispose();
  assert.equal(endpoints[0]!.isTerminated, true);
});

test('aborting terminates the active Worker; the next reset restores targets and ignores obsolete messages', async () => {
  const endpoints: InProcessWorker[] = [];
  const pipeline = client(endpoints);
  const image = texture();
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 'recovery' })]);
  await pipeline.reset('old');
  endpoints[0]!.hangsOnFrames = true;
  const controller = new AbortController();
  const frame = grayFrame('old', 1, image);
  const pending = pipeline.process(frame, controller.signal);
  await new Promise((r) => setImmediate(r));
  controller.abort();
  await assert.rejects(pending, hasCode('ABORTED'));
  assert.equal(frame.image.isReleased, false);
  assert.equal(endpoints[0]!.isTerminated, true);
  await pipeline.reset('new');
  assert.equal(endpoints.length, 2);
  assert.ok(endpoints[1]!.posted.some((p) => p.type === 'load-targets'));
  assert.deepEqual(endpoints[1]!.posted.at(-1), {
    ...endpoints[1]!.posted.at(-1),
    type: 'reset',
    sessionId: 'new',
  });
  await assert.rejects(
    pipeline.process(grayFrame('old', 2, image), new AbortController().signal),
    hasCode('FRAME_FAILED'),
  );
  await pipeline.dispose();
});

test('one request at a time; a hung request times out, terminates the Worker and reports a failure', async () => {
  const endpoints: InProcessWorker[] = [];
  const failures: EngineError[] = [];
  const pipeline = client(endpoints, { requestTimeoutMs: 100, onFailure: (e) => failures.push(e) });
  const image = texture();
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 't' })]);
  await pipeline.reset('s');
  endpoints[0]!.hangsOnFrames = true;
  const pending = pipeline.process(grayFrame('s', 1, image), new AbortController().signal);
  await assert.rejects(
    pipeline.process(grayFrame('s', 2, image), new AbortController().signal),
    hasCode('RESOURCE_FAILED', /Only one/),
  );
  await assert.rejects(pending, hasCode('RESOURCE_FAILED', /timed out/));
  assert.equal(endpoints[0]!.isTerminated, true);
  assert.equal(failures.length, 1);
  await pipeline.reset('new');
  await pipeline.dispose();
  await assert.rejects(pipeline.reset('again'), hasCode('DISPOSED'));
});

test('size limits surface a safe reason; other failures stay generic', async () => {
  const endpoints: InProcessWorker[] = [];
  const pipeline = client(endpoints);
  await pipeline.loadTargets([await compileGrayTarget(texture(), { targetId: 't' })]);
  await pipeline.reset('s');
  const wide = { widthPx: 4097, heightPx: 32, data: new Uint8Array(4097 * 32) };
  await assert.rejects(
    pipeline.process(grayFrame('s', 1, wide), new AbortController().signal),
    hasCode('UNSUPPORTED', /Standard image exceeds processing limit/),
  );
  await pipeline.reset('s2');
  const small = { widthPx: 16, heightPx: 16, data: new Uint8Array(256) };
  await assert.rejects(
    pipeline.process(grayFrame('s2', 1, small), new AbortController().signal),
    (e: unknown) => e instanceof EngineError && e.message === WORKER_GENERIC_REASON,
  );
  await pipeline.dispose();
});

test('the capability names the matcher that really runs and is announced on initialization', async () => {
  for (const [exactMatching, matching] of [
    ['wasm', 'wasm-simd'],
    ['js', 'cpu'],
  ] as const) {
    const capabilities: VisionCapability[] = [];
    const pipeline = client([], {
      options: { exactMatching },
      onCapability: (c) => capabilities.push(c),
    });
    await pipeline.reset('s');
    assert.equal(capabilities.at(-1)!.matching, matching);
    assert.equal(capabilities.at(-1)!.execution, 'worker');
    if (exactMatching === 'wasm')
      assert.equal(capabilities.at(-1)!.matchingSelection, 'simd:selected');
    await pipeline.dispose();
  }
  assert.throws(
    () => client([], { options: { exactMatching: 'gpu' as 'js' } }),
    hasCode('INVALID_CONFIG'),
  );
  assert.throws(() => client([], { requestTimeoutMs: 50 }), hasCode('INVALID_CONFIG'));
});

test('observing recognition delivers capability, timing, trace and result in that order with preparation stages', async () => {
  const order: string[] = [];
  const pipeline = client([], {
    options: { observeRecognition: true, collectMatchedPoints: true },
    onCapability: () => order.push('capability'),
    onTiming: (_frame, _generation, timing) =>
      order.push(timing.prepareStages ? 'timing+stages' : 'timing'),
    onRecognitionTrace: (trace) => order.push(`trace:${trace.frameId}`),
    onResult: (result) => order.push(`result:${result.frameId}`),
  });
  const image = texture();
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 't' })]);
  await pipeline.reset('s');
  order.length = 0;
  let last: TrackingResult | undefined;
  for (let i = 1; i <= 3; i++)
    last = await pipeline.process(grayFrame('s', i, image), new AbortController().signal);
  assert.deepEqual(order.slice(0, 3), ['timing+stages', 'trace:1', 'result:1']);
  assert.equal(last!.state, 'TRACKING');
  assert.ok(
    last!.matchedPoints && last!.matchedPoints.pointsPx.length === last!.quality.inlierCount,
  );
  await pipeline.dispose();
});

test('matched points are dropped unless requested', async () => {
  const pipeline = client([]);
  const image = texture();
  await pipeline.loadTargets([await compileGrayTarget(image, { targetId: 't' })]);
  await pipeline.reset('s');
  for (let i = 1; i <= 3; i++) {
    const result = await pipeline.process(grayFrame('s', i, image), new AbortController().signal);
    assert.equal('matchedPoints' in result, false);
  }
  await pipeline.dispose();
});

test('the runtime refuses overlapping requests, foreign protocols, stale generations and unknown requests', async () => {
  const responses: VisionResponse[] = [];
  const handle = createVisionRuntime((message) => responses.push(message));
  const envelope = (requestId: number, generation = 1) => ({
    protocol: 1 as const,
    requestId,
    generation,
  });
  await handle({
    ...envelope(1),
    type: 'init',
    options: {
      collectMatchedPoints: false,
      observeRecognition: false,
      exactMatching: 'js',
      scaleRetry: true,
    },
  });
  assert.equal(responses.at(-1)!.type, 'ready');
  await handle({ ...envelope(2), protocol: 2 as 1, type: 'reset', sessionId: 's' });
  assert.equal(responses.at(-1)!.type, 'error');
  await handle({ ...envelope(3, 9), type: 'reset', sessionId: 's' });
  assert.deepEqual(responses.at(-1), {
    ...envelope(3, 9),
    type: 'error',
    code: 'FRAME_FAILED',
    isRecoverable: true,
    reason: WORKER_GENERIC_REASON,
  });
  await handle({ ...envelope(4), type: 'unknown' } as unknown as Parameters<typeof handle>[0]);
  assert.equal((responses.at(-1) as { code: string }).code, 'FRAME_FAILED');
  const first = handle({ ...envelope(5), type: 'reset', sessionId: 's' });
  await handle({ ...envelope(6), type: 'reset', sessionId: 's' });
  assert.equal(responses.at(-1)!.type, 'error', 'busy');
  await first;
  await handle({
    ...envelope(7),
    type: 'init',
    options: {
      collectMatchedPoints: false,
      observeRecognition: false,
      exactMatching: 'js',
      scaleRetry: true,
    },
  });
  assert.equal((responses.at(-1) as { code: string }).code, 'INVALID_CONFIG', 'initialized once');
  await handle({ ...envelope(8), type: 'dispose' });
  assert.equal(responses.at(-1)!.type, 'ack');
});

test('a CPU lease copies the rows and never detaches the original; release is idempotent', async () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const frame = grayFrame(
    's',
    1,
    { widthPx: 2, heightPx: 2, data: source },
    { image: createOwnedImage('gray8', source, () => {}) },
  );
  const lease = await prepareTransfer(frame, new AbortController().signal, null);
  const image = lease.frame.image as { buffer: ArrayBuffer };
  assert.deepEqual([...new Uint8Array(image.buffer)], [1, 2, 3, 4]);
  assert.equal(lease.copiedBytes, 4);
  assert.equal(lease.frame.geometry, null);
  const received = structuredClone(lease.frame, { transfer: lease.transfer });
  lease.markTransferred();
  lease.release();
  lease.release();
  assert.equal(image.buffer.byteLength, 0);
  assert.deepEqual(
    [...new Uint8Array((received.image as { buffer: ArrayBuffer }).buffer)],
    [1, 2, 3, 4],
  );
  assert.equal(source.byteLength, 4);
  assert.equal(frame.image.isReleased, false);
});

test('a standard image is copied at its own size and goes to the Worker without a transform', async () => {
  // A 4 × 2 camera picture whose standard image is 2 × 1 (half scale).
  const standard = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
  const base = grayFrame('s', 1, { widthPx: 4, heightPx: 2, data: new Uint8Array(8) });
  const frame = {
    ...base,
    geometry: { ...base.geometry, standardWidthPx: 2, standardHeightPx: 1 },
    image: createOwnedImage('standard-rgba8', standard, () => {}),
  };
  const lease = await prepareTransfer(frame, new AbortController().signal);
  const image = lease.frame.image as {
    kind: string;
    width: number;
    height: number;
    buffer: ArrayBuffer;
  };
  assert.deepEqual([image.kind, image.width, image.height], ['rgba8', 2, 1]);
  assert.deepEqual([...new Uint8Array(image.buffer)], [...standard]);
  assert.equal(lease.copiedBytes, 8);
  assert.equal(lease.frame.geometry, null, 'the Worker only converts it to gray');
  lease.release();
  assert.equal(frame.image.isReleased, false);
});

test('a native lease closes only its own clone, and only while it still owns it', async () => {
  let closed = 0;
  const picture = {
    displayWidth: 2,
    displayHeight: 2,
    clone: () => ({ close: () => closed++ }),
  } as unknown as VideoFrame;
  const frame = grayFrame(
    's',
    1,
    { widthPx: 2, heightPx: 2, data: new Uint8Array(4) },
    { image: createOwnedImage('video-frame', picture, () => {}) },
  );
  const notSent = await prepareTransfer(frame, new AbortController().signal);
  notSent.release();
  notSent.release();
  assert.equal(closed, 1);
  const sent = await prepareTransfer(frame, new AbortController().signal);
  sent.markTransferred();
  sent.release();
  assert.equal(closed, 1, 'a transferred clone belongs to the receiver');
  await assert.rejects(
    prepareTransfer(frame, new AbortController().signal, null),
    hasCode('FRAME_FAILED', /geometry/),
  );
  const wrongSize = {
    displayWidth: 3,
    displayHeight: 2,
    clone: () => ({ close() {} }),
  } as unknown as VideoFrame;
  await assert.rejects(
    prepareTransfer(
      { ...frame, image: createOwnedImage('video-frame', wrongSize, () => {}) },
      new AbortController().signal,
    ),
    hasCode('FRAME_FAILED', /dimensions/),
  );
});

test('a cancelled bitmap preparation closes its late copy and leaves the original alone', async () => {
  const previous = globalThis.createImageBitmap;
  let resolve: (bitmap: ImageBitmap) => void = () => {};
  let closed = 0;
  globalThis.createImageBitmap = (() =>
    new Promise<ImageBitmap>((r) => (resolve = r))) as typeof createImageBitmap;
  try {
    const controller = new AbortController();
    const bitmap = { width: 2, height: 2 } as unknown as ImageBitmap;
    const frame = grayFrame(
      's',
      1,
      { widthPx: 2, heightPx: 2, data: new Uint8Array(4) },
      { image: createOwnedImage('image-bitmap', bitmap, () => {}) },
    );
    const pending = prepareTransfer(frame, controller.signal);
    controller.abort();
    resolve({ close: () => closed++ } as unknown as ImageBitmap);
    await assert.rejects(pending, hasCode('ABORTED'));
    assert.equal(closed, 1);
    assert.equal(frame.image.isReleased, false);
  } finally {
    globalThis.createImageBitmap = previous;
  }
});

test('the lease snapshots the geometry', async () => {
  const frame = grayFrame('s', 1, texture());
  const lease = await prepareTransfer(frame, new AbortController().signal);
  (frame.geometry.crop as { x: number }).x = 100;
  assert.equal(lease.frame.geometry!.crop.x, 0);
  lease.release();
});

test('an embedded Worker lives on a Blob URL that is revoked exactly once, also when construction fails', () => {
  const revoked: string[] = [];
  let terminated = 0;
  let failConstruction = false;
  const env = {
    Blob: class {},
    URL: {
      createObjectURL: () => `blob:${revoked.length}`,
      revokeObjectURL: (url: string) => void revoked.push(url),
    },
    Worker: class {
      constructor() {
        if (failConstruction) throw new Error('blocked by policy');
      }
      postMessage() {}
      terminate() {
        terminated++;
      }
      addEventListener() {}
      removeEventListener() {}
    },
  };
  const factory = createEmbeddedWorkerFactory('self.onmessage = () => {}', env as never);
  const worker = factory();
  worker.terminate();
  worker.terminate();
  assert.equal(terminated, 2);
  assert.equal(revoked.length, 1);
  failConstruction = true;
  assert.throws(() => factory(), /blocked/);
  assert.equal(revoked.length, 2);
  assert.throws(() => createEmbeddedWorkerFactory(''), hasCode('INVALID_CONFIG'));
});
