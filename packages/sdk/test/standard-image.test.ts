/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The standard image of a captured picture inside the Worker: cached canvases, a cleared output each frame, strides
// and orientations, explicit limits before any allocation, and optional stage timing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGeometry } from '@livemira/camera';
import {
  rgbaToGray,
  standardize,
  StandardImageWorkspace,
  type PrepareStages,
  type TransferredImage,
} from '@livemira/compute';
import { EngineError, type FrameGeometry, type Mat3 } from '@livemira/contracts';

import { withCanvas, type CanvasLog } from './fake-canvas.ts';
import { HALF, handGeometry, IDENT, raw, rgbaPattern } from './worker-frames.ts';

const run = (
  image: TransferredImage,
  geometry: FrameGeometry | null,
  workspace: StandardImageWorkspace,
  stages?: PrepareStages,
) => standardize({ image, geometry }, workspace, rgbaToGray, stages);

const failsWith = (code: string, log: CanvasLog) => (e: unknown) => {
  assert.ok(e instanceof EngineError);
  assert.equal(e.code, code);
  assert.equal(log.canvases.length, 0, 'canvas allocated before validation');
  assert.equal(log.imageData, 0);
  return true;
};

test('canvases and contexts are cached, resized only when dimensions change, and drawn into a cleared output', () =>
  withCanvas({}, (log) => {
    const workspace = new StandardImageWorkspace();
    for (let i = 0; i < 3; i++)
      run(raw(rgbaPattern(8, 6, i), 8, 6), handGeometry(4, 3, HALF), workspace);
    assert.equal(log.canvases.length, 2);
    assert.equal(log.contexts, 2);
    assert.equal(log.resizes, 0);
    assert.equal(log.clears, 3);
    assert.deepEqual(log.contextOptions, [undefined, { willReadFrequently: true }]);
    run(raw(rgbaPattern(10, 6), 10, 6), handGeometry(4, 3, HALF), workspace);
    assert.equal(log.canvases.length, 2);
    assert.equal(log.resizes, 1, 'only the input width changed');
    run(raw(rgbaPattern(10, 6), 10, 6), handGeometry(5, 3, HALF), workspace);
    assert.equal(log.resizes, 2, 'only the output width changed');
    run(raw(rgbaPattern(10, 6), 10, 6), handGeometry(5, 3, HALF), workspace);
    assert.equal(log.resizes, 2);
    assert.equal(log.contexts, 2);
    const [input, output] = log.canvases;
    workspace.dispose();
    for (const canvas of [input!, output!]) assert.deepEqual([canvas.width, canvas.height], [0, 0]);
    run(raw(rgbaPattern(8, 6), 8, 6), handGeometry(4, 3, HALF), workspace);
    assert.equal(
      log.canvases.length,
      4,
      'dispose drops the cache; a later frame builds fresh canvases',
    );
  }));

test('the output is cleared each frame: uncovered pixels never keep the previous frame', () =>
  withCanvas({}, () => {
    const workspace = new StandardImageWorkspace();
    const white = new Uint8Array(8 * 6 * 4).fill(255);
    assert.ok(
      run(raw(white, 8, 6), handGeometry(8, 6, IDENT), workspace).data.every((v) => v === 255),
    );
    const second = run(raw(white, 8, 6), handGeometry(8, 6, HALF), workspace).data;
    const fresh = run(
      raw(white, 8, 6),
      handGeometry(8, 6, HALF),
      new StandardImageWorkspace(),
    ).data;
    assert.deepEqual([...second], [...fresh]);
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 8; x++)
        assert.equal(second[y * 8 + x], x < 4 && y < 3 ? 255 : 0, `pixel ${x},${y}`);
    // The transform is reset after every draw, so a following identity draw is unaffected.
    assert.ok(
      run(raw(white, 8, 6), handGeometry(8, 6, IDENT), workspace).data.every((v) => v === 255),
    );
  }));

test('gray, stride and orientation results match an independent expectation and leave the source alone', () =>
  withCanvas({}, () => {
    const workspace = new StandardImageWorkspace();
    const w = 6;
    const h = 4;
    const rgba = rgbaPattern(w, h);
    const expected = rgbaToGray(rgba, w, h).data;
    // Strided RGBA with poisoned padding.
    const stride = w * 4 + 12;
    const padded = new Uint8Array(stride * h).fill(0xaa);
    for (let y = 0; y < h; y++) padded.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * stride);
    for (const geometry of [null, handGeometry(w, h, IDENT)]) {
      const image = raw(padded, w, h, { strideBytes: stride }) as { buffer: ArrayBuffer };
      const before = new Uint8Array(image.buffer).slice();
      const out = run(image as TransferredImage, geometry, workspace);
      assert.deepEqual([out.widthPx, out.heightPx], [w, h]);
      assert.deepEqual([...out.data], [...expected]);
      assert.deepEqual(new Uint8Array(image.buffer), before);
    }
    // Gray8 with and without stride, with and without geometry.
    const gray = new Uint8Array(w * h).map((_, i) => (i * 37 + 5) & 255);
    const grayStride = w + 3;
    const grayPadded = new Uint8Array(grayStride * h).fill(0xbb);
    for (let y = 0; y < h; y++) grayPadded.set(gray.subarray(y * w, (y + 1) * w), y * grayStride);
    for (const [pixels, strideBytes] of [
      [gray, w],
      [grayPadded, grayStride],
    ] as const) {
      for (const geometry of [null, handGeometry(w, h, IDENT)]) {
        const out = run(raw(pixels, w, h, { kind: 'gray8', strideBytes }), geometry, workspace);
        assert.deepEqual([...out.data], [...gray]);
      }
    }
    // Rotation by 90° with the camera's own geometry: source (x, y) lands on column h-1-y, row x.
    const turned = run(
      raw(rgba, w, h),
      createGeometry({ widthPx: w, heightPx: h, rotationDeg: 90, longEdge: 'native' }),
      workspace,
    );
    assert.deepEqual([turned.widthPx, turned.heightPx], [h, w]);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        assert.equal(turned.data[x * h + (h - 1 - y)], expected[y * w + x]);
    const flipped = run(
      raw(rgba, w, h),
      createGeometry({ widthPx: w, heightPx: h, isMirrored: true, longEdge: 'native' }),
      workspace,
    );
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        assert.equal(flipped.data[y * w + (w - 1 - x)], expected[y * w + x]);
    // Different sizes in sequence never leak earlier pixels.
    const small = run(raw(rgbaPattern(3, 2, 9), 3, 2), handGeometry(3, 2, IDENT), workspace).data;
    assert.deepEqual([...small], [...rgbaToGray(rgbaPattern(3, 2, 9), 3, 2).data]);
  }));

test('layout, geometry and size limits fail explicitly before any canvas or ImageData allocation', () =>
  withCanvas({}, (log) => {
    const workspace = new StandardImageWorkspace();
    const good = raw(rgbaPattern(4, 4), 4, 4) as Extract<TransferredImage, { buffer: ArrayBuffer }>;
    const geometry = handGeometry(4, 4, IDENT);
    const bad = (image: TransferredImage, g: FrameGeometry | null, code: string) =>
      assert.throws(() => run(image, g, workspace), failsWith(code, log));
    // Malformed raw layouts.
    bad({ ...good, strideBytes: 15 }, geometry, 'FRAME_FAILED');
    bad({ ...good, buffer: new ArrayBuffer(60) }, geometry, 'FRAME_FAILED');
    bad({ ...good, width: 0 }, geometry, 'FRAME_FAILED');
    bad({ ...good, height: 2.5 }, geometry, 'FRAME_FAILED');
    bad({ ...good, width: NaN }, geometry, 'FRAME_FAILED');
    bad({ ...good, kind: 'bgra8' as never }, geometry, 'FRAME_FAILED');
    bad({ ...good, strideBytes: Number.MAX_SAFE_INTEGER }, geometry, 'FRAME_FAILED');
    // Malformed geometry.
    for (const H of [
      [1, 0, 0, 0, 1, 0, 0, 0],
      [1, 0, 0, 0, 1, 0, 0, 0, 2],
      [1, 0, 0, 0, 1, 0, 0.5, 0, 1],
      [1, 0, 0, 0, 1, 0, 0, 0.1, 1],
      [NaN, 0, 0, 0, 1, 0, 0, 0, 1],
      [1, 0, Infinity, 0, 1, 0, 0, 0, 1],
      [1, 0, 0, 0, '1', 0, 0, 0, 1],
      null,
    ])
      bad(good, handGeometry(4, 4, H as Mat3 | null), 'FRAME_FAILED');
    for (const [w, h] of [
      [0, 4],
      [4, 0],
      [3.5, 4],
      [NaN, 4],
      [-4, 4],
    ] as const)
      bad(good, handGeometry(w, h, IDENT), 'FRAME_FAILED');
    // Standard (processing) cap: 4096 per edge and 4,194,304 pixels; frames are never resized silently.
    for (const [w, h] of [
      [4097, 10],
      [10, 4097],
      [4096, 1025],
      [2049, 2049],
    ] as const)
      bad(good, handGeometry(w, h, IDENT), 'UNSUPPORTED');
    bad(
      { kind: 'gray8', buffer: new ArrayBuffer(4097), width: 4097, height: 1, strideBytes: 4097 },
      null,
      'UNSUPPORTED',
    );
    // Native pictures over the raw cap, with an oversized standard image, or without a geometry.
    const native = {
      displayWidth: 1920,
      displayHeight: 1080,
      pixels: rgbaPattern(1, 1),
      close() {},
    };
    const frame = (image: object) =>
      ({ kind: 'video-frame', image }) as unknown as TransferredImage;
    bad(frame(native), handGeometry(5000, 10, IDENT), 'UNSUPPORTED');
    bad(frame({ ...native, displayWidth: 16385, displayHeight: 1 }), geometry, 'UNSUPPORTED');
    bad(frame(native), null, 'UNSUPPORTED');
    assert.equal(log.draws, 0);
    // A raw source over 16,777,216 pixels is rejected even though the standard image would be small.
    const huge = new ArrayBuffer(4097 * 4097);
    bad(
      { kind: 'gray8', buffer: huge, width: 4097, height: 4097, strideBytes: 4097 },
      handGeometry(100, 100, IDENT),
      'UNSUPPORTED',
    );
    bad(
      {
        kind: 'gray8',
        buffer: new ArrayBuffer(16385),
        width: 16385,
        height: 1,
        strideBytes: 16385,
      },
      handGeometry(100, 100, IDENT),
      'UNSUPPORTED',
    );
    assert.equal(huge.byteLength, 4097 * 4097, 'source buffer not detached');
  }));

test('raw sources above 4,194,304 pixels downsample to a valid standard image', () =>
  withCanvas({}, (log) => {
    const w = 2400;
    const h = 1800;
    const gray = new Uint8Array(w * h).map((_, i) => (i * 13) & 255);
    const out = run(
      raw(gray, w, h, { kind: 'gray8' }),
      handGeometry(1200, 900, HALF),
      new StandardImageWorkspace(),
    );
    assert.deepEqual([out.widthPx, out.heightPx, out.data.length], [1200, 900, 1200 * 900]);
    // Pixel centres: destination (x, y) samples source (2x+1, 2y+1).
    assert.equal(out.data[0], gray[w + 1]);
    assert.equal(out.data[1], gray[w + 3]);
    assert.equal(out.data[1200], gray[3 * w + 1]);
    assert.equal(log.canvases[0]!.width, w);
    assert.equal(log.canvases[1]!.width, 1200);
  }));

test('a missing canvas, context or ImageData is explicit and leaves no cached resources', async () => {
  const image = () => raw(rgbaPattern(4, 4), 4, 4);
  const geometry = handGeometry(4, 4, IDENT);
  const isUnsupported = (e: unknown) => e instanceof EngineError && e.code === 'UNSUPPORTED';
  assert.throws(() => run(image(), geometry, new StandardImageWorkspace()), isUnsupported);
  await withCanvas({ noContext: true }, (log) => {
    const workspace = new StandardImageWorkspace();
    assert.throws(() => run(image(), geometry, workspace), isUnsupported);
    assert.equal(log.canvases.length, 1);
    assert.equal(log.canvases[0]!.width, 0, 'a canvas without a context is released');
    log.flags.noContext = false;
    assert.equal(run(image(), geometry, workspace).widthPx, 4);
    assert.equal(log.canvases.length, 3, 'the failed surface was not cached');
    log.flags.ctorThrows = true;
    assert.throws(() => run(image(), geometry, new StandardImageWorkspace()), isUnsupported);
    log.flags.ctorThrows = false;
    // The output context fails after the input surface exists: the input stays owned and dispose releases it.
    const partial = new StandardImageWorkspace();
    const opened = log.canvases.length;
    const globals = globalThis as unknown as {
      OffscreenCanvas: new (w: number, h: number) => { getContext(...a: unknown[]): unknown };
    };
    const Original = globals.OffscreenCanvas;
    let calls = 0;
    globals.OffscreenCanvas = class extends Original {
      override getContext(...a: unknown[]) {
        return ++calls === 2 ? null : super.getContext(...a);
      }
    };
    assert.throws(() => run(image(), geometry, partial), isUnsupported);
    const created = log.canvases.slice(opened);
    assert.equal(created.length, 2);
    assert.equal(created[1]!.width, 0);
    partial.dispose();
    assert.ok(created.every((c) => c.width === 0 && c.height === 0));
  });
  const globals = globalThis as { OffscreenCanvas?: unknown };
  globals.OffscreenCanvas = class {};
  try {
    assert.throws(() => run(image(), geometry, new StandardImageWorkspace()), isUnsupported);
  } finally {
    delete globals.OffscreenCanvas;
  }
});

test('optional stage timing separates canvas and gray stages, with identical pixels and no clock reads when off', () =>
  withCanvas({}, () => {
    const image = raw(rgbaPattern(8, 6), 8, 6);
    const geometry = handGeometry(4, 3, HALF);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')!;
    let ticks = 0;
    Object.defineProperty(globalThis, 'performance', {
      configurable: true,
      value: { now: () => ++ticks },
    });
    try {
      const off = run(image, geometry, new StandardImageWorkspace());
      assert.equal(ticks, 0);
      const stages: PrepareStages = {
        inputPackingDurationUs: 0,
        inputUploadDurationUs: 0,
        standardDrawDurationUs: 0,
        readbackDurationUs: 0,
        grayscaleDurationUs: 0,
      };
      const on = run(image, geometry, new StandardImageWorkspace(), stages);
      assert.deepEqual(on.data, off.data);
      assert.ok(ticks > 0);
      for (const value of Object.values(stages)) assert.ok(Number.isFinite(value) && value >= 0);
      assert.ok(
        stages.standardDrawDurationUs > 0 &&
          stages.readbackDurationUs > 0 &&
          stages.grayscaleDurationUs > 0,
      );
    } finally {
      Object.defineProperty(globalThis, 'performance', descriptor);
    }
  }));
