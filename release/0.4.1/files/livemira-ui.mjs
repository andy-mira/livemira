/*! LiveMira ui | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

// packages/ui/src/session.ts
var MAX_TARGETS = 10;
var TARGET_ID = /^[A-Za-z0-9_.-]{1,128}$/;
var UI_STOP = "ui-stop";
var notice = (key, params) => params ? { key, params } : { key };
var errorCode = (cause) => typeof cause === "object" && cause !== null && typeof cause.code === "string" ? cause.code : null;
var isAbort = (cause, signal) => signal.aborted || errorCode(cause) === "ABORTED" || cause instanceof Error && cause.name === "AbortError";
var DEFAULT_NOTICES = {
  "engine-load": "notice.engineLoadFailed",
  "photo-load": "notice.photoLoadFailed",
  "photo-compile": "notice.startFailed",
  start: "notice.cameraOrEngine",
  "video-load": "notice.videoLoadFailed"
};
var ENDED_NOTICES = {
  "camera-suspended": "notice.backgrounded",
  "camera-error": "notice.cameraInterrupted",
  "worker-failure": "notice.workerFailure"
};
var START_NOTICES = {
  CAMERA_PERMISSION_DENIED: "notice.cameraDenied",
  CAMERA_SUSPENDED: "notice.backgrounded"
};
var AUTOPLAY_BLOCKED = "notice.autoplayBlocked";
var defaultLoadMedia = async (url, { signal }) => {
  const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {
    });
    throw new Error(`HTTP ${response.status}`);
  }
  return response.blob();
};
function invalidTargets(targets) {
  if (targets.length === 0) return notice("notice.noTargets");
  if (targets.length > MAX_TARGETS) return notice("notice.tooMany", { max: MAX_TARGETS });
  const ids = /* @__PURE__ */ new Set();
  for (const target of targets) {
    const isUsable = typeof target.id === "string" && TARGET_ID.test(target.id) && !ids.has(target.id) && (target.target !== void 0 ? target.target.targetId === target.id : target.photo instanceof Blob || typeof target.photo === "string") && (target.video instanceof Blob || typeof target.video === "string");
    if (!isUsable) return notice("notice.invalidTargets");
    ids.add(target.id);
  }
  return null;
}
function createArSession(options) {
  const loadMedia = options.loadMedia ?? defaultLoadMedia;
  const listeners = /* @__PURE__ */ new Set();
  let targets = [...options.targets];
  let module = null;
  let engine = null;
  let engineContainer = null;
  let unsubscribeEngine = null;
  let run = null;
  let runCounter = 0;
  let starting = null;
  let stopping = null;
  let disposing = null;
  let video = null;
  let lastNotified = "";
  let state = {
    phase: "idle",
    progress: null,
    notice: null,
    isMuted: true,
    isAdjusting: false,
    isPlaybackBlocked: false,
    isStale: false,
    skippedCount: 0,
    activeTargetId: null,
    isDisposed: false
  };
  const observe = (observation) => {
    try {
      options.observe?.(observation);
    } catch {
    }
  };
  const view = () => {
    if (state.phase !== "scanning") return "searching";
    if (state.activeTargetId === null) return run?.hasFound ? "lost" : "searching";
    if (video?.targetId !== state.activeTargetId) return "loading";
    if (video.fact === "failed" || video.fact === "download-failed") return "videoError";
    return video.fact === "playing" ? "playing" : "loading";
  };
  const snapshot = () => Object.freeze({ ...state, view: view() });
  const notify = () => {
    const current = JSON.stringify(snapshot());
    if (current === lastNotified) return;
    lastNotified = current;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
      }
    }
  };
  const update = (change) => {
    state = { ...state, ...change };
    notify();
  };
  const isCurrent = (candidate) => run === candidate && !candidate.isEnded;
  const classify = (classifier, cause, phase, targetId) => {
    let own;
    try {
      own = classifier?.(cause, { phase, targetId });
    } catch {
      own = void 0;
    }
    return {
      notice: own?.notice ?? notice(DEFAULT_NOTICES[phase]),
      shouldStop: phase === "video-load" ? own?.shouldStop === true : true,
      isStale: own?.isStale === true
    };
  };
  const mediaOf = (file) => ({
    file,
    isMuted: state.isMuted,
    ...options.video?.isLooping !== void 0 ? { isLooping: options.video.isLooping } : {},
    ...options.video?.fit !== void 0 ? { fit: options.video.fit } : {}
  });
  const releaseVideo = () => {
    const previous = video;
    if (!previous) return;
    video = null;
    previous.controller.abort();
    try {
      engine?.setTargetMedia(previous.targetId, null);
    } catch {
    }
  };
  const bindFile = (bound, file) => {
    bound.file = file;
    bound.fact = "loading";
    engine?.setTargetMedia(bound.targetId, mediaOf(file));
  };
  const downloadVideo = (current, bound, url) => {
    const began = Date.now();
    bound.fact = "downloading";
    observe({ type: "target", name: "video-requested", targetId: bound.targetId });
    loadMedia(url, {
      signal: bound.controller.signal,
      kind: "video",
      targetId: bound.targetId
    }).then(
      (file) => {
        if (!isCurrent(current) || video !== bound || bound.controller.signal.aborted) return;
        if (file.size === 0) {
          observe({
            type: "target",
            name: "video-failed",
            targetId: bound.targetId,
            code: "empty"
          });
          bound.fact = "download-failed";
          update({ notice: notice("notice.emptyVideo") });
          return;
        }
        observe({
          type: "target",
          name: "video-loaded",
          targetId: bound.targetId,
          durationMs: Date.now() - began,
          bytes: file.size
        });
        try {
          bindFile(bound, file);
        } catch {
          bound.fact = "failed";
          update({ notice: notice("notice.videoPlayFailed") });
          return;
        }
        notify();
      },
      (cause) => {
        if (!isCurrent(current) || video !== bound || isAbort(cause, bound.controller.signal))
          return;
        observe({
          type: "target",
          name: "video-failed",
          targetId: bound.targetId,
          code: errorCode(cause) ?? "load"
        });
        bound.fact = "download-failed";
        const outcome = classify(options.classifyError, cause, "video-load", bound.targetId);
        if (outcome.shouldStop) {
          void stopRun(current, { notice: outcome.notice, isStale: outcome.isStale });
          return;
        }
        update({ notice: outcome.notice, ...outcome.isStale ? { isStale: true } : {} });
      }
    );
  };
  const showVideo = (current, targetId) => {
    if (video?.targetId === targetId) return;
    releaseVideo();
    const target = targets.find((t) => t.id === targetId);
    if (!target) return;
    const bound = {
      targetId,
      controller: new AbortController(),
      fact: "loading",
      file: null
    };
    video = bound;
    state = { ...state, isPlaybackBlocked: false };
    if (typeof target.video === "string") downloadVideo(current, bound, target.video);
    else {
      try {
        bindFile(bound, target.video);
      } catch {
        bound.fact = "failed";
      }
    }
  };
  const onEngineEvent = (name, event) => {
    observe({ type: "engine", name, event });
    const current = run;
    if (!current || current.isEnded) return;
    switch (name) {
      case "sessionStartFailed":
        current.startFailure = event.code;
        return;
      case "sessionEnded": {
        const reason = event.reason;
        if (reason === UI_STOP || reason === "start-failed" || reason === "start-cancelled") return;
        if (state.phase !== "scanning") return;
        void endRun(current, {
          notice: notice(ENDED_NOTICES[reason] ?? "notice.cameraInterrupted")
        });
        return;
      }
      default:
    }
    if (state.phase !== "scanning") return;
    switch (name) {
      case "targetFound":
      case "targetUpdated": {
        const targetId = event.result.targetId;
        if (!targetId) return;
        if (name === "targetFound") observe({ type: "target", name: "found", targetId });
        current.hasFound = true;
        showVideo(current, targetId);
        update({ activeTargetId: targetId });
        return;
      }
      case "targetLost": {
        const targetId = event.targetId;
        if (targetId) observe({ type: "target", name: "lost", targetId });
        if (state.activeTargetId !== null && (targetId === null || targetId === state.activeTargetId))
          update({ activeTargetId: null });
        return;
      }
      case "viewportTransition": {
        const transition = event;
        if (!Number.isSafeInteger(transition.epoch) || transition.epoch < 0) return;
        if (transition.phase === "begin") {
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
      case "mediaState": {
        const media = event;
        if (!video || media.targetId !== video.targetId) return;
        const bound = video;
        switch (media.state) {
          case "playing":
            bound.fact = "playing";
            update({
              isPlaybackBlocked: false,
              ...state.notice?.key === AUTOPLAY_BLOCKED ? { notice: null } : {}
            });
            return;
          case "loading":
          case "pause":
          case "waiting":
          case "ended":
            if (bound.fact === "playing") bound.fact = "loading";
            notify();
            return;
          case "error":
            bound.fact = "failed";
            update({ notice: notice("notice.videoPlayFailed") });
            return;
          case "loading-failed":
            if (media.media.presentation?.failureReason === "playback-blocked") return;
            bound.fact = "failed";
            update({ notice: notice("notice.videoPlayFailed") });
            return;
          default:
            return;
        }
      }
      case "playbackBlocked":
        if (video && event.targetId === video.targetId)
          update({ isPlaybackBlocked: true, notice: notice(AUTOPLAY_BLOCKED) });
        return;
      default:
    }
  };
  const EVENTS = [
    "sessionStartFailed",
    "sessionEnded",
    "targetFound",
    "targetUpdated",
    "targetLost",
    "viewportTransition",
    "mediaState",
    "playbackBlocked",
    "attemptStart",
    "ready",
    "cameraPermission",
    "cameraStatus",
    "pageVisibility",
    "capabilityChanged",
    "stageTiming",
    "error"
  ];
  const engineFor = (container) => {
    if (engine && engineContainer === container) return engine;
    if (engine) {
      unsubscribeEngine?.();
      void engine.dispose().catch(() => {
      });
    }
    const created = module.createEngine({ ...options.engineOptions, container });
    const offs = EVENTS.map((name) => created.on(name, (event) => onEngineEvent(name, event)));
    unsubscribeEngine = () => {
      for (const off of offs) off();
    };
    engine = created;
    engineContainer = container;
    return created;
  };
  const finish = (current, end) => {
    if (current.isEnded) return;
    current.isEnded = true;
    current.controller.abort();
    current.notice ??= end.notice ?? null;
    releaseVideo();
    if (run === current) run = null;
    update({
      phase: "idle",
      progress: null,
      notice: current.notice,
      isAdjusting: false,
      isPlaybackBlocked: false,
      activeTargetId: null,
      ...end.isStale ? { isStale: true } : {}
    });
  };
  const endRun = async (current, end) => {
    observe({ type: "lifecycle", name: "stop", reason: "engine" });
    finish(current, end);
  };
  const stopRun = (current, stop = {}) => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (current && !current.isEnded) {
        current.notice ??= stop.notice ?? null;
        current.controller.abort();
        update({ phase: "stopping" });
        observe({ type: "lifecycle", name: "stop", reason: stop.reason ?? UI_STOP });
        releaseVideo();
        try {
          await engine?.stop(stop.reason ?? UI_STOP);
        } catch {
        }
        finish(current, { isStale: stop.isStale === true });
      } else if (stop.notice || stop.isStale) {
        update({
          ...stop.notice ? { notice: stop.notice } : {},
          ...stop.isStale ? { isStale: true } : {}
        });
      }
    })().finally(() => {
      stopping = null;
    });
    return stopping;
  };
  const fail = (current, cause, phase, targetId) => {
    const outcome = classify(options.classifyError, cause, phase, targetId);
    finish(current, { notice: outcome.notice, isStale: outcome.isStale });
  };
  const prepareTargets = async (current, list) => {
    const signal = current.controller.signal;
    const prepared = [];
    let skipped = 0;
    update({ progress: { done: 0, total: list.length } });
    for (const [index, source] of list.entries()) {
      if (source.target !== void 0) {
        prepared.push({ target: source.target, source });
      } else {
        let photo;
        try {
          photo = typeof source.photo === "string" ? await loadMedia(source.photo, { signal, kind: "photo", targetId: source.id }) : source.photo;
        } catch (cause) {
          if (!isCurrent(current) || isAbort(cause, signal)) return null;
          fail(current, cause, "photo-load", source.id);
          return null;
        }
        if (!isCurrent(current)) return null;
        const began = Date.now();
        try {
          const workerFactory = options.engineOptions?.adapters?.workerFactory;
          const target = await module.compileTargetImage(photo, {
            targetId: source.id,
            signal,
            ...options.photoMaxEdgePx !== void 0 ? { maxEdgePx: options.photoMaxEdgePx } : {},
            ...workerFactory ? { workerFactory } : {}
          });
          if (!isCurrent(current)) return null;
          observe({
            type: "target",
            name: "photo-compiled",
            targetId: source.id,
            durationMs: Date.now() - began
          });
          prepared.push({ target, source });
        } catch (cause) {
          if (!isCurrent(current) || isAbort(cause, signal)) return null;
          if (errorCode(cause) !== "INVALID_TARGET") {
            fail(current, cause, "photo-compile", source.id);
            return null;
          }
          skipped += 1;
          observe({
            type: "target",
            name: "photo-rejected",
            targetId: source.id,
            code: "INVALID_TARGET"
          });
        }
      }
      update({ progress: { done: index + 1, total: list.length }, skippedCount: skipped });
    }
    return prepared;
  };
  const runOnce = async (current, container) => {
    const list = targets;
    update({
      phase: "preparing",
      notice: null,
      isStale: false,
      skippedCount: 0,
      progress: null,
      isAdjusting: false,
      isPlaybackBlocked: false,
      activeTargetId: null
    });
    observe({ type: "lifecycle", name: "start" });
    const invalid = invalidTargets(list);
    if (invalid) {
      finish(current, { notice: invalid });
      return;
    }
    if (!module) {
      try {
        module = await options.loadEngine();
      } catch (cause) {
        if (isCurrent(current)) fail(current, cause, "engine-load", null);
        return;
      }
      if (!isCurrent(current)) return;
    }
    let instance;
    try {
      instance = engineFor(container);
    } catch (cause) {
      fail(current, cause, "start", null);
      return;
    }
    const prepared = await prepareTargets(current, list);
    if (!prepared || !isCurrent(current)) return;
    if (prepared.length === 0) {
      finish(current, { notice: notice("notice.allRejected") });
      return;
    }
    update({ phase: "starting", progress: null });
    try {
      await instance.setTargets(prepared.map(({ target }) => ({ target })));
      if (!isCurrent(current)) return;
      await instance.start();
    } catch (cause) {
      if (!isCurrent(current)) return;
      const key = START_NOTICES[current.startFailure ?? errorCode(cause) ?? ""];
      if (key) finish(current, { notice: notice(key) });
      else fail(current, cause, "start", null);
      return;
    }
    if (!isCurrent(current)) {
      return;
    }
    update({ phase: "scanning" });
    observe({ type: "lifecycle", name: "ready" });
  };
  const session = {
    getState: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async start(container) {
      if (state.isDisposed || disposing) return;
      if (starting) return starting;
      if (stopping) await stopping;
      if (state.isDisposed || disposing || starting) return starting ?? void 0;
      if (run && !run.isEnded) return;
      const current = {
        id: ++runCounter,
        controller: new AbortController(),
        notice: null,
        isEnded: false,
        startFailure: null,
        hasFound: false,
        newestEpoch: -1,
        pendingEpoch: null
      };
      run = current;
      starting = runOnce(current, container).catch(() => {
        if (isCurrent(current)) finish(current, { notice: notice("notice.startFailed") });
      }).finally(() => {
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
      let result;
      try {
        result = instance ? instance.media.setMuted(isMuted) : Promise.resolve(false);
      } catch {
        result = Promise.resolve(false);
      }
      update({ isMuted });
      return result.then(
        (isAccepted) => {
          observe({ type: "sound", isMuted, isAccepted });
          if (isAccepted && state.notice?.key === AUTOPLAY_BLOCKED) update({ notice: null });
          if (isAccepted || isMuted) return true;
          const isShowing = bound !== null && bound === video && state.activeTargetId === bound.targetId;
          if (isShowing) {
            void instance?.media.setMuted(true).catch(() => false);
            update({ isMuted: true, notice: notice("notice.soundRefused") });
            return false;
          }
          if (bound && bound === video && bound.file) {
            try {
              bindFile(bound, bound.file);
            } catch {
              bound.fact = "failed";
            }
          }
          return true;
        },
        () => {
          update({ isMuted: true });
          return false;
        }
      );
    },
    async retryVideo() {
      const current = run;
      const bound = video;
      if (!current || current.isEnded || !bound || !engine) return;
      const target = targets.find((t) => t.id === bound.targetId);
      if (bound.fact === "download-failed" && typeof target?.video === "string") {
        update({ notice: null });
        downloadVideo(current, bound, target.video);
        notify();
        return;
      }
      let result;
      try {
        result = engine.media.retry();
      } catch {
        result = Promise.resolve(false);
      }
      if (bound.fact === "failed") bound.fact = "loading";
      update({ notice: null, isPlaybackBlocked: false });
      await result.catch(() => false);
    },
    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        await stopRun(run);
        await starting?.catch(() => {
        });
        unsubscribeEngine?.();
        unsubscribeEngine = null;
        const instance = engine;
        engine = null;
        engineContainer = null;
        try {
          await instance?.dispose();
        } catch {
        }
        update({ isDisposed: true });
        listeners.clear();
      })();
      return disposing;
    }
  };
  return session;
}

// packages/ui/src/messages.ts
var ZH_CN = Object.freeze({
  title: "扫描照片，看见视频",
  exit: "关闭相机",
  restart: "重新开始",
  reloadVideo: "重新加载视频",
  soundOn: "开启声音",
  soundOff: "关闭声音",
  skipped: "有 {count} 张照片不适合扫描，已跳过。",
  "status.preparingProgress": "正在准备照片（{done}/{total}）…",
  "status.preparing": "正在准备…",
  "status.viewport": "正在调整画面…",
  "status.starting": "正在打开相机…",
  "status.stopping": "正在停止…",
  "status.loading": "找到照片了，正在加载视频…",
  "status.playing": "正在播放",
  "status.lost": "照片移开了，重新对准即可继续。",
  "status.videoError": "视频暂时无法播放。",
  "status.searching": "请把相机对准要识别的照片。",
  "notice.noTargets": "没有完整的照片与视频可以扫描。",
  "notice.tooMany": "一次最多扫描 {max} 组照片与视频。",
  "notice.invalidTargets": "照片与视频的配置无效（编号缺失、重复或与识别数据不一致）。",
  "notice.allRejected": "这些照片都无法用于扫描，请换更清晰的照片。",
  "notice.startFailed": "扫描未能启动，请重试。",
  "notice.emptyVideo": "视频文件为空。",
  "notice.cameraDenied": "没有相机权限，请在浏览器设置中允许后重新开始。",
  "notice.cameraInterrupted": "相机已中断，请重新开始。",
  "notice.workerFailure": "识别组件出现问题，已停止扫描，请重新开始。",
  "notice.videoPlayFailed": "视频无法播放，可以点“重新加载视频”再试一次。",
  "notice.videoLoadFailed": "视频暂时无法加载，请检查网络后点“重新加载视频”。",
  "notice.autoplayBlocked": "浏览器阻止了视频自动播放。",
  "notice.soundRefused": "浏览器暂时没有允许播放声音，请再点一次。",
  "notice.backgrounded": "页面进入后台，已停止扫描，请重新开始。",
  "notice.photoLoadFailed": "照片加载失败，请检查网络后重试。",
  "notice.engineLoadFailed": "扫描组件加载失败，请检查网络后重试。",
  "notice.cameraOrEngine": "无法打开相机或识别组件，请确认已允许相机权限后重试。"
});
var EN = Object.freeze({
  title: "Scan a photo to see its video",
  exit: "Close camera",
  restart: "Start again",
  reloadVideo: "Reload video",
  soundOn: "Turn sound on",
  soundOff: "Turn sound off",
  skipped: {
    one: "{count} photo is not suitable for scanning and was skipped.",
    other: "{count} photos are not suitable for scanning and were skipped."
  },
  "status.preparingProgress": "Preparing photos ({done}/{total})…",
  "status.preparing": "Getting ready…",
  "status.viewport": "Adjusting the view…",
  "status.starting": "Opening the camera…",
  "status.stopping": "Stopping…",
  "status.loading": "Photo found. Loading its video…",
  "status.playing": "Playing",
  "status.lost": "The photo moved out of view. Point at it again to continue.",
  "status.videoError": "The video cannot play right now.",
  "status.searching": "Point the camera at a photo to scan.",
  "notice.noTargets": "There are no complete photo and video pairs to scan.",
  "notice.tooMany": "You can scan at most {max} pairs at a time.",
  "notice.invalidTargets": "The photo and video setup is invalid (a missing or duplicate id, or an id that does not match its target data).",
  "notice.allRejected": "None of the photos can be used for scanning. Try clearer photos.",
  "notice.startFailed": "Scanning could not start. Please try again.",
  "notice.emptyVideo": "The video file is empty.",
  "notice.cameraDenied": "Camera access was not granted. Allow it in your browser settings, then start again.",
  "notice.cameraInterrupted": "The camera was interrupted. Please start again.",
  "notice.workerFailure": "The recognition component ran into a problem and scanning stopped. Please start again.",
  "notice.videoPlayFailed": "The video cannot play. Choose “Reload video” to try again.",
  "notice.videoLoadFailed": "The video cannot be loaded right now. Check your connection, then choose “Reload video”.",
  "notice.autoplayBlocked": "Your browser blocked automatic video playback.",
  "notice.soundRefused": "The browser did not allow sound yet. Please tap again.",
  "notice.backgrounded": "The page went to the background and scanning stopped. Please start again.",
  "notice.photoLoadFailed": "The photos could not be loaded. Check your connection and try again.",
  "notice.engineLoadFailed": "The scanning component could not be loaded. Check your connection and try again.",
  "notice.cameraOrEngine": "The camera or recognition component could not be started. Make sure camera access is allowed, then try again."
});
var DEFAULT_LOCALE = "zh-CN";
var TABLES = { "zh-CN": ZH_CN, en: EN };
function resolveLocale(locale) {
  const tag = (locale ?? "").toLowerCase();
  return tag === "en" || tag.startsWith("en-") ? "en" : DEFAULT_LOCALE;
}
var fill = (message, params) => {
  const text = typeof message === "string" ? message : params?.["count"] === 1 ? message.one : message.other;
  return params ? text.replace(/\{(\w+)\}/g, (all, name) => String(params[name] ?? all)) : text;
};
function createTranslator(options = {}) {
  const locale = resolveLocale(options.locale);
  return {
    locale,
    t(key, params) {
      const own = options.translate?.(key, params, locale);
      if (typeof own === "string") return own;
      const message = options.messages?.[locale]?.[key] ?? TABLES[locale][key] ?? options.messages?.[DEFAULT_LOCALE]?.[key] ?? ZH_CN[key] ?? key;
      return fill(message, params);
    }
  };
}

// packages/ui/src/styles.ts
var STYLE_TEXT = `
.lm-ar {
  --lm-ar-bg: #1d1810;
  --lm-ar-fg: #fff8ee;
  --lm-ar-chip-bg: rgba(29, 24, 16, 0.55);
  --lm-ar-notice-bg: rgba(164, 55, 43, 0.85);
  --lm-ar-accent: #c0674a;
  --lm-ar-accent-hover: #a4533a;
  --lm-ar-accent-fg: #fff8ee;
  --lm-ar-focus: #fff8ee;
  --lm-ar-font: inherit;
  --lm-ar-radius: 16px;
  --lm-ar-control-radius: 22px;
  --lm-ar-button-radius: 999px;
  --lm-ar-z: 20;
  position: relative; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box;
  background: var(--lm-ar-bg); color: var(--lm-ar-fg); font-family: var(--lm-ar-font); line-height: 1.4;
  overscroll-behavior: none; touch-action: none;
}
.lm-ar *, .lm-ar *::before, .lm-ar *::after { box-sizing: border-box; }
.lm-ar[hidden], .lm-ar [hidden] { display: none; }

/* Full screen: fixed to the dynamic viewport, never scrolls, controls stay inside the safe areas. */
.lm-ar--fullscreen { position: fixed; inset: 0; width: auto; height: 100vh; height: 100dvh; z-index: var(--lm-ar-z); }
.lm-ar--embedded { position: relative; }

/* The layers get their own stacking contexts so nothing inside the camera or the AR layer can paint over the curtain. */
.lm-ar__stage { position: absolute; inset: 0; z-index: 0; }
/* Pure black on purpose (not the theme background): it matches the camera's own mask while the view is rotating. */
.lm-ar__curtain {
  position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--lm-ar-curtain, #000); color: var(--lm-ar-fg); font-size: 14px;
}

.lm-ar__exit, .lm-ar__sound {
  position: absolute; z-index: 3; top: calc(10px + env(safe-area-inset-top)); display: grid; place-items: center;
  min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: var(--lm-ar-control-radius);
  background: var(--lm-ar-chip-bg); color: var(--lm-ar-fg); font: inherit; text-decoration: none; cursor: pointer;
}
.lm-ar__exit { left: calc(10px + env(safe-area-inset-left)); font-size: 28px; line-height: 1; }
.lm-ar__sound { right: calc(10px + env(safe-area-inset-right)); width: 44px; }
.lm-ar__exit:focus-visible, .lm-ar__sound:focus-visible, .lm-ar__button:focus-visible { outline: 2px solid var(--lm-ar-focus); outline-offset: 2px; }
.lm-ar__icon { display: block; width: 20px; height: 20px; fill: currentColor; }

.lm-ar__hud {
  /* A separate row below the 44px exit/sound row (10px + 44px + 8px), so the status can never collide with them. */
  position: absolute; z-index: 2; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right)); top: calc(62px + env(safe-area-inset-top));
  display: grid; justify-items: center; gap: 6px; pointer-events: none;
}
.lm-ar__status {
  display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 6px 12px; max-width: 100%; border-radius: var(--lm-ar-radius);
  background: var(--lm-ar-chip-bg); font-size: 13px; line-height: 1.4; text-align: center; overflow-wrap: anywhere;
}
.lm-ar__notice { background: var(--lm-ar-notice-bg); }
.lm-ar__spinner {
  display: inline-block; flex: none; width: 16px; height: 16px; border: 2px solid rgba(255, 248, 238, 0.35); border-top-color: var(--lm-ar-fg);
  border-radius: 50%; animation: lm-ar-spin 0.8s linear infinite;
}
@keyframes lm-ar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .lm-ar__spinner { animation-duration: 2s; } }

.lm-ar__controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  padding: 12px calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
}
.lm-ar__button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 36px; margin: 0; padding: 0 16px; border: 1px solid transparent;
  border-radius: var(--lm-ar-button-radius); background: var(--lm-ar-accent); color: var(--lm-ar-accent-fg); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
}
.lm-ar__button:hover { background: var(--lm-ar-accent-hover); }
`;

// packages/ui/src/view.ts
var SOUND_ON = '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
var SOUND_OFF = '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
var styles = /* @__PURE__ */ new Map();
var scrollLocks = /* @__PURE__ */ new Map();
function acquireStyle(doc) {
  let entry = styles.get(doc);
  if (!entry) {
    const element = doc.createElement("style");
    element.setAttribute("data-livemira-ui", "");
    element.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement).appendChild(element);
    entry = { count: 0, element };
    styles.set(doc, entry);
  }
  entry.count += 1;
  const held = entry;
  return () => {
    held.count -= 1;
    if (held.count === 0) {
      held.element.remove();
      styles.delete(doc);
    }
  };
}
function lockScroll(doc) {
  const body = doc.body;
  if (!body) return () => {
  };
  let entry = scrollLocks.get(doc);
  if (!entry) {
    entry = { count: 0, overflow: body.style.overflow };
    scrollLocks.set(doc, entry);
    body.style.overflow = "hidden";
  }
  entry.count += 1;
  const held = entry;
  return () => {
    held.count -= 1;
    if (held.count === 0) {
      body.style.overflow = held.overflow;
      scrollLocks.delete(doc);
    }
  };
}
var variableName = (name) => name.startsWith("--") ? name : `--lm-ar-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
function statusLine(state) {
  if (state.notice?.key === "notice.autoplayBlocked") return null;
  switch (state.phase) {
    case "preparing":
      return state.progress ? {
        key: "status.preparingProgress",
        params: {
          done: Math.min(state.progress.done + 1, state.progress.total),
          total: state.progress.total
        }
      } : { key: "status.preparing" };
    case "starting":
      return { key: "status.starting" };
    case "stopping":
      return { key: "status.stopping" };
    case "idle":
      return state.notice ? null : { key: "status.preparing" };
    default:
  }
  switch (state.view) {
    case "loading":
      return { key: "status.loading" };
    case "playing":
      return { key: "status.playing" };
    case "lost":
      return { key: "status.lost" };
    case "videoError":
      return { key: "status.videoError" };
    default:
      return { key: "status.searching" };
  }
}
function mountArView(container, session, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let settings = { ...options };
  let translator = createTranslator(settings);
  let isDestroyed = false;
  let hasStarted = false;
  const element = (tag, className) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };
  const root = element("div", "lm-ar");
  root.classList.add(settings.mode === "embedded" ? "lm-ar--embedded" : "lm-ar--fullscreen");
  root.setAttribute("role", "region");
  const stage = element("div", "lm-ar__stage");
  const curtain = element("div", "lm-ar__curtain");
  const curtainSpinner = element("span", "lm-ar__spinner");
  const curtainText = element("span", "lm-ar__curtain-text");
  curtainText.setAttribute("role", "status");
  curtain.append(curtainSpinner, curtainText);
  curtain.hidden = true;
  const exitIsLink = settings.exitHref !== void 0;
  const exit = element(exitIsLink ? "a" : "button", "lm-ar__exit");
  if (exitIsLink) exit.setAttribute("href", settings.exitHref);
  else exit.setAttribute("type", "button");
  exit.textContent = "×";
  exit.addEventListener("click", (event) => settings.onExit?.(event));
  const sound = element("button", "lm-ar__sound");
  sound.setAttribute("type", "button");
  sound.addEventListener("click", () => void session.setMuted(!session.getState().isMuted));
  const hud = element("div", "lm-ar__hud");
  const status = element("p", "lm-ar__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const spinner = element("span", "lm-ar__spinner");
  const statusText = element("span", "lm-ar__text");
  status.append(spinner, statusText);
  const noticeLine = element("p", "lm-ar__status lm-ar__notice");
  noticeLine.setAttribute("role", "alert");
  const skippedLine = element("p", "lm-ar__status");
  hud.append(status, noticeLine, skippedLine);
  const controls = element("div", "lm-ar__controls");
  const button = (key, onClick) => {
    const node = element("button", "lm-ar__button");
    node.setAttribute("type", "button");
    node.dataset["label"] = key;
    node.addEventListener("click", onClick);
    return node;
  };
  const restart = button("restart", () => start());
  const reload = button("reloadVideo", () => void session.retryVideo());
  controls.append(restart, reload);
  root.append(stage, curtain, exit, sound, hud, controls);
  const applyTheme = (theme) => {
    for (const [name, value] of Object.entries(theme ?? {}))
      root.style.setProperty(variableName(name), value);
  };
  applyTheme(settings.theme);
  const render = () => {
    if (isDestroyed) return;
    const state = session.getState();
    const t = translator.t;
    const isScanning = state.phase === "scanning";
    root.setAttribute("aria-label", t("title"));
    root.lang = translator.locale;
    exit.hidden = settings.onExit === void 0 && !exitIsLink;
    exit.setAttribute("aria-label", t("exit"));
    exit.setAttribute("title", t("exit"));
    sound.hidden = !isScanning;
    sound.innerHTML = state.isMuted ? SOUND_OFF : SOUND_ON;
    const soundLabel = t(state.isMuted ? "soundOn" : "soundOff");
    sound.setAttribute("aria-label", soundLabel);
    sound.setAttribute("title", soundLabel);
    sound.setAttribute("aria-pressed", String(!state.isMuted));
    const isCovered = state.isAdjusting && state.phase !== "idle" && state.phase !== "stopping";
    curtain.hidden = !isCovered;
    if (isCovered) curtainText.textContent = t("status.viewport");
    const line = isCovered ? null : statusLine(state);
    status.hidden = line === null;
    if (line) {
      statusText.textContent = t(line.key, line.params);
      spinner.hidden = !(state.phase === "preparing" || state.phase === "starting" || state.phase === "stopping" || isScanning && state.view === "loading" || state.phase === "idle" && !state.notice);
    }
    noticeLine.hidden = state.notice === null;
    noticeLine.textContent = state.notice ? state.notice.text ?? t(state.notice.key, state.notice.params) : "";
    skippedLine.hidden = state.skippedCount === 0 || state.phase === "idle";
    skippedLine.textContent = t("skipped", { count: state.skippedCount });
    restart.hidden = !(state.phase === "idle" && state.notice !== null && !state.isDisposed);
    reload.hidden = !(isScanning && state.view === "videoError");
    for (const node of [restart, reload]) node.textContent = t(node.dataset["label"]);
  };
  const start = () => {
    if (isDestroyed) return;
    hasStarted = true;
    void session.start(stage);
  };
  const onHidden = (reason) => {
    if (settings.isStoppedWhenHidden === false || session.getState().phase === "idle") return;
    void session.stop({ reason, notice: { key: "notice.backgrounded" } });
  };
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") onHidden("hidden");
  };
  const onPageHide = () => onHidden("pagehide");
  const releaseStyle = acquireStyle(doc);
  const releaseScroll = settings.mode === "embedded" ? () => {
  } : lockScroll(doc);
  const unsubscribe = session.subscribe(render);
  doc.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onPageHide);
  container.appendChild(root);
  render();
  let observer = null;
  let frame = null;
  const hasSize = () => stage.clientWidth > 0 && stage.clientHeight > 0;
  const startWhenSized = () => {
    if (isDestroyed || hasStarted) return;
    if (hasSize()) {
      observer?.disconnect();
      observer = null;
      start();
      return;
    }
    if (!observer && win && "ResizeObserver" in win) {
      observer = new win.ResizeObserver(() => startWhenSized());
      observer.observe(stage);
    } else if (!observer && win) {
      frame = win.requestAnimationFrame(() => {
        frame = null;
        startWhenSized();
      });
    }
  };
  if (settings.isAutoStart !== false) startWhenSized();
  return {
    element: root,
    update(change) {
      if (isDestroyed) return;
      settings = { ...settings, ...change };
      translator = createTranslator(settings);
      if (change.theme) applyTheme(change.theme);
      render();
    },
    start,
    destroy() {
      if (isDestroyed) return;
      isDestroyed = true;
      observer?.disconnect();
      if (frame !== null) win?.cancelAnimationFrame(frame);
      unsubscribe();
      doc.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pagehide", onPageHide);
      root.remove();
      releaseScroll();
      releaseStyle();
    }
  };
}

// packages/ui/src/camera.ts
function mountArCamera(container, options) {
  const session = createArSession(options);
  let view;
  try {
    view = mountArView(container, session, options);
  } catch (error) {
    void session.dispose();
    throw error;
  }
  let destroying = null;
  return {
    session,
    view,
    destroy() {
      destroying ??= (async () => {
        try {
          view.destroy();
        } finally {
          await session.dispose();
        }
      })();
      return destroying;
    }
  };
}
export {
  DEFAULT_LOCALE,
  EN,
  ZH_CN,
  createArSession,
  createTranslator,
  mountArCamera,
  mountArView,
  resolveLocale
};
