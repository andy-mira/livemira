var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// packages/ui/src/session.ts
var MAX_TARGETS = 10;
var ID_RULE = /^[A-Za-z0-9_.-]{1,128}$/;
var PHOTO_CONCURRENCY = 3;
var fetchMedia = async (url, request) => {
  const response = await fetch(url, {
    signal: request.signal,
    credentials: "same-origin",
    referrerPolicy: "no-referrer"
  });
  if (!response.ok)
    throw Object.assign(new Error(`HTTP ${response.status} for ${request.kind}`), { status: response.status });
  const total = Number(response.headers.get("content-length")) || 0;
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !total || !request.onProgress) return response.blob();
  const reader = response.body.getReader();
  const parts = [];
  let received = 0;
  for (; ; ) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    request.onProgress(Math.min(1, received / total));
  }
  return new Blob(parts, { type });
};
var RunStop = class extends Error {
  constructor(notice, isStale = false) {
    super(notice.key);
    __publicField(this, "notice");
    __publicField(this, "isStale");
    this.notice = notice;
    this.isStale = isStale;
  }
};
var INITIAL = Object.freeze({
  phase: "idle",
  view: "searching",
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
  isDisposed: false
});
var sameValue = (a, b) => a === b || typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b) || !!a && !!b && typeof a === "object" && typeof b === "object" && JSON.stringify(a) === JSON.stringify(b);
function noticeForEngineError(error) {
  const e = error;
  switch (e?.code) {
    case "CAMERA_PERMISSION_DENIED":
      return { key: "notice.cameraDenied" };
    case "CAMERA_UNAVAILABLE":
      return { key: "notice.cameraUnavailable" };
    case "CAMERA_ENDED":
      return { key: "notice.cameraInterrupted" };
    case "UNSUPPORTED_DEVICE":
      return { key: e.missing?.includes("secure-context") ? "notice.insecure" : "notice.unsupported" };
    case "CAMERA_START_FAILED":
      return { key: "notice.cameraOrEngine" };
    case "WORKER_FAILED":
      return { key: "notice.workerFailure" };
    default:
      return { key: "notice.startFailed" };
  }
}
function checkTargetList(targets) {
  if (!Array.isArray(targets) || targets.length === 0) return { key: "notice.noTargets" };
  if (targets.length > MAX_TARGETS) return { key: "notice.tooMany", params: { max: MAX_TARGETS } };
  const ids = /* @__PURE__ */ new Set();
  for (const t of targets) {
    const hasPhoto = typeof t?.photo === "string" || typeof Blob !== "undefined" && t?.photo instanceof Blob;
    const hasTarget = !!t?.target;
    const hasVideo = typeof t?.video === "string" && t.video.length > 0 || typeof Blob !== "undefined" && t?.video instanceof Blob;
    if (!ID_RULE.test(t?.id ?? "") || ids.has(t.id) || hasPhoto === hasTarget || !hasVideo)
      return { key: "notice.invalidTargets" };
    ids.add(t.id);
  }
  return null;
}
async function mapLimit(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;
  const lane = async () => {
    while (next < items.length && failure === null) {
      const i = next++;
      try {
        results[i] = await work(items[i]);
      } catch (error) {
        failure ??= error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure !== null) throw failure;
  return results;
}
function createArSession(options) {
  let state = INITIAL;
  const listeners = /* @__PURE__ */ new Set();
  let targets = options.targets;
  const loadMedia = options.loadMedia ?? fetchMedia;
  const isStreamed = options.video?.isStreamed ?? !options.loadMedia;
  let module = null;
  let engine = null;
  let engineContainer = null;
  let engineListeners = [];
  let run = null;
  let runs = 0;
  let starting = null;
  let stopping = null;
  let disposing = null;
  const observe = (observation) => {
    try {
      options.observe?.(observation);
    } catch {
    }
  };
  const classify = (cause, phase, targetId) => {
    try {
      return options.classifyError?.(cause, { phase, targetId }) ?? void 0;
    } catch {
      return void 0;
    }
  };
  const notify = () => {
    for (const listener of [...listeners])
      try {
        listener();
      } catch {
      }
  };
  const computeView = (next) => {
    const r = run;
    const active = next.activeTargetId;
    if (!r || next.phase !== "scanning") return "searching";
    if (!active) return r.wasFound ? "lost" : "searching";
    if (r.video?.targetId !== active) return "loading";
    const fact = r.mediaFacts.get(active);
    if (r.video.fact === "download-failed" || fact === "error") return "videoError";
    if (fact === "playing") return "playing";
    return "loading";
  };
  const update = (patch) => {
    const draft = { ...state, ...patch };
    const next = Object.freeze({ ...draft, view: computeView(draft) });
    const changed = Object.keys(next).some((k) => !sameValue(state[k], next[k]));
    if (!changed) return;
    state = next;
    notify();
  };
  const isCurrent = (r) => run === r && !r.isEnded;
  const onEngine = (type, listener) => {
    engineListeners.push(engine.on(type, listener));
  };
  const listen = () => {
    onEngine("targetFound", ({ targetId }) => {
      const r = run;
      if (!r || r.isEnded) return;
      r.wasFound = true;
      observe({ type: "target", name: "found", targetId });
      bindVideo(r, targetId);
      update({ activeTargetId: targetId });
    });
    onEngine("targetLost", ({ targetId }) => {
      const r = run;
      if (!r || r.isEnded || state.activeTargetId !== targetId) return;
      observe({ type: "target", name: "lost", targetId });
      update({ activeTargetId: null, isPlaybackBlocked: false });
    });
    onEngine("viewport", ({ phase }) => {
      if (run && !run.isEnded) update({ isAdjusting: phase === "begin" });
    });
    onEngine("media", ({ targetId, state: fact, code }) => {
      const r = run;
      if (!r || r.isEnded) return;
      r.mediaFacts.set(targetId, fact);
      const video = r.video;
      if (video?.targetId !== targetId) return update({});
      if (fact === "playing") {
        if (video.isStreamed && !video.isReported) {
          video.isReported = true;
          const durationMs = Math.round(performance.now() - video.requestedAt);
          observe({ type: "target", name: "video-loaded", targetId, durationMs });
        }
        update({ isPlaybackBlocked: false, videoProgress: null, notice: videoNotice() ? null : state.notice });
      } else if (fact === "blocked") update({ isPlaybackBlocked: true });
      else if (fact === "error") {
        observe({ type: "target", name: "video-failed", targetId, ...code ? { code } : {} });
        if (video.isStreamed && (code === "network" || code === "unsupported"))
          videoLoadFailed(r, targetId, Object.assign(new Error(`The video could not be loaded (${code})`), { code }));
        else update({ notice: { key: "notice.videoPlayFailed" } });
      } else update({});
    });
    onEngine("ended", ({ error }) => {
      const r = run;
      if (!r || r.isEnded || !r.isCameraOn || !error) return;
      const c = classify(error, "start", null);
      void endRun(r, {
        notice: c?.notice ?? noticeForEngineError(error),
        isStale: !!c?.isStale,
        reason: "engine-ended"
      });
    });
  };
  const videoNotice = () => !!state.notice && ["notice.videoPlayFailed", "notice.videoLoadFailed", "notice.autoplayBlocked", "notice.emptyVideo"].includes(
    state.notice.key
  );
  const releaseVideo = (r) => {
    const video = r.video;
    if (!video) return;
    r.video = null;
    video.abort.abort();
    try {
      engine?.setTargetProgress(video.targetId, null);
      engine?.setTargetMedia(video.targetId, null);
    } catch {
    }
  };
  const bindVideo = (r, targetId, isRetry = false) => {
    if (!isRetry && r.video?.targetId === targetId) return;
    releaseVideo(r);
    const target = r.targets.find((t) => t.id === targetId);
    if (!target || !engine) return;
    const video = {
      targetId,
      abort: new AbortController(),
      fact: "downloading",
      requestedAt: performance.now(),
      isStreamed: isStreamed && typeof target.video === "string",
      isReported: false
    };
    r.video = video;
    const settings = { isLooping: options.video?.isLooping ?? true, fit: options.video?.fit ?? "contain" };
    const setMedia = (blob) => {
      if (blob.size === 0) {
        video.fact = "download-failed";
        update({ notice: { key: "notice.emptyVideo" } });
        return;
      }
      video.fact = "set";
      engine?.setTargetProgress(targetId, null);
      engine?.setTargetMedia(targetId, { file: blob, ...settings });
      update({ videoProgress: null });
    };
    if (typeof target.video !== "string") return setMedia(target.video);
    observe({ type: "target", name: "video-requested", targetId });
    if (video.isStreamed) {
      video.fact = "set";
      engine.setTargetMedia(targetId, { url: target.video, ...settings });
      return;
    }
    engine.setTargetProgress(targetId, Number.NaN);
    update({ videoProgress: Number.NaN });
    const url = target.video;
    void loadMedia(url, {
      signal: video.abort.signal,
      kind: "video",
      targetId,
      onProgress: (fraction) => {
        if (r.video !== video || r.isEnded) return;
        engine?.setTargetProgress(targetId, fraction);
        update({ videoProgress: fraction });
      }
    }).then(
      (blob) => {
        if (r.video !== video || r.isEnded) return;
        observe({
          type: "target",
          name: "video-loaded",
          targetId,
          bytes: blob.size,
          durationMs: Math.round(performance.now() - video.requestedAt)
        });
        setMedia(blob);
      },
      (cause) => {
        if (r.video !== video || r.isEnded || video.abort.signal.aborted) return;
        video.fact = "download-failed";
        engine?.setTargetProgress(targetId, null);
        observe({ type: "target", name: "video-failed", targetId, code: "download" });
        videoLoadFailed(r, targetId, cause);
      }
    );
  };
  const videoLoadFailed = (r, targetId, cause) => {
    const c = classify(cause, "video-load", targetId);
    if (c?.shouldStop)
      void endRun(r, {
        notice: c.notice ?? { key: "notice.videoLoadFailed" },
        isStale: !!c.isStale,
        reason: "video-load"
      });
    else
      update({
        notice: c?.notice ?? { key: "notice.videoLoadFailed" },
        videoProgress: null,
        ...c?.isStale ? { isStale: true } : {}
      });
  };
  const preparePhotos = async (r, engineModule, onProgress) => {
    let done = 0;
    let skipped = 0;
    const bundles = await mapLimit(r.targets, PHOTO_CONCURRENCY, async (t) => {
      if (r.abort.signal.aborted) throw new Error("aborted");
      try {
        if (t.target) {
          const bundle = t.target instanceof Uint8Array ? await engineModule.parseTarget(t.target) : t.target;
          if (bundle.targetId !== t.id) throw new RunStop({ key: "notice.invalidTargets" });
          return bundle;
        }
        let blob;
        if (typeof t.photo === "string") {
          try {
            blob = await loadMedia(t.photo, { signal: r.abort.signal, kind: "photo", targetId: t.id });
          } catch (cause) {
            if (r.abort.signal.aborted) throw cause;
            const c = classify(cause, "photo-load", t.id);
            throw new RunStop(c?.notice ?? { key: "notice.photoLoadFailed" }, !!c?.isStale);
          }
        } else blob = t.photo;
        const started = performance.now();
        try {
          const bundle = await engineModule.compileTargetImage(blob, {
            targetId: t.id,
            maxEdgePx: options.photoMaxEdgePx ?? 640,
            signal: r.abort.signal
          });
          observe({
            type: "target",
            name: "photo-compiled",
            targetId: t.id,
            durationMs: Math.round(performance.now() - started)
          });
          return bundle;
        } catch (cause) {
          if (r.abort.signal.aborted) throw cause;
          const code = cause.code ?? "";
          if (["UNSUITABLE_TARGET", "DECODE_FAILED", "INVALID_TARGET"].includes(code)) {
            skipped++;
            observe({ type: "target", name: "photo-rejected", targetId: t.id, code });
            return null;
          }
          const c = classify(cause, "photo-compile", t.id);
          throw new RunStop(c?.notice ?? { key: "notice.startFailed" }, !!c?.isStale);
        }
      } finally {
        onProgress(++done);
      }
    });
    if (isCurrent(r)) update({ skippedCount: skipped });
    const usable = bundles.filter((b) => b !== null);
    if (!usable.length) throw new RunStop({ key: "notice.allRejected" });
    return usable;
  };
  const endRun = async (r, end) => {
    if (r.isEnded) return;
    r.isEnded = true;
    r.abort.abort();
    releaseVideo(r);
    observe({ type: "lifecycle", name: "stop", reason: end.reason });
    try {
      await engine?.stop(end.reason);
    } catch {
    }
    if (run === r)
      update({
        phase: "idle",
        notice: end.notice,
        isStale: end.isStale,
        progress: null,
        readiness: null,
        isCameraOn: false,
        videoProgress: null,
        activeTargetId: null,
        isPlaybackBlocked: false,
        isAdjusting: false
      });
  };
  const runStart = async (r, container) => {
    observe({ type: "lifecycle", name: "start" });
    const total = r.targets.length;
    let photosDone = 0;
    let engineLoaded = false;
    const readiness = () => Math.min(
      0.98,
      (engineLoaded ? 0.12 : 0.02) + (total ? 0.58 * (photosDone / total) : 0) + (r.isCameraOn ? 0.28 : 0)
    );
    update({
      phase: "preparing",
      notice: null,
      isStale: false,
      skippedCount: 0,
      progress: { done: 0, total },
      readiness: readiness(),
      isCameraOn: false,
      videoProgress: null,
      activeTargetId: null,
      isPlaybackBlocked: false,
      isAdjusting: false
    });
    const problem = checkTargetList(r.targets);
    if (problem) return endRun(r, { notice: problem, isStale: false, reason: "invalid-targets" });
    try {
      const loaded = module ?? await options.loadEngine();
      if (typeof loaded?.createEngine !== "function" || typeof loaded.compileTargetImage !== "function")
        throw new Error("Not a LiveMira engine module");
      module = loaded;
    } catch (cause) {
      if (!isCurrent(r)) return;
      const c = classify(cause, "engine-load", null);
      return endRun(r, {
        notice: c?.notice ?? { key: "notice.engineLoadFailed" },
        isStale: !!c?.isStale,
        reason: "engine-load"
      });
    }
    if (!isCurrent(r)) return;
    engineLoaded = true;
    update({ readiness: readiness() });
    if (!engine || engineContainer !== container) {
      for (const off of engineListeners.splice(0)) off();
      const old = engine;
      engine = null;
      await old?.dispose().catch(() => {
      });
      try {
        engine = module.createEngine({ ...options.engineOptions, container });
      } catch (cause) {
        const c = classify(cause, "start", null);
        return endRun(r, { notice: c?.notice ?? noticeForEngineError(cause), isStale: !!c?.isStale, reason: "start" });
      }
      engineContainer = container;
      listen();
      if (!state.isMuted) void engine.media.setMuted(false);
    }
    const current = engine;
    const camera = current.start().then(
      () => {
        if (!isCurrent(r)) return;
        r.isCameraOn = true;
        update({ isCameraOn: true, readiness: readiness() });
      },
      (error) => {
        r.abort.abort();
        throw error;
      }
    );
    const photos = preparePhotos(r, module, (done) => {
      photosDone = done;
      if (isCurrent(r))
        update({
          progress: { done, total },
          readiness: readiness(),
          ...done === total && !r.isCameraOn ? { phase: "starting" } : {}
        });
    });
    const [photoResult, cameraResult] = await Promise.allSettled([
      photos.catch((error) => {
        r.abort.abort();
        throw error;
      }),
      camera
    ]);
    if (!isCurrent(r)) return;
    if (cameraResult.status === "rejected") {
      const cause = cameraResult.reason;
      const c = classify(cause, "start", null);
      return endRun(r, { notice: c?.notice ?? noticeForEngineError(cause), isStale: !!c?.isStale, reason: "start" });
    }
    if (photoResult.status === "rejected") {
      const cause = photoResult.reason;
      const notice = cause instanceof RunStop ? cause.notice : { key: "notice.startFailed" };
      return endRun(r, { notice, isStale: cause instanceof RunStop && cause.isStale, reason: "photos" });
    }
    try {
      await current.setTargets(photoResult.value);
    } catch (cause) {
      if (!isCurrent(r)) return;
      return endRun(r, { notice: { key: "notice.invalidTargets" }, isStale: false, reason: "targets" });
    }
    if (!isCurrent(r)) return;
    update({ phase: "scanning", progress: null, readiness: null });
    observe({ type: "lifecycle", name: "ready" });
  };
  const session = {
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
      if (run && !run.isEnded) return starting ?? void 0;
      const r = {
        id: ++runs,
        abort: new AbortController(),
        targets: [...targets],
        isEnded: false,
        isCameraOn: false,
        wasFound: false,
        video: null,
        mediaFacts: /* @__PURE__ */ new Map()
      };
      run = r;
      const attempt = runStart(r, container).catch(async () => {
        await endRun(r, { notice: { key: "notice.startFailed" }, isStale: false, reason: "error" });
      });
      starting = attempt;
      void attempt.finally(() => {
        if (starting === attempt) starting = null;
      });
      return attempt;
    },
    stop(stopOptions = {}) {
      if (stopping) return stopping;
      const r = run;
      if (!r || r.isEnded) {
        if (stopOptions.notice || stopOptions.isStale)
          update({ notice: stopOptions.notice ?? state.notice, isStale: stopOptions.isStale ?? state.isStale });
        return Promise.resolve();
      }
      update({ phase: "stopping" });
      const attempt = endRun(r, {
        notice: stopOptions.notice ?? null,
        isStale: !!stopOptions.isStale,
        reason: stopOptions.reason ?? "ui-stop"
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
      observe({ type: "sound", isMuted, isAccepted: accepted });
      if (accepted) update({ isMuted, ...state.isPlaybackBlocked && !isMuted ? { isPlaybackBlocked: false } : {} });
      else update({ isMuted: true, notice: { key: "notice.soundRefused" } });
      return accepted;
    },
    async retryVideo() {
      const r = run;
      if (!r || r.isEnded || !engine) return;
      const video = r.video;
      if (video?.fact === "download-failed") {
        update({ notice: null });
        bindVideo(r, video.targetId, true);
        return;
      }
      update({ notice: null, isPlaybackBlocked: false });
      try {
        await engine.media.retry();
      } catch {
      }
    },
    dispose() {
      if (disposing) return disposing;
      disposing = (async () => {
        await session.stop({ reason: "dispose" });
        await starting?.catch(() => {
        });
        for (const off of engineListeners.splice(0)) off();
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

// packages/ui/src/styles.ts
var STYLE_TEXT = `
.lm-ar {
  --lm-ar-bg: #1d1810;
  --lm-ar-fg: #fff8ee;
  --lm-ar-muted: rgba(255, 248, 238, 0.68);
  --lm-ar-chip-bg: rgba(29, 24, 16, 0.58);
  --lm-ar-notice-bg: rgba(164, 55, 43, 0.88);
  --lm-ar-accent: #c0674a;
  --lm-ar-accent-hover: #a4533a;
  --lm-ar-accent-fg: #fff8ee;
  --lm-ar-focus: #fff8ee;
  --lm-ar-guide: rgba(255, 248, 238, 0.92);
  --lm-ar-font: inherit;
  --lm-ar-radius: 16px;
  --lm-ar-control-radius: 22px;
  --lm-ar-button-radius: 999px;
  --lm-ar-z: 20;
  position: relative; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box;
  background: var(--lm-ar-bg); color: var(--lm-ar-fg); font-family: var(--lm-ar-font); line-height: 1.4;
  overscroll-behavior: none; touch-action: none; -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none; user-select: none;
}
.lm-ar *, .lm-ar *::before, .lm-ar *::after { box-sizing: border-box; }
.lm-ar[hidden], .lm-ar [hidden] { display: none !important; }
.lm-ar--fullscreen { position: fixed; inset: 0; width: auto; height: 100vh; height: 100dvh; z-index: var(--lm-ar-z); }
.lm-ar--embedded { position: relative; }

/* Layers, bottom to top: camera stage, scanning guide, loader, curtain, controls. */
.lm-ar__stage { position: absolute; inset: 0; z-index: 0; }

/* Scanning guide: four corners breathing around the spot to aim at, with a soft light sweeping down. */
.lm-ar__guide {
  position: absolute; z-index: 1; left: 50%; top: 50%; width: min(70vmin, 360px); aspect-ratio: 4 / 3;
  transform: translate(-50%, -50%); pointer-events: none;
  opacity: 0; transition: opacity 0.35s ease, transform 0.35s ease;
}
.lm-ar__guide--on { opacity: 1; animation: lm-ar-breathe 2.8s ease-in-out infinite; }
.lm-ar__corner { position: absolute; width: 18%; aspect-ratio: 1; border: 0 solid var(--lm-ar-guide); filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45)); }
.lm-ar__corner:nth-child(1) { left: 0; top: 0; border-left-width: 3px; border-top-width: 3px; border-top-left-radius: 14px; }
.lm-ar__corner:nth-child(2) { right: 0; top: 0; border-right-width: 3px; border-top-width: 3px; border-top-right-radius: 14px; }
.lm-ar__corner:nth-child(3) { right: 0; bottom: 0; border-right-width: 3px; border-bottom-width: 3px; border-bottom-right-radius: 14px; }
.lm-ar__corner:nth-child(4) { left: 0; bottom: 0; border-left-width: 3px; border-bottom-width: 3px; border-bottom-left-radius: 14px; }
.lm-ar__sweep {
  position: absolute; left: 6%; right: 6%; top: 0; height: 22%; border-radius: 50%;
  background: radial-gradient(ellipse at 50% 100%, rgba(255, 248, 238, 0.34), rgba(192, 103, 74, 0.12) 45%, transparent 70%);
  animation: lm-ar-sweep 2.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes lm-ar-breathe { 0%, 100% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.035); } }
@keyframes lm-ar-sweep { 0% { transform: translateY(-10%); opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translateY(360%); opacity: 0; } }

/* Loader: a progress ring with the percentage, the current step and a hint. Opaque until the camera shows. */
.lm-ar__loader {
  position: absolute; inset: 0; z-index: 2; display: grid; place-content: center; justify-items: center; gap: 14px;
  padding: 24px; text-align: center; background: var(--lm-ar-bg); transition: opacity 0.45s ease, background-color 0.45s ease;
}
.lm-ar__loader--camera { background: radial-gradient(ellipse at center, rgba(29, 24, 16, 0.78), rgba(29, 24, 16, 0.5)); }
.lm-ar__loader--leaving { opacity: 0; pointer-events: none; }
.lm-ar__ring { position: relative; width: 96px; height: 96px; }
.lm-ar__ring svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.lm-ar__ring-track { fill: none; stroke: rgba(255, 248, 238, 0.16); stroke-width: 5; }
.lm-ar__ring-bar { fill: none; stroke: var(--lm-ar-accent); stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
.lm-ar__ring-glow { fill: none; stroke: var(--lm-ar-accent); stroke-width: 9; opacity: 0.25; filter: blur(4px); transition: stroke-dashoffset 0.4s ease; }
.lm-ar__percent {
  position: absolute; inset: 0; display: grid; place-items: center; font-size: 20px; font-weight: 600;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
}
.lm-ar__step { margin: 0; font-size: 15px; font-weight: 600; }
.lm-ar__hint { margin: 0; font-size: 13px; color: var(--lm-ar-muted); }

/* Curtain while the view changes shape: pure black, like the camera's own mask. */
.lm-ar__curtain {
  position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--lm-ar-curtain, #000); color: var(--lm-ar-fg); font-size: 14px;
}

.lm-ar__exit, .lm-ar__sound {
  position: absolute; z-index: 5; top: calc(10px + env(safe-area-inset-top)); display: grid; place-items: center;
  min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: var(--lm-ar-control-radius);
  background: var(--lm-ar-chip-bg); color: var(--lm-ar-fg); font: inherit; text-decoration: none; cursor: pointer;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); transition: transform 0.15s ease, background-color 0.2s ease;
}
.lm-ar__exit:active, .lm-ar__sound:active { transform: scale(0.94); }
.lm-ar__exit { left: calc(10px + env(safe-area-inset-left)); font-size: 28px; line-height: 1; }
.lm-ar__sound { right: calc(10px + env(safe-area-inset-right)); width: 44px; }
.lm-ar__sound--attention { background: var(--lm-ar-accent); animation: lm-ar-pulse 1.4s ease-in-out infinite; }
@keyframes lm-ar-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(192, 103, 74, 0.55); } 50% { box-shadow: 0 0 0 10px rgba(192, 103, 74, 0); } }
.lm-ar__exit:focus-visible, .lm-ar__sound:focus-visible, .lm-ar__button:focus-visible { outline: 2px solid var(--lm-ar-focus); outline-offset: 2px; }
.lm-ar__icon { display: block; width: 20px; height: 20px; fill: currentColor; }

.lm-ar__hud {
  /* A row below the 44px exit/sound row, so the status never collides with them. */
  position: absolute; z-index: 4; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right));
  top: calc(62px + env(safe-area-inset-top)); display: grid; justify-items: center; gap: 6px; pointer-events: none;
}
.lm-ar__status {
  display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 7px 14px; max-width: 100%; border-radius: var(--lm-ar-radius);
  background: var(--lm-ar-chip-bg); font-size: 13px; line-height: 1.4; text-align: center; overflow-wrap: anywhere;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); animation: lm-ar-in 0.25s ease;
}
.lm-ar__notice { background: var(--lm-ar-notice-bg); }
@keyframes lm-ar-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.lm-ar__spinner {
  display: inline-block; flex: none; width: 16px; height: 16px; border: 2px solid rgba(255, 248, 238, 0.3); border-top-color: var(--lm-ar-fg);
  border-radius: 50%; animation: lm-ar-spin 0.8s linear infinite;
}
.lm-ar__dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: #7ccf8a; box-shadow: 0 0 8px #7ccf8a; }
@keyframes lm-ar-spin { to { transform: rotate(360deg); } }

.lm-ar__controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  padding: 12px calc(12px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
}
.lm-ar__button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 40px; margin: 0; padding: 0 20px; border: 1px solid transparent;
  border-radius: var(--lm-ar-button-radius); background: var(--lm-ar-accent); color: var(--lm-ar-accent-fg); font: inherit; font-size: 15px;
  font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); transition: transform 0.15s ease, background-color 0.2s ease;
}
.lm-ar__button:hover { background: var(--lm-ar-accent-hover); }
.lm-ar__button:active { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .lm-ar__guide--on, .lm-ar__sweep, .lm-ar__sound--attention, .lm-ar__status { animation: none; }
  .lm-ar__sweep { display: none; }
  .lm-ar__spinner { animation-duration: 2s; }
  .lm-ar__loader, .lm-ar__guide, .lm-ar__ring-bar, .lm-ar__ring-glow { transition: none; }
}
`;

// packages/ui/src/messages.ts
var ZH_CN = Object.freeze({
  title: "扫描照片，看见视频",
  exit: "关闭相机",
  restart: "重新开始",
  reloadVideo: "重新加载视频",
  soundOn: "开启声音",
  soundOff: "关闭声音",
  skipped: "有 {count} 张照片不适合扫描，已跳过。",
  "loader.engine": "正在加载识别组件…",
  "loader.photos": "正在准备照片 {done}/{total}",
  "loader.camera": "正在打开相机…",
  "loader.hint": "首次使用需要允许访问相机",
  "status.preparingProgress": "正在准备照片（{done}/{total}）…",
  "status.preparing": "正在准备…",
  "status.viewport": "正在调整画面…",
  "status.starting": "正在打开相机…",
  "status.stopping": "正在停止…",
  "status.loading": "找到照片了，正在加载视频…",
  "status.loadingProgress": "找到照片了，正在加载视频 {percent}%",
  "status.playing": "正在播放",
  "status.lost": "照片移开了，重新对准即可继续。",
  "status.videoError": "视频暂时无法播放。",
  "status.searching": "请把相机对准要识别的照片。",
  "status.blocked": "轻点声音按钮即可播放。",
  "notice.noTargets": "没有完整的照片与视频可以扫描。",
  "notice.tooMany": "一次最多扫描 {max} 组照片与视频。",
  "notice.invalidTargets": "照片与视频的配置无效（编号缺失、重复或与识别数据不一致）。",
  "notice.allRejected": "这些照片都无法用于扫描，请换更清晰的照片。",
  "notice.startFailed": "扫描未能启动，请重试。",
  "notice.emptyVideo": "视频文件为空。",
  "notice.cameraDenied": "没有相机权限，请在浏览器设置中允许后重新开始。",
  "notice.cameraUnavailable": "没有找到可用的相机。",
  "notice.cameraInterrupted": "相机已中断，请重新开始。",
  "notice.unsupported": "本设备无法进行识别：需要 WebGL2 支持（请换用较新的浏览器或设备）。",
  "notice.insecure": "请通过 HTTPS 打开本页面，才能使用相机。",
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
  "loader.engine": "Loading the scanner…",
  "loader.photos": "Preparing photos {done}/{total}",
  "loader.camera": "Opening the camera…",
  "loader.hint": "Allow camera access when asked",
  "status.preparingProgress": "Preparing photos ({done}/{total})…",
  "status.preparing": "Getting ready…",
  "status.viewport": "Adjusting the view…",
  "status.starting": "Opening the camera…",
  "status.stopping": "Stopping…",
  "status.loading": "Photo found. Loading its video…",
  "status.loadingProgress": "Photo found. Loading its video {percent}%",
  "status.playing": "Playing",
  "status.lost": "The photo moved out of view. Point at it again to continue.",
  "status.videoError": "The video cannot play right now.",
  "status.searching": "Point the camera at a photo to scan.",
  "status.blocked": "Tap the sound button to play.",
  "notice.noTargets": "There are no complete photo and video pairs to scan.",
  "notice.tooMany": "You can scan at most {max} pairs at a time.",
  "notice.invalidTargets": "The photo and video setup is invalid (a missing or duplicate id, or an id that does not match its target data).",
  "notice.allRejected": "None of the photos can be used for scanning. Try clearer photos.",
  "notice.startFailed": "Scanning could not start. Please try again.",
  "notice.emptyVideo": "The video file is empty.",
  "notice.cameraDenied": "Camera access was not granted. Allow it in your browser settings, then start again.",
  "notice.cameraUnavailable": "No camera is available.",
  "notice.cameraInterrupted": "The camera was interrupted. Please start again.",
  "notice.unsupported": "This device cannot scan: WebGL2 is required (try a newer browser or device).",
  "notice.insecure": "Open this page over HTTPS to use the camera.",
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

// packages/ui/src/translator.ts
var TABLES = { "zh-CN": ZH_CN, en: EN };
function resolveLocale(locale) {
  return typeof locale === "string" && /^en(-|$)/i.test(locale) ? "en" : "zh-CN";
}
function format(message, params) {
  const count = params?.count;
  const text = typeof message === "string" ? message : count === 1 ? message.one : message.other;
  return text.replace(/\{(\w+)\}/g, (whole, name) => params && name in params ? String(params[name]) : whole);
}
function createTranslator(options = {}) {
  const locale = resolveLocale(options.locale);
  return {
    locale,
    t(key, params) {
      try {
        const own = options.translate?.(key, params, locale);
        if (typeof own === "string") return own;
      } catch {
      }
      const message = options.messages?.[locale]?.[key] ?? options.messages?.[options.locale ?? ""]?.[key] ?? TABLES[locale][key] ?? ZH_CN[key];
      return message === void 0 ? key : format(message, params);
    }
  };
}

// packages/ui/src/view.ts
var SOUND_ON = '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
var SOUND_OFF = '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
var RING_LENGTH = 2 * Math.PI * 42;
var styles = /* @__PURE__ */ new Map();
var scrollLocks = /* @__PURE__ */ new Map();
function acquireStyle(doc) {
  let entry = styles.get(doc);
  if (!entry) {
    const element = doc.createElement("style");
    element.setAttribute("data-livemira-ui", "");
    element.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement).append(element);
    styles.set(doc, entry = { element, count: 0 });
  }
  entry.count++;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.count === 0) {
      held.element.remove();
      styles.delete(doc);
    }
  };
}
function lockScroll(doc) {
  let entry = scrollLocks.get(doc);
  if (!entry) {
    entry = { count: 0, html: doc.documentElement.style.overflow, body: doc.body?.style.overflow ?? "" };
    doc.documentElement.style.overflow = "hidden";
    if (doc.body) doc.body.style.overflow = "hidden";
    scrollLocks.set(doc, entry);
  }
  entry.count++;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.count === 0) {
      doc.documentElement.style.overflow = held.html;
      if (doc.body) doc.body.style.overflow = held.body;
      scrollLocks.delete(doc);
    }
  };
}
var el = (doc, tag, className) => {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
};
function mountArView(container, session, options = {}) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let current = { ...options };
  let t = createTranslator(current);
  const releaseStyle = acquireStyle(doc);
  const mode = current.mode ?? "fullscreen";
  const releaseScroll = mode === "fullscreen" ? lockScroll(doc) : () => {
  };
  const root = el(doc, "div", `lm-ar lm-ar--${mode}`);
  const stage = el(doc, "div", "lm-ar__stage");
  const guide = el(doc, "div", "lm-ar__guide");
  guide.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 4; i++) guide.append(el(doc, "span", "lm-ar__corner"));
  guide.append(el(doc, "span", "lm-ar__sweep"));
  const loader = el(doc, "div", "lm-ar__loader");
  loader.setAttribute("role", "progressbar");
  loader.setAttribute("aria-valuemin", "0");
  loader.setAttribute("aria-valuemax", "100");
  const ring = el(doc, "div", "lm-ar__ring");
  ring.innerHTML = `<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="lm-ar__ring-track" cx="48" cy="48" r="42"/><circle class="lm-ar__ring-glow" cx="48" cy="48" r="42" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"/><circle class="lm-ar__ring-bar" cx="48" cy="48" r="42" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"/></svg>`;
  const percent = el(doc, "span", "lm-ar__percent");
  ring.append(percent);
  const step = el(doc, "p", "lm-ar__step");
  const hint = el(doc, "p", "lm-ar__hint");
  loader.append(ring, step, hint);
  const curtain = el(doc, "div", "lm-ar__curtain");
  curtain.setAttribute("role", "status");
  const curtainText = el(doc, "span", "");
  curtain.append(el(doc, "span", "lm-ar__spinner"), curtainText);
  const exit = current.exitHref ? el(doc, "a", "lm-ar__exit") : el(doc, "button", "lm-ar__exit");
  if (exit instanceof HTMLAnchorElement) exit.href = current.exitHref;
  else exit.type = "button";
  exit.textContent = "×";
  const sound = el(doc, "button", "lm-ar__sound");
  sound.type = "button";
  const hud = el(doc, "div", "lm-ar__hud");
  const status = el(doc, "p", "lm-ar__status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const notice = el(doc, "p", "lm-ar__status lm-ar__notice");
  notice.setAttribute("role", "alert");
  const info = el(doc, "p", "lm-ar__status");
  hud.append(status, notice, info);
  const controls = el(doc, "div", "lm-ar__controls");
  const restart = el(doc, "button", "lm-ar__button");
  restart.type = "button";
  const reload = el(doc, "button", "lm-ar__button");
  reload.type = "button";
  controls.append(restart, reload);
  root.append(stage, guide, loader, curtain, exit, sound, hud, controls);
  container.append(root);
  const applyTheme = () => {
    for (const [name, value] of Object.entries(current.theme ?? {})) root.style.setProperty(`--lm-ar-${name}`, value);
  };
  applyTheme();
  let started = false;
  const start = () => {
    started = true;
    void session.start(stage);
  };
  restart.addEventListener("click", start);
  reload.addEventListener("click", () => void session.retryVideo());
  sound.addEventListener("click", () => void session.setMuted(!session.getState().isMuted));
  exit.addEventListener("click", (event) => current.onExit?.(event));
  let leaveTimer = null;
  let lastActive = null;
  const setText = (node, text, spinner = false, dot = false) => {
    node.hidden = !text;
    if (!text) return;
    const key = `${spinner}|${dot}|${text}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.textContent = "";
    if (spinner) node.append(el(doc, "span", "lm-ar__spinner"));
    if (dot) node.append(el(doc, "span", "lm-ar__dot"));
    node.append(doc.createTextNode(text));
  };
  const render = () => {
    const s = session.getState();
    root.dataset.phase = s.phase;
    root.dataset.view = s.view;
    const preparing = s.phase === "preparing" || s.phase === "starting";
    const scanning = s.phase === "scanning";
    if (preparing) {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = null;
      loader.hidden = false;
      loader.classList.remove("lm-ar__loader--leaving");
      loader.classList.toggle("lm-ar__loader--camera", s.isCameraOn);
      const value = Math.round(100 * (s.readiness ?? 0));
      percent.textContent = `${value}%`;
      loader.setAttribute("aria-valuenow", String(value));
      const offset = String(RING_LENGTH * (1 - (s.readiness ?? 0)));
      for (const bar of loader.querySelectorAll("circle:not(.lm-ar__ring-track)"))
        bar.setAttribute("stroke-dashoffset", offset);
      const p = s.progress;
      step.textContent = (s.readiness ?? 0) < 0.1 ? t.t("loader.engine") : p && p.done < p.total ? t.t("loader.photos", { done: p.done, total: p.total }) : t.t("loader.camera");
      loader.setAttribute("aria-label", step.textContent);
      hint.textContent = t.t("loader.hint");
      hint.hidden = s.isCameraOn;
    } else if (!loader.hidden && !leaveTimer) {
      if (scanning) {
        percent.textContent = "100%";
        for (const bar of loader.querySelectorAll("circle:not(.lm-ar__ring-track)"))
          bar.setAttribute("stroke-dashoffset", "0");
        loader.classList.add("lm-ar__loader--leaving");
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          loader.hidden = true;
        }, 480);
      } else loader.hidden = true;
    }
    guide.classList.toggle("lm-ar__guide--on", scanning && !s.activeTargetId && !s.isAdjusting);
    curtain.hidden = !(scanning && s.isAdjusting);
    curtainText.textContent = t.t("status.viewport");
    let statusText = null;
    let spinner = false;
    let dot = false;
    if (s.phase === "stopping") {
      statusText = t.t("status.stopping");
      spinner = true;
    } else if (scanning && !s.isAdjusting) {
      if (s.isPlaybackBlocked) statusText = t.t("status.blocked");
      else if (s.view === "searching") statusText = t.t("status.searching");
      else if (s.view === "lost") statusText = t.t("status.lost");
      else if (s.view === "videoError") statusText = t.t("status.videoError");
      else if (s.view === "playing") {
        statusText = t.t("status.playing");
        dot = true;
      } else {
        const progress = s.videoProgress;
        statusText = progress !== null && Number.isFinite(progress) ? t.t("status.loadingProgress", { percent: Math.round(progress * 100) }) : t.t("status.loading");
        spinner = true;
      }
    }
    setText(status, statusText, spinner, dot);
    setText(notice, s.notice ? s.notice.text ?? t.t(s.notice.key, s.notice.params) : null);
    setText(info, scanning && s.skippedCount > 0 ? t.t("skipped", { count: s.skippedCount }) : null);
    exit.hidden = !current.onExit && !current.exitHref;
    exit.setAttribute("aria-label", t.t("exit"));
    sound.hidden = !scanning;
    if (sound.dataset.muted !== String(s.isMuted)) {
      sound.dataset.muted = String(s.isMuted);
      sound.innerHTML = s.isMuted ? SOUND_OFF : SOUND_ON;
    }
    sound.setAttribute("aria-label", t.t(s.isMuted ? "soundOn" : "soundOff"));
    sound.setAttribute("aria-pressed", String(!s.isMuted));
    sound.classList.toggle("lm-ar__sound--attention", s.isPlaybackBlocked);
    const isFinal = s.notice?.key === "notice.unsupported" || s.notice?.key === "notice.insecure";
    restart.hidden = !(s.phase === "idle" && started && !s.isDisposed && !isFinal);
    restart.textContent = t.t("restart");
    reload.hidden = !(scanning && s.view === "videoError");
    reload.textContent = t.t("reloadVideo");
    if (s.activeTargetId && s.activeTargetId !== lastActive && current.isHapticEnabled !== false)
      try {
        win?.navigator?.vibrate?.(12);
      } catch {
      }
    lastActive = s.activeTargetId;
  };
  const unsubscribe = session.subscribe(render);
  render();
  let observer = null;
  if (current.isAutoStart !== false) {
    const tryStart = () => {
      if (started || stage.clientWidth === 0 || stage.clientHeight === 0) return;
      observer?.disconnect();
      observer = null;
      start();
    };
    observer = new ResizeObserver(tryStart);
    observer.observe(stage);
    tryStart();
  }
  const onHidden = () => {
    if (current.isStoppedWhenHidden === false) return;
    const phase = session.getState().phase;
    if (phase === "idle" || phase === "stopping") return;
    void session.stop({ reason: "page-hidden", notice: { key: "notice.backgrounded" } });
  };
  const onVisibility = () => {
    if (doc.visibilityState === "hidden") onHidden();
  };
  doc.addEventListener("visibilitychange", onVisibility);
  win?.addEventListener("pagehide", onHidden);
  let destroyed = false;
  return {
    element: root,
    update(change) {
      if (destroyed) return;
      current = { ...current, ...change };
      t = createTranslator(current);
      applyTheme();
      render();
    },
    start() {
      if (!destroyed) start();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (leaveTimer) clearTimeout(leaveTimer);
      observer?.disconnect();
      unsubscribe();
      doc.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("pagehide", onHidden);
      root.remove();
      releaseScroll();
      releaseStyle();
    }
  };
}

// packages/ui/src/index.ts
var UI_VERSION = true ? "0.5.0" : "0.0.0-dev";
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
        view.destroy();
        await session.dispose();
      })();
      return destroying;
    }
  };
}
export {
  DEFAULT_LOCALE,
  EN,
  UI_VERSION,
  ZH_CN,
  createArSession,
  createTranslator,
  fetchMedia,
  mountArCamera,
  mountArView,
  resolveLocale
};
