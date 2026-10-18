/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The headless camera session: turns photos into targets, starts the engine, downloads a video once its photo is
// recognized and keeps a small state for a view. The engine draws the camera, masks view changes, shows and reveals
// the video and ends its session when the page is hidden; this file only follows its events.
//
// Every run has its own AbortController: anything a stopped or replaced run started (an engine import, a photo, a
// compile, a video download) is ignored when it finishes late. One video is bound at a time, like the overlay shows
// one at a time: recognizing another photo cancels the previous download and releases the previous video.

import type * as LiveMira from '@livemira/engine';

import type {
  ArClassifyError,
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
  EngineModule,
} from './types.ts';

const MAX_TARGETS = 10;
const TARGET_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const UI_STOP = 'ui-stop';

/** Facts of the bound video. 'failed' is latched until the video is reloaded or another target is bound. */
type VideoFact = 'downloading' | 'loading' | 'playing' | 'download-failed' | 'failed';

interface Run {
  readonly id: number;
  readonly controller: AbortController;
  /** First notice of this run; later terminal events never replace it. */
  notice: ArNotice | null;
  isEnded: boolean;
  /** Code of `sessionStartFailed`, read when `engine.start()` rejects. */
  startFailure: string | null;
  hasFound: boolean;
  newestEpoch: number;
  pendingEpoch: number | null;
}

interface BoundVideo {
  readonly targetId: string;
  readonly controller: AbortController;
  fact: VideoFact;
  /** The downloaded or given file, kept to bind it again with another sound setting. */
  file: Blob | null;
}

const notice = (key: string, params?: Record<string, string | number>): ArNotice =>
  params ? { key, params } : { key };

const errorCode = (cause: unknown): string | null =>
  typeof cause === 'object' &&
  cause !== null &&
  typeof (cause as { code?: unknown }).code === 'string'
    ? (cause as { code: string }).code
    : null;

const isAbort = (cause: unknown, signal: AbortSignal): boolean =>
  signal.aborted ||
  errorCode(cause) === 'ABORTED' ||
  (cause instanceof Error && cause.name === 'AbortError');

const DEFAULT_NOTICES: Readonly<Record<ArErrorPhase, string>> = {
  'engine-load': 'notice.engineLoadFailed',
  'photo-load': 'notice.photoLoadFailed',
  'photo-compile': 'notice.startFailed',
  start: 'notice.cameraOrEngine',
  'video-load': 'notice.videoLoadFailed',
};

/** Why the engine ended a session by itself, as a notice. */
const ENDED_NOTICES: Readonly<Record<string, string>> = {
  'camera-suspended': 'notice.backgrounded',
  'camera-error': 'notice.cameraInterrupted',
  'worker-failure': 'notice.workerFailure',
};

/** Why a start failed, from the engine's error code. */
const START_NOTICES: Readonly<Record<string, string>> = {
  CAMERA_PERMISSION_DENIED: 'notice.cameraDenied',
  CAMERA_SUSPENDED: 'notice.backgrounded',
};

const AUTOPLAY_BLOCKED = 'notice.autoplayBlocked';

const defaultLoadMedia: ArLoadMedia = async (url, { signal }) => {
  const response = await fetch(url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  return response.blob();
};

/** Why a target list cannot start, or null. */
function invalidTargets(targets: readonly ArTarget[]): ArNotice | null {
  if (targets.length === 0) return notice('notice.noTargets');
  if (targets.length > MAX_TARGETS) return notice('notice.tooMany', { max: MAX_TARGETS });
  const ids = new Set<string>();
  for (const target of targets) {
    const isUsable =
      typeof target.id === 'string' &&
      TARGET_ID.test(target.id) &&
      !ids.has(target.id) &&
      (target.target !== undefined
        ? target.target.targetId === target.id
        : target.photo instanceof Blob || typeof target.photo === 'string') &&
      (target.video instanceof Blob || typeof target.video === 'string');
    if (!isUsable) return notice('notice.invalidTargets');
    ids.add(target.id);
  }
  return null;
}

export function createArSession(options: ArSessionOptions): ArSession {
  const loadMedia = options.loadMedia ?? defaultLoadMedia;
  const listeners = new Set<() => void>();
  let targets = [...options.targets];
  let module: EngineModule | null = null;
  let engine: LiveMira.Engine | null = null;
  let engineContainer: HTMLElement | null = null;
  let unsubscribeEngine: (() => void) | null = null;
  let run: Run | null = null;
  let runCounter = 0;
  let starting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let disposing: Promise<void> | null = null;
  let video: BoundVideo | null = null;
  let lastNotified = '';
  let state: Omit<ArState, 'view'> & { view?: never } = {
    phase: 'idle',
    progress: null,
    notice: null,
    isMuted: true,
    isAdjusting: false,
    isPlaybackBlocked: false,
    isStale: false,
    skippedCount: 0,
    activeTargetId: null,
    isDisposed: false,
  };

  const observe = (observation: ArObservation): void => {
    try {
      options.observe?.(observation);
    } catch {
      // An observer never affects the session.
    }
  };

  const view = (): ArView => {
    if (state.phase !== 'scanning') return 'searching';
    if (state.activeTargetId === null) return run?.hasFound ? 'lost' : 'searching';
    if (video?.targetId !== state.activeTargetId) return 'loading';
    if (video.fact === 'failed' || video.fact === 'download-failed') return 'videoError';
    return video.fact === 'playing' ? 'playing' : 'loading';
  };

  const snapshot = (): ArState => Object.freeze({ ...state, view: view() });

  const notify = (): void => {
    const current = JSON.stringify(snapshot());
    if (current === lastNotified) return;
    lastNotified = current;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failing listener never affects the session or the other listeners.
      }
    }
  };

  const update = (change: Partial<Omit<ArState, 'view'>>): void => {
    state = { ...state, ...change };
    notify();
  };

  const isCurrent = (candidate: Run): boolean => run === candidate && !candidate.isEnded;

  /** The host's classification merged over the default; phases before scanning always end the run. */
  const classify = (
    classifier: ArClassifyError | undefined,
    cause: unknown,
    phase: ArErrorPhase,
    targetId: string | null,
  ): Required<Pick<ArErrorClassification, 'notice' | 'shouldStop' | 'isStale'>> => {
    let own: ArErrorClassification | void;
    try {
      own = classifier?.(cause, { phase, targetId });
    } catch {
      // A failing classifier keeps the default.
      own = undefined;
    }
    return {
      notice: own?.notice ?? notice(DEFAULT_NOTICES[phase]),
      shouldStop: phase === 'video-load' ? own?.shouldStop === true : true,
      isStale: own?.isStale === true,
    };
  };

  // --- video -----------------------------------------------------------------------------------------------------

  const mediaOf = (file: Blob): LiveMira.TargetMedia => ({
    file,
    isMuted: state.isMuted,
    ...(options.video?.isLooping !== undefined ? { isLooping: options.video.isLooping } : {}),
    ...(options.video?.fit !== undefined ? { fit: options.video.fit } : {}),
  });

  const releaseVideo = (): void => {
    const previous = video;
    if (!previous) return;
    video = null;
    previous.controller.abort();
    try {
      engine?.setTargetMedia(previous.targetId, null);
    } catch {
      // The engine may already be disposed; its own disposal releases the media.
    }
  };

  const bindFile = (bound: BoundVideo, file: Blob): void => {
    bound.file = file;
    bound.fact = 'loading';
    engine?.setTargetMedia(bound.targetId, mediaOf(file));
  };

  const downloadVideo = (current: Run, bound: BoundVideo, url: string): void => {
    const began = Date.now();
    bound.fact = 'downloading';
    observe({ type: 'target', name: 'video-requested', targetId: bound.targetId });
    loadMedia(url, {
      signal: bound.controller.signal,
      kind: 'video',
      targetId: bound.targetId,
    }).then(
      (file) => {
        if (!isCurrent(current) || video !== bound || bound.controller.signal.aborted) return;
        if (file.size === 0) {
          observe({
            type: 'target',
            name: 'video-failed',
            targetId: bound.targetId,
            code: 'empty',
          });
          bound.fact = 'download-failed';
          update({ notice: notice('notice.emptyVideo') });
          return;
        }
        observe({
          type: 'target',
          name: 'video-loaded',
          targetId: bound.targetId,
          durationMs: Date.now() - began,
          bytes: file.size,
        });
        try {
          bindFile(bound, file);
        } catch {
          bound.fact = 'failed';
          update({ notice: notice('notice.videoPlayFailed') });
          return;
        }
        notify();
      },
      (cause: unknown) => {
        if (!isCurrent(current) || video !== bound || isAbort(cause, bound.controller.signal))
          return;
        observe({
          type: 'target',
          name: 'video-failed',
          targetId: bound.targetId,
          code: errorCode(cause) ?? 'load',
        });
        bound.fact = 'download-failed';
        const outcome = classify(options.classifyError, cause, 'video-load', bound.targetId);
        if (outcome.shouldStop) {
          void stopRun(current, { notice: outcome.notice, isStale: outcome.isStale });
          return;
        }
        update({ notice: outcome.notice, ...(outcome.isStale ? { isStale: true } : {}) });
      },
    );
  };

  /** Binds the video of a recognized target; a failed one is reloaded only by `retryVideo`. */
  const showVideo = (current: Run, targetId: string): void => {
    if (video?.targetId === targetId) return;
    releaseVideo();
    const target = targets.find((t) => t.id === targetId);
    if (!target) return;
    const bound: BoundVideo = {
      targetId,
      controller: new AbortController(),
      fact: 'loading',
      file: null,
    };
    video = bound;
    state = { ...state, isPlaybackBlocked: false };
    if (typeof target.video === 'string') downloadVideo(current, bound, target.video);
    else {
      try {
        bindFile(bound, target.video);
      } catch {
        bound.fact = 'failed';
      }
    }
  };

  // --- engine events ---------------------------------------------------------------------------------------------

  const onEngineEvent = <K extends keyof LiveMira.EngineEvents>(
    name: K,
    event: LiveMira.EngineEvents[K],
  ): void => {
    observe({ type: 'engine', name, event });
    const current = run;
    if (!current || current.isEnded) return;
    switch (name) {
      case 'sessionStartFailed':
        current.startFailure = (event as LiveMira.EngineEvents['sessionStartFailed']).code;
        return;
      case 'sessionEnded': {
        const reason = (event as LiveMira.EngineEvents['sessionEnded']).reason;
        // A stop of the UI and a failed start are handled where they happen.
        if (reason === UI_STOP || reason === 'start-failed' || reason === 'start-cancelled') return;
        if (state.phase !== 'scanning') return;
        void endRun(current, {
          notice: notice(ENDED_NOTICES[reason] ?? 'notice.cameraInterrupted'),
        });
        return;
      }
      default:
    }
    if (state.phase !== 'scanning') return;
    switch (name) {
      case 'targetFound':
      case 'targetUpdated': {
        const targetId = (event as LiveMira.EngineEvents['targetFound']).result.targetId;
        if (!targetId) return;
        if (name === 'targetFound') observe({ type: 'target', name: 'found', targetId });
        current.hasFound = true;
        showVideo(current, targetId);
        update({ activeTargetId: targetId });
        return;
      }
      case 'targetLost': {
        const targetId = (event as LiveMira.EngineEvents['targetLost']).targetId;
        if (targetId) observe({ type: 'target', name: 'lost', targetId });
        // The video stays bound: the same photo found again (also after a rotation) continues without a download.
        if (
          state.activeTargetId !== null &&
          (targetId === null || targetId === state.activeTargetId)
        )
          update({ activeTargetId: null });
        return;
      }
      case 'viewportTransition': {
        const transition = event as LiveMira.EngineEvents['viewportTransition'];
        if (!Number.isSafeInteger(transition.epoch) || transition.epoch < 0) return;
        if (transition.phase === 'begin') {
          if (transition.epoch < current.newestEpoch) return;
          current.newestEpoch = transition.epoch;
          current.pendingEpoch = transition.epoch;
          update({ isAdjusting: true });
        } else if (transition.epoch === current.pendingEpoch) {
          current.pendingEpoch = null;
          update({ isAdjusting: false });
        }
        return;
      }
      case 'mediaState': {
        const media = event as LiveMira.EngineEvents['mediaState'];
        if (!video || media.targetId !== video.targetId) return;
        const bound = video;
        switch (media.state) {
          case 'playing':
            bound.fact = 'playing';
            update({
              isPlaybackBlocked: false,
              ...(state.notice?.key === AUTOPLAY_BLOCKED ? { notice: null } : {}),
            });
            return;
          case 'loading':
          case 'pause':
          case 'waiting':
          case 'ended':
            if (bound.fact === 'playing') bound.fact = 'loading';
            notify();
            return;
          case 'error':
            bound.fact = 'failed';
            update({ notice: notice('notice.videoPlayFailed') });
            return;
          case 'loading-failed':
            // A blocked autoplay is not a failure: `playbackBlocked` follows and a tap resumes it.
            if (media.media.presentation?.failureReason === 'playback-blocked') return;
            bound.fact = 'failed';
            update({ notice: notice('notice.videoPlayFailed') });
            return;
          default:
            return;
        }
      }
      case 'playbackBlocked':
        if (
          video &&
          (event as LiveMira.EngineEvents['playbackBlocked']).targetId === video.targetId
        )
          // Only a notice: there is no extra "tap to play"; a tap on the sound control resumes playback.
          update({ isPlaybackBlocked: true, notice: notice(AUTOPLAY_BLOCKED) });
        return;
      default:
    }
  };

  const EVENTS: readonly (keyof LiveMira.EngineEvents)[] = [
    'sessionStartFailed',
    'sessionEnded',
    'targetFound',
    'targetUpdated',
    'targetLost',
    'viewportTransition',
    'mediaState',
    'playbackBlocked',
    'attemptStart',
    'ready',
    'cameraPermission',
    'cameraStatus',
    'pageVisibility',
    'capabilityChanged',
    'stageTiming',
    'error',
  ];

  const engineFor = (container: HTMLElement): LiveMira.Engine => {
    if (engine && engineContainer === container) return engine;
    if (engine) {
      unsubscribeEngine?.();
      void engine.dispose().catch(() => {});
    }
    const created = module!.createEngine({ ...options.engineOptions, container });
    const offs = EVENTS.map((name) => created.on(name, (event) => onEngineEvent(name, event)));
    unsubscribeEngine = () => {
      for (const off of offs) off();
    };
    engine = created;
    engineContainer = container;
    return created;
  };

  // --- runs ------------------------------------------------------------------------------------------------------

  /** Ends a run in the state (idle, with its first notice); the caller has stopped or will stop the engine. */
  const finish = (current: Run, end: { notice?: ArNotice | null; isStale?: boolean }): void => {
    if (current.isEnded) return;
    current.isEnded = true;
    current.controller.abort();
    current.notice ??= end.notice ?? null;
    releaseVideo();
    if (run === current) run = null;
    update({
      phase: 'idle',
      progress: null,
      notice: current.notice,
      isAdjusting: false,
      isPlaybackBlocked: false,
      activeTargetId: null,
      ...(end.isStale ? { isStale: true } : {}),
    });
  };

  /** The engine ended the session by itself. */
  const endRun = async (current: Run, end: { notice: ArNotice }): Promise<void> => {
    observe({ type: 'lifecycle', name: 'stop', reason: 'engine' });
    finish(current, end);
  };

  /** The UI or the host ends a run: stop the engine, then go idle. */
  const stopRun = (current: Run | null, stop: ArStopOptions = {}): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (current && !current.isEnded) {
        current.notice ??= stop.notice ?? null;
        current.controller.abort();
        update({ phase: 'stopping' });
        observe({ type: 'lifecycle', name: 'stop', reason: stop.reason ?? UI_STOP });
        releaseVideo();
        try {
          await engine?.stop(stop.reason ?? UI_STOP);
        } catch {
          // The engine reports its own cleanup problems; the run ends either way.
        }
        finish(current, { isStale: stop.isStale === true });
      } else if (stop.notice || stop.isStale) {
        update({
          ...(stop.notice ? { notice: stop.notice } : {}),
          ...(stop.isStale ? { isStale: true } : {}),
        });
      }
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  };

  /** Fails the run before scanning with a classified notice. */
  const fail = (
    current: Run,
    cause: unknown,
    phase: ArErrorPhase,
    targetId: string | null,
  ): void => {
    const outcome = classify(options.classifyError, cause, phase, targetId);
    finish(current, { notice: outcome.notice, isStale: outcome.isStale });
  };

  const prepareTargets = async (
    current: Run,
    list: readonly ArTarget[],
  ): Promise<{ target: LiveMira.TargetBundle; source: ArTarget }[] | null> => {
    const signal = current.controller.signal;
    const prepared: { target: LiveMira.TargetBundle; source: ArTarget }[] = [];
    let skipped = 0;
    update({ progress: { done: 0, total: list.length } });
    for (const [index, source] of list.entries()) {
      if (source.target !== undefined) {
        prepared.push({ target: source.target, source });
      } else {
        let photo: Blob;
        try {
          photo =
            typeof source.photo === 'string'
              ? await loadMedia(source.photo, { signal, kind: 'photo', targetId: source.id })
              : source.photo;
        } catch (cause) {
          if (!isCurrent(current) || isAbort(cause, signal)) return null;
          fail(current, cause, 'photo-load', source.id);
          return null;
        }
        if (!isCurrent(current)) return null;
        const began = Date.now();
        try {
          const workerFactory = options.engineOptions?.adapters?.workerFactory;
          const target = await module!.compileTargetImage(photo, {
            targetId: source.id,
            signal,
            ...(options.photoMaxEdgePx !== undefined ? { maxEdgePx: options.photoMaxEdgePx } : {}),
            ...(workerFactory ? { workerFactory } : {}),
          });
          if (!isCurrent(current)) return null;
          observe({
            type: 'target',
            name: 'photo-compiled',
            targetId: source.id,
            durationMs: Date.now() - began,
          });
          prepared.push({ target, source });
        } catch (cause) {
          if (!isCurrent(current) || isAbort(cause, signal)) return null;
          if (errorCode(cause) !== 'INVALID_TARGET') {
            fail(current, cause, 'photo-compile', source.id);
            return null;
          }
          skipped += 1;
          observe({
            type: 'target',
            name: 'photo-rejected',
            targetId: source.id,
            code: 'INVALID_TARGET',
          });
        }
      }
      update({ progress: { done: index + 1, total: list.length }, skippedCount: skipped });
    }
    return prepared;
  };

  const runOnce = async (current: Run, container: HTMLElement): Promise<void> => {
    const list = targets;
    update({
      phase: 'preparing',
      notice: null,
      isStale: false,
      skippedCount: 0,
      progress: null,
      isAdjusting: false,
      isPlaybackBlocked: false,
      activeTargetId: null,
    });
    observe({ type: 'lifecycle', name: 'start' });
    const invalid = invalidTargets(list);
    if (invalid) {
      finish(current, { notice: invalid });
      return;
    }
    if (!module) {
      try {
        module = await options.loadEngine();
      } catch (cause) {
        if (isCurrent(current)) fail(current, cause, 'engine-load', null);
        return;
      }
      if (!isCurrent(current)) return;
    }
    let instance: LiveMira.Engine;
    try {
      instance = engineFor(container);
    } catch (cause) {
      fail(current, cause, 'start', null);
      return;
    }
    const prepared = await prepareTargets(current, list);
    if (!prepared || !isCurrent(current)) return;
    if (prepared.length === 0) {
      finish(current, { notice: notice('notice.allRejected') });
      return;
    }
    update({ phase: 'starting', progress: null });
    try {
      await instance.setTargets(prepared.map(({ target }) => ({ target })));
      if (!isCurrent(current)) return;
      await instance.start();
    } catch (cause) {
      if (!isCurrent(current)) return;
      const key = START_NOTICES[current.startFailure ?? errorCode(cause) ?? ''];
      if (key) finish(current, { notice: notice(key) });
      else fail(current, cause, 'start', null);
      return;
    }
    if (!isCurrent(current)) {
      // Stopped while the camera was opening: the stop waits for the engine queue and ends it.
      return;
    }
    update({ phase: 'scanning' });
    observe({ type: 'lifecycle', name: 'ready' });
  };

  const session: ArSession = {
    getState: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    async start(container) {
      if (state.isDisposed || disposing) return;
      if (starting) return starting;
      if (stopping) await stopping;
      if (state.isDisposed || disposing || starting) return starting ?? undefined;
      if (run && !run.isEnded) return;
      const current: Run = {
        id: ++runCounter,
        controller: new AbortController(),
        notice: null,
        isEnded: false,
        startFailure: null,
        hasFound: false,
        newestEpoch: -1,
        pendingEpoch: null,
      };
      run = current;
      starting = runOnce(current, container)
        .catch(() => {
          if (isCurrent(current)) finish(current, { notice: notice('notice.startFailed') });
        })
        .finally(() => {
          starting = null;
        });
      return starting;
    },

    stop(stop) {
      return stopRun(run, stop);
    },

    setTargets(next) {
      targets = [...next];
    },

    setMuted(isMuted) {
      if (state.isDisposed) return Promise.resolve(false);
      const instance = engine;
      const bound = video;
      // Called in the tap's own call stack: nothing is awaited before the engine sees it.
      let result: Promise<boolean>;
      try {
        result = instance ? instance.media.setMuted(isMuted) : Promise.resolve(false);
      } catch {
        result = Promise.resolve(false);
      }
      update({ isMuted });
      return result.then(
        (isAccepted) => {
          observe({ type: 'sound', isMuted, isAccepted });
          if (isAccepted && state.notice?.key === AUTOPLAY_BLOCKED) update({ notice: null });
          if (isAccepted || isMuted) return true;
          const isShowing =
            bound !== null && bound === video && state.activeTargetId === bound.targetId;
          if (isShowing) {
            // The browser refused sound: back to muted so the button tells the truth.
            void instance?.media.setMuted(true).catch(() => false);
            update({ isMuted: true, notice: notice('notice.soundRefused') });
            return false;
          }
          // Nothing is playing: the choice applies to the next video, and to the bound one when it comes back.
          if (bound && bound === video && bound.file) {
            try {
              bindFile(bound, bound.file);
            } catch {
              bound.fact = 'failed';
            }
          }
          return true;
        },
        () => {
          update({ isMuted: true });
          return false;
        },
      );
    },

    async retryVideo() {
      const current = run;
      const bound = video;
      if (!current || current.isEnded || !bound || !engine) return;
      const target = targets.find((t) => t.id === bound.targetId);
      if (bound.fact === 'download-failed' && typeof target?.video === 'string') {
        update({ notice: null });
        downloadVideo(current, bound, target.video);
        notify();
        return;
      }
      // Called in the tap's own call stack: a blocked or failed playback needs the gesture.
      let result: Promise<boolean>;
      try {
        result = engine.media.retry();
      } catch {
        result = Promise.resolve(false);
      }
      if (bound.fact === 'failed') bound.fact = 'loading';
      update({ notice: null, isPlaybackBlocked: false });
      await result.catch(() => false);
    },

    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        // Stop first: it aborts whatever the start is waiting for, so the start ends promptly.
        await stopRun(run);
        await starting?.catch(() => {});
        unsubscribeEngine?.();
        unsubscribeEngine = null;
        const instance = engine;
        engine = null;
        engineContainer = null;
        try {
          await instance?.dispose();
        } catch {
          // Disposal problems are the engine's to report; the session is gone either way.
        }
        update({ isDisposed: true });
        listeners.clear();
      })();
      return disposing;
    },
  };
  return session;
}
