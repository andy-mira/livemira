/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type Frame, type TrackingResult } from '@livemira/contracts';
import { DiagnosticLog } from '@livemira/diagnostics';
import { createEngine } from '@livemira/engine';

import { EngineCore } from '../src/engine/engine-core.ts';

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function frame(sessionId: string, frameId: number, released: number[]): Frame {
  return {
    sessionId,
    frameId,
    pictureKey: `${sessionId}:${frameId}`,
    timing: {
      sourceTimestampUs: frameId * 33000,
      timestampSource: 'media-time',
      arrivalTimeUs: frameId * 33000,
      observationTimeUs: frameId * 33000,
    },
    widthPx: 640,
    heightPx: 480,
    geometry: {
      H_standardFromInput: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      H_viewportFromStandard: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      crop: { x: 0, y: 0, width: 640, height: 480 },
      rotationDeg: 0,
      isMirrored: false,
      fit: 'cover',
      standardWidthPx: 640,
      standardHeightPx: 480,
      viewportWidthCss: 640,
      viewportHeightCss: 480,
      devicePixelRatio: 1,
    },
    image: {
      format: 'rgba8',
      isReleased: false,
      data: () => new Uint8Array(4),
      release: () => void released.push(frameId),
    },
  } as unknown as Frame;
}

function result(sessionId: string, frameId: number): TrackingResult {
  return {
    sessionId,
    frameId,
    observationTimeUs: frameId * 33000,
    state: 'TRACKING',
    reason: 'original-target-measured',
    targetId: 't1',
    H_imageFromTarget: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    cornersPx: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    quality: {
      inlierCount: 20,
      inlierRatio: 0.8,
      reprojectionErrorPx: 1,
      spatialCoverage: 0.5,
      isDegenerate: false,
      isMeasured: true,
    },
    prediction: { ageUs: 0, lastMeasuredTimeUs: 0, expiresAtUs: 100000 },
  };
}

function setup(options: { telemetry?: DiagnosticLog; failCamera?: boolean } = {}) {
  const released: number[] = [];
  const calls: string[] = [];
  let deliver: ((frame: Frame) => void) | null = null;
  const core = new EngineCore({
    source: {
      start: async (_session, onFrame) => {
        calls.push('source.start');
        if (options.failCamera)
          throw new EngineError('CAMERA_PERMISSION_DENIED', 'denied', { isRecoverable: true });
        deliver = onFrame;
      },
      stop: async () => void calls.push('source.stop'),
      dispose: async () => void calls.push('source.dispose'),
    },
    pipeline: {
      loadTargets: async () => {},
      reset: async () => void calls.push('pipeline.reset'),
      process: async (f) => result(f.sessionId, f.frameId),
      dispose: async () => void calls.push('pipeline.dispose'),
    },
    overlay: {
      start: async () => void calls.push('overlay.start'),
      update: async () => void calls.push('overlay.update'),
      hide: () => void calls.push('overlay.hide'),
      stop: async () => void calls.push('overlay.stop'),
      dispose: async () => void calls.push('overlay.dispose'),
    },
    ...(options.telemetry ? { telemetry: options.telemetry } : {}),
    capability: () => ({}) as never,
  });
  const events: string[] = [];
  for (const name of [
    'ready',
    'targetFound',
    'targetLost',
    'sessionEnded',
    'sessionStartFailed',
    'error',
  ] as const)
    core.on(name, () => events.push(name));
  return { core, calls, events, released, deliver: (f: Frame) => deliver?.(f) };
}

test('a session starts the parts in order, presents results and ends cleanly', async () => {
  const { core, calls, events, released, deliver } = setup();
  assert.equal(core.state, 'idle');
  await core.start({} as never);
  assert.equal(core.state, 'running');
  assert.deepEqual(calls.slice(0, 3), ['pipeline.reset', 'overlay.start', 'source.start']);
  deliver(frame(core.sessionId!, 1, released));
  await settle();
  await settle();
  assert.deepEqual(events, ['ready', 'targetFound']);
  assert.deepEqual(released, [1], 'the frame is released after processing');
  await core.stop();
  assert.equal(core.state, 'idle');
  assert.deepEqual(events.slice(-2), ['targetLost', 'sessionEnded']);
  await core.dispose();
  assert.equal(core.state, 'disposed');
  assert.ok(calls.includes('pipeline.dispose') && calls.includes('overlay.dispose'));
  assert.throws(
    () => core.on('ready', () => {}),
    (e) => e instanceof EngineError && e.code === 'DISPOSED',
  );
});

test('a failing camera fails the start with its own code and cleans up', async () => {
  const { core, events, calls } = setup({ failCamera: true });
  await assert.rejects(
    core.start({} as never),
    (e) => e instanceof EngineError && e.code === 'CAMERA_PERMISSION_DENIED',
  );
  assert.deepEqual(events, ['sessionStartFailed', 'error', 'sessionEnded']);
  assert.ok(calls.includes('source.stop') && calls.includes('overlay.stop'));
  assert.equal(core.state, 'idle');
});

test('frame records are built only for sessions at the full diagnostic level', async () => {
  const log = new DiagnosticLog({ level: 'key' });
  const { core, released, deliver } = setup({ telemetry: log });
  await core.start({} as never);
  deliver(frame(core.sessionId!, 1, released));
  await settle();
  await core.stop();
  log.setLevel('full');
  await core.start({} as never);
  deliver(frame(core.sessionId!, 1, released));
  await settle();
  await settle();
  await core.stop();
  const exported = log.export();
  assert.equal(exported.frames?.length, 1);
  assert.equal(exported.frames?.[0]?.targetId, 't1');
});

test('invalid engine options are rejected before anything is created', () => {
  const container = { ownerDocument: {} } as unknown as HTMLElement;
  for (const options of [
    {},
    { container, camera: { processingLongEdge: 720 } },
    { container, camera: { fit: 'stretch' } },
    { container, tracking: { lossDisplayGraceMs: 2000 } },
    { container, extensions: [{}] },
  ]) {
    assert.throws(
      () => createEngine(options as never),
      (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
    );
  }
  assert.throws(
    () => new EngineCore({ source: {}, pipeline: {}, overlay: {}, maxPredictionMs: 101 } as never),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
});
