/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Frames inside the vision Worker runtime: each runtime owns its canvases, errors leave the Worker only as fixed safe
// reasons, disposal releases everything, real camera sizes pass through, and observing recognition changes no result.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGeometry, createOwnedImage } from '@livemira/camera';
import {
  rgbaToGray,
  standardize,
  StandardImageWorkspace,
  STANDARD_TOO_LARGE,
} from '@livemira/compute';
import type { Frame, TrackingResult } from '@livemira/contracts';
import { compileGrayTarget } from '@livemira/target-compiler';

import { prepareTransfer } from '../src/worker/frame-transfer.ts';
import {
  WORKER_GENERIC_REASON,
  type VisionResponse,
  type WorkerFrame,
} from '../src/worker/protocol.ts';
import { createVisionRuntime } from '../src/worker/vision-runtime.ts';
import { withCanvas } from './fake-canvas.ts';
import { texture } from './support.ts';
import { HALF, handGeometry, IDENT, raw, rgbaPattern } from './worker-frames.ts';

type Body = Record<string, unknown>;

function runtime() {
  const messages: VisionResponse[] = [];
  const handle = createVisionRuntime((message) => messages.push(message));
  let id = 0;
  const send = async (body: Body): Promise<VisionResponse> => {
    await handle({ protocol: 1, requestId: ++id, generation: 1, ...body } as never);
    return messages.at(-1)!;
  };
  return { messages, send };
}

const init = (observeRecognition = false): Body => ({
  type: 'init',
  options: {
    collectMatchedPoints: false,
    observeRecognition,
    exactMatching: 'js',
    scaleRetry: true,
  },
});

const frame = (
  frameId: number,
  image: WorkerFrame['image'],
  geometry: WorkerFrame['geometry'],
): Body => ({
  type: 'frame',
  frame: {
    metadata: {
      sessionId: 's',
      frameId,
      pictureKey: `image-${frameId}`,
      observationTimeUs: frameId * 33333,
    },
    image,
    geometry,
  },
});

/** RGBA of a gray picture. */
function rgbaOf(gray: { widthPx: number; heightPx: number; data: Uint8Array }): Uint8Array {
  const rgba = new Uint8Array(gray.widthPx * gray.heightPx * 4);
  for (let i = 0; i < gray.data.length; i++) {
    rgba.fill(gray.data[i]!, i * 4, i * 4 + 3);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

test('two runtimes never share canvases and each releases only its own on dispose', () =>
  withCanvas({}, async (log) => {
    const runtimes = [runtime(), runtime()];
    for (const r of runtimes) await r.send(init());
    for (const r of runtimes)
      await r.send(frame(1, raw(rgbaPattern(8, 6), 8, 6), handGeometry(4, 3, HALF)));
    assert.equal(log.canvases.length, 4);
    assert.equal((await runtimes[0]!.send({ type: 'dispose' })).type, 'ack');
    assert.deepEqual(
      log.canvases.map((c) => c.width === 0 && c.height === 0),
      [true, true, false, false],
    );
    await runtimes[1]!.send({ type: 'dispose' });
    assert.ok(log.canvases.every((c) => c.width === 0 && c.height === 0));
  }));

test('size limits leave the Worker as a fixed safe reason; other failures stay generic and never leak text', () =>
  withCanvas({}, async (log) => {
    const { messages, send } = runtime();
    await send(init());
    const oversize = (await send(
      frame(1, raw(new Uint8Array(4097), 4097, 1, { kind: 'gray8' }), null),
    )) as {
      code: string;
      reason: string;
    };
    assert.equal(oversize.code, 'UNSUPPORTED');
    assert.equal(oversize.reason, STANDARD_TOO_LARGE);
    const standard = (await send(
      frame(2, raw(new Uint8Array(64), 4, 4), handGeometry(4097, 1, IDENT)),
    )) as {
      reason: string;
    };
    assert.equal(standard.reason, oversize.reason);
    log.flags.noContext = true;
    const noCanvas = (await send(
      frame(3, raw(new Uint8Array(64), 4, 4), handGeometry(4, 4, IDENT)),
    )) as {
      code: string;
      reason: string;
    };
    assert.equal(noCanvas.code, 'UNSUPPORTED');
    assert.equal(noCanvas.reason, WORKER_GENERIC_REASON);
    // Hostile exception text from a lower layer is not forwarded.
    (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas = class {
      constructor() {
        throw new Error('secret https://example.invalid/?token=1');
      }
    };
    const hostile = (await send(
      frame(4, raw(new Uint8Array(64), 4, 4), handGeometry(4, 4, IDENT)),
    )) as {
      reason: string;
    };
    assert.equal(hostile.reason, WORKER_GENERIC_REASON);
    assert.ok(!JSON.stringify(messages).includes('secret'));
  }));

test('dispose releases the canvases; the runtime can be initialized again and builds fresh ones', () =>
  withCanvas({}, async (log) => {
    const { send } = runtime();
    await send(init());
    await send(frame(1, raw(rgbaPattern(4, 4), 4, 4), handGeometry(4, 4, IDENT)));
    assert.equal(log.canvases.length, 2);
    assert.equal((await send({ type: 'dispose' })).type, 'ack');
    assert.ok(log.canvases.every((c) => c.width === 0 && c.height === 0));
    assert.equal((await send(init())).type, 'ready');
    await send(frame(2, raw(rgbaPattern(4, 4), 4, 4), handGeometry(4, 4, IDENT)));
    assert.equal(log.canvases.length, 4);
    assert.equal((await send({ type: 'dispose' })).type, 'ack');
  }));

test('real 720p and 1080p portrait and landscape frames pass through the transfer and the Worker conversion', () =>
  withCanvas({}, async (log) => {
    const workspace = new StandardImageWorkspace();
    for (const [w, h] of [
      [720, 1280],
      [1280, 720],
      [1080, 1920],
      [1920, 1080],
    ] as const) {
      const rgba = rgbaPattern(w, h, w);
      const source = rgba.slice();
      const geometry = createGeometry({ widthPx: w, heightPx: h, longEdge: 'native' });
      assert.deepEqual([geometry.standardWidthPx, geometry.standardHeightPx], [w, h]);
      const original: Frame = {
        sessionId: 's',
        frameId: 1,
        pictureKey: 'image-1',
        timing: {
          sourceTimestampUs: 0,
          timestampSource: 'replay',
          arrivalTimeUs: 0,
          observationTimeUs: 0,
        },
        widthPx: w,
        heightPx: h,
        geometry,
        image: createOwnedImage('rgba8', rgba, () => {
          throw new Error('A borrower released the original picture');
        }),
      } as unknown as Frame;
      const lease = await prepareTransfer(original, new AbortController().signal);
      const cloned = structuredClone(lease.frame, { transfer: lease.transfer });
      lease.markTransferred();
      assert.equal((lease.transfer[0] as ArrayBuffer).byteLength, 0, 'the copy was transferred');
      assert.deepEqual(rgba, source, 'the borrowed original is untouched');
      const out = standardize(cloned, workspace);
      assert.deepEqual([out.widthPx, out.heightPx], [w, h]);
      assert.deepEqual(out.data, rgbaToGray(source, w, h).data);
    }
    assert.equal(log.canvases.length, 2, 'one input and one output canvas serve every size');
    // Landscape camera pixels turned into portrait standard orientation.
    const w = 1920;
    const h = 1080;
    const rgba = rgbaPattern(w, h);
    const expected = rgbaToGray(rgba, w, h).data;
    const out = standardize(
      {
        image: raw(rgba, w, h),
        geometry: createGeometry({ widthPx: w, heightPx: h, rotationDeg: 90, longEdge: 'native' }),
      },
      workspace,
    );
    assert.deepEqual([out.widthPx, out.heightPx], [h, w]);
    for (const [x, y] of [
      [0, 0],
      [1919, 0],
      [0, 1079],
      [1919, 1079],
      [960, 540],
      [17, 903],
    ] as const)
      assert.equal(out.data[x * h + (h - 1 - y)], expected[y * w + x]);
  }));

test('end to end in the runtime: results for real frames, 1080p accepted, oversize reported, all released', () =>
  withCanvas({}, async (log) => {
    const { send } = runtime();
    const image = texture();
    await send(init());
    await send({
      type: 'load-targets',
      targets: [await compileGrayTarget(image, { targetId: 'worker-frame' })],
    });
    await send({ type: 'reset', sessionId: 's' });
    const rgba = rgbaOf(image);
    let last: VisionResponse | undefined;
    for (let i = 1; i <= 3; i++) {
      last = await send(
        frame(
          i,
          raw(rgba, image.widthPx, image.heightPx),
          handGeometry(image.widthPx, image.heightPx, IDENT),
        ),
      );
      assert.equal(last.type, 'result');
    }
    const result = (last as { result: TrackingResult }).result;
    assert.equal(result.state, 'TRACKING');
    assert.equal(result.targetId, 'worker-frame');
    assert.equal(log.canvases.length, 2);
    // Tracking pixels equal the no-canvas path for the same bytes.
    const direct = standardize(
      { image: raw(rgba, image.widthPx, image.heightPx), geometry: null },
      new StandardImageWorkspace(),
    );
    assert.deepEqual([...direct.data], [...image.data]);
    const gray = new Uint8Array(1920 * 1080).map((_, i) => (i * 7 + (i >> 8)) & 255);
    assert.equal(
      (
        await send(
          frame(4, raw(gray, 1920, 1080, { kind: 'gray8' }), handGeometry(1920, 1080, IDENT)),
        )
      ).type,
      'result',
      '1080p lands in the Worker',
    );
    const oversize = (await send(
      frame(5, raw(gray.subarray(0, 4097), 4097, 1, { kind: 'gray8' }), null),
    )) as {
      type: string;
      code: string;
    };
    assert.deepEqual([oversize.type, oversize.code], ['error', 'UNSUPPORTED']);
    assert.equal((await send({ type: 'dispose' })).type, 'ack');
    assert.ok(log.canvases.every((c) => c.width === 0 && c.height === 0));
  }));

test('observed and unobserved runtimes return identical results; only observation adds stages and a trace', () =>
  withCanvas({}, async () => {
    const image = texture();
    const target = await compileGrayTarget(image, { targetId: 'forest-03' });
    const rgba = rgbaOf(image);
    const routes: TrackingResult[][] = [];
    for (const observeRecognition of [false, true]) {
      const { send } = runtime();
      await send(init(observeRecognition));
      await send({ type: 'load-targets', targets: [target] });
      await send({ type: 'reset', sessionId: 's' });
      const route: TrackingResult[] = [];
      for (let i = 0; i < 7; i++) {
        const pixels = i === 3 ? new Uint8Array(rgba.length).fill(20) : rgba;
        const message = (await send(
          frame(
            i,
            raw(pixels, image.widthPx, image.heightPx),
            handGeometry(image.widthPx, image.heightPx, IDENT),
          ),
        )) as unknown as {
          type: string;
          result: TrackingResult;
          timing: Record<string, unknown>;
          trace?: unknown;
        };
        assert.equal(message.type, 'result');
        assert.equal('prepareStages' in message.timing, observeRecognition);
        assert.equal('trace' in message, observeRecognition);
        route.push(message.result);
      }
      await send({ type: 'dispose' });
      routes.push(route);
    }
    assert.deepEqual(routes[0], routes[1]);
    assert.ok(routes[0]!.some((r) => r.state === 'TRACKING' && r.quality.isMeasured));
  }));
