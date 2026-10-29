// SPDX-License-Identifier: Apache-2.0
// The camera session: prepares the photos (download, compile) while the camera opens, then follows the engine's
// recognition: the recognised photo's video is requested only then (streamed by the browser, or downloaded through
// `loadMedia`), one video at a time. Errors become notices;
// the host may reclassify them. State changes are published as one immutable state object.

import type {
  ArErrorClassification,
  ArErrorPhase,
  ArLoadMedia,
  ArNotice,
  ArObservation,
  ArSession,
  ArSessionOptions,
  ArState,
  ArStopOptions,
  ArTarget,
  ArView,
  EngineError,
  EngineEventMap,
  EngineInstance,
  EngineMediaState,
  EngineModule,
  TargetBundle,
} from './api.ts';

const MAX_TARGETS = 10;
const ID_RULE = /^[A-Za-z0-9_.-]{1,128}$/;
/** Photos downloaded and compiled at the same time. */
const PHOTO_CONCURRENCY = 3;

/**
 * `fetch` with cookies for the page's own origin only (never to another origin) and no referrer, reporting progress
 * when the size is known. Same-origin cookies matter: a page behind a login or an access cookie serves its photos and
 * videos only with them.
 */
export const fetchMedia: ArLoadMedia = async (url, request) => {
  const response = await fetch(url, {
    signal: request.signal,
    credentials: 'same-origin',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok)
    throw Object.assign(new Error(`HTTP ${response.status} for ${request.kind}`), { status: response.status });
  const total = Number(response.headers.get('content-length')) || 0;
  const type = response.headers.get('content-type') ?? '';
  if (!response.body || !total || !request.onProgress) return response.blob();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    request.onProgress(Math.min(1, received / total));
  }
  return new Blob(parts as BlobPart[], { type });
};

/** A fatal problem of a run: it ends with this notice. */
class RunStop extends Error {
  readonly notice: ArNotice;
  readonly isStale: boolean;
  constructor(notice: ArNotice, isStale = false) {
    super(notice.key);
    this.notice = notice;
    this.isStale = isStale;
  }
}

interface BoundVideo {
  readonly targetId: string;
  abort: AbortController;
  fact: 'downloading' | 'download-failed' | 'set';
  requestedAt: number;
  /** Played from its URL; 'video-loaded' is reported at its first playback. */
  isStreamed: boolean;
  isReported: boolean;
}

interface Run {
  readonly id: number;
  readonly abort: AbortController;
  readonly targets: readonly ArTarget[];
  isEnded: boolean;
  isCameraOn: boolean;
  wasFound: boolean;
  video: BoundVideo | null;
  readonly mediaFacts: Map<string, EngineMediaState>;
}

const INITIAL: ArState = Object.freeze({
  phase: 'idle',
  view: 'searching',
  progress: null,
  readiness: null,
  isCameraOn: false,
  videoProgress: null,
  notice: null,
  isMuted: true,
  isAdjusting: false,
  isPlaybackBlocked: false,
  isStale: false,
  skippedCount: 0,
  activeTargetId: null,
  isDisposed: false,
});

const sameValue = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) ||
  (!!a && !!b && typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));

/** The notice for an engine error that ended or prevented a start. */
export function noticeForEngineError(error: unknown): ArNotice {
  const e = error as Partial<EngineError> & { missing?: readonly string[] };
  switch (e?.code) {
    case 'CAMERA_PERMISSION_DENIED':
      return { key: 'notice.cameraDenied' };
    case 'CAMERA_UNAVAILABLE':
      return { key: 'notice.cameraUnavailable' };
    case 'CAMERA_ENDED':
      return { key: 'notice.cameraInterrupted' };
    case 'UNSUPPORTED_DEVICE':
      return { key: e.missing?.includes('secure-context') ? 'notice.insecure' : 'notice.unsupported' };
    case 'CAMERA_START_FAILED':
      return { key: 'notice.cameraOrEngine' };
    case 'WORKER_FAILED':
      return { key: 'notice.workerFailure' };
    default:
      return { key: 'notice.startFailed' };
  }
}

/** Problems with the target list itself, as a notice; null when it can run. */
export function checkTargetList(targets: readonly ArTarget[]): ArNotice | null {
  if (!Array.isArray(targets) || targets.length === 0) return { key: 'notice.noTargets' };
  if (targets.length > MAX_TARGETS) return { key: 'notice.tooMany', params: { max: MAX_TARGETS } };
  const ids = new Set<string>();
  for (const t of targets) {
    const hasPhoto = typeof t?.photo === 'string' || (typeof Blob !== 'undefined' && t?.photo instanceof Blob);
    const hasTarget = !!t?.target;
    const hasVideo =
      (typeof t?.video === 'string' && t.video.length > 0) || (typeof Blob !== 'undefined' && t?.video instanceof Blob);
    if (!ID_RULE.test(t?.id ?? '') || ids.has(t.id) || hasPhoto === hasTarget || !hasVideo)
      return { key: 'notice.invalidTargets' };
    ids.add(t.id);
  }
  return null;
}

/** Runs `work` over `items`, at most `limit` at a time, keeping the order of results. */
async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown = null;
  const lane = async (): Promise<void> => {
    while (next < items.length && failure === null) {
      const i = next++;
      try {
        results[i] = await work(items[i]!);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== null) throw failure;
  return results;
}

export function createArSession(options: ArSessionOptions): ArSession {
  let state: ArState = INITIAL;
  const listeners = new Set<() => void>();
  let targets: readonly ArTarget[] = options.targets;
  const loadMedia = options.loadMedia ?? fetchMedia;
  const isStreamed = options.video?.isStreamed ?? !options.loadMedia;
  let module: EngineModule | null = null;
  let engine: EngineInstance | null = null;
  let engineContainer: HTMLElement | null = null;
  let engineListeners: (() => void)[] = [];
  let run: Run | null = null;
  let runs = 0;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let disposing: Promise<void> | null = null;

  const observe = (observation: ArObservation): void => {
    try {
      options.observe?.(observation);
    } catch {
      // Observers never affect the session.
    }
  };

  const classify = (
    cause: unknown,
    phase: ArErrorPhase,
    targetId: string | null,
  ): ArErrorClassification | undefined => {
    try {
      return options.classifyError?.(cause, { phase, targetId }) ?? undefined;
    } catch {
      return undefined;
    }
  };

  const notify = (): void => {
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
        // A failing listener does not stop the others.
      }
  };

  const computeView = (next: ArState): ArView => {
    const r = run;
    const active = next.activeTargetId;
    if (!r || next.phase !== 'scanning') return 'searching';
    if (!active) return r.wasFound ? 'lost' : 'searching';
    if (r.video?.targetId !== active) return 'loading';
    const fact = r.mediaFacts.get(active);
    if (r.video.fact === 'download-failed' || fact === 'error') return 'videoError';
    if (fact === 'playing') return 'playing';
    return 'loading';
  };

  const update = (patch: Partial<ArState>): void => {
    const draft = { ...state, ...patch };
    const next = Object.freeze({ ...draft, view: computeView(draft) });
    const changed = (Object.keys(next) as (keyof ArState)[]).some((k) => !sameValue(state[k], next[k]));
    if (!changed) return;
    state = next;
    notify();
  };

  const isCurrent = (r: Run): boolean => run === r && !r.isEnded;

  // ---- Engine events, routed to the current run ----

  const onEngine = <K extends keyof EngineEventMap>(type: K, listener: (event: EngineEventMap[K]) => void): void => {
    engineListeners.push(engine!.on(type, listener));
  };

  const listen = (): void => {
    onEngine('targetFound', ({ targetId }) => {
      const r = run;
      if (!r || r.isEnded) return;
      r.wasFound = true;
      observe({ type: 'target', name: 'found', targetId });
      bindVideo(r, targetId);
      update({ activeTargetId: targetId });
    });
    onEngine('targetLost', ({ targetId }) => {
      const r = run;
      if (!r || r.isEnded || state.activeTargetId !== targetId) return;
      observe({ type: 'target', name: 'lost', targetId });
      update({ activeTargetId: null, isPlaybackBlocked: false });
    });
    onEngine('viewport', ({ phase }) => {
      if (run && !run.isEnded) update({ isAdjusting: phase === 'begin' });
    });
    onEngine('media', ({ targetId, state: fact, code }) => {
      const r = run;
      if (!r || r.isEnded) return;
      r.mediaFacts.set(targetId, fact);
      const video = r.video;
      if (video?.targetId !== targetId) return update({});
      if (fact === 'playing') {
        if (video.isStreamed && !video.isReported) {
          video.isReported = true;
          const durationMs = Math.round(performance.now() - video.requestedAt);
          observe({ type: 'target', name: 'video-loaded', targetId, durationMs });
        }
        update({ isPlaybackBlocked: false, videoProgress: null, notice: videoNotice() ? null : state.notice });
      } else if (fact === 'blocked') update({ isPlaybackBlocked: true });
      else if (fact === 'error') {
        observe({ type: 'target', name: 'video-failed', targetId, ...(code ? { code } : {}) });
        // A streamed video that cannot be fetched (browsers report a refused or missing file as unsupported).
        if (video.isStreamed && (code === 'network' || code === 'unsupported'))
          videoLoadFailed(r, targetId, Object.assign(new Error(`The video could not be loaded (${code})`), { code }));
        else update({ notice: { key: 'notice.videoPlayFailed' } });
      } else update({});
    });
    onEngine('ended', ({ error }) => {
      const r = run;
      // A failed start is handled where the start is awaited; this is a running camera ending on its own.
      if (!r || r.isEnded || !r.isCameraOn || !error) return;
      const c = classify(error, 'start', null);
      void endRun(r, {
        notice: c?.notice ?? noticeForEngineError(error),
        isStale: !!c?.isStale,
        reason: 'engine-ended',
      });
    });
  };

  /** Whether the notice on screen is about the current video (a successful playback clears it). */
  const videoNotice = (): boolean =>
    !!state.notice &&
    ['notice.videoPlayFailed', 'notice.videoLoadFailed', 'notice.autoplayBlocked', 'notice.emptyVideo'].includes(
      state.notice.key,
    );

  // ---- Videos: one bound at a time, downloaded once its photo is recognised ----

  const releaseVideo = (r: Run): void => {
    const video = r.video;
    if (!video) return;
    r.video = null;
    video.abort.abort();
    try {
      engine?.setTargetProgress(video.targetId, null);
      engine?.setTargetMedia(video.targetId, null);
    } catch {
      // The engine is gone.
    }
  };

  const bindVideo = (r: Run, targetId: string, isRetry = false): void => {
    if (!isRetry && r.video?.targetId === targetId) return;
    releaseVideo(r);
    const target = r.targets.find((t) => t.id === targetId);
    if (!target || !engine) return;
    const video: BoundVideo = {
      targetId,
      abort: new AbortController(),
      fact: 'downloading',
      requestedAt: performance.now(),
      isStreamed: isStreamed && typeof target.video === 'string',
      isReported: false,
    };
    r.video = video;
    const settings = { isLooping: options.video?.isLooping ?? true, fit: options.video?.fit ?? 'contain' };
    const setMedia = (blob: Blob): void => {
      if (blob.size === 0) {
        video.fact = 'download-failed';
        update({ notice: { key: 'notice.emptyVideo' } });
        return;
      }
      video.fact = 'set';
      engine?.setTargetProgress(targetId, null);
      engine?.setTargetMedia(targetId, { file: blob, ...settings });
      update({ videoProgress: null });
    };
    if (typeof target.video !== 'string') return setMedia(target.video);
    observe({ type: 'target', name: 'video-requested', targetId });
    if (video.isStreamed) {
      video.fact = 'set';
      engine.setTargetMedia(targetId, { url: target.video, ...settings });
      return;
    }
    engine.setTargetProgress(targetId, Number.NaN);
    update({ videoProgress: Number.NaN });
    const url = target.video;
    void loadMedia(url, {
      signal: video.abort.signal,
      kind: 'video',
      targetId,
      onProgress: (fraction) => {
        if (r.video !== video || r.isEnded) return;
        engine?.setTargetProgress(targetId, fraction);
        update({ videoProgress: fraction });
      },
    }).then(
      (blob) => {
        if (r.video !== video || r.isEnded) return;
        observe({
          type: 'target',
          name: 'video-loaded',
          targetId,
          bytes: blob.size,
          durationMs: Math.round(performance.now() - video.requestedAt),
        });
        setMedia(blob);
      },
      (cause: unknown) => {
        if (r.video !== video || r.isEnded || video.abort.signal.aborted) return;
        video.fact = 'download-failed';
        engine?.setTargetProgress(targetId, null);
        observe({ type: 'target', name: 'video-failed', targetId, code: 'download' });
        videoLoadFailed(r, targetId, cause);
      },
    );
  };

  /** The video could not be loaded: the host decides between a notice with "Reload" and ending the run. */
  const videoLoadFailed = (r: Run, targetId: string, cause: unknown): void => {
    const c = classify(cause, 'video-load', targetId);
    if (c?.shouldStop)
      void endRun(r, {
        notice: c.notice ?? { key: 'notice.videoLoadFailed' },
        isStale: !!c.isStale,
        reason: 'video-load',
      });
    else
      update({
        notice: c?.notice ?? { key: 'notice.videoLoadFailed' },
        videoProgress: null,
        ...(c?.isStale ? { isStale: true } : {}),
      });
  };

  // ---- Photos ----

  const preparePhotos = async (
    r: Run,
    engineModule: EngineModule,
    onProgress: (done: number) => void,
  ): Promise<TargetBundle[]> => {
    let done = 0;
    let skipped = 0;
    const bundles = await mapLimit(r.targets, PHOTO_CONCURRENCY, async (t): Promise<TargetBundle | null> => {
      // An ended run (no camera, a stop) starts no further photo.
      if (r.abort.signal.aborted) throw new Error('aborted');
      try {
        if (t.target) {
          const bundle = t.target instanceof Uint8Array ? await engineModule.parseTarget(t.target) : t.target;
          if (bundle.targetId !== t.id) throw new RunStop({ key: 'notice.invalidTargets' });
          return bundle;
        }
        let blob: Blob;
        if (typeof t.photo === 'string') {
          try {
            blob = await loadMedia(t.photo, { signal: r.abort.signal, kind: 'photo', targetId: t.id });
          } catch (cause) {
            if (r.abort.signal.aborted) throw cause;
            const c = classify(cause, 'photo-load', t.id);
            throw new RunStop(c?.notice ?? { key: 'notice.photoLoadFailed' }, !!c?.isStale);
          }
        } else blob = t.photo!;
        const started = performance.now();
        try {
          const bundle = await engineModule.compileTargetImage(blob, {
            targetId: t.id,
            maxEdgePx: options.photoMaxEdgePx ?? 640,
            signal: r.abort.signal,
          });
          observe({
            type: 'target',
            name: 'photo-compiled',
            targetId: t.id,
            durationMs: Math.round(performance.now() - started),
          });
          return bundle;
        } catch (cause) {
          if (r.abort.signal.aborted) throw cause;
          const code = (cause as { code?: string }).code ?? '';
          if (['UNSUITABLE_TARGET', 'DECODE_FAILED', 'INVALID_TARGET'].includes(code)) {
            skipped++;
            observe({ type: 'target', name: 'photo-rejected', targetId: t.id, code });
            return null;
          }
          const c = classify(cause, 'photo-compile', t.id);
          throw new RunStop(c?.notice ?? { key: 'notice.startFailed' }, !!c?.isStale);
        }
      } finally {
        onProgress(++done);
      }
    });
    if (isCurrent(r)) update({ skippedCount: skipped });
    const usable = bundles.filter((b): b is TargetBundle => b !== null);
    if (!usable.length) throw new RunStop({ key: 'notice.allRejected' });
    return usable;
  };

  // ---- Runs ----

  const endRun = async (r: Run, end: { notice: ArNotice | null; isStale: boolean; reason: string }): Promise<void> => {
    if (r.isEnded) return;
    r.isEnded = true;
    r.abort.abort();
    releaseVideo(r);
    observe({ type: 'lifecycle', name: 'stop', reason: end.reason });
    try {
      await engine?.stop(end.reason);
    } catch {
      // Stopping never fails the session.
    }
    if (run === r)
      update({
        phase: 'idle',
        notice: end.notice,
        isStale: end.isStale,
        progress: null,
        readiness: null,
        isCameraOn: false,
        videoProgress: null,
        activeTargetId: null,
        isPlaybackBlocked: false,
        isAdjusting: false,
      });
  };

  const runStart = async (r: Run, container: HTMLElement): Promise<void> => {
    observe({ type: 'lifecycle', name: 'start' });
    const total = r.targets.length;
    let photosDone = 0;
    let engineLoaded = false;
    const readiness = (): number =>
      Math.min(
        0.98,
        (engineLoaded ? 0.12 : 0.02) + (total ? 0.58 * (photosDone / total) : 0) + (r.isCameraOn ? 0.28 : 0),
      );
    update({
      phase: 'preparing',
      notice: null,
      isStale: false,
      skippedCount: 0,
      progress: { done: 0, total },
      readiness: readiness(),
      isCameraOn: false,
      videoProgress: null,
      activeTargetId: null,
      isPlaybackBlocked: false,
      isAdjusting: false,
    });
    const problem = checkTargetList(r.targets);
    if (problem) return endRun(r, { notice: problem, isStale: false, reason: 'invalid-targets' });

    // The engine module.
    try {
      const loaded = module ?? (await options.loadEngine());
      if (typeof loaded?.createEngine !== 'function' || typeof loaded.compileTargetImage !== 'function')
        throw new Error('Not a LiveMira engine module');
      module = loaded;
    } catch (cause) {
      if (!isCurrent(r)) return;
      const c = classify(cause, 'engine-load', null);
      return endRun(r, {
        notice: c?.notice ?? { key: 'notice.engineLoadFailed' },
        isStale: !!c?.isStale,
        reason: 'engine-load',
      });
    }
    if (!isCurrent(r)) return;
    engineLoaded = true;
    update({ readiness: readiness() });

    // The engine, once per container.
    if (!engine || engineContainer !== container) {
      for (const off of engineListeners.splice(0)) off();
      const old = engine;
      engine = null;
      await old?.dispose().catch(() => {});
      try {
        engine = module.createEngine({ ...options.engineOptions, container });
      } catch (cause) {
        const c = classify(cause, 'start', null);
        return endRun(r, { notice: c?.notice ?? noticeForEngineError(cause), isStale: !!c?.isStale, reason: 'start' });
      }
      engineContainer = container;
      listen();
      if (!state.isMuted) void engine.media.setMuted(false);
    }
    const current = engine;

    // Photos and camera at the same time: the camera prompt shows while the photos compile.
    const camera = current.start().then(
      () => {
        if (!isCurrent(r)) return;
        r.isCameraOn = true;
        update({ isCameraOn: true, readiness: readiness() });
      },
      (error: unknown) => {
        // No camera: the photos need not finish.
        r.abort.abort();
        throw error;
      },
    );
    const photos = preparePhotos(r, module, (done) => {
      photosDone = done;
      if (isCurrent(r))
        update({
          progress: { done, total },
          readiness: readiness(),
          ...(done === total && !r.isCameraOn ? { phase: 'starting' } : {}),
        });
    });
    // Both settle before deciding, so neither keeps running after a failure of the other.
    const [photoResult, cameraResult] = await Promise.allSettled([
      photos.catch((error: unknown) => {
        r.abort.abort();
        throw error;
      }),
      camera,
    ]);
    if (!isCurrent(r)) return;
    if (cameraResult.status === 'rejected') {
      const cause = cameraResult.reason;
      const c = classify(cause, 'start', null);
      return endRun(r, { notice: c?.notice ?? noticeForEngineError(cause), isStale: !!c?.isStale, reason: 'start' });
    }
    if (photoResult.status === 'rejected') {
      const cause = photoResult.reason;
      const notice = cause instanceof RunStop ? cause.notice : { key: 'notice.startFailed' };
      return endRun(r, { notice, isStale: cause instanceof RunStop && cause.isStale, reason: 'photos' });
    }
    try {
      await current.setTargets(photoResult.value);
    } catch (cause) {
      if (!isCurrent(r)) return;
      return endRun(r, { notice: { key: 'notice.invalidTargets' }, isStale: false, reason: 'targets' });
    }
    if (!isCurrent(r)) return;
    update({ phase: 'scanning', progress: null, readiness: null });
    observe({ type: 'lifecycle', name: 'ready' });
  };

  const session: ArSession = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async start(container) {
      if (state.isDisposed || disposing) return;
      if (stopping) await stopping;
      if (run && !run.isEnded) return starting ?? undefined;
      const r: Run = {
        id: ++runs,
        abort: new AbortController(),
        targets: [...targets],
        isEnded: false,
        isCameraOn: false,
        wasFound: false,
        video: null,
        mediaFacts: new Map(),
      };
      run = r;
      const attempt = runStart(r, container).catch(async () => {
        // Anything unexpected ends the run with the generic notice.
        await endRun(r, { notice: { key: 'notice.startFailed' }, isStale: false, reason: 'error' });
      });
      starting = attempt;
      void attempt.finally(() => {
        if (starting === attempt) starting = null;
      });
      return attempt;
    },
    stop(stopOptions: ArStopOptions = {}) {
      if (stopping) return stopping;
      const r = run;
      if (!r || r.isEnded) {
        if (stopOptions.notice || stopOptions.isStale)
          update({ notice: stopOptions.notice ?? state.notice, isStale: stopOptions.isStale ?? state.isStale });
        return Promise.resolve();
      }
      update({ phase: 'stopping' });
      const attempt = endRun(r, {
        notice: stopOptions.notice ?? null,
        isStale: !!stopOptions.isStale,
        reason: stopOptions.reason ?? 'ui-stop',
      }).finally(() => {
        stopping = null;
      });
      stopping = attempt;
      return attempt;
    },
    setTargets(next) {
      targets = next;
    },
    async setMuted(isMuted) {
      let accepted = true;
      if (engine) {
        try {
          accepted = await engine.media.setMuted(isMuted);
        } catch {
          accepted = false;
        }
      }
      observe({ type: 'sound', isMuted, isAccepted: accepted });
      if (accepted) update({ isMuted, ...(state.isPlaybackBlocked && !isMuted ? { isPlaybackBlocked: false } : {}) });
      else update({ isMuted: true, notice: { key: 'notice.soundRefused' } });
      return accepted;
    },
    async retryVideo() {
      const r = run;
      if (!r || r.isEnded || !engine) return;
      const video = r.video;
      if (video?.fact === 'download-failed') {
        update({ notice: null });
        bindVideo(r, video.targetId, true);
        return;
      }
      update({ notice: null, isPlaybackBlocked: false });
      try {
        await engine.media.retry();
      } catch {
        // The state follows the engine's media events.
      }
    },
    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        await session.stop({ reason: 'dispose' });
        await starting?.catch(() => {});
        for (const off of engineListeners.splice(0)) off();
        const instance = engine;
        engine = null;
        engineContainer = null;
        try {
          await instance?.dispose();
        } catch {
          // Disposal is best effort.
        }
        update({ isDisposed: true });
        listeners.clear();
      })();
      return disposing;
    },
  };
  return session;
}
