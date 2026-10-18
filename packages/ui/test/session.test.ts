/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createArSession,
  type ArObservation,
  type ArSessionOptions,
  type ArTarget,
} from '@livemira/ui';

import { deferred, engineError, fakeModule, settle, type FakeEngine } from './fakes.ts';

const container = {} as HTMLElement;
const blob = (text = 'x'): Blob => new Blob([text]);
const pair = (id: string): ArTarget => ({
  id,
  photo: `https://media/${id}.jpg`,
  video: `https://media/${id}.mp4`,
});

function setup(overrides: Partial<ArSessionOptions> = {}) {
  const fake = fakeModule();
  const requested: string[] = [];
  const downloads = new Map<string, ReturnType<typeof deferred<Blob>>>();
  const observations: ArObservation[] = [];
  const session = createArSession({
    loadEngine: () => fake.module,
    targets: [pair('a'), pair('b')],
    loadMedia: (url, { signal }) => {
      requested.push(url);
      if (!url.endsWith('.mp4')) return Promise.resolve(blob(url));
      const pending = deferred<Blob>();
      downloads.set(url, pending);
      signal.addEventListener('abort', () =>
        pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      return pending.promise;
    },
    observe: (o) => observations.push(o),
    ...overrides,
  });
  const engine = (): FakeEngine => fake.engines.at(-1)!;
  const scanning = async (): Promise<FakeEngine> => {
    await session.start(container);
    assert.equal(session.getState().phase, 'scanning');
    return engine();
  };
  return { fake, session, requested, downloads, observations, engine, scanning };
}

test('a start compiles the photos, starts the engine in the container and scans', async () => {
  const { fake, session, requested, observations, scanning } = setup();
  const states: string[] = [];
  session.subscribe(() => states.push(session.getState().phase));
  const engine = await scanning();
  assert.deepEqual(
    requested,
    ['https://media/a.jpg', 'https://media/b.jpg'],
    'videos wait for recognition',
  );
  assert.deepEqual(fake.compiled, ['a', 'b']);
  assert.equal(engine.options.container, container);
  assert.deepEqual(engine.calls, ['setTargets:a,b', 'start']);
  assert.deepEqual([...new Set(states)], ['preparing', 'starting', 'scanning']);
  assert.equal(session.getState().view, 'searching');
  assert.deepEqual(
    observations.filter((o) => o.type === 'lifecycle').map((o) => o.type === 'lifecycle' && o.name),
    ['start', 'ready'],
  );
});

test('the compile gets the signal and the host Worker factory, so a strict page compiles too', async () => {
  const workerFactory = (): Worker => ({}) as Worker;
  const { fake, scanning } = setup({
    engineOptions: { adapters: { workerFactory } },
    photoMaxEdgePx: 960,
  });
  await scanning();
  const options = fake.compileOptions[0] as {
    signal: AbortSignal;
    workerFactory: unknown;
    maxEdgePx: number;
  };
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.workerFactory, workerFactory);
  assert.equal(options.maxEdgePx, 960);
});

test('invalid target lists start nothing', async () => {
  const cases: [ArTarget[], string][] = [
    [[], 'notice.noTargets'],
    [Array.from({ length: 11 }, (_, i) => pair(`t${i}`)), 'notice.tooMany'],
    [[pair('a'), pair('a')], 'notice.invalidTargets'],
    [[pair('bad id')], 'notice.invalidTargets'],
    [
      [{ id: 'a', target: { targetId: 'other' } as never, video: 'v.mp4' }],
      'notice.invalidTargets',
    ],
  ];
  for (const [targets, key] of cases) {
    const { fake, session } = setup({ targets });
    await session.start(container);
    assert.equal(session.getState().phase, 'idle');
    assert.equal(session.getState().notice?.key, key);
    assert.equal(fake.engines.length, 0);
  }
});

test('a photo that cannot be a target is skipped and counted; when none is left nothing starts', async () => {
  const { fake, session, scanning } = setup();
  fake.compileResults.set('a', () => Promise.reject(engineError('INVALID_TARGET')));
  const engine = await scanning();
  assert.deepEqual(engine.targets, ['b'], 'the other photo keeps its own id and video');
  assert.equal(session.getState().skippedCount, 1);

  const second = setup();
  for (const id of ['a', 'b'])
    second.fake.compileResults.set(id, () => Promise.reject(engineError('INVALID_TARGET')));
  await second.session.start(container);
  assert.equal(second.session.getState().notice?.key, 'notice.allRejected');
  assert.equal(second.session.getState().phase, 'idle');
});

test('a compile failure that is not the photo ends the run instead of skipping it', async () => {
  const { fake, session } = setup();
  fake.compileResults.set('a', () => Promise.reject(engineError('RESOURCE_FAILED')));
  await session.start(container);
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'notice.startFailed');
  assert.equal(session.getState().skippedCount, 0);
});

test('the host classifies failures: its notice and staleness win, but a failure before scanning always ends the run', async () => {
  const seen: unknown[] = [];
  const { session } = setup({
    loadMedia: () => Promise.reject(Object.assign(new Error('gone'), { status: 404 })),
    classifyError: (cause, context) => {
      seen.push([context.phase, context.targetId, (cause as { status?: number }).status]);
      return { notice: { key: 'host.expired' }, isStale: true, shouldStop: false };
    },
  });
  await session.start(container);
  assert.deepEqual(seen, [['photo-load', 'a', 404]]);
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'host.expired');
  assert.equal(session.getState().isStale, true);
});

test('an engine that cannot be loaded ends the run with its notice, and a later start loads it again', async () => {
  const fake = fakeModule();
  let attempts = 0;
  const session = createArSession({
    loadEngine: () => (++attempts === 1 ? Promise.reject(new Error('offline')) : fake.module),
    targets: [pair('a')],
    loadMedia: async () => blob(),
  });
  await session.start(container);
  assert.equal(session.getState().notice?.key, 'notice.engineLoadFailed');
  await session.start(container);
  assert.equal(session.getState().phase, 'scanning');
  assert.equal(session.getState().notice, null);
});

test('a video is downloaded once its photo is recognized, once, and the view follows its real playback', async () => {
  const { session, requested, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  engine.found('a');
  assert.equal(requested.filter((u) => u.endsWith('.mp4')).length, 1);
  assert.equal(session.getState().view, 'loading');
  assert.equal(session.getState().activeTargetId, 'a');
  downloads.get('https://media/a.mp4')!.resolve(blob('video'));
  await settle();
  assert.deepEqual(engine.calls.at(-1), 'media:a:muted=true');
  assert.equal(session.getState().view, 'loading', 'a bound video is not playing yet');
  engine.mediaState('a', 'playing');
  assert.equal(session.getState().view, 'playing');
  engine.emit('targetLost', { targetId: 'a', reason: 'lost' });
  assert.equal(session.getState().view, 'lost');
  engine.found('a');
  assert.equal(
    session.getState().view,
    'playing',
    'found again within the hold: no new playing event is needed',
  );
  assert.equal(requested.filter((u) => u.endsWith('.mp4')).length, 1, 'never downloaded again');
});

test('another recognized photo cancels the first download and releases its video; its late result is ignored', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  const first = downloads.get('https://media/a.mp4')!;
  engine.found('b');
  first.resolve(blob('late'));
  downloads.get('https://media/b.mp4')!.resolve(blob('video b'));
  await settle();
  assert.ok(!engine.bindings.has('a'), 'the late video of a is never bound');
  assert.ok(engine.bindings.has('b'));
  engine.found('a');
  assert.ok(!engine.bindings.has('b'), 'b is released when a is shown');
  assert.ok(engine.calls.includes('media:b:null'));
  assert.equal(session.getState().activeTargetId, 'a');
});

test('a media failure is latched over later pause and hide events; a blocked autoplay is not a failure', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  engine.mediaState('a', 'loading-failed', 'media-error');
  engine.mediaState('a', 'error');
  engine.mediaState('a', 'hidden');
  engine.mediaState('a', 'pause');
  assert.equal(session.getState().view, 'videoError');
  assert.equal(session.getState().notice?.key, 'notice.videoPlayFailed');
  await session.retryVideo();
  assert.equal(engine.calls.at(-1), 'retry');
  assert.equal(session.getState().view, 'loading');

  engine.mediaState('a', 'loading-failed', 'playback-blocked');
  engine.emit('playbackBlocked', { targetId: 'a' });
  assert.equal(session.getState().view, 'loading');
  assert.equal(session.getState().isPlaybackBlocked, true);
  assert.equal(session.getState().notice?.key, 'notice.autoplayBlocked');
  const retried = session.retryVideo();
  assert.equal(engine.calls.at(-1), 'retry', 'the engine sees the tap in its call stack');
  await retried;
  engine.mediaState('a', 'playing');
  assert.equal(session.getState().isPlaybackBlocked, false);
  assert.equal(session.getState().view, 'playing');
});

test('a tap on the sound control resumes a blocked autoplay and clears its notice', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  engine.emit('playbackBlocked', { targetId: 'a' });
  assert.equal(session.getState().notice?.key, 'notice.autoplayBlocked');
  assert.equal(await session.setMuted(false), true);
  assert.equal(session.getState().notice, null);
  engine.mediaState('a', 'playing');
  assert.equal(session.getState().view, 'playing');
});

test('an empty video file is reported and can be loaded again', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(new Blob([]));
  await settle();
  assert.equal(session.getState().view, 'videoError');
  assert.equal(session.getState().notice?.key, 'notice.emptyVideo');
  assert.ok(!engine.bindings.has('a'));
});

test('a start that fails for any other reason than permission says camera or recognition', async () => {
  const { session, fake } = setup({ loadMedia: async () => blob() });
  const prepared = fake.module.createEngine;
  (fake.module as { createEngine: typeof prepared }).createEngine = (options) => {
    const created = prepared(options) as unknown as FakeEngine;
    created.startResult = () => Promise.reject(engineError('CAMERA_UNAVAILABLE'));
    return created as unknown as ReturnType<typeof prepared>;
  };
  await session.start(container);
  assert.equal(session.getState().notice?.key, 'notice.cameraOrEngine');
});

test('a failed download keeps the camera running and is downloaded again only on request', async () => {
  const { session, requested, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.reject(new Error('network'));
  await settle();
  assert.equal(session.getState().phase, 'scanning');
  assert.equal(session.getState().view, 'videoError');
  assert.equal(session.getState().notice?.key, 'notice.videoLoadFailed');
  engine.found('a');
  assert.equal(requested.filter((u) => u.endsWith('.mp4')).length, 1, 'no automatic retry');
  await session.retryVideo();
  assert.equal(requested.filter((u) => u.endsWith('.mp4')).length, 2);
  assert.equal(session.getState().view, 'loading');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  assert.ok(engine.bindings.has('a'));
});

test('a host may end the run on a video failure', async () => {
  const { session, downloads, scanning } = setup({
    classifyError: () => ({
      shouldStop: true,
      isStale: true,
      notice: { key: 'host.videoExpired' },
    }),
  });
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.reject(new Error('404'));
  await settle();
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'host.videoExpired');
  assert.equal(session.getState().isStale, true);
  assert.ok(engine.calls.includes('stop:ui-stop'));
});

test('a view change covers only the newest epoch and keeps the bound video', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  engine.emit('viewportTransition', { phase: 'begin', epoch: 1 });
  engine.emit('targetLost', { targetId: 'a', reason: 'viewport-transition' });
  assert.equal(session.getState().isAdjusting, true);
  assert.equal(session.getState().activeTargetId, null);
  engine.emit('viewportTransition', { phase: 'begin', epoch: 2 });
  engine.emit('viewportTransition', { phase: 'end', epoch: 1 });
  assert.equal(session.getState().isAdjusting, true, 'an older end does not uncover');
  engine.emit('viewportTransition', { phase: 'begin', epoch: 1 });
  engine.emit('viewportTransition', { phase: 'end', epoch: 2 });
  assert.equal(session.getState().isAdjusting, false);
  assert.ok(engine.bindings.has('a'), 'the rotation never releases the video');
  engine.found('a');
  assert.equal(session.getState().view, 'loading');
});

test('a failed start reports one notice, however many engine events it causes', async () => {
  const { session, engine, fake } = setup();
  const prepared = fake.module.createEngine;
  (fake.module as { createEngine: typeof prepared }).createEngine = (options) => {
    const created = prepared(options) as unknown as FakeEngine;
    created.startResult = async () => {
      created.emit('sessionStartFailed', { code: 'CAMERA_PERMISSION_DENIED' });
      created.emit('error', { error: engineError('CAMERA_PERMISSION_DENIED') });
      created.emit('sessionEnded', { reason: 'start-failed' });
      throw engineError('CAMERA_PERMISSION_DENIED');
    };
    return created as unknown as ReturnType<typeof prepared>;
  };
  const notices: (string | undefined)[] = [];
  session.subscribe(() => notices.push(session.getState().notice?.key));
  await session.start(container);
  assert.equal(engine().calls.includes('start'), true);
  assert.equal(session.getState().phase, 'idle');
  assert.deepEqual([...new Set(notices.filter(Boolean))], ['notice.cameraDenied']);
});

test('an engine that ends its session by itself ends the run, cancels the download and releases the video', async () => {
  for (const [reason, key] of [
    ['camera-suspended', 'notice.backgrounded'],
    ['camera-error', 'notice.cameraInterrupted'],
    ['worker-failure', 'notice.workerFailure'],
  ] as const) {
    const { session, downloads, scanning } = setup();
    const engine = await scanning();
    engine.found('a');
    const pending = downloads.get('https://media/a.mp4')!;
    engine.found('b');
    downloads.get('https://media/b.mp4')!.resolve(blob());
    await settle();
    engine.emit('sessionEnded', { reason });
    pending.resolve(blob());
    await settle();
    assert.equal(session.getState().phase, 'idle');
    assert.equal(session.getState().notice?.key, key);
    assert.equal(engine.bindings.size, 0, 'nothing stays bound after the run');
  }
});

test('a stop while preparing ignores what finishes late, and the next start runs normally', async () => {
  const photo = deferred<Blob>();
  const { fake, session } = setup({ loadMedia: () => photo.promise });
  const started = session.start(container);
  await settle();
  assert.equal(session.getState().phase, 'preparing');
  await session.stop();
  photo.resolve(blob());
  await started;
  await settle();
  assert.equal(session.getState().phase, 'idle');
  assert.deepEqual(fake.compiled, [], 'the late photo is not compiled');
  assert.equal(session.getState().notice, null);
});

test('concurrent starts join one run; a start while stopping waits for the stop', async () => {
  const { fake, session } = setup({ loadMedia: async () => blob() });
  await Promise.all([session.start(container), session.start(container)]);
  assert.equal(fake.engines.length, 1);
  assert.equal(fake.engines[0]!.calls.filter((c) => c === 'start').length, 1);
  const stopped = session.stop();
  const restarted = session.start(container);
  await Promise.all([stopped, restarted]);
  assert.equal(session.getState().phase, 'scanning');
  assert.equal(fake.engines.length, 1, 'the engine of the container is reused');
  assert.deepEqual(fake.engines[0]!.calls.slice(-3), ['stop:ui-stop', 'setTargets:a,b', 'start']);
});

test('a host stop carries its notice and staleness', async () => {
  const { session, scanning } = setup({ loadMedia: async () => blob() });
  await scanning();
  await session.stop({
    reason: 'session-expired',
    notice: { key: 'host.unauthorized' },
    isStale: true,
  });
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'host.unauthorized');
  assert.equal(session.getState().isStale, true);
});

test('sound: the engine sees the tap at once; a refused unmute while playing goes back to muted', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  engine.mediaState('a', 'playing');
  engine.muteResult = false;
  const pending = session.setMuted(false);
  assert.equal(engine.calls.at(-1), 'setMuted:false', 'called synchronously');
  assert.equal(await pending, false);
  await settle();
  assert.equal(engine.calls.at(-1), 'setMuted:true');
  assert.equal(session.getState().isMuted, true);
  assert.equal(session.getState().notice?.key, 'notice.soundRefused');
});

test('sound chosen while nothing plays applies to the next video', async () => {
  const { session, downloads, scanning } = setup();
  const engine = await scanning();
  engine.muteResult = false;
  assert.equal(await session.setMuted(false), true);
  assert.equal(session.getState().isMuted, false);
  engine.found('a');
  downloads.get('https://media/a.mp4')!.resolve(blob());
  await settle();
  assert.equal(engine.calls.at(-1), 'media:a:muted=false');
});

test('dispose stops, disposes the engine, ends the session for good and is idempotent', async () => {
  const { session, scanning } = setup({ loadMedia: async () => blob() });
  const engine = await scanning();
  await Promise.all([session.dispose(), session.dispose()]);
  assert.deepEqual(engine.calls.slice(-2), ['stop:ui-stop', 'dispose']);
  assert.equal(session.getState().isDisposed, true);
  await session.start(container);
  assert.equal(
    engine.calls.filter((c) => c === 'start').length,
    1,
    'a disposed session never starts',
  );
});

test('dispose during preparing ends promptly', async () => {
  const photo = deferred<Blob>();
  const { session } = setup({
    loadMedia: (_url, { signal }) => {
      signal.addEventListener('abort', () =>
        photo.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      return photo.promise;
    },
  });
  void session.start(container);
  await settle();
  await session.dispose();
  assert.equal(session.getState().isDisposed, true);
});

test('a throwing observer or listener never affects the session', async () => {
  const { session, scanning } = setup({
    loadMedia: async () => blob(),
    observe: () => {
      throw new Error('observer');
    },
  });
  session.subscribe(() => {
    throw new Error('listener');
  });
  await scanning();
  assert.equal(session.getState().phase, 'scanning');
});
