// SPDX-License-Identifier: Apache-2.0
// The camera session against a scripted engine: preparation, recognition, videos, errors and the host's say.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  ArLoadMedia,
  ArSession,
  ArState,
  ArTarget,
  EngineEventMap,
  EngineModule,
  TargetBundle,
} from '../src/api.ts';
import { createArSession } from '../src/session.ts';

const bundle = (id: string): TargetBundle => ({
  format: 'livemira-target/2',
  targetId: id,
  widthPx: 640,
  heightPx: 480,
  pointCount: 500,
  bytes: new Uint8Array([1, 2, 3]),
});

const coded = (code: string): Error => Object.assign(new Error(code), { code });

function scriptedEngine(
  script: {
    startError?: Error;
    compile?: (id: string) => Promise<TargetBundle>;
    /** The camera permission prompt: start() waits for it. */
    startGate?: Promise<void>;
    /** An engine module of an older release. */
    hasNoSuspend?: boolean;
  } = {},
) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const calls: string[] = [];
  const engine = {
    state: 'idle',
    targets: [] as readonly TargetBundle[],
    media: new Map<string, Blob | string>(),
    progress: new Map<string, number>(),
    async setTargets(targets: readonly TargetBundle[]) {
      engine.targets = targets;
    },
    setTargetMedia(id: string, media: { file?: Blob; url?: string } | null) {
      calls.push(`media ${id} ${media ? 'set' : 'clear'}`);
      if (media) engine.media.set(id, media.file ?? media.url!);
      else engine.media.delete(id);
    },
    setTargetProgress(id: string, progress: number | null) {
      if (progress === null) engine.progress.delete(id);
      else engine.progress.set(id, progress);
    },
    async start() {
      calls.push('start');
      await new Promise((r) => setTimeout(r, 5));
      if (script.startGate) await script.startGate;
      if (script.startError) throw script.startError;
      engine.state = 'running';
    },
    async stop(reason?: string) {
      calls.push(`stop ${reason}`);
      engine.state = 'idle';
    },
    async dispose() {
      calls.push('dispose');
    },
    on<K extends keyof EngineEventMap>(type: K, listener: (event: EngineEventMap[K]) => void) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener as (event: unknown) => void);
      return () => set.delete(listener as (event: unknown) => void);
    },
    emit<K extends keyof EngineEventMap>(type: K, event: EngineEventMap[K]) {
      for (const l of listeners.get(type) ?? []) l(event);
    },
    mediaControl: { muted: true },
  };
  const module: EngineModule = {
    createEngine: () => ({
      ...engine,
      get state() {
        return engine.state;
      },
      media: {
        setMuted: async (m: boolean) => {
          engine.mediaControl.muted = m;
          return true;
        },
        retry: async () => {
          calls.push('retry');
          return true;
        },
        selectTarget: (id: string | null) => void calls.push(`select ${id}`),
      },
      setTargets: engine.setTargets,
      setTargetMedia: engine.setTargetMedia,
      setTargetProgress: engine.setTargetProgress,
      start: engine.start,
      stop: engine.stop,
      dispose: engine.dispose,
      on: engine.on,
      ...(script.hasNoSuspend
        ? {}
        : {
            suspend: () => void calls.push('suspend'),
            resume: () => void calls.push('resume'),
          }),
    }),
    compileTargetImage: async (_blob, options) =>
      script.compile ? script.compile(options.targetId) : bundle(options.targetId),
    parseTarget: async () => bundle('stored'),
  };
  return { module, engine, calls };
}

const photo = new Blob([new Uint8Array(10)], { type: 'image/png' });
const pairs = (n: number): ArTarget[] =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, photo, video: `https://videos.example/${i}.mp4` }));

function waitFor(session: ArSession, predicate: (s: ArState) => boolean, ms = 2000): Promise<ArState> {
  return new Promise((resolve, reject) => {
    if (predicate(session.getState())) return resolve(session.getState());
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timeout; state: ${JSON.stringify(session.getState())}`));
    }, ms);
    const off = session.subscribe(() => {
      if (!predicate(session.getState())) return;
      clearTimeout(timer);
      off();
      resolve(session.getState());
    });
  });
}

const container = {} as HTMLElement;

test('prepares photos while the camera opens, then recognises, downloads and plays one video at a time', async () => {
  const { module, engine } = scriptedEngine();
  const phases: string[] = [];
  const loads: string[] = [];
  const loadMedia: ArLoadMedia = async (url, request) => {
    loads.push(`${request.kind} ${url}`);
    request.onProgress?.(0.5);
    return new Blob([new Uint8Array(100)], { type: 'video/mp4' });
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(3), loadMedia });
  session.subscribe(() => {
    const p = session.getState().phase;
    if (phases.at(-1) !== p) phases.push(p);
  });
  await session.start(container);
  const s = session.getState();
  assert.equal(s.phase, 'scanning');
  assert.deepEqual(
    phases.filter((p) => p !== 'starting'),
    ['preparing', 'scanning'],
  );
  assert.equal(s.isCameraOn, true);
  assert.equal(s.readiness, null);
  assert.equal(engine.targets.length, 3);
  assert.equal(loads.length, 0, 'no video before recognition');

  engine.emit('targetFound', { targetId: 'p1' });
  assert.equal(session.getState().view, 'loading');
  await waitFor(session, () => engine.media.has('p1'));
  assert.deepEqual(loads, ['video https://videos.example/1.mp4']);
  engine.emit('media', { targetId: 'p1', state: 'playing' });
  assert.equal(session.getState().view, 'playing');
  engine.emit('targetLost', { targetId: 'p1', reason: 'out-of-view' });
  assert.equal(session.getState().view, 'lost');

  // Another photo: the second video is downloaded, the first stays loaded.
  engine.emit('targetFound', { targetId: 'p2' });
  await waitFor(session, () => engine.media.has('p2'));
  assert.equal(engine.media.has('p1'), true);
  await session.dispose();
  assert.equal(engine.media.size, 0, 'a dispose releases them all');
  assert.equal(session.getState().isDisposed, true);
});

test('by default a video URL is streamed: handed to the engine at recognition, reported at its first playback', async () => {
  const { module, engine, calls } = scriptedEngine();
  const observed: string[] = [];
  const phases: string[] = [];
  const session = createArSession({
    loadEngine: () => module,
    targets: pairs(2),
    observe: (o) => {
      if (o.type === 'target' && o.name.startsWith('video')) observed.push(`${o.name} ${o.durationMs ?? ''}`.trim());
    },
    classifyError: (_cause, { phase }) => {
      phases.push(phase);
    },
  });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  assert.equal(engine.media.get('p0'), 'https://videos.example/0.mp4', 'the URL itself, no download');
  assert.equal(engine.progress.has('p0'), false);
  assert.deepEqual([session.getState().view, session.getState().videoProgress], ['loading', null]);
  engine.emit('media', { targetId: 'p0', state: 'playing' });
  assert.equal(session.getState().view, 'playing');
  assert.match(observed.join('|'), /^video-requested\|video-loaded \d+$/);

  // The file cannot be fetched: a load failure the host may classify, with "Reload".
  engine.emit('media', { targetId: 'p0', state: 'error', code: 'unsupported' });
  assert.deepEqual([session.getState().view, session.getState().notice?.key], ['videoError', 'notice.videoLoadFailed']);
  assert.deepEqual(phases, ['video-load']);
  await session.retryVideo();
  assert.ok(calls.includes('retry'));
  await session.dispose();
});

test('unsuitable photos are skipped; when none is left the run ends with a notice', async () => {
  const some = scriptedEngine({
    compile: async (id) => (id === 'p0' ? Promise.reject(coded('UNSUITABLE_TARGET')) : bundle(id)),
  });
  const a = createArSession({ loadEngine: () => some.module, targets: pairs(2) });
  await a.start(container);
  assert.equal(a.getState().phase, 'scanning');
  assert.equal(a.getState().skippedCount, 1);
  assert.deepEqual(
    some.engine.targets.map((t) => t.targetId),
    ['p1'],
  );

  const none = scriptedEngine({ compile: async () => Promise.reject(coded('UNSUITABLE_TARGET')) });
  const b = createArSession({ loadEngine: () => none.module, targets: pairs(2) });
  await b.start(container);
  assert.equal(b.getState().phase, 'idle');
  assert.equal(b.getState().notice?.key, 'notice.allRejected');
});

test('a refused camera ends the run with its notice and stops the photo work', async () => {
  let compiled = 0;
  const { module } = scriptedEngine({
    startError: coded('CAMERA_PERMISSION_DENIED'),
    compile: async (id) => {
      await new Promise((r) => setTimeout(r, 30));
      compiled++;
      return bundle(id);
    },
  });
  const session = createArSession({ loadEngine: () => module, targets: pairs(6) });
  await session.start(container);
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'notice.cameraDenied');
  assert.ok(compiled < 6, `photo work stopped early (${compiled} compiled)`);
  const unsupported = scriptedEngine({
    startError: Object.assign(coded('UNSUPPORTED_DEVICE'), { missing: ['webgl2'] }),
  });
  const u = createArSession({ loadEngine: () => unsupported.module, targets: pairs(1) });
  await u.start(container);
  assert.equal(u.getState().notice?.key, 'notice.unsupported');
});

test('a failed video download keeps the camera; "reload video" downloads it again', async () => {
  const { module, engine } = scriptedEngine();
  let attempts = 0;
  const loadMedia: ArLoadMedia = async () => {
    attempts++;
    if (attempts === 1) throw new Error('network');
    return new Blob([new Uint8Array(5)]);
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(1), loadMedia });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  const failed = await waitFor(session, (s) => s.view === 'videoError');
  assert.equal(failed.notice?.key, 'notice.videoLoadFailed');
  assert.equal(failed.phase, 'scanning');
  await session.retryVideo();
  await waitFor(session, () => engine.media.has('p0'));
  assert.equal(session.getState().notice, null);
  assert.equal(attempts, 2);
});

test('the host decides what an error means: an expired video link ends the run as stale', async () => {
  const { module, engine, calls } = scriptedEngine();
  const session = createArSession({
    loadEngine: () => module,
    targets: pairs(1),
    loadMedia: async () => Promise.reject(Object.assign(new Error('gone'), { status: 404 })),
    classifyError: (cause, context) =>
      context.phase === 'video-load' && (cause as { status?: number }).status === 404
        ? { shouldStop: true, isStale: true, notice: { key: 'host.videoExpired' } }
        : undefined,
  });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  const ended = await waitFor(session, (s) => s.phase === 'idle');
  assert.equal(ended.isStale, true);
  assert.equal(ended.notice?.key, 'host.videoExpired');
  assert.ok(calls.includes('stop video-load'));
});

test('invalid target lists and engine load failures become notices', async () => {
  const { module } = scriptedEngine();
  const dup = createArSession({ loadEngine: () => module, targets: [...pairs(1), ...pairs(1)] });
  await dup.start(container);
  assert.equal(dup.getState().notice?.key, 'notice.invalidTargets');
  const many = createArSession({ loadEngine: () => module, targets: pairs(11) });
  await many.start(container);
  assert.deepEqual(many.getState().notice, { key: 'notice.tooMany', params: { max: 10 } });
  const broken = createArSession({ loadEngine: () => Promise.reject(new Error('offline')), targets: pairs(1) });
  await broken.start(container);
  assert.equal(broken.getState().notice?.key, 'notice.engineLoadFailed');
});

test('precompiled targets skip compilation; a bundle for another id is refused', async () => {
  const { module, engine } = scriptedEngine();
  const ok = createArSession({
    loadEngine: () => module,
    targets: [{ id: 'stored', target: new Uint8Array([9]), video: 'v.mp4' }],
  });
  await ok.start(container);
  assert.equal(ok.getState().phase, 'scanning');
  assert.deepEqual(
    engine.targets.map((t) => t.targetId),
    ['stored'],
  );
  const wrong = createArSession({
    loadEngine: () => module,
    targets: [{ id: 'other', target: bundle('stored'), video: 'v.mp4' }],
  });
  await wrong.start(container);
  assert.equal(wrong.getState().notice?.key, 'notice.invalidTargets');
});

test('a stop while preparing ends the run at once; the next start runs again', async () => {
  const { module, calls } = scriptedEngine({
    compile: async (id) => {
      await new Promise((r) => setTimeout(r, 40));
      return bundle(id);
    },
  });
  const session = createArSession({ loadEngine: () => module, targets: pairs(3) });
  const run = session.start(container);
  await waitFor(session, (s) => s.phase === 'preparing' && s.isCameraOn);
  await session.stop({ reason: 'page-hidden', notice: { key: 'notice.backgrounded' } });
  await run;
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'notice.backgrounded');
  assert.ok(calls.includes('stop page-hidden'));
  await session.start(container);
  assert.equal(session.getState().phase, 'scanning');
  await session.dispose();
});

// ---- Lifecycle: videos kept per run, suspend/resume, stop and the camera permission ----

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const video = (bytes = 100): Blob => new Blob([new Uint8Array(bytes)], { type: 'video/mp4' });
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('A, B, A: each video is requested once and stays loaded while the target is lost and found again', async () => {
  const { module, engine, calls } = scriptedEngine();
  const requests: string[] = [];
  const loadMedia: ArLoadMedia = async (_url, request) => {
    requests.push(`${request.kind} ${request.targetId}`);
    return video();
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(2), loadMedia });
  await session.start(container);
  for (const id of ['p0', 'p1', 'p0', 'p1', 'p0']) {
    engine.emit('targetFound', { targetId: id });
    await tick(2);
    engine.emit('media', { targetId: id, state: 'playing' });
    assert.equal(session.getState().view, 'playing');
    engine.emit('targetLost', { targetId: id, reason: 'out-of-view' });
  }
  assert.deepEqual(requests, ['video p0', 'video p1']);
  assert.equal(calls.filter((c) => c.startsWith('media')).length, 2, 'the engine is given each video once');
  assert.equal(
    calls.some((c) => c.endsWith('clear')),
    false,
    'nothing released on a switch',
  );
  assert.deepEqual([...engine.media.keys()].sort(), ['p0', 'p1']);
  await session.dispose();
});

test('one video plays at a time: the recognised photo is selected, the kept videos stay paused', async () => {
  const { module, engine, calls } = scriptedEngine();
  const session = createArSession({ loadEngine: () => module, targets: pairs(2) });
  await session.start(container);
  const selections = (): string[] => calls.filter((c) => c.startsWith('select '));
  assert.deepEqual(selections(), ['select null'], 'nothing plays before a photo is recognised');
  // Both photos in view: B is found after A and becomes the one that plays.
  engine.emit('targetFound', { targetId: 'p0' });
  engine.emit('targetFound', { targetId: 'p1' });
  assert.deepEqual(selections().slice(1), ['select p0', 'select p1']);
  assert.equal(session.getState().activeTargetId, 'p1');
  engine.emit('targetLost', { targetId: 'p1', reason: 'out-of-view' });
  engine.emit('targetFound', { targetId: 'p0' });
  assert.deepEqual(selections().slice(3), ['select null', 'select p0']);
  assert.deepEqual([...engine.media.keys()].sort(), ['p0', 'p1'], 'no video was released');
  await session.dispose();
});

test('streamed videos are also handed over once per target', async () => {
  const { module, engine, calls } = scriptedEngine();
  const session = createArSession({ loadEngine: () => module, targets: pairs(2) });
  await session.start(container);
  for (const id of ['p0', 'p1', 'p0']) {
    engine.emit('targetFound', { targetId: id });
    engine.emit('targetLost', { targetId: id, reason: 'out-of-view' });
  }
  assert.deepEqual(
    calls.filter((c) => c.startsWith('media')),
    ['media p0 set', 'media p1 set'],
  );
  await session.dispose();
});

test('a download that completes while its photo is out of view is kept and does not disturb the visible one', async () => {
  const { module, engine } = scriptedEngine();
  const gates = new Map<string, ReturnType<typeof deferred<Blob>>>();
  const loadMedia: ArLoadMedia = (_url, request) => {
    const gate = deferred<Blob>();
    gates.set(request.targetId, gate);
    request.onProgress?.(0.5);
    return gate.promise;
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(2), loadMedia });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  assert.equal(session.getState().videoProgress, 0.5);
  engine.emit('targetLost', { targetId: 'p0', reason: 'out-of-view' });
  engine.emit('targetFound', { targetId: 'p1' });
  assert.equal(session.getState().activeTargetId, 'p1');
  gates.get('p0')!.resolve(video());
  await tick();
  assert.equal(engine.media.has('p0'), true, 'p0 loaded in the background');
  assert.equal(engine.progress.has('p0'), false);
  assert.equal(session.getState().view, 'loading', 'p1 is still loading');
  assert.equal(session.getState().videoProgress, 0.5, 'the progress shown is the one of p1');
  gates.get('p1')!.resolve(video());
  await tick();
  assert.equal(engine.media.has('p1'), true);
  await session.dispose();
});

test('a download that fails while its photo is out of view is reported when the photo is found; "reload" retries it', async () => {
  const { module, engine } = scriptedEngine();
  const attempts = new Map<string, number>();
  const gate = deferred<Blob>();
  const classified: (string | null)[] = [];
  const loadMedia: ArLoadMedia = async (_url, request) => {
    attempts.set(request.targetId, (attempts.get(request.targetId) ?? 0) + 1);
    if (request.targetId === 'p0' && attempts.get('p0') === 1) return gate.promise;
    return video();
  };
  const session = createArSession({
    loadEngine: () => module,
    targets: pairs(2),
    loadMedia,
    classifyError: (_cause, context) => {
      classified.push(context.targetId);
    },
  });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  engine.emit('targetLost', { targetId: 'p0', reason: 'out-of-view' });
  engine.emit('targetFound', { targetId: 'p1' });
  await tick();
  gate.reject(new Error('network'));
  await tick();
  assert.equal(session.getState().notice, null, 'no notice about a video nobody is looking at');
  assert.deepEqual(classified, [], 'the host is asked when it matters');

  engine.emit('targetLost', { targetId: 'p1', reason: 'out-of-view' });
  engine.emit('targetFound', { targetId: 'p0' });
  assert.equal(session.getState().view, 'videoError');
  assert.equal(session.getState().notice?.key, 'notice.videoLoadFailed');
  assert.deepEqual(classified, ['p0']);
  await session.retryVideo();
  await waitFor(session, () => engine.media.has('p0'));
  assert.equal(attempts.get('p0'), 2);
  assert.equal(attempts.get('p1'), 1);
  assert.equal(session.getState().notice, null);
  await session.dispose();
});

test('a stop aborts every download, releases the videos and ignores what arrives afterwards', async () => {
  const { module, engine } = scriptedEngine();
  const signals: AbortSignal[] = [];
  const gates: ReturnType<typeof deferred<Blob>>[] = [];
  const loadMedia: ArLoadMedia = (_url, request) => {
    signals.push(request.signal);
    const gate = deferred<Blob>();
    gates.push(gate);
    return gate.promise;
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(3), loadMedia });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  engine.emit('targetLost', { targetId: 'p0', reason: 'out-of-view' });
  engine.emit('targetFound', { targetId: 'p1' });
  assert.equal(signals.length, 2);
  await session.stop({ reason: 'ui-stop' });
  assert.deepEqual(
    signals.map((s) => s.aborted),
    [true, true],
  );
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().videoProgress, null);
  gates[0]!.resolve(video());
  gates[1]!.reject(new Error('late'));
  await tick();
  assert.equal(engine.media.size, 0, 'a late completion sets nothing');
  assert.equal(session.getState().notice, null, 'a late failure says nothing');
  await session.dispose();
});

test('an explicit stop clears the loaded videos; the next run requests them again', async () => {
  const { module, engine } = scriptedEngine();
  let requests = 0;
  const loadMedia: ArLoadMedia = async () => {
    requests++;
    return video();
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(2), loadMedia });
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  await waitFor(session, () => engine.media.has('p0'));
  await session.stop();
  assert.equal(engine.media.size, 0);
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  await waitFor(session, () => engine.media.has('p0'));
  assert.equal(requests, 2);
  await session.dispose();
});

test('suspend keeps the engine and every loaded video; resume goes on without requesting anything again', async () => {
  const { module, engine, calls } = scriptedEngine();
  let requests = 0;
  const loadMedia: ArLoadMedia = async () => {
    requests++;
    return video();
  };
  const session = createArSession({ loadEngine: () => module, targets: pairs(2), loadMedia });
  assert.equal(session.suspend(), false, 'nothing to suspend before a run');
  await session.start(container);
  engine.emit('targetFound', { targetId: 'p0' });
  await waitFor(session, () => engine.media.has('p0'));
  engine.emit('media', { targetId: 'p0', state: 'playing' });

  assert.equal(session.suspend(), true);
  assert.equal(session.suspend(), true, 'idempotent');
  engine.emit('targetLost', { targetId: 'p0', reason: 'suspended' });
  assert.equal(session.getState().isSuspended, true);
  assert.equal(session.getState().phase, 'scanning', 'the run goes on');
  assert.equal(engine.media.has('p0'), true);
  assert.equal(calls.filter((c) => c === 'suspend').length, 1);
  assert.equal(
    calls.some((c) => c.startsWith('stop') || c === 'dispose'),
    false,
    'no teardown',
  );

  session.resume();
  session.resume();
  assert.equal(session.getState().isSuspended, false);
  assert.equal(calls.filter((c) => c === 'resume').length, 1);
  engine.emit('targetFound', { targetId: 'p0' });
  assert.equal(requests, 1);
  assert.equal(session.getState().activeTargetId, 'p0');
  await session.dispose();
});

test('suspend before the engine exists starts the run suspended; an engine without suspend ends it', async () => {
  const early = scriptedEngine();
  const session = createArSession({ loadEngine: () => early.module, targets: pairs(1) });
  const run = session.start(container);
  assert.equal(session.suspend(), true, 'accepted while the engine is still loading');
  await run;
  assert.equal(session.getState().isSuspended, true);
  assert.ok(early.calls.includes('suspend'));
  session.resume();
  assert.equal(early.calls.includes('resume'), true);
  await session.dispose();

  const old = scriptedEngine({ hasNoSuspend: true });
  const legacy = createArSession({ loadEngine: () => old.module, targets: pairs(1) });
  await legacy.start(container);
  assert.equal(legacy.suspend(), false, 'the caller stops instead');
  assert.equal(legacy.getState().isSuspended, false);
  await legacy.dispose();

  const hidden = scriptedEngine({ hasNoSuspend: true });
  const racing = createArSession({ loadEngine: () => hidden.module, targets: pairs(1) });
  const raced = racing.start(container);
  racing.suspend();
  await raced;
  assert.equal(racing.getState().phase, 'idle');
  assert.equal(racing.getState().notice?.key, 'notice.backgrounded');
});

test('a stop clears a pending suspend: the next run is not suspended', async () => {
  const { module } = scriptedEngine();
  const session = createArSession({ loadEngine: () => module, targets: pairs(1) });
  await session.start(container);
  session.suspend();
  await session.stop();
  assert.equal(session.getState().isSuspended, false);
  await session.start(container);
  assert.equal(session.getState().isSuspended, false);
  await session.dispose();
});

test('waiting for the camera permission: photos finish, no made-up percentage, a late grant after a stop is ignored', async () => {
  const gate = deferred();
  const { module } = scriptedEngine({ startGate: gate.promise });
  const readiness: (number | null)[] = [];
  const session = createArSession({ loadEngine: () => module, targets: pairs(3) });
  session.subscribe(() => {
    const r = session.getState().readiness;
    if (readiness.at(-1) !== r) readiness.push(r);
  });
  const run = session.start(container);
  const waiting = await waitFor(session, (s) => s.phase === 'starting');
  assert.equal(waiting.isCameraOn, false);
  assert.deepEqual(waiting.progress, { done: 3, total: 3 });
  assert.equal(waiting.readiness, 1, 'the photos are all prepared; the permission is not part of the measure');
  assert.ok(
    readiness.every((r) => r === null || [0, 1 / 3, 2 / 3, 1].includes(r)),
    `only photo counts: ${readiness.join(',')}`,
  );
  const stopped = session.stop({ reason: 'ui-stop' });
  gate.resolve();
  await Promise.all([stopped, run]);
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().isCameraOn, false, 'a grant after the stop does not turn the run on');
  await session.dispose();
});

test('before the engine is loaded the readiness is unknown, not a percentage', async () => {
  const { module } = scriptedEngine();
  const gate = deferred<EngineModule>();
  const session = createArSession({ loadEngine: () => gate.promise, targets: pairs(2) });
  const run = session.start(container);
  assert.equal(session.getState().phase, 'preparing');
  assert.equal(session.getState().readiness, null);
  gate.resolve(module);
  await run;
  assert.equal(session.getState().phase, 'scanning');
  assert.equal(session.getState().readiness, null);
  await session.dispose();
});

test('a camera that cannot start ends the run with its notice and keeps no video', async () => {
  const { module, engine } = scriptedEngine({ startError: coded('CAMERA_START_FAILED') });
  const session = createArSession({ loadEngine: () => module, targets: pairs(2) });
  await session.start(container);
  assert.equal(session.getState().phase, 'idle');
  assert.equal(session.getState().notice?.key, 'notice.cameraOrEngine');
  assert.equal(engine.media.size, 0);
  await session.start(container);
  assert.equal(session.getState().notice?.key, 'notice.cameraOrEngine', 'a retry runs the same way');
});
