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

function scriptedEngine(script: { startError?: Error; compile?: (id: string) => Promise<TargetBundle> } = {}) {
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
      },
      setTargets: engine.setTargets,
      setTargetMedia: engine.setTargetMedia,
      setTargetProgress: engine.setTargetProgress,
      start: engine.start,
      stop: engine.stop,
      dispose: engine.dispose,
      on: engine.on,
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

  // Another photo: the first video is released, the second downloaded.
  engine.emit('targetFound', { targetId: 'p2' });
  await waitFor(session, () => engine.media.has('p2'));
  assert.equal(engine.media.has('p1'), false);
  await session.dispose();
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
