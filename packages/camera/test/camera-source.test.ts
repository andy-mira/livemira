/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CameraSource, type CameraEvent, type CameraSourceOptions } from '@livemira/camera';
import { EngineError, type Frame } from '@livemira/contracts';

import { FakeBrowser, settle, type FakeBrowserOptions } from './fake-browser.ts';

function setup(options: FakeBrowserOptions = {}, source: Partial<CameraSourceOptions> = {}) {
  const browser = new FakeBrowser(options);
  const camera = new CameraSource({
    previewContainer: browser.container as never,
    env: browser.env,
    ...source,
  });
  const frames: Frame[] = [];
  const events: CameraEvent[] = [];
  camera.onEvent((event) => events.push(event));
  const start = (): Promise<void> =>
    camera.start('session-1', (frame) => frames.push(frame), new AbortController().signal);
  return { browser, camera, frames, events, start };
}

/** Native pictures timed by the video's media time, the non-default setting the native paths need. */
const NATIVE = { camera: { capture: 'auto', timestamps: 'media-time' } } as const;

test('a started camera delivers owned frames with their geometry, picture key and session timing', async () => {
  const { browser, camera, frames, events, start } = setup({}, NATIVE);
  await start();
  assert.deepEqual(
    events.map((e) => e.type),
    ['permission', 'permission', 'ready'],
  );
  browser.frame();
  browser.frame();
  assert.equal(
    frames.length,
    2,
    'native pictures are delivered synchronously within the frame callback',
  );
  const [first, second] = frames as [Frame, Frame];
  assert.equal(first.sessionId, 'session-1');
  assert.deepEqual([first.frameId, second.frameId], [0, 1]);
  assert.equal(first.pictureKey, 'session-1:1');
  assert.equal(first.image.format, 'video-frame');
  assert.deepEqual([first.widthPx, first.heightPx], [720, 1280]);
  assert.equal(first.geometry.viewportWidthCss, 400);
  assert.equal(first.timing.timestampSource, 'media-time');
  assert.equal(Math.round(second.timing.observationTimeUs - first.timing.observationTimeUs), 33000);
  assert.ok(Object.isFrozen(first.geometry));
  assert.ok(events.some((e) => e.type === 'geometryChanged'));
  assert.ok(events.some((e) => e.type === 'pictureSize'));
  first.image.release();
  assert.equal(browser.closedPictures, 1);
  await camera.dispose();
  assert.equal(browser.tracks[0]!.stopped, true);
  assert.equal(browser.attached(), 0);
  assert.equal(browser.intervals.size, 0);
  assert.equal(browser.container.children.length, 0, 'the preview layer is removed');
});

test('the camera request becomes getUserMedia constraints', async () => {
  const { browser, start, camera } = setup(
    {},
    { camera: { facingMode: 'user', idealWidthPx: 640, idealHeightPx: 480 } },
  );
  await start();
  assert.deepEqual(browser.constraints[0], {
    audio: false,
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: { ideal: 'user' } },
  });
  await camera.dispose();
});

test('without native pictures, the standard image is read back with the frame geometry through one cached canvas', async () => {
  const { browser, frames, start, camera } = setup(
    { hasVideoFrame: false },
    { geometry: { longEdge: 640 } },
  );
  await start();
  browser.frame();
  browser.frame();
  assert.deepEqual(
    frames.map((f) => f.image.format),
    ['standard-rgba8', 'standard-rgba8'],
  );
  const g = frames[0]!.geometry;
  assert.deepEqual([g.standardWidthPx, g.standardHeightPx], [360, 640]);
  assert.equal((frames[0]!.image.data() as Uint8Array).byteLength, 360 * 640 * 4);
  const h = g.H_standardFromInput;
  const draw = `standard:360x640:${[h[0], h[3], h[1], h[4], h[2], h[5]].join(',')}`;
  assert.deepEqual(
    browser.draws.filter((d) => !d.startsWith('preview')),
    [draw, draw],
  );
  // A quarter of the 720 × 1280 picture per frame.
  assert.equal(
    (camera.getDiagnostics().stats as { cpuReadbackBytes: number }).cpuReadbackBytes,
    2 * 360 * 640 * 4,
  );
  for (const frame of frames) frame.image.release();
  await camera.dispose();
});

test('by default the standard image is read back and timed by the frame callback, even with native pictures', async () => {
  const { browser, camera, frames, start } = setup();
  await start();
  browser.frame();
  browser.frame();
  assert.deepEqual(
    frames.map((f) => [f.image.format, f.timing.timestampSource]),
    [
      ['standard-rgba8', 'callback'],
      ['standard-rgba8', 'callback'],
    ],
  );
  const d = camera.getDiagnostics();
  assert.deepEqual([d.capture, d.timestamps], ['canvas', 'callback']);
  for (const frame of frames) frame.image.release();
  await camera.dispose();
});

test('a failing VideoFrame falls back to ImageBitmap for the rest of the run', async () => {
  const { browser, frames, start, camera } = setup(
    { videoFrameThrows: true, hasImageBitmap: true },
    NATIVE,
  );
  await start();
  browser.frame();
  await settle();
  browser.frame();
  await settle();
  assert.deepEqual(
    frames.map((f) => f.image.format),
    ['image-bitmap', 'image-bitmap'],
  );
  const stats = camera.getDiagnostics().stats as Record<string, number>;
  assert.equal(stats.nativeSnapshotFailures, 1, 'disabled after the first failure');
  assert.equal(stats.bitmapCopies, 2);
  await camera.dispose();
});

test('without frame callbacks, animation frames and decoded-frame counts detect new frames', async () => {
  const { browser, frames, events, start, camera } = setup({ hasFrameCallback: false });
  await start();
  assert.equal(
    (events.find((e) => e.type === 'ready') as { capturePath: string }).capturePath,
    'decoded-frame-count',
  );
  browser.frame();
  browser.frame();
  assert.equal(frames.length, 2);
  await camera.dispose();
  assert.equal(browser.frames.size, 0, 'the pending animation frame is cancelled');
});

test('a denied permission rejects the start with a failure event', async () => {
  const { events, start } = setup({ permission: 'denied' });
  await assert.rejects(
    start(),
    (e) => e instanceof EngineError && e.code === 'CAMERA_PERMISSION_DENIED',
  );
  const failure = events.find((e) => e.type === 'failure') as Extract<
    CameraEvent,
    { type: 'failure' }
  >;
  assert.equal(failure.error.code, 'CAMERA_PERMISSION_DENIED');
  assert.ok(events.some((e) => e.type === 'permission' && e.permission === 'denied'));
});

test('aborting the start stops the camera', async () => {
  const browser = new FakeBrowser();
  const camera = new CameraSource({ previewContainer: null, env: browser.env });
  const controller = new AbortController();
  const started = camera.start('s', () => {}, controller.signal);
  controller.abort();
  await assert.rejects(started, (e) => e instanceof EngineError && e.code === 'ABORTED');
  await settle();
  assert.ok(browser.tracks.every((t) => t.stopped));
});

test('a stall reports a recommended fallback, which the next start uses', async () => {
  const { browser, camera, events, start } = setup();
  await start();
  browser.frame();
  browser.advance(2100);
  const failure = events.find((e) => e.type === 'failure') as Extract<
    CameraEvent,
    { type: 'failure' }
  >;
  assert.equal(failure.error.code, 'CAMERA_FRAME_STALLED');
  assert.equal(failure.detail, 'NO_VIDEO_CALLBACK');
  assert.deepEqual(failure.recommended, { capture: 'canvas', timestamps: 'callback' });
  assert.deepEqual(camera.getDiagnostics().recovery, {
    detail: 'NO_VIDEO_CALLBACK',
    nextCamera: { capture: 'canvas', timestamps: 'callback' },
  });
  const frames: Frame[] = [];
  await camera.start('session-2', (f) => frames.push(f), new AbortController().signal);
  browser.frame();
  assert.equal(frames[0]!.image.format, 'standard-rgba8');
  assert.equal(frames[0]!.timing.timestampSource, 'callback');
  await camera.dispose();
});

test('a media time that does not advance switches the run to callback timestamps instead of stalling', async () => {
  const { browser, camera, frames, events, start } = setup({ isMediaTimeFrozen: true }, NATIVE);
  await start();
  browser.frame();
  browser.frame();
  browser.frame();
  assert.equal(frames.length, 1, 'two repeats are still taken for repeated pictures');
  browser.frame();
  assert.deepEqual(
    events.filter((e) => e.type === 'timestampsChanged'),
    [{ type: 'timestampsChanged', timestamps: 'callback', reason: 'MEDIA_TIME_FROZEN' }],
  );
  browser.frame();
  browser.frame();
  assert.equal(frames.length, 3);
  const [first, second, third] = frames as [Frame, Frame, Frame];
  assert.equal(first.timing.timestampSource, 'media-time');
  assert.equal(second.timing.timestampSource, 'callback');
  // The session clock goes on: callback frames are observed when they arrive, after the first frame.
  assert.ok(second.timing.observationTimeUs > first.timing.observationTimeUs);
  assert.equal(Math.round(third.timing.observationTimeUs - second.timing.observationTimeUs), 33000);
  // Frames keep arriving for more than the two seconds after which the camera used to stall.
  for (let i = 0; i < 70; i++) {
    browser.frame();
    if (i % 8 === 0) browser.advance(0);
  }
  assert.equal(frames.length, 73);
  assert.equal(
    events.some((e) => e.type === 'failure'),
    false,
    'no stall',
  );
  const diagnostics = camera.getDiagnostics();
  assert.equal(diagnostics['timestamps'], 'callback');
  assert.equal(diagnostics['timestampFallback'], 'MEDIA_TIME_FROZEN');
  for (const frame of frames) frame.image.release();
  // The next run starts on the requested media time again.
  await camera.stop();
  await start();
  assert.equal(camera.getDiagnostics()['timestampFallback'], null);
  await camera.dispose();
});

test('a hidden page stops the camera and reports suspension', async () => {
  const { browser, camera, events, frames, start } = setup();
  await start();
  browser.setHidden(true);
  assert.equal(events.at(-1)!.type, 'suspended');
  assert.equal(browser.tracks[0]!.stopped, true);
  assert.equal(camera.getDiagnostics().state, 'suspended');
  browser.setHidden(false);
  await settle();
  assert.equal(browser.tracks.length, 1, 'the camera is not restarted by itself');
  assert.equal(frames.length, 0);
  await camera.dispose();
});

test('starting while the page is hidden is rejected as suspended', async () => {
  const { browser, start } = setup();
  browser.setHidden(true);
  await assert.rejects(start(), (e) => e instanceof EngineError && e.code === 'CAMERA_SUSPENDED');
});

test('an ended track and a source clock reset each end the run with a failure', async () => {
  for (const cause of ['ended', 'reset'] as const) {
    const { browser, camera, events, start } = setup();
    await start();
    browser.frame();
    if (cause === 'ended') browser.tracks[0]!.listeners.fire('ended');
    else {
      browser.nowMs -= 500;
      browser.frame();
    }
    const failure = events.find((e) => e.type === 'failure') as Extract<
      CameraEvent,
      { type: 'failure' }
    >;
    assert.equal(
      failure.error.code,
      cause === 'ended' ? 'CAMERA_TRACK_ENDED' : 'CAMERA_CLOCK_RESET',
    );
    assert.equal(camera.getDiagnostics().state, 'stopped');
    await camera.dispose();
  }
});

test('the camera can be configured only while stopped; a disposed source refuses use', async () => {
  const { camera, start } = setup();
  await start();
  assert.throws(
    () => camera.configure({ camera: { facingMode: 'user' } }),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
  camera.configure({ geometry: { fit: 'contain' } });
  await camera.stop();
  camera.configure({ camera: { facingMode: 'user' } });
  assert.equal(camera.nowSessionUs(), null);
  assert.deepEqual(
    (await camera.listCameras()).map((d) => d.deviceId),
    ['a'],
  );
  await camera.dispose();
  assert.throws(
    () => camera.onEvent(() => {}),
    (e) => e instanceof EngineError && e.code === 'DISPOSED',
  );
});

test('a picture that arrives after the camera stopped is closed and never delivered', async () => {
  const { browser, camera, frames, start } = setup(
    { hasVideoFrame: false, hasImageBitmap: true, holdBitmaps: true },
    NATIVE,
  );
  const failures: unknown[] = [];
  const onRejection = (reason: unknown) => failures.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    await start();
    browser.frame();
    await camera.stop();
    browser.releaseBitmaps();
    await settle();
    await settle();
    assert.equal(frames.length, 0);
    assert.equal(browser.closedPictures, 1, 'the late picture is closed');
    assert.deepEqual(failures, [], 'nothing is left unhandled');
  } finally {
    process.off('unhandledRejection', onRejection);
    await camera.dispose();
  }
});

test('stopping from the permission request listener ends the start before the camera is asked', async () => {
  const { browser, camera, events, start } = setup();
  let isArmed = true;
  camera.onEvent((event) => {
    if (isArmed && event.type === 'permission' && event.phase === 'request') {
      isArmed = false;
      void camera.stop();
    }
  });
  await assert.rejects(start(), (e) => e instanceof EngineError && e.code === 'CAMERA_SUSPENDED');
  assert.equal(browser.getUserMediaCalls, 0, 'the cancelled request never reaches getUserMedia');
  assert.equal(browser.video, null, 'no video is created');
  assert.equal(events.filter((e) => e.type === 'ready').length, 0);
  await start();
  assert.equal(events.filter((e) => e.type === 'ready').length, 1, 'a restart works');
  await camera.dispose();
});
