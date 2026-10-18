/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import {
  isWechatIosVideo,
  VideoSession,
  wechatIosBridgeRecovery,
  type PlaybackRecovery,
  type VideoSessionEvent,
} from '@livemira/media';

type Listener = () => void;

/** A media element whose play() results are scripted. */
function fakeVideo(options: { userAgent?: string; bridge?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const docListeners = new Map<string, Set<Listener>>();
  const outcomes: string[] = [];
  const calls: string[] = [];
  const add = (map: Map<string, Set<Listener>>) => (type: string, fn: Listener) => {
    if (!map.has(type)) map.set(type, new Set());
    map.get(type)!.add(fn);
  };
  const remove = (map: Map<string, Set<Listener>>) => (type: string, fn: Listener) =>
    void map.get(type)?.delete(fn);
  const win = {
    navigator: { userAgent: options.userAgent ?? 'Mozilla/5.0' },
    ...(options.bridge
      ? {
          WeixinJSBridge: {
            invoke: (_method: string, _params: object, callback: () => void) => callback(),
          },
        }
      : {}),
    addEventListener() {},
    removeEventListener() {},
  };
  const video = {
    paused: true,
    ended: false,
    duration: NaN,
    currentTime: 0,
    readyState: 0,
    networkState: 0,
    videoWidth: 0,
    videoHeight: 0,
    error: null as { code: number } | null,
    muted: false,
    loop: false,
    playsInline: false,
    src: '',
    ownerDocument: {
      hidden: false,
      defaultView: win,
      addEventListener: add(docListeners),
      removeEventListener: remove(docListeners),
    },
    play() {
      calls.push('play');
      const outcome = outcomes.shift() ?? 'ok';
      if (outcome === 'ok') {
        video.paused = false;
        return Promise.resolve();
      }
      return Promise.reject(Object.assign(new Error(outcome), { name: outcome }));
    },
    pause() {
      video.paused = true;
      calls.push('pause');
    },
    load() {
      calls.push('load');
    },
    removeAttribute(name: string) {
      calls.push(`remove:${name}`);
    },
    addEventListener: add(listeners),
    removeEventListener: remove(listeners),
    fire(type: string) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
  return { video, outcomes, calls };
}

function setup(options?: Parameters<typeof fakeVideo>[0], recoveries?: PlaybackRecovery[]) {
  const fake = fakeVideo(options);
  const events: VideoSessionEvent[] = [];
  const session = new VideoSession(fake.video as never, {
    onEvent: (e) => events.push(e),
    ...(recoveries ? { recoveries } : {}),
  });
  return { ...fake, events, session };
}

test('configure applies the media policy to the element and play starts it', async () => {
  const { video, session } = setup();
  session.configure({ url: 'https://example.test/a.mp4', isMuted: false });
  assert.equal(video.src, 'https://example.test/a.mp4');
  assert.equal(video.muted, false);
  assert.equal(video.loop, true);
  assert.equal(video.playsInline, true);
  assert.equal(await session.play(), true);
  assert.equal(session.getSnapshot().playbackPath, 'native');
  assert.equal(session.getSnapshot().isPaused, false);
});

test('invalid configurations are rejected', () => {
  const { session } = setup();
  for (const config of [
    { url: '' },
    { url: 'x', onResume: 'later' },
    { url: 'x', playbackRecovery: 'always' },
  ]) {
    assert.throws(
      () => session.configure(config as never),
      (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
    );
  }
});

test('a blocked play reports playbackBlocked; a gesture resumes it', async () => {
  const { outcomes, events, session } = setup();
  session.configure({ url: 'a' });
  outcomes.push('NotAllowedError');
  assert.equal(await session.play(), false);
  assert.deepEqual(events, [{ type: 'playbackBlocked', reason: 'playback-gesture-required' }]);
  assert.equal(await session.resumeFromGesture(), true);
});

test('play and media failures carry MEDIA_FAILED with the original detail', async () => {
  const { video, outcomes, events, session } = setup();
  session.configure({ url: 'a' });
  outcomes.push('NotSupportedError');
  await session.play();
  video.error = { code: 2 };
  video.fire('error');
  const failures = events.filter((e) => e.type === 'failure');
  assert.deepEqual(
    failures.map((e) => [e.error.code, e.detail, e.error.message]),
    [
      ['MEDIA_FAILED', 'MEDIA_PLAY_FAILED', 'media-source-not-supported'],
      ['MEDIA_FAILED', 'MEDIA_LOAD_OR_DECODE', 'media-network-error'],
    ],
  );
});

test('a newer play cancels the older one', async () => {
  const { session } = setup();
  session.configure({ url: 'a' });
  const first = session.play();
  const second = session.play();
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
});

test('on iOS WeChat a blocked play is recovered once through the bridge', async () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) MicroMessenger/8.0';
  const { video, outcomes, calls, events, session } = setup({ userAgent: ua, bridge: true });
  assert.equal(isWechatIosVideo(video as never), true);
  session.configure({ url: 'a' });
  outcomes.push('NotAllowedError', 'ok');
  assert.equal(await session.play(), true);
  assert.equal(calls.filter((c) => c === 'play').length, 2);
  assert.equal(events.length, 0);
  const snapshot = session.getSnapshot();
  assert.equal(snapshot.playbackPath, 'wechat-bridge');
  assert.equal(snapshot.recoveryAttempts, 1);
});

test('a recovery whose own play fails reports that error instead of the blocked play', async () => {
  const recovery: PlaybackRecovery = {
    id: 'test',
    isApplicable: () => true,
    prepare: () => ({
      result: Promise.resolve({
        status: 'failed',
        error: Object.assign(new Error('x'), { name: 'NotSupportedError' }),
      }),
      start() {},
      cancel() {},
    }),
  };
  const { outcomes, events, session } = setup({}, [recovery]);
  session.configure({ url: 'a' });
  outcomes.push('NotAllowedError');
  assert.equal(await session.play(), false);
  assert.equal(events[0]!.type, 'failure');
  assert.equal(session.getSnapshot().playbackPath, 'test');
  session.configure({ url: 'a', playbackRecovery: 'off' });
  outcomes.push('NotAllowedError');
  await session.play();
  assert.equal(events.at(-1)!.type, 'playbackBlocked');
  assert.equal(session.getSnapshot().recoveryAttempts, 0);
});

test('the default recovery list holds the WeChat bridge', () => {
  assert.equal(wechatIosBridgeRecovery.id, 'wechat-bridge');
  assert.equal(isWechatIosVideo(fakeVideo().video as never), false);
});

test('the loop watch rewinds a clip stalled at its end', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { video, session } = setup();
    video.duration = 10;
    session.configure({ url: 'a' });
    await session.play();
    video.currentTime = 9.9;
    for (let i = 0; i < 3; i++) mock.timers.tick(400);
    assert.equal(video.currentTime, 0, 'rewound after two unchanged polls near the end');
    assert.equal(session.getSnapshot().loopRecoveries, 1);
  } finally {
    mock.timers.reset();
  }
});

test('the presentable frame is reported once a picture is decoded', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { video, session } = setup();
    session.configure({ url: 'a' });
    await session.play();
    Object.assign(video, { readyState: 4, videoWidth: 640, videoHeight: 360 });
    const frames: unknown[] = [];
    assert.equal(
      session.awaitPresentableFrame((f) => frames.push(f)),
      'time-progress',
    );
    video.currentTime = 0.1;
    mock.timers.tick(100);
    video.currentTime = 0.2;
    mock.timers.tick(100);
    assert.equal(frames.length, 1);
    assert.equal((frames[0] as { signal: string }).signal, 'time-progress');
  } finally {
    mock.timers.reset();
  }
});

test('retry keeps the position across the reload; dispose removes the listeners', async () => {
  const { video, calls, session } = setup();
  video.duration = 10;
  session.configure({ url: 'a' });
  await session.play();
  video.currentTime = 4;
  await session.retryFromGesture();
  video.fire('loadedmetadata');
  assert.equal(video.currentTime, 4);
  session.dispose();
  assert.equal(video.listenerCount(), 0);
  assert.ok(calls.includes('remove:src'));
  await assert.rejects(session.play(), (e) => e instanceof EngineError && e.code === 'DISPOSED');
});
