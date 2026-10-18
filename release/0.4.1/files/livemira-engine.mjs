/*! LiveMira engine | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

// <define:__LIVEMIRA_BUILD__>
var define_LIVEMIRA_BUILD_default = { variant: "readable", buildId: "ead49413c2b51a532c34b61afe5a55fa33f1aee84c3d918d6a25aec4a49ef42f" };

// packages/sdk/src/build-info.ts
var ENGINE_VERSION = "0.4.1";
var engineBuildInfo = Object.freeze(
  typeof define_LIVEMIRA_BUILD_default === "undefined" ? { version: ENGINE_VERSION, format: "modules", variant: null, buildId: null } : {
    version: ENGINE_VERSION,
    format: "single",
    variant: define_LIVEMIRA_BUILD_default.variant,
    buildId: define_LIVEMIRA_BUILD_default.buildId
  }
);

// packages/contracts/src/errors.ts
var EngineError = class extends Error {
  code;
  isRecoverable;
  constructor(code, message, options) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "EngineError";
    this.code = code;
    this.isRecoverable = options.isRecoverable;
  }
};

// packages/contracts/src/target.ts
function validateTargetBundle(value) {
  const t = value;
  const fail = () => {
    throw new EngineError("INVALID_TARGET", "Malformed, incompatible or oversized target bundle", {
      isRecoverable: false
    });
  };
  if (!t || t.schemaVersion !== 1 || !t.targetId || typeof t.targetId !== "string" || t.targetId.length > 256 || !t.compilerVersion || !t.algorithmVersion || !/^[a-f0-9]{64}$/i.test(t.imageHash ?? "") || t.orientation !== "top-left") {
    fail();
  }
  if (![t.widthPx, t.heightPx].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || t.physicalWidthMeters !== null && !(Number.isFinite(t.physicalWidthMeters) && t.physicalWidthMeters > 0)) {
    fail();
  }
  const f = t.features;
  if (!f || !Array.isArray(f.points) || f.points.length > 1e5 || !Number.isInteger(f.descriptorLength) || f.descriptorLength < 1 || f.descriptorLength > 512 || !f.descriptorType || !Array.isArray(f.descriptors) || f.descriptors.length !== f.points.length * f.descriptorLength || !f.descriptors.every(Number.isFinite)) {
    fail();
  }
  if (!f.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
    fail();
  if (!Array.isArray(t.pyramid) || t.pyramid.length > 16 || !t.preprocessing || !Array.isArray(t.diagnostics))
    fail();
  let bytes = 0;
  for (const level of t.pyramid) {
    if (![level.width, level.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || !Number.isFinite(level.scale) || level.scale <= 0 || !Array.isArray(level.pixels) || level.pixels.length !== level.width * level.height) {
      fail();
    }
    bytes += level.pixels.length;
    if (bytes > 16777216 || !level.pixels.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      fail();
  }
}

// packages/contracts/src/tracking-result.ts
var MAX_MATCHED_POINTS = 512;

// packages/camera/src/geometry/frame-geometry.ts
function multiply3(a, b) {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    return a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6];
  });
}
var ROTATIONS = (w, h) => ({
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  90: [0, -1, h, 1, 0, 0, 0, 0, 1],
  180: [-1, 0, w, 0, -1, h, 0, 0, 1],
  270: [0, 1, 0, -1, 0, w, 0, 0, 1]
});
function createGeometry(params) {
  const {
    widthPx: width,
    heightPx: height,
    rotationDeg: rotation = 0,
    isMirrored: mirrored = false,
    crop = { x: 0, y: 0, width, height },
    longEdge = 640,
    viewportWidthCss: cssWidth = width,
    viewportHeightCss: cssHeight = height,
    devicePixelRatio: dpr = 1,
    fit = "cover",
    isViewportMirrored: viewportMirrored = false
  } = params;
  if (![width, height, crop.width, crop.height, cssWidth, cssHeight, dpr].every(
    (v) => Number.isFinite(v) && v > 0
  ) || longEdge !== "native" && !(Number.isFinite(longEdge) && longEdge > 0) || ![crop.x, crop.y].every((v) => Number.isFinite(v) && v >= 0) || crop.x + crop.width > width || crop.y + crop.height > height || ![0, 90, 180, 270].includes(rotation) || !["contain", "cover"].includes(fit)) {
    throw new EngineError("INVALID_CONFIG", "Invalid frame geometry", { isRecoverable: false });
  }
  const w = crop.width;
  const h = crop.height;
  const unmirror = mirrored ? [-1, 0, w, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rw = rotation % 180 ? h : w;
  const rh = rotation % 180 ? w : h;
  const targetEdge = longEdge === "native" ? Math.max(rw, rh) : longEdge;
  const scale = Math.min(1, targetEdge / Math.max(rw, rh));
  const standardWidthPx = Math.max(1, Math.round(rw * scale));
  const standardHeightPx = Math.max(1, Math.round(rh * scale));
  const H_standardFromInput = multiply3(
    [standardWidthPx / rw, 0, 0, 0, standardHeightPx / rh, 0, 0, 0, 1],
    multiply3(
      ROTATIONS(w, h)[rotation],
      multiply3(unmirror, [1, 0, -crop.x, 0, 1, -crop.y, 0, 0, 1])
    )
  );
  const viewportScale = Math[fit === "cover" ? "max" : "min"](
    cssWidth / standardWidthPx,
    cssHeight / standardHeightPx
  );
  let H_viewportFromStandard = [
    viewportScale,
    0,
    (cssWidth - standardWidthPx * viewportScale) / 2,
    0,
    viewportScale,
    (cssHeight - standardHeightPx * viewportScale) / 2,
    0,
    0,
    1
  ];
  if (viewportMirrored)
    H_viewportFromStandard = multiply3([-1, 0, cssWidth, 0, 1, 0, 0, 0, 1], H_viewportFromStandard);
  return {
    H_standardFromInput,
    H_viewportFromStandard,
    crop: { ...crop },
    rotationDeg: rotation,
    isMirrored: mirrored,
    fit,
    standardWidthPx,
    standardHeightPx,
    viewportWidthCss: cssWidth,
    viewportHeightCss: cssHeight,
    devicePixelRatio: dpr
  };
}

// packages/camera/src/owned-image.ts
function createOwnedImage(format, value, close = () => value.close?.()) {
  let isReleased = false;
  const image = {
    format,
    get isReleased() {
      return isReleased;
    },
    data() {
      if (isReleased)
        throw new EngineError("RESOURCE_FAILED", "Image has been released", {
          isRecoverable: false
        });
      return value;
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      close();
    }
  };
  return image;
}

// packages/camera/src/capture/frame-clock.ts
var FrameClock = class {
  nowUs;
  originUs;
  lastSourceUs = -Infinity;
  offsetUs = null;
  constructor(nowUs = () => performance.now() * 1e3) {
    this.nowUs = nowUs;
    this.originUs = nowUs();
  }
  /** Session time now. */
  arrival() {
    return Math.max(0, this.nowUs() - this.originUs);
  }
  /**
   * Maps one source timestamp. Returns null for a repeated timestamp (the same picture again); throws
   * `CAMERA_CLOCK_RESET` when the source clock goes backwards.
   */
  observe(sourceTimestampUs, arrivalTimeUs = this.arrival()) {
    if (!Number.isFinite(sourceTimestampUs) || !Number.isFinite(arrivalTimeUs)) {
      throw new EngineError("CAMERA_CAPTURE_FAILED", "Finite timestamps required", {
        isRecoverable: true
      });
    }
    if (sourceTimestampUs === this.lastSourceUs) return null;
    if (sourceTimestampUs < this.lastSourceUs) {
      throw new EngineError("CAMERA_CLOCK_RESET", "SOURCE_CLOCK_RESET", { isRecoverable: true });
    }
    this.lastSourceUs = sourceTimestampUs;
    this.offsetUs ??= arrivalTimeUs - sourceTimestampUs;
    return {
      sourceTimestampUs,
      arrivalTimeUs,
      observationTimeUs: sourceTimestampUs + this.offsetUs,
      sourceToSessionOffsetUs: this.offsetUs
    };
  }
  /** Maps a different source clock from now on (callback timestamps after a frozen media time); session time goes on. */
  restartSource() {
    this.lastSourceUs = -Infinity;
    this.offsetUs = null;
  }
};

// packages/camera/src/viewport/viewport-measure.ts
var round2 = (n) => Math.round((n ?? 0) * 100) / 100;
function measureView(container, env) {
  const rect = container?.getBoundingClientRect?.();
  const vv = env.visualViewport;
  return JSON.stringify([
    round2(rect?.width ?? container?.clientWidth),
    round2(rect?.height ?? container?.clientHeight),
    round2(vv?.width ?? env.innerWidth),
    round2(vv?.height ?? env.innerHeight),
    env.screen?.orientation?.angle ?? env.orientation ?? null,
    env.devicePixelRatio ?? 1
  ]);
}
function containerGeometry(container, env) {
  if (!container) return null;
  const rect = container.getBoundingClientRect?.();
  const cssWidth = rect?.width ?? container.clientWidth;
  const cssHeight = rect?.height ?? container.clientHeight;
  if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0)
    return null;
  return {
    viewportWidthCss: cssWidth,
    viewportHeightCss: cssHeight,
    devicePixelRatio: env.devicePixelRatio ?? 1
  };
}
function layoutSize(env) {
  const vv = env.visualViewport;
  const ok = (w, h) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  if (ok(env.innerWidth, env.innerHeight)) return [env.innerWidth, env.innerHeight];
  return ok(vv?.width, vv?.height) ? [vv.width, vv.height] : null;
}
function hasLayoutTurned(before, after) {
  if (!before || !after) return false;
  const [w0, h0] = before;
  const [w, h] = after;
  return w >= h !== w0 >= h0 && Math.abs(w - h0) < Math.abs(w - w0) && Math.abs(h - w0) < Math.abs(h - h0);
}

// packages/camera/src/viewport/viewport-gate.ts
var DEFAULT_VIEWPORT_STABILIZATION = Object.freeze({
  stableFrames: 2,
  quietMs: 100,
  orientationIntrinsicWaitMs: 400
});
var ViewportGate = class {
  epoch = 0;
  isGated = false;
  isDisposed = false;
  stable = 0;
  lastSig = null;
  openSig = null;
  openDims = null;
  stableSinceUs = 0;
  lastTriggerUs = 0;
  intrinsicWaitUntilUs = 0;
  preDims = null;
  prepared = null;
  paintRequest = null;
  isTurnWait = false;
  view;
  openLayout;
  stableFrames;
  quietUs;
  intrinsicWaitUs;
  cleanups = [];
  env;
  container;
  nowUs;
  onTransition;
  setMask;
  stats = {
    transitions: 0,
    triggers: 0,
    preparedGeometries: 0,
    droppedFrames: 0,
    staleEpochDrops: 0,
    lastReason: null,
    lastOpenedEpoch: null
  };
  constructor(options) {
    const o = { ...DEFAULT_VIEWPORT_STABILIZATION, ...options.stabilization };
    if (!Number.isSafeInteger(o.stableFrames) || o.stableFrames < 1 || !Number.isFinite(o.quietMs) || o.quietMs < 0 || !Number.isFinite(o.orientationIntrinsicWaitMs) || o.orientationIntrinsicWaitMs < 0) {
      throw new EngineError("INVALID_CONFIG", "Invalid viewport stabilization options", {
        isRecoverable: false
      });
    }
    this.env = options.env;
    this.container = options.container ?? null;
    this.nowUs = options.nowUs;
    this.onTransition = options.onTransition ?? (() => {
    });
    this.setMask = options.setMask ?? (() => {
    });
    this.stableFrames = o.stableFrames;
    this.quietUs = o.quietMs * 1e3;
    this.intrinsicWaitUs = o.orientationIntrinsicWaitMs * 1e3;
    this.view = this.measure();
    this.openLayout = layoutSize(this.env);
    this.listen();
  }
  listen() {
    const env = this.env;
    const on = (target, name, fn) => {
      if (typeof target?.addEventListener !== "function") return;
      target.addEventListener(name, fn);
      this.cleanups.push(() => target.removeEventListener?.(name, fn));
    };
    on(env.screen?.orientation, "change", () => this.trigger("orientation", true));
    on(env, "orientationchange", () => this.trigger("orientation", true));
    on(env, "resize", () => this.check("resize"));
    on(env.visualViewport, "resize", () => this.check("visual-viewport"));
    if (this.container && typeof env.ResizeObserver === "function") {
      const observer = new env.ResizeObserver(() => this.check("container"));
      observer.observe(this.container);
      this.cleanups.push(() => observer.disconnect());
    }
  }
  /** Watches the camera video for intrinsic size changes. */
  attachVideo(video) {
    if (this.isDisposed || typeof video?.addEventListener !== "function") return;
    const fn = () => this.trigger("intrinsic", false);
    video.addEventListener("resize", fn);
    this.cleanups.push(() => video.removeEventListener?.("resize", fn));
  }
  /** The container's current CSS size and pixel ratio, or null without a usable container. */
  viewportGeometry() {
    return containerGeometry(this.container, this.env);
  }
  measure() {
    return measureView(this.container, this.env);
  }
  /** Resize-class events trigger only when the measured view really changed. */
  check(reason) {
    if (this.isDisposed) return;
    if (this.measure() !== this.view) this.trigger(reason, false);
  }
  /** Masks immediately and starts a new epoch. */
  trigger(reason, isOrientation) {
    if (this.isDisposed) return;
    this.view = this.measure();
    const now = this.nowUs();
    this.epoch++;
    this.stable = 0;
    this.lastSig = null;
    this.lastTriggerUs = now;
    this.stableSinceUs = now;
    this.discardPrepared();
    const isInferred = !isOrientation && hasLayoutTurned(this.openLayout, layoutSize(this.env)) && !this.isTurnWait;
    if (isInferred) isOrientation = true;
    this.stats.triggers++;
    this.stats.lastReason = reason;
    if (isOrientation) {
      this.isTurnWait = true;
      this.preDims ??= this.openDims;
      this.intrinsicWaitUntilUs = now + this.intrinsicWaitUs;
    }
    if (!this.isGated) {
      this.isGated = true;
      this.stats.transitions++;
    }
    this.setMask(true);
    this.onTransition({ phase: "begin", epoch: this.epoch, reason });
  }
  /** Taken when a capture starts. It can confirm only if the prepared geometry was already painted at this moment. */
  begin() {
    return {
      epoch: this.epoch,
      view: this.measure(),
      prepared: this.prepared?.isPainted ? this.prepared : null
    };
  }
  /**
   * Called with a fully captured frame; true means the frame may be delivered. `sig` identifies the frame's geometry
   * inputs and `dims` its intrinsic size. The stages may re-enter the gate.
   */
  admit(token, sig, dims, stages = {}) {
    if (this.isDisposed) return false;
    if (token.epoch !== this.epoch) {
      this.stats.staleEpochDrops++;
      this.stats.droppedFrames++;
      return false;
    }
    if (this.container && !this.viewportGeometry()) {
      if (!this.isGated) this.trigger("empty-container", false);
      this.stats.droppedFrames++;
      return false;
    }
    const view = this.measure();
    if (view !== token.view || view !== this.view) {
      this.trigger("frame-view", false);
      this.stats.droppedFrames++;
      return false;
    }
    if (!this.isGated) {
      if (this.openSig !== null && sig !== this.openSig) {
        this.trigger("frame-geometry", false);
        this.stats.droppedFrames++;
        return false;
      }
      this.openSig = sig;
      this.openDims = dims;
      return true;
    }
    return this.admitWhileGated(token, sig, dims, stages);
  }
  admitWhileGated(token, sig, dims, { prepare = () => {
  }, commit = () => {
  } }) {
    const now = this.nowUs();
    if (sig !== this.lastSig) {
      this.stable = 1;
      this.stableSinceUs = now;
      this.discardPrepared();
    } else this.stable++;
    this.lastSig = sig;
    const isIntrinsicReady = now >= this.intrinsicWaitUntilUs || !this.preDims || dims !== this.preDims;
    if (this.stable < this.stableFrames || now - this.stableSinceUs < this.quietUs || !isIntrinsicReady) {
      this.discardPrepared();
      this.stats.droppedFrames++;
      return false;
    }
    if (!this.prepared) {
      const prepared2 = { epoch: this.epoch, sig, dims, isPainted: false };
      this.prepared = prepared2;
      prepare();
      if (!this.holds(prepared2) || !this.viewUnchanged(token)) {
        this.stats.droppedFrames++;
        return false;
      }
      this.stats.preparedGeometries++;
      this.awaitPaint(prepared2);
      this.stats.droppedFrames++;
      return false;
    }
    if (token.prepared !== this.prepared || !this.prepared.isPainted || this.prepared.sig !== sig || this.prepared.dims !== dims) {
      this.stats.droppedFrames++;
      return false;
    }
    const prepared = this.prepared;
    commit();
    if (!this.holds(prepared) || !this.viewUnchanged(token)) {
      this.stats.droppedFrames++;
      return false;
    }
    this.isGated = false;
    this.openSig = sig;
    this.openDims = dims;
    this.preDims = null;
    this.isTurnWait = false;
    this.openLayout = layoutSize(this.env);
    this.stats.lastOpenedEpoch = this.epoch;
    this.discardPrepared();
    this.setMask(false);
    this.onTransition({ phase: "end", epoch: this.epoch, reason: this.stats.lastReason });
    return !this.isDisposed && !this.isGated && token.epoch === this.epoch;
  }
  /** Silent view changes (no event delivered) re-arm the gate; false means the frame must not be shown. */
  viewUnchanged(token) {
    if (this.isDisposed) return false;
    const isValid = (!this.container || this.viewportGeometry()) && this.measure() === token.view && token.view === this.view;
    if (!isValid) this.trigger("frame-view", false);
    return Boolean(isValid) && !this.isDisposed;
  }
  /** True while the prepared state is still current (a re-entrant trigger, stop or dispose invalidates it). */
  holds(prepared) {
    return !this.isDisposed && this.prepared === prepared && prepared.epoch === this.epoch;
  }
  /** Two animation frames: the first runs before the next paint, the second after that paint. Without rAF there is nothing to wait for. */
  awaitPaint(prepared) {
    const raf = this.env.requestAnimationFrame;
    if (typeof raf !== "function") {
      prepared.isPainted = true;
      return;
    }
    const request = (fn) => raf.call(this.env, fn);
    const done = () => {
      if (!this.holds(prepared)) return;
      this.paintRequest = null;
      prepared.isPainted = true;
    };
    try {
      this.paintRequest = request(() => {
        if (!this.holds(prepared)) return;
        this.paintRequest = null;
        try {
          this.paintRequest = request(done);
        } catch {
          done();
        }
      });
    } catch {
      this.paintRequest = null;
      prepared.isPainted = true;
    }
  }
  discardPrepared() {
    this.prepared = null;
    const id = this.paintRequest;
    this.paintRequest = null;
    if (id != null) {
      try {
        this.env.cancelAnimationFrame?.(id);
      } catch {
      }
    }
  }
  getDiagnostics() {
    return {
      state: this.isGated ? "gated" : "open",
      phase: !this.isGated ? "open" : this.prepared ? this.prepared.isPainted ? "confirming" : "painting" : "settling",
      epoch: this.epoch,
      stableFrames: this.stable,
      requiredStableFrames: this.stableFrames,
      ...this.stats
    };
  }
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.discardPrepared();
    for (const cleanup of this.cleanups.splice(0)) {
      try {
        cleanup();
      } catch {
      }
    }
    this.setMask(false);
  }
};

// packages/camera/src/camera-types.ts
var DEFAULT_CAPTURE = "canvas";
var DEFAULT_TIMESTAMPS = "callback";

// packages/camera/src/preview/preview-style.ts
function previewStyle(geometry, widthPx, heightPx) {
  const h = multiply3(geometry.H_viewportFromStandard, geometry.H_standardFromInput);
  const crop = geometry.crop;
  return {
    position: "absolute",
    left: "0px",
    top: "0px",
    width: `${widthPx}px`,
    height: `${heightPx}px`,
    minWidth: "0px",
    minHeight: "0px",
    maxWidth: "none",
    maxHeight: "none",
    padding: "0px",
    border: "0px",
    boxSizing: "content-box",
    aspectRatio: "auto",
    objectFit: "contain",
    objectPosition: "0 0",
    transformOrigin: "0 0",
    transform: `matrix(${h[0]},${h[3]},${h[1]},${h[4]},${h[2]},${h[5]})`,
    clipPath: `inset(${crop.y}px ${widthPx - crop.x - crop.width}px ${heightPx - crop.y - crop.height}px ${crop.x}px)`
  };
}

// packages/camera/src/preview/preview-surface.ts
var canvasPreviewSurface = (layer2) => {
  let canvas = null;
  let context;
  try {
    canvas = layer2.ownerDocument?.createElement("canvas") ?? null;
    context = typeof canvas?.getContext === "function" ? canvas.getContext("2d", { alpha: false }) : null;
  } catch {
    context = null;
  }
  if (!canvas || !context || typeof context.drawImage !== "function") return null;
  Object.assign(canvas.style, { visibility: "hidden", zIndex: "1" });
  canvas.setAttribute?.("aria-hidden", "true");
  layer2.appendChild(canvas);
  let alive = canvas;
  let isDrawn = false;
  const drawing = context;
  const disable = () => {
    if (!alive) return;
    const element = alive;
    alive = null;
    isDrawn = false;
    try {
      element.remove?.();
      element.width = element.height = 0;
    } catch {
    }
  };
  const draw = (video, widthPx, heightPx) => {
    if (video.videoWidth !== widthPx || video.videoHeight !== heightPx) return false;
    try {
      drawing.drawImage(video, 0, 0, widthPx, heightPx);
      return true;
    } catch {
      disable();
      return false;
    }
  };
  return {
    get kind() {
      return alive ? "canvas" : "video";
    },
    update(video, style, widthPx, heightPx) {
      if (!alive) return false;
      if (alive.width !== widthPx || alive.height !== heightPx) {
        alive.width = widthPx;
        alive.height = heightPx;
        isDrawn = false;
      }
      if (draw(video, widthPx, heightPx)) isDrawn = true;
      if (!alive) return false;
      Object.assign(alive.style, style, { zIndex: "1" });
      return isDrawn;
    },
    setVisible(isVisible) {
      if (alive) alive.style.visibility = isVisible ? "visible" : "hidden";
    },
    remove: disable
  };
};
var videoPreviewSurface = () => null;

// packages/camera/src/preview/preview-layer.ts
function mountPreviewLayer(video, container, createSurface = canvasPreviewSurface) {
  const doc = container.ownerDocument;
  const layer2 = doc.createElement("div");
  Object.assign(layer2.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    isolation: "isolate"
  });
  layer2.setAttribute?.("aria-hidden", "true");
  video.style.visibility = "hidden";
  layer2.appendChild(video);
  const curtain = doc.createElement("div");
  Object.assign(curtain.style, {
    position: "absolute",
    inset: "0",
    background: "#000",
    pointerEvents: "none",
    display: "none",
    zIndex: "2"
  });
  curtain.setAttribute?.("aria-hidden", "true");
  layer2.appendChild(curtain);
  let surface = createSurface(layer2, video);
  container.appendChild(layer2);
  let isMasked = false;
  let isFresh = false;
  let isDrawn = false;
  const showSurface = () => {
    surface?.setVisible(!isMasked && isFresh && isDrawn);
  };
  return {
    update(geometry, widthPx, heightPx) {
      isFresh = true;
      const style = previewStyle(geometry, widthPx, heightPx);
      Object.assign(video.style, style, { visibility: isMasked ? "hidden" : "visible" });
      if (!surface) return;
      isDrawn = surface.update(video, style, widthPx, heightPx);
      if (surface.kind === "video") {
        surface = null;
        isDrawn = false;
        return;
      }
      showSurface();
    },
    mask(on) {
      isMasked = on;
      curtain.style.display = on ? "block" : "none";
      if (on) {
        isFresh = false;
        video.style.visibility = "hidden";
      } else if (isFresh) video.style.visibility = "visible";
      showSurface();
    },
    get surface() {
      return surface?.kind ?? "video";
    },
    remove() {
      layer2.remove?.();
      surface?.remove();
      surface = null;
      isDrawn = false;
    }
  };
}

// packages/camera/src/capture/capture-frame.ts
var FROZEN_MEDIA_TIME_PICTURES = 3;
var FrameCapture = class {
  frameId = 0;
  lastPresented = -1;
  lastCallbackUs = null;
  latestGeometry = null;
  lastFrameDiagnostic = null;
  lastNativeDimensions = null;
  isSnapshotBusy = false;
  repeatedMediaTimes = 0;
  geometryKey = null;
  layoutKey = null;
  context;
  nowUs;
  /** The run's current generation; readable after the camera stopped, when no context can be built any more. */
  generation;
  constructor(context, nowUs, generation) {
    this.context = context;
    this.nowUs = nowUs;
    this.generation = generation;
  }
  /** Handles one new-frame callback. Errors end the camera run through `onFailure`. */
  async capture(generation, sourceTimestampUs, presentedFrames, onFailure) {
    const run = this.context();
    if (generation !== run.generation || !run.isRunning) return;
    this.lastCallbackUs = this.nowUs();
    if (!Number.isSafeInteger(presentedFrames) || presentedFrames <= 0) return;
    if (presentedFrames <= this.lastPresented) {
      run.stats.duplicateCallbacks++;
      return;
    }
    if (this.lastPresented >= 0)
      run.stats.missedPresented += Math.max(0, presentedFrames - this.lastPresented - 1);
    this.lastPresented = presentedFrames;
    if (this.isSnapshotBusy) {
      run.stats.busyDrops++;
      return;
    }
    const geometryOptions = run.geometryOptions();
    const settings = run.track.getSettings();
    const gate = run.gate;
    const gateToken = gate?.begin() ?? null;
    const video = run.video;
    if (!video.videoWidth || !video.videoHeight) return;
    const inputWidth = video.videoWidth;
    const inputHeight = video.videoHeight;
    let handle = null;
    this.isSnapshotBusy = true;
    try {
      const reportedMediaTimeUs = sourceTimestampUs;
      const arrivalTimeUs = run.clock.arrival();
      if (run.timestamps === "callback") sourceTimestampUs = arrivalTimeUs;
      const timing = run.clock.observe(sourceTimestampUs, arrivalTimeUs);
      if (!timing) {
        run.stats.duplicateCallbacks++;
        if (run.timestamps === "media-time" && ++this.repeatedMediaTimes >= FROZEN_MEDIA_TIME_PICTURES)
          run.useCallbackTimestamps();
        return;
      }
      this.repeatedMediaTimes = 0;
      const standardGeometry = createGeometry({
        ...geometryOptions,
        widthPx: inputWidth,
        heightPx: inputHeight
      });
      const isCurrent = () => generation === this.generation();
      const native = run.snapshotter.takeNative(run.video, sourceTimestampUs, isCurrent);
      handle = this.snapshot(
        run,
        generation,
        gateToken,
        inputWidth,
        inputHeight,
        native instanceof Promise ? await native : native,
        standardGeometry
      );
      if (!handle) return;
      run.stats.snapshots++;
      if (generation !== this.generation()) {
        run.stats.staleDrops++;
        handle.release();
        handle = null;
        return;
      }
      const delivered = this.admitAndDeliver(run, generation, gateToken, handle, {
        inputWidth,
        inputHeight,
        settings,
        geometryOptions,
        timing,
        reportedMediaTimeUs,
        presentedFrames,
        standardGeometry
      });
      if (delivered) handle = null;
    } catch (error) {
      handle?.release();
      run.stats.snapshotFailures++;
      if (generation === this.generation()) onFailure(error);
    } finally {
      this.isSnapshotBusy = false;
    }
  }
  /** Owns the native picture, or reads the frame back when there is none usable. Null when stale. */
  snapshot(run, generation, gateToken, inputWidth, inputHeight, native, standardGeometry) {
    let value = native?.picture ?? null;
    if (generation !== this.generation()) {
      value?.close?.();
      run.stats.staleDrops++;
      return null;
    }
    if (run.gate && gateToken && run.gate.epoch !== gateToken.epoch) {
      value?.close?.();
      run.stats.transitionDrops++;
      return null;
    }
    if (value && (run.video.videoWidth !== inputWidth || run.video.videoHeight !== inputHeight)) {
      value.close?.();
      run.stats.dimensionChangeDrops++;
      return null;
    }
    if (value) {
      const displayWidth = value.displayWidth ?? value.width;
      const displayHeight = value.displayHeight ?? value.height;
      const frame = value;
      this.lastNativeDimensions = {
        videoWidth: inputWidth,
        videoHeight: inputHeight,
        displayWidth,
        displayHeight,
        codedWidth: frame.codedWidth ?? null,
        codedHeight: frame.codedHeight ?? null
      };
      if (displayWidth !== inputWidth || displayHeight !== inputHeight) {
        value.close?.();
        value = null;
        run.stats.snapshotDimensionMismatches++;
      }
    }
    if (value) {
      return native.format === "video-frame" ? createOwnedImage("video-frame", value) : createOwnedImage("image-bitmap", value);
    }
    if (generation !== this.generation()) return null;
    return createOwnedImage(
      "standard-rgba8",
      run.snapshotter.readback(run.document, run.video, standardGeometry),
      () => {
      }
    );
  }
  admitAndDeliver(run, generation, gateToken, handle, capture) {
    const { inputWidth, inputHeight, settings, geometryOptions } = capture;
    const gate = run.gate;
    let geometry = capture.standardGeometry;
    let isCommitted = false;
    const build = () => geometry ??= createGeometry({
      ...geometryOptions,
      widthPx: inputWidth,
      heightPx: inputHeight
    });
    const announce = () => {
      const layoutKey = `${inputWidth}x${inputHeight}`;
      if (!gate || !run.preview || this.layoutKey === layoutKey) return;
      this.layoutKey = layoutKey;
      run.emit({ type: "pictureSize", widthPx: inputWidth, heightPx: inputHeight });
    };
    const prepare = () => {
      announce();
      if (generation !== this.generation()) return;
      run.preview?.update(build(), inputWidth, inputHeight);
    };
    const commit = () => {
      isCommitted = true;
      this.latestGeometry = build();
      run.preview?.update(this.latestGeometry, inputWidth, inputHeight);
    };
    if (gate) {
      if (!gate.isGated && this.layoutKey === null) {
        announce();
        if (generation !== this.generation()) return this.drop(run, handle, "staleDrops");
      }
      const sig = JSON.stringify([
        inputWidth,
        inputHeight,
        settings.deviceId,
        settings.zoom,
        geometryOptions
      ]);
      if (!gate.admit(gateToken, sig, `${inputWidth}x${inputHeight}`, { prepare, commit })) {
        handle.release();
        run.stats.transitionDrops++;
        run.progressed();
        return true;
      }
      if (generation !== this.generation()) return this.drop(run, handle, "staleDrops");
    }
    if (!isCommitted) commit();
    const frameGeometry = build();
    const key = JSON.stringify([
      inputWidth,
      inputHeight,
      settings.deviceId,
      settings.zoom,
      frameGeometry
    ]);
    if (key !== this.geometryKey) {
      this.geometryKey = key;
      run.emit({ type: "geometryChanged", geometry: frameGeometry });
      if (generation !== this.generation() || gate && gate.epoch !== gateToken.epoch)
        return this.drop(run, handle);
    }
    return this.deliver(run, generation, gateToken, handle, capture);
  }
  deliver(run, generation, gateToken, handle, capture) {
    const { inputWidth, inputHeight, timing } = capture;
    const latest = this.latestGeometry;
    const frame = {
      sessionId: run.sessionId,
      frameId: this.frameId++,
      pictureKey: `${run.sessionId}:${capture.presentedFrames}`,
      timing: {
        sourceTimestampUs: timing.sourceTimestampUs,
        timestampSource: run.timestamps,
        arrivalTimeUs: timing.arrivalTimeUs,
        observationTimeUs: timing.observationTimeUs
      },
      widthPx: inputWidth,
      heightPx: inputHeight,
      geometry: Object.freeze({
        ...latest,
        crop: Object.freeze({ ...latest.crop }),
        H_standardFromInput: Object.freeze([
          ...latest.H_standardFromInput
        ]),
        H_viewportFromStandard: Object.freeze([
          ...latest.H_viewportFromStandard
        ])
      }),
      image: handle
    };
    run.emit({ type: "clockMapping", sourceToSessionOffsetUs: timing.sourceToSessionOffsetUs });
    if (generation !== this.generation() || run.gate && run.gate.epoch !== gateToken.epoch)
      return this.drop(run, handle);
    this.lastFrameDiagnostic = {
      frameId: frame.frameId,
      widthPx: inputWidth,
      heightPx: inputHeight,
      format: handle.format,
      sourceTimestampUs: timing.sourceTimestampUs,
      reportedMediaTimeUs: capture.reportedMediaTimeUs,
      timestampSource: run.timestamps,
      arrivalTimeUs: timing.arrivalTimeUs,
      observationTimeUs: timing.observationTimeUs,
      snapshotCompleteTimeUs: run.clock.arrival()
    };
    run.deliver(frame);
    run.progressed();
    return true;
  }
  drop(run, handle, counter) {
    if (counter) run.stats[counter]++;
    handle.release();
    return true;
  }
};
function captureFailure(error) {
  return error instanceof EngineError && error.code === "CAMERA_CLOCK_RESET" ? error : new EngineError("CAMERA_CAPTURE_FAILED", "FRAME_CAPTURE_FAILED", {
    isRecoverable: true,
    cause: error
  });
}

// packages/camera/src/capture/snapshot.ts
var videoFrameSnapshot = {
  format: "video-frame",
  isAvailable: (env) => typeof env.VideoFrame === "function",
  take: (env, video, sourceTimestampUs) => new env.VideoFrame(video, { timestamp: Math.round(sourceTimestampUs) }),
  disablesOnlyWhenCurrent: false
};
var imageBitmapSnapshot = {
  format: "image-bitmap",
  isAvailable: (env) => typeof env.createImageBitmap === "function",
  take: (env, video) => env.createImageBitmap(video),
  disablesOnlyWhenCurrent: true
};
var SNAPSHOT_STRATEGIES = Object.freeze({
  auto: Object.freeze([videoFrameSnapshot, imageBitmapSnapshot]),
  canvas: Object.freeze([])
});
var Snapshotter = class {
  disabled = /* @__PURE__ */ new Set();
  standardCanvas = null;
  standardContext = null;
  strategies;
  env;
  stats;
  constructor(env, strategies, stats) {
    this.env = env;
    this.strategies = strategies;
    this.stats = stats;
  }
  /**
   * The first native picture any enabled strategy produces, or null. A synchronous strategy (VideoFrame) answers
   * synchronously, so no asynchronous step is added; an asynchronous one (ImageBitmap) answers through a promise.
   * `isCurrent` tells whether the camera run that asked is still current when an asynchronous strategy fails.
   */
  takeNative(video, sourceTimestampUs, isCurrent) {
    return this.tryFrom(0, video, sourceTimestampUs, isCurrent);
  }
  tryFrom(index, video, sourceTimestampUs, isCurrent) {
    for (let i = index; i < this.strategies.length; i++) {
      const strategy = this.strategies[i];
      if (this.disabled.has(strategy) || !strategy.isAvailable(this.env)) continue;
      let picture;
      try {
        picture = strategy.take(this.env, video, sourceTimestampUs);
      } catch {
        this.fail(strategy, isCurrent);
        continue;
      }
      if (!(picture instanceof Promise)) return this.succeed(strategy, picture);
      return picture.then(
        (settled) => this.succeed(strategy, settled),
        () => {
          this.fail(strategy, isCurrent);
          return this.tryFrom(i + 1, video, sourceTimestampUs, isCurrent);
        }
      );
    }
    return null;
  }
  succeed(strategy, picture) {
    if (strategy.format === "image-bitmap") this.stats.bitmapCopies++;
    return { picture, format: strategy.format };
  }
  fail(strategy, isCurrent) {
    if (strategy.format === "video-frame") this.stats.nativeSnapshotFailures++;
    else this.stats.bitmapSnapshotFailures++;
    if (!strategy.disablesOnlyWhenCurrent || isCurrent()) this.disabled.add(strategy);
  }
  /**
   * Canvas readback: draws the frame straight into its standard image with the geometry's transform (the canvas is
   * cached, its context requested once per size) and reads that back. The Worker then only converts it to gray.
   */
  readback(doc, video, geometry) {
    const widthPx = geometry.standardWidthPx;
    const heightPx = geometry.standardHeightPx;
    this.standardCanvas ??= doc.createElement("canvas");
    if (this.standardCanvas.width !== widthPx || this.standardCanvas.height !== heightPx) {
      this.standardCanvas.width = widthPx;
      this.standardCanvas.height = heightPx;
      this.standardContext = null;
    }
    this.standardContext ??= this.standardCanvas.getContext("2d", { willReadFrequently: true });
    const context = this.standardContext;
    if (!context) throw new Error("IMAGE_SNAPSHOT_UNAVAILABLE");
    const h = geometry.H_standardFromInput;
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, widthPx, heightPx);
      context.setTransform(h[0], h[3], h[1], h[4], h[2], h[5]);
      context.drawImage(video, 0, 0);
    } finally {
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    const rgba = context.getImageData(0, 0, widthPx, heightPx);
    const pixels = new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
    this.stats.cpuReadbackBytes += pixels.byteLength;
    return pixels;
  }
  dispose() {
    this.standardContext = null;
    if (this.standardCanvas) this.standardCanvas.width = this.standardCanvas.height = 0;
    this.standardCanvas = null;
  }
};

// packages/camera/src/capture/camera-runtime.ts
var STALL_LIMIT_US = 2e6;
var WATCHDOG_INTERVAL_MS = 250;
function newStats() {
  return {
    snapshots: 0,
    bitmapCopies: 0,
    snapshotFailures: 0,
    duplicateCallbacks: 0,
    busyDrops: 0,
    cpuReadbackBytes: 0,
    nativeSnapshotFailures: 0,
    bitmapSnapshotFailures: 0,
    staleDrops: 0,
    missedPresented: 0,
    snapshotDimensionMismatches: 0,
    dimensionChangeDrops: 0,
    transitionDrops: 0
  };
}
var CameraRuntime = class {
  state = "stopped";
  generation = 0;
  sessionId = null;
  clock = null;
  isDisposed = false;
  request = {};
  geometryOptions;
  gate = null;
  isGateMasked = false;
  preview = null;
  stream = null;
  video = null;
  camera = null;
  capture = null;
  snapshotter = null;
  callbackId = null;
  callbackKind = null;
  isVideoCallbackDisabled = false;
  watchdog = null;
  lastProgressUs = null;
  /** Timestamps the current run uses: the requested ones, or callback ones after a frozen media time. */
  timestamps = DEFAULT_TIMESTAMPS;
  timestampFallback = null;
  stats = newStats();
  options;
  env;
  nowUs;
  visibilityListener;
  constructor(options) {
    this.options = options;
    this.env = options.env;
    const clock = options.env.performance ?? performance;
    this.nowUs = options.nowUs ?? (() => clock.now() * 1e3);
    this.geometryOptions = options.geometry;
    this.visibilityListener = () => {
      if (this.env.document?.hidden && (this.state === "running" || this.state === "starting")) {
        this.stopInternal("suspended");
        this.emit({ type: "suspended" });
      }
    };
    this.env.document?.addEventListener("visibilitychange", this.visibilityListener);
  }
  emit(event) {
    try {
      this.options.onEvent(event);
    } catch {
    }
  }
  fail(code, detail, isRecoverable, extra = {}) {
    this.emit({
      type: "failure",
      error: new EngineError(code, detail, {
        isRecoverable,
        ...extra.cause !== void 0 ? { cause: extra.cause } : {}
      }),
      detail,
      ...extra.recommended !== void 0 ? { recommended: extra.recommended } : {}
    });
  }
  /** Opens the camera. Throws (after reporting a failure event) when it cannot start. */
  async start(sessionId, request) {
    if (this.isDisposed)
      throw new EngineError("DISPOSED", "Camera disposed", { isRecoverable: false });
    this.stop();
    this.request = { ...request };
    if (request.capture !== void 0 && request.capture !== "auto" && request.capture !== "canvas") {
      throw new EngineError("INVALID_CONFIG", "Unsupported capture mode", { isRecoverable: false });
    }
    if (request.timestamps !== void 0 && request.timestamps !== "media-time" && request.timestamps !== "callback") {
      throw new EngineError("INVALID_CONFIG", "Unsupported timestamp mode", {
        isRecoverable: false
      });
    }
    if (this.env.document?.hidden) {
      this.state = "suspended";
      return;
    }
    const generation = this.generation;
    this.state = "starting";
    let stream;
    try {
      this.createGate(generation);
      const devices = this.env.navigator?.mediaDevices;
      const getUserMedia = devices?.getUserMedia;
      if (!this.env.isSecureContext || typeof getUserMedia !== "function")
        throw new Error("CAMERA_UNAVAILABLE");
      this.emit({ type: "permission", phase: "request", permission: "pending" });
      if (generation !== this.generation) return;
      stream = await this.openStream(
        generation,
        (constraints) => getUserMedia.call(devices, constraints)
      );
      if (!stream) return;
      if (!await this.attachVideo(generation, stream)) return;
      this.beginRun(generation, sessionId);
    } catch (error) {
      if (generation !== this.generation) return;
      if (!stream) {
        const isDenied2 = error?.name === "NotAllowedError";
        this.emit({
          type: "permission",
          phase: "result",
          permission: isDenied2 ? "denied" : "failed"
        });
        if (generation !== this.generation) return;
      }
      this.stop();
      const isDenied = error?.name === "NotAllowedError";
      const detail = isDenied ? "CAMERA_PERMISSION_DENIED" : error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "CAMERA_START_FAILED";
      const code = isDenied ? "CAMERA_PERMISSION_DENIED" : detail === "CAMERA_UNAVAILABLE" ? "CAMERA_UNAVAILABLE" : "CAMERA_START_FAILED";
      this.fail(code, detail, true, { cause: error });
      throw new EngineError(code, detail, { isRecoverable: true, cause: error });
    }
  }
  /** Observes the view even while permission or playback is pending; stopInternal owns cleanup. */
  createGate(generation) {
    const stabilization = this.options.viewportStabilization;
    if (stabilization === false || typeof this.env.addEventListener !== "function") return;
    this.gate = new ViewportGate({
      env: this.env,
      container: this.options.previewContainer,
      nowUs: () => this.nowUs(),
      stabilization,
      setMask: (on) => {
        this.isGateMasked = on;
        this.preview?.mask(on);
      },
      onTransition: (event) => {
        if (generation !== this.generation) return;
        if (this.gate?.epoch !== event.epoch) return;
        try {
          this.options.onTransition(event);
        } catch {
        }
      }
    });
  }
  async openStream(generation, getUserMedia) {
    const request = this.request;
    const stream = await getUserMedia({
      audio: false,
      video: {
        width: { ideal: request.idealWidthPx ?? 1280 },
        height: { ideal: request.idealHeightPx ?? 720 },
        ...request.deviceId ? { deviceId: { exact: request.deviceId } } : { facingMode: { ideal: request.facingMode ?? "environment" } }
      }
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return void 0;
    }
    this.stream = stream;
    this.emit({ type: "permission", phase: "result", permission: "granted" });
    if (generation !== this.generation) return void 0;
    return stream;
  }
  async attachVideo(generation, stream) {
    const video = this.env.document.createElement("video");
    this.video = video;
    if (this.options.previewContainer) {
      this.preview = mountPreviewLayer(
        video,
        this.options.previewContainer,
        this.options.previewSurface
      );
      if (this.isGateMasked) this.preview.mask(true);
    }
    this.gate?.attachVideo(video);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("NO_VIDEO_TRACK");
    const endedListener = () => {
      if (generation !== this.generation) return;
      this.fail("CAMERA_TRACK_ENDED", "TRACK_ENDED", true);
      this.stop();
    };
    track.addEventListener("ended", endedListener);
    this.camera = { stream, video, track, endedListener };
    await video.play();
    if (generation !== this.generation) {
      video.pause();
      video.srcObject = null;
      return false;
    }
    const hasFrameCallback = typeof video.requestVideoFrameCallback === "function";
    if (!hasFrameCallback && typeof video.getVideoPlaybackQuality !== "function")
      throw new Error("NEW_FRAME_DETECTION_UNAVAILABLE");
    return true;
  }
  beginRun(generation, sessionId) {
    this.sessionId = sessionId;
    this.clock = new FrameClock(this.nowUs);
    this.snapshotter = new Snapshotter(
      this.env,
      (this.options.snapshotStrategies ?? SNAPSHOT_STRATEGIES)[this.request.capture ?? DEFAULT_CAPTURE],
      this.stats
    );
    this.capture = new FrameCapture(
      () => this.captureContext(),
      this.nowUs,
      () => this.generation
    );
    this.isVideoCallbackDisabled = false;
    this.timestamps = this.request.timestamps ?? DEFAULT_TIMESTAMPS;
    this.timestampFallback = null;
    this.state = "running";
    this.lastProgressUs = this.nowUs();
    const setIntervalFn = this.env.setInterval?.bind(this.env) ?? ((fn, ms) => setInterval(fn, ms));
    this.watchdog = setIntervalFn(() => this.checkStall(generation), WATCHDOG_INTERVAL_MS);
    this.schedule(generation);
    if (this.state !== "running") throw new Error("NEW_FRAME_DETECTION_UNAVAILABLE");
    const settings = this.camera.track.getSettings();
    this.emit({
      type: "ready",
      settings,
      capturePath: this.callbackKind === "video" ? "video-frame-callback" : "decoded-frame-count"
    });
  }
  captureContext() {
    const camera = this.camera;
    const generation = () => this.generation;
    const isRunning = () => this.state === "running";
    return {
      get generation() {
        return generation();
      },
      get isRunning() {
        return isRunning();
      },
      sessionId: this.sessionId,
      video: camera.video,
      track: camera.track,
      document: this.env.document,
      gate: this.gate,
      preview: this.preview,
      clock: this.clock,
      snapshotter: this.snapshotter,
      stats: this.stats,
      timestamps: this.timestamps,
      useCallbackTimestamps: () => {
        if (this.timestamps === "callback") return;
        this.timestamps = "callback";
        this.timestampFallback = "MEDIA_TIME_FROZEN";
        this.clock.restartSource();
        this.emit({
          type: "timestampsChanged",
          timestamps: "callback",
          reason: "MEDIA_TIME_FROZEN"
        });
      },
      geometryOptions: () => ({
        ...this.geometryOptions,
        ...this.gate?.viewportGeometry() ?? {},
        ...this.geometryOptions.crop ? { crop: { ...this.geometryOptions.crop } } : {}
      }),
      emit: (event) => this.emit(event),
      deliver: (frame) => this.options.consume(frame),
      progressed: () => {
        this.lastProgressUs = this.nowUs();
      }
    };
  }
  /** New-frame detection: requestVideoFrameCallback, or animation frames plus decoded-frame counts as the fallback. */
  schedule(generation) {
    if (generation !== this.generation || this.state !== "running") return;
    const video = this.camera.video;
    if (!this.isVideoCallbackDisabled && typeof video.requestVideoFrameCallback === "function") {
      this.callbackKind = "video";
      try {
        this.callbackId = video.requestVideoFrameCallback((_now, metadata) => {
          if (generation !== this.generation || this.state !== "running") return;
          this.callbackId = null;
          void this.capture.capture(
            generation,
            metadata.mediaTime * 1e6,
            metadata.presentedFrames,
            (error) => this.captureFailed(error)
          );
          this.schedule(generation);
        });
      } catch {
        this.isVideoCallbackDisabled = true;
        if (typeof video.getVideoPlaybackQuality !== "function" || typeof this.env.requestAnimationFrame !== "function") {
          this.fail("CAMERA_START_FAILED", "NEW_FRAME_DETECTION_UNAVAILABLE", false);
          this.stop();
          return;
        }
        this.emit({
          type: "capturePathChanged",
          capturePath: "decoded-frame-count",
          reason: "VIDEO_CALLBACK_FAILED"
        });
        this.schedule(generation);
      }
      return;
    }
    this.callbackKind = "animation";
    this.callbackId = this.env.requestAnimationFrame(() => {
      if (generation !== this.generation || this.state !== "running") return;
      this.callbackId = null;
      const quality = video.getVideoPlaybackQuality();
      const presented = quality.totalVideoFrames - quality.droppedVideoFrames;
      if (Number.isSafeInteger(presented) && presented > 0) {
        void this.capture.capture(
          generation,
          video.currentTime * 1e6,
          presented,
          (error) => this.captureFailed(error)
        );
      }
      this.schedule(generation);
    });
  }
  captureFailed(error) {
    const failure = captureFailure(error);
    this.emit({
      type: "failure",
      error: failure,
      detail: failure.code === "CAMERA_CLOCK_RESET" ? "SOURCE_CLOCK_RESET" : "FRAME_CAPTURE_FAILED"
    });
    this.stop();
  }
  /** Changes geometry options; on a live stream this is a viewport-class change that masks and settles again. */
  updateGeometry(options) {
    const next = { ...this.geometryOptions, ...options };
    const isChanged = JSON.stringify(next) !== JSON.stringify(this.geometryOptions);
    this.geometryOptions = next;
    if (isChanged && this.gate && this.state !== "stopped") this.gate.trigger("geometry", false);
  }
  /** Two seconds without a delivered or gated frame: report a stall with a recommended fallback, and stop. */
  checkStall(generation = this.generation) {
    if (generation !== this.generation || this.state !== "running" || this.nowUs() - this.lastProgressUs < STALL_LIMIT_US)
      return;
    const canFallback = this.request.capture !== "canvas" || this.timestamps !== "callback";
    const lastCallbackUs = this.capture?.lastCallbackUs ?? null;
    const detail = lastCallbackUs !== null && this.nowUs() - lastCallbackUs < 1e6 ? "CALLBACK_WITHOUT_NEW_PACKET" : "NO_VIDEO_CALLBACK";
    this.fail("CAMERA_FRAME_STALLED", detail, canFallback, {
      recommended: canFallback ? { capture: "canvas", timestamps: "callback" } : null
    });
    this.stop();
  }
  getDiagnostics() {
    const settings = this.camera?.track.getSettings() ?? {};
    const video = this.camera?.video;
    const rect = video?.getBoundingClientRect?.();
    const capture = this.capture;
    return {
      state: this.state,
      sessionId: this.sessionId,
      generation: this.generation,
      callbackPath: this.callbackKind,
      capture: this.request.capture ?? DEFAULT_CAPTURE,
      timestamps: this.timestampFallback ? "callback" : this.request.timestamps ?? DEFAULT_TIMESTAMPS,
      timestampFallback: this.timestampFallback,
      lastPresented: capture?.lastPresented ?? null,
      sinceLastPacketUs: this.lastProgressUs === null ? null : this.nowUs() - this.lastProgressUs,
      sinceLastCallbackUs: capture?.lastCallbackUs == null ? null : this.nowUs() - capture.lastCallbackUs,
      settings: Object.fromEntries(
        ["width", "height", "frameRate", "facingMode", "resizeMode", "zoom"].filter((k) => settings[k] !== void 0).map((k) => [k, settings[k]])
      ),
      geometry: capture?.latestGeometry ?? null,
      lastFrame: capture?.lastFrameDiagnostic ?? null,
      nativeDimensions: capture?.lastNativeDimensions ?? null,
      preview: video ? {
        intrinsicWidth: video.videoWidth,
        intrinsicHeight: video.videoHeight,
        renderedWidth: rect?.width ?? null,
        renderedHeight: rect?.height ?? null,
        surface: this.preview?.surface ?? null
      } : null,
      viewportGate: this.gate?.getDiagnostics() ?? null,
      stats: { ...this.stats }
    };
  }
  stopInternal(state) {
    this.generation++;
    if (this.watchdog != null)
      (this.env.clearInterval?.bind(this.env) ?? clearInterval)(this.watchdog);
    this.watchdog = null;
    const camera = this.camera;
    if (this.callbackId != null) {
      if (this.callbackKind === "video") {
        camera?.video?.cancelVideoFrameCallback?.(this.callbackId);
      } else this.env.cancelAnimationFrame?.(this.callbackId);
    }
    this.callbackId = null;
    if (camera) camera.track.removeEventListener("ended", camera.endedListener);
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.gate?.dispose();
    this.gate = null;
    this.isGateMasked = false;
    this.preview?.remove();
    this.preview = null;
    this.stream = null;
    this.video = null;
    this.camera = null;
    this.snapshotter?.dispose();
    this.snapshotter = null;
    this.state = state;
  }
  stop() {
    this.stopInternal("stopped");
  }
  async dispose() {
    this.isDisposed = true;
    this.stop();
    this.env.document?.removeEventListener("visibilitychange", this.visibilityListener);
  }
};

// packages/camera/src/camera-source.ts
var aborted = (message) => new EngineError("ABORTED", message, { isRecoverable: true });
var CameraSource = class {
  camera;
  geometry;
  runtime = null;
  isDisposed = false;
  lifecycleGeneration = 0;
  cancelStart = null;
  abortCleanup = null;
  lastDiagnostics = null;
  lastRecovery = null;
  transitionListeners = /* @__PURE__ */ new Set();
  eventListeners = /* @__PURE__ */ new Set();
  options;
  env;
  constructor(options) {
    this.options = options;
    this.camera = { ...options.camera };
    this.geometry = { ...options.geometry };
    this.env = options.env ?? globalThis;
  }
  assertUsable() {
    if (this.isDisposed)
      throw new EngineError("DISPOSED", "Camera source disposed", { isRecoverable: false });
  }
  /** Begin and end of each viewport transition of the current camera run; between them no frames are delivered. */
  onViewportTransition(listener) {
    this.assertUsable();
    if (typeof listener !== "function")
      throw new EngineError("INVALID_CONFIG", "Transition listener must be a function", {
        isRecoverable: false
      });
    this.transitionListeners.add(listener);
    return () => void this.transitionListeners.delete(listener);
  }
  onEvent(listener) {
    this.assertUsable();
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }
  forward(event) {
    if (event.type === "failure" && event.error.code === "CAMERA_FRAME_STALLED" && event.recommended) {
      this.camera = { ...this.camera, ...event.recommended };
      this.lastRecovery = { detail: event.detail, nextCamera: event.recommended };
    }
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  /** Starts a camera run for `sessionId`, delivering frames to `onFrame`. Aborting `signal` stops it. */
  async start(sessionId, onFrame, signal) {
    this.assertUsable();
    const generation = this.lifecycleGeneration + 1;
    await this.stop();
    if (generation !== this.lifecycleGeneration || this.isDisposed)
      throw aborted("Camera start superseded");
    if (signal.aborted) throw aborted("Camera start aborted");
    const runtime = new CameraRuntime({
      env: this.env,
      consume: onFrame,
      previewContainer: this.options.previewContainer,
      geometry: this.geometry,
      viewportStabilization: this.options.viewportStabilization ?? {},
      ...this.options.previewSurface ? { previewSurface: this.options.previewSurface } : {},
      ...this.options.snapshotStrategies ? { snapshotStrategies: this.options.snapshotStrategies } : {},
      ...this.options.nowUs ? { nowUs: this.options.nowUs } : {},
      onEvent: (event) => this.forward(event),
      onTransition: (event) => {
        if (this.runtime !== runtime) return;
        for (const listener of [...this.transitionListeners]) {
          try {
            listener(event);
          } catch {
          }
        }
      }
    });
    this.runtime = runtime;
    let rejectAbort = () => {
    };
    const abortion = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      runtime.stop();
      rejectAbort(aborted("Camera start aborted"));
    };
    this.cancelStart = abort;
    signal.addEventListener("abort", abort, { once: true });
    this.abortCleanup = () => signal.removeEventListener("abort", abort);
    try {
      await Promise.race([runtime.start(sessionId, this.camera), abortion]);
      if (runtime.state !== "running")
        throw new EngineError("CAMERA_SUSPENDED", "CAMERA_SUSPENDED", { isRecoverable: true });
    } catch (error) {
      if (this.runtime === runtime) await this.stop();
      throw error;
    }
  }
  async stop() {
    this.lifecycleGeneration++;
    this.cancelStart?.();
    this.cancelStart = null;
    this.abortCleanup?.();
    this.abortCleanup = null;
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.dispose();
    if (runtime) this.lastDiagnostics = runtime.getDiagnostics();
  }
  /** Changes the camera (only while stopped) and the geometry options (a live change masks and settles again). */
  configure(change) {
    this.assertUsable();
    if (change.camera) {
      if (this.runtime)
        throw new EngineError("INVALID_CONFIG", "Stop the engine before configuring its camera", {
          isRecoverable: true
        });
      this.camera = { ...this.camera, ...change.camera };
    }
    if (change.geometry) {
      this.geometry = { ...this.geometry, ...change.geometry };
      this.runtime?.updateGeometry(change.geometry);
    }
  }
  getDiagnostics() {
    return {
      ...this.runtime?.getDiagnostics() ?? this.lastDiagnostics ?? { state: "stopped", sessionId: null },
      recovery: this.lastRecovery
    };
  }
  async listCameras() {
    const devices = await this.env.navigator?.mediaDevices?.enumerateDevices?.() ?? [];
    return devices.filter((device) => device.kind === "videoinput");
  }
  /** The current camera run's session clock, or null while not running. */
  nowSessionUs() {
    return this.runtime?.state === "running" ? this.runtime.clock.arrival() : null;
  }
  async dispose() {
    this.isDisposed = true;
    try {
      await this.stop();
    } finally {
      this.transitionListeners.clear();
      this.eventListeners.clear();
    }
  }
};

// packages/media/src/media-types.ts
var PRESENTATION_FAILURE_REASONS = Object.freeze([
  "media-error",
  "playback-blocked",
  "loading-timeout"
]);

// packages/media/src/playback-recovery.ts
function findRecovery(recoveries, video) {
  for (const recovery of recoveries) {
    try {
      if (recovery.isApplicable(video)) return recovery;
    } catch {
    }
  }
  return null;
}

// packages/media/src/adapters/wechat-ios-bridge.ts
var WECHAT_BRIDGE_TIMEOUT_MS = 1500;
var BRIDGE_METHOD = "getNetworkType";
function isWechatIosVideo(video) {
  try {
    const ua = video?.ownerDocument?.defaultView?.navigator?.userAgent;
    return typeof ua === "string" && /\b(?:iPhone|iPad|iPod)\b/.test(ua) && /MicroMessenger/i.test(ua);
  } catch {
    return false;
  }
}
function prepareBridgePlay(video, isLive, timeoutMs = WECHAT_BRIDGE_TIMEOUT_MS) {
  let doc;
  let win;
  let isStarted = false;
  let isSettled = false;
  let isInvoked = false;
  let isCalled = false;
  let timer = null;
  let resolveResult = () => {
  };
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const undo = [];
  const isHidden = () => doc?.hidden === true || doc?.visibilityState === "hidden";
  const live = () => {
    try {
      return !isSettled && Boolean(isLive()) && !isHidden();
    } catch {
      return false;
    }
  };
  const finish = (outcome) => {
    if (isSettled) return;
    isSettled = true;
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
    for (const fn of undo.splice(0)) {
      try {
        fn();
      } catch {
      }
    }
    resolveResult(outcome);
  };
  const listen = (target, name, handler) => {
    if (typeof target?.addEventListener !== "function") return;
    target.addEventListener(name, handler);
    if (isSettled) {
      target.removeEventListener?.(name, handler);
      return;
    }
    undo.push(() => target.removeEventListener?.(name, handler));
  };
  const onCallback = () => {
    if (isCalled || isSettled) return;
    if (!live()) return finish({ status: "cancelled" });
    isCalled = true;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    let play;
    try {
      play = video.play;
    } catch {
      return finish({ status: "failed" });
    }
    if (!live()) return finish({ status: "cancelled" });
    let pending;
    try {
      pending = Promise.resolve(play.call(video));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => finish({ status: "played" }),
      (error) => finish({ status: "failed", error })
    );
  };
  const tryInvoke = () => {
    if (isSettled || isInvoked) return;
    if (!live()) return finish({ status: "cancelled" });
    let bridge;
    let invoke;
    try {
      bridge = win?.WeixinJSBridge;
      invoke = bridge?.invoke;
    } catch {
      return finish({ status: "failed" });
    }
    if (!bridge || typeof invoke !== "function") return;
    if (!live()) return finish({ status: "cancelled" });
    isInvoked = true;
    try {
      invoke.call(bridge, BRIDGE_METHOD, {}, onCallback);
    } catch {
      if (!isCalled) finish({ status: "failed" });
    }
  };
  const onReady = () => {
    try {
      tryInvoke();
    } catch {
      finish({ status: "failed" });
    }
  };
  return {
    result,
    start() {
      if (isStarted || isSettled) return;
      isStarted = true;
      try {
        doc = video.ownerDocument;
        win = doc?.defaultView;
        if (!live()) return finish({ status: "cancelled" });
        listen(doc, "WeixinJSBridgeReady", onReady);
        listen(doc, "visibilitychange", () => {
          if (isHidden()) finish({ status: "cancelled" });
        });
        listen(win, "pagehide", () => finish({ status: "cancelled" }));
        if (!isSettled) {
          timer = globalThis.setTimeout(() => {
            timer = null;
            finish({ status: "failed" });
          }, timeoutMs);
        }
        tryInvoke();
      } catch {
        finish({ status: "failed" });
      }
    },
    cancel() {
      finish({ status: "cancelled" });
    }
  };
}
var wechatIosBridgeRecovery = Object.freeze({
  id: "wechat-bridge",
  isApplicable: isWechatIosVideo,
  prepare: (video, isLive) => prepareBridgePlay(video, isLive)
});
var DEFAULT_PLAYBACK_RECOVERIES = Object.freeze([
  wechatIosBridgeRecovery
]);

// packages/media/src/loop-watch.ts
var POLL_MS = 400;
var MAX_RECOVERIES_WITHOUT_PROGRESS = 3;
var LoopWatch = class {
  /** Rewinds performed since the media was configured. */
  loopRecoveries = 0;
  timer = null;
  epoch = 0;
  recoveryFrames = null;
  signature = null;
  stalledPolls = 0;
  recoveriesSinceProgress = 0;
  host;
  constructor(host) {
    this.host = host;
  }
  get isArmed() {
    return this.timer !== null;
  }
  /** New media: forget recoveries. */
  reset() {
    this.loopRecoveries = 0;
    this.recoveriesSinceProgress = 0;
    this.recoveryFrames = null;
  }
  isNearEnd() {
    const d = this.host.video.duration;
    const t = this.host.video.currentTime;
    return Number.isFinite(d) && d > 0 && Number.isFinite(t) && d - t <= Math.min(0.35, d * 0.2);
  }
  /** Starts (or restarts) polling while playback is active, looping and the duration finite. */
  arm() {
    this.cancel();
    const host = this.host;
    if (!host.isPlaying() || !host.isLooping() || !Number.isFinite(host.video.duration)) return;
    const generation = host.generation();
    const epoch = ++this.epoch;
    const poll = () => {
      if (epoch !== this.epoch) return;
      this.timer = null;
      if (!host.isPlaying() || generation !== host.generation()) return;
      const video = host.video;
      const t = video.currentTime;
      const frames = video.getVideoPlaybackQuality?.()?.totalVideoFrames;
      const signature = `${t}|${frames ?? ""}`;
      const isNearEnd = this.isNearEnd();
      if (signature !== this.signature) {
        this.signature = signature;
        this.stalledPolls = 0;
        const hasProgressed = this.recoveryFrames === null ? false : Number.isFinite(frames) ? frames > this.recoveryFrames : t > 0.05;
        if (!isNearEnd && hasProgressed) {
          this.recoveriesSinceProgress = 0;
          this.recoveryFrames = null;
        }
      } else if (isNearEnd) this.stalledPolls++;
      if (isNearEnd && (video.ended || this.stalledPolls >= 2)) {
        this.recover();
        return;
      }
      this.timer = globalThis.setTimeout(poll, POLL_MS);
    };
    this.timer = globalThis.setTimeout(poll, POLL_MS);
  }
  cancel() {
    this.epoch++;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.signature = null;
    this.stalledPolls = 0;
  }
  /** Rewinds once and plays once; gives up after three recoveries without observed progress. */
  recover() {
    this.cancel();
    const host = this.host;
    if (!host.isPlaying() || !host.isLooping() || this.recoveriesSinceProgress >= MAX_RECOVERIES_WITHOUT_PROGRESS)
      return;
    this.recoveriesSinceProgress++;
    this.loopRecoveries++;
    this.recoveryFrames = host.video.getVideoPlaybackQuality?.()?.totalVideoFrames ?? 0;
    try {
      host.video.currentTime = 0;
    } catch {
      return;
    }
    if (host.video.paused || host.video.ended) host.replay();
    else this.arm();
  }
};

// packages/media/src/presentable-frame.ts
var POLL_MS2 = 100;
var HAVE_CURRENT_DATA = 2;
var unrefTimer = (timer) => {
  timer?.unref?.();
  return timer;
};
var PresentableFrameWatch = class {
  epoch = 0;
  handle = null;
  timer = null;
  video;
  isDisposed;
  constructor(video, isDisposed) {
    this.video = video;
    this.isDisposed = isDisposed;
  }
  /** Replaces any earlier watch. Returns the signal in use. A cancelled watch never calls back. */
  await(callback) {
    this.cancel();
    const video = this.video;
    const epoch = this.epoch;
    const owns = () => !this.isDisposed() && epoch === this.epoch;
    const decoded = () => {
      const n = video.getVideoPlaybackQuality?.()?.totalVideoFrames;
      return Number.isFinite(n) ? n : null;
    };
    const hasPicture = () => video.readyState >= HAVE_CURRENT_DATA && video.videoWidth > 0 && video.videoHeight > 0 && !video.error;
    const finish = (signal, mediaTime, presentedFrames) => {
      if (!owns()) return;
      this.cancel();
      callback({ signal, mediaTime, presentedFrames, decodedFrames: decoded() });
    };
    if (typeof video.requestVideoFrameCallback === "function") {
      const tick = (_now, metadata) => {
        if (!owns()) return;
        this.handle = null;
        if (hasPicture()) {
          finish(
            "video-frame-callback",
            Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : null,
            Number.isFinite(metadata?.presentedFrames) ? metadata.presentedFrames : null
          );
        } else if (owns()) this.handle = video.requestVideoFrameCallback(tick);
      };
      this.handle = video.requestVideoFrameCallback(tick);
      return "video-frame-callback";
    }
    const baseTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const baseFrames = decoded();
    let previous = baseTime;
    let streak = 0;
    const poll = () => {
      if (!owns()) return;
      this.timer = null;
      const t = video.currentTime;
      const hasAdvanced = Number.isFinite(t) && t > previous && t > baseTime;
      if (Number.isFinite(t)) previous = Math.max(previous, t);
      streak = hasPicture() && !video.paused && hasAdvanced ? streak + 1 : 0;
      const frames = decoded();
      if (streak >= 2 && (baseFrames === null || frames !== null && frames > baseFrames)) {
        finish("time-progress", Number.isFinite(t) ? t : null, null);
        return;
      }
      if (owns()) this.timer = unrefTimer(globalThis.setTimeout(poll, POLL_MS2));
    };
    this.timer = unrefTimer(globalThis.setTimeout(poll, POLL_MS2));
    return "time-progress";
  }
  cancel() {
    this.epoch++;
    const handle = this.handle;
    const timer = this.timer;
    this.handle = null;
    this.timer = null;
    if (handle !== null) {
      try {
        this.video.cancelVideoFrameCallback?.(handle);
      } catch {
      }
    }
    if (timer !== null) globalThis.clearTimeout(timer);
  }
};

// packages/media/src/video-session.ts
var CANCELLED = /* @__PURE__ */ Symbol("cancelled");
var MEDIA_ERROR_REASONS = Object.freeze({
  1: "media-aborted",
  2: "media-network-error",
  3: "media-decode-error",
  4: "media-source-not-supported"
});
var callPlay = (video, owns) => {
  try {
    const play = video.play;
    if (!owns()) return Promise.resolve(CANCELLED);
    return Promise.resolve(play.call(video));
  } catch (error) {
    return Promise.reject(error);
  }
};
var disposedError = () => new EngineError("DISPOSED", "Media session disposed", { isRecoverable: false });
function validateMediaConfig(config) {
  const isOneOf = (value, allowed) => value === void 0 || allowed.includes(value);
  if (!config || !config.url || !isOneOf(config.fit, ["contain", "cover"]) || !isOneOf(config.onLost, ["pause-and-hide", "hide"]) || !isOneOf(config.onResume, ["resume", "restart"]) || !isOneOf(config.playbackRecovery, ["auto", "off"]) || !isOneOf(config.crossOrigin, ["anonymous", "use-credentials", null])) {
    throw new EngineError("INVALID_CONFIG", "Invalid media configuration", {
      isRecoverable: false
    });
  }
}
var VideoSession = class {
  generation = 0;
  isDisposed = false;
  isActive = false;
  restoreTime = null;
  onResume = "resume";
  playbackRecovery = "auto";
  isLooping = true;
  request = null;
  playbackPath = null;
  recoveryAttempts = 0;
  video;
  onEvent;
  recoveries;
  loop;
  presentable;
  onError;
  onMetadata;
  onEnded;
  constructor(video, options = {}) {
    this.video = video;
    this.onEvent = options.onEvent ?? (() => {
    });
    this.recoveries = options.recoveries ?? DEFAULT_PLAYBACK_RECOVERIES;
    this.loop = new LoopWatch({
      video,
      isPlaying: () => !this.isDisposed && this.isActive,
      isLooping: () => this.isLooping,
      generation: () => this.generation,
      replay: () => void this.play(false)
    });
    this.presentable = new PresentableFrameWatch(video, () => this.isDisposed);
    this.onEnded = () => {
      if (this.isActive && this.isLooping && video.ended && this.loop.isNearEnd())
        this.loop.recover();
    };
    this.onMetadata = () => {
      if (this.isActive && this.isLooping && !this.loop.isArmed) this.loop.arm();
      if (this.restoreTime === null) return;
      const time = this.restoreTime;
      this.restoreTime = null;
      try {
        video.currentTime = Number.isFinite(video.duration) ? Math.min(time, Math.max(0, video.duration - 1e-3)) : time;
      } catch {
      }
    };
    this.onError = () => {
      this.isActive = false;
      this.generation++;
      this.cancelRequest();
      this.loop.cancel();
      this.presentable.cancel();
      const reason = MEDIA_ERROR_REASONS[video.error?.code ?? 0] ?? "media-error";
      this.onEvent({
        type: "failure",
        error: new EngineError("MEDIA_FAILED", reason, { isRecoverable: true }),
        detail: "MEDIA_LOAD_OR_DECODE"
      });
    };
    video.addEventListener("error", this.onError);
    video.addEventListener("loadedmetadata", this.onMetadata);
    video.addEventListener("ended", this.onEnded);
  }
  /** Stops any playback and loads the configured media. */
  configure(config) {
    if (this.isDisposed) throw disposedError();
    validateMediaConfig(config);
    const isMuted = config.isMuted ?? true;
    const isLooping = config.isLooping ?? true;
    this.stop();
    this.onResume = config.onResume ?? "resume";
    this.playbackRecovery = config.playbackRecovery ?? "auto";
    this.playbackPath = null;
    this.recoveryAttempts = 0;
    this.isLooping = Boolean(isLooping);
    this.loop.reset();
    const video = this.video;
    video.muted = isMuted;
    video.loop = isLooping;
    video.playsInline = true;
    video.defaultMuted = isMuted;
    video.preload = "metadata";
    video.crossOrigin = config.crossOrigin === void 0 ? "anonymous" : config.crossOrigin;
    video.src = config.url;
    video.load();
  }
  /**
   * Plays the configured media; `isRestart` rewinds first when the media restarts on resume. Resolves true once
   * playback started, false when it failed (reported through the event) or a newer request replaced this one.
   */
  async play(isRestart = true) {
    if (this.isDisposed) throw disposedError();
    this.cancelRequest();
    const generation = ++this.generation;
    this.isActive = true;
    let abort = () => {
    };
    const cancelled = new Promise((resolve) => {
      abort = () => resolve(CANCELLED);
    });
    const request = { recovery: null, cancelled, abort: () => abort() };
    this.request = request;
    const owns = () => this.request === request && generation === this.generation && !this.isDisposed;
    try {
      let isFailed = false;
      let error;
      try {
        if (isRestart && this.onResume === "restart") this.video.currentTime = 0;
        if (!owns()) return false;
        this.playbackPath = "native";
        if (await Promise.race([callPlay(this.video, owns), cancelled]) === CANCELLED)
          return false;
      } catch (e) {
        isFailed = true;
        error = e;
      }
      if (isFailed) {
        if (!owns()) return false;
        const recovery = error?.name === "NotAllowedError" && this.playbackRecovery === "auto" ? findRecovery(this.recoveries, this.video) : null;
        if (!owns()) return false;
        if (recovery) {
          const attempt = recovery.prepare(this.video, () => owns() && this.isActive);
          request.recovery = attempt;
          this.recoveryAttempts++;
          this.playbackPath = recovery.id;
          attempt.start();
          const outcome = await attempt.result;
          if (outcome.status === "cancelled") return false;
          if (outcome.status === "played") isFailed = false;
          else if (outcome.error !== void 0) error = outcome.error;
          if (generation !== this.generation || this.isDisposed) return false;
        }
      }
      if (!isFailed) {
        if (generation !== this.generation || !this.isActive) return false;
        this.loop.arm();
        return true;
      }
      if (!owns()) return false;
      this.isActive = false;
      const name = error?.name;
      if (name === "NotAllowedError") {
        this.onEvent({ type: "playbackBlocked", reason: "playback-gesture-required" });
      } else {
        const reason = name === "NotSupportedError" ? "media-source-not-supported" : "media-play-failed";
        this.onEvent({
          type: "failure",
          error: new EngineError("MEDIA_FAILED", reason, { isRecoverable: true, cause: error }),
          detail: "MEDIA_PLAY_FAILED"
        });
      }
      return false;
    } finally {
      if (this.request === request) this.request = null;
    }
  }
  cancelRequest() {
    const request = this.request;
    if (!request) return;
    this.request = null;
    request.recovery?.cancel();
    request.abort();
  }
  /** Call directly within a user gesture after playbackBlocked. */
  resumeFromGesture() {
    return this.play(false);
  }
  setMuted(isMuted) {
    if (this.isDisposed) throw disposedError();
    this.video.muted = Boolean(isMuted);
    this.video.defaultMuted = Boolean(isMuted);
  }
  /** Reloads the element and plays again (keeping the position unless the media restarts on resume). */
  retryFromGesture() {
    if (this.isDisposed) throw disposedError();
    const time = this.video.currentTime;
    this.pause();
    this.restoreTime = this.onResume !== "restart" && Number.isFinite(time) && time > 0 ? time : null;
    this.video.load();
    return this.play();
  }
  getSnapshot() {
    const video = this.video;
    const quality = video.getVideoPlaybackQuality?.();
    return {
      isPaused: video.paused,
      isMuted: video.muted,
      isPlaysInline: video.playsInline,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      readyState: video.readyState,
      networkState: video.networkState,
      widthPx: video.videoWidth,
      heightPx: video.videoHeight,
      errorCode: video.error?.code ?? null,
      decodedFrames: quality?.totalVideoFrames ?? null,
      droppedFrames: quality?.droppedVideoFrames ?? null,
      isLooping: Boolean(video.loop),
      isEnded: Boolean(video.ended),
      loopRecoveries: this.loop.loopRecoveries,
      playbackPath: this.playbackPath,
      recoveryAttempts: this.recoveryAttempts
    };
  }
  pause() {
    this.generation++;
    this.isActive = false;
    this.cancelRequest();
    this.loop.cancel();
    this.video.pause();
  }
  /**
   * Calls back once when the current request has a presentable picture. A newer call, stop(), configure(), a media
   * error and dispose() cancel it; pause() does not (a hidden, paused element resumes the same request).
   */
  awaitPresentableFrame(callback) {
    if (this.isDisposed) throw disposedError();
    return this.presentable.await(callback);
  }
  cancelPresentable() {
    this.presentable.cancel();
  }
  stop() {
    this.restoreTime = null;
    this.pause();
    this.presentable.cancel();
    this.video.removeAttribute("src");
    this.video.srcObject = null;
    this.video.load();
  }
  dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.stop();
    this.video.removeEventListener("error", this.onError);
    this.video.removeEventListener("loadedmetadata", this.onMetadata);
    this.video.removeEventListener("ended", this.onEnded);
  }
};

// packages/renderer/src/loss-hold.ts
var MAX_LOSS_DISPLAY_GRACE_MS = 1e3;
function isValidGrace(graceMs) {
  return typeof graceMs === "number" && Number.isFinite(graceMs) && graceMs > 0 && graceMs <= MAX_LOSS_DISPLAY_GRACE_MS;
}
function clearHoldTimer(hold) {
  if (hold?.timer != null) clearTimeout(hold.timer);
}

// packages/renderer/src/media-binding.ts
var MediaBindings = class {
  configs = /* @__PURE__ */ new Map();
  ownedUrls = /* @__PURE__ */ new Map();
  get(targetId) {
    return this.configs.get(targetId);
  }
  get ownedUrlCount() {
    return this.ownedUrls.size;
  }
  /** Sets a target's configuration; an owned object URL that is no longer used is revoked. */
  set(targetId, config) {
    const owned = this.ownedUrls.get(targetId);
    if (owned && owned !== config.url) {
      URL.revokeObjectURL(owned);
      this.ownedUrls.delete(targetId);
    }
    this.configs.set(targetId, { ...config });
  }
  /** Records that the renderer created `url` for this target. */
  own(targetId, url) {
    this.ownedUrls.set(targetId, url);
  }
  update(targetId, change) {
    const config = this.configs.get(targetId);
    if (config) this.configs.set(targetId, { ...config, ...change });
  }
  delete(targetId) {
    this.configs.delete(targetId);
    const url = this.ownedUrls.get(targetId);
    if (url) URL.revokeObjectURL(url);
    this.ownedUrls.delete(targetId);
  }
  dispose() {
    for (const url of this.ownedUrls.values()) URL.revokeObjectURL(url);
    this.ownedUrls.clear();
    this.configs.clear();
  }
};

// packages/renderer/src/plane/perspective.ts
function project(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10)
    throw new RangeError("Point at projective horizon");
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}
function multiply(a, b) {
  return Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    return a[r * 3] * b[c] + a[r * 3 + 1] * b[c + 3] + a[r * 3 + 2] * b[c + 6];
  });
}
function homographyFromCorners(widthPx, heightPx, corners) {
  if (!(widthPx > 0 && heightPx > 0) || !Number.isFinite(widthPx + heightPx))
    throw new RangeError("Invalid target size");
  if (corners.length !== 4 || corners.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
    throw new RangeError("Invalid corners");
  const source = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ];
  const rows = source.flatMap(([x, y], i) => {
    const [u, v] = corners[i];
    return [
      [x, y, 1, 0, 0, 0, -u * x, -u * y, u],
      [0, 0, 0, x, y, 1, -v * x, -v * y, v]
    ];
  });
  for (let c = 0; c < 8; c++) {
    let pivot = c;
    for (let r = c + 1; r < 8; r++)
      if (Math.abs(rows[r][c]) > Math.abs(rows[pivot][c])) pivot = r;
    if (Math.abs(rows[pivot][c]) < 1e-10) throw new RangeError("Degenerate quadrilateral");
    [rows[c], rows[pivot]] = [rows[pivot], rows[c]];
    const row = rows[c];
    const scale = row[c];
    for (let j = c; j <= 8; j++) row[j] /= scale;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const other = rows[r];
      const factor = other[c];
      for (let j = c; j <= 8; j++) other[j] -= factor * row[j];
    }
  }
  const n = rows.map((row) => row[8]);
  const h = [
    n[0] / widthPx,
    n[1] / heightPx,
    n[2],
    n[3] / widthPx,
    n[4] / heightPx,
    n[5],
    n[6] / widthPx,
    n[7] / heightPx,
    1
  ];
  validatePlane(h, widthPx, heightPx);
  return h;
}
function validatePlane(h, widthPx, heightPx) {
  if (h.length !== 9 || !h.every(Number.isFinite)) throw new RangeError("Invalid homography");
  const [a, b, c, d, e, f, g, k, m] = h;
  const determinant = a * (e * m - f * k) - b * (d * m - f * g) + c * (d * k - e * g);
  if (Math.abs(determinant) < 1e-12) throw new RangeError("Singular homography");
  const ws = [
    [0, 0],
    [widthPx, 0],
    [widthPx, heightPx],
    [0, heightPx]
  ].map(([x, y]) => g * x + k * y + m);
  if (ws.some((w) => !Number.isFinite(w) || Math.abs(w) < 1e-10 || Math.sign(w) !== Math.sign(ws[0])))
    throw new RangeError("Plane crosses projective horizon");
}
function cssMatrix(h) {
  const k = h[8];
  if (!Number.isFinite(k) || Math.abs(k) < 1e-10) throw new RangeError("Invalid homogeneous scale");
  const a = h.map((v) => v / k);
  return `matrix3d(${[a[0], a[3], 0, a[6], a[1], a[4], 0, a[7], 0, 0, 1, 0, a[2], a[5], 0, 1].join(",")})`;
}
function mediaRect(targetWidth, targetHeight, videoWidth, videoHeight, fit = "contain") {
  if (![targetWidth, targetHeight, videoWidth, videoHeight].every((v) => Number.isFinite(v) && v > 0))
    throw new RangeError("Invalid media dimensions");
  if (fit !== "contain" && fit !== "cover") throw new RangeError("Unknown fit");
  const scale = (fit === "contain" ? Math.min : Math.max)(
    targetWidth / videoWidth,
    targetHeight / videoHeight
  );
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return { x: (targetWidth - width) / 2, y: (targetHeight - height) / 2, width, height };
}

// packages/renderer/src/plane/video-plane.ts
var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
var VideoPlane = class {
  /** The plane element; the video is its first child. */
  element;
  widthPx;
  heightPx;
  constructor(container, video, options) {
    const fit = options.fit ?? "contain";
    mediaRect(options.widthPx, options.heightPx, 1, 1, fit);
    this.widthPx = options.widthPx;
    this.heightPx = options.heightPx;
    this.element = container.ownerDocument.createElement("div");
    Object.assign(this.element.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: `${options.widthPx}px`,
      height: `${options.heightPx}px`,
      transformOrigin: "0 0",
      overflow: "hidden",
      pointerEvents: "none",
      display: "none"
    });
    Object.assign(video.style, { width: "100%", height: "100%", objectFit: fit, display: "block" });
    this.element.append(video);
    container.append(this.element);
  }
  /** Places the plane on the target corners (standard-image pixels) mapped into the viewport; hides it on failure. */
  place(corners, viewportFromImage = IDENTITY) {
    try {
      const h = multiply(
        viewportFromImage,
        homographyFromCorners(this.widthPx, this.heightPx, corners)
      );
      validatePlane(h, this.widthPx, this.heightPx);
      this.element.style.transform = cssMatrix(h);
      this.element.style.display = "block";
    } catch (error) {
      this.hide();
      throw error;
    }
  }
  hide() {
    this.element.style.display = "none";
  }
  /** Shows the plane again where it was last placed. */
  show() {
    if (this.element.style.transform) this.element.style.display = "block";
  }
  dispose() {
    this.element.remove();
  }
};

// packages/renderer/src/reveal/plane-presentation.ts
var REVEAL_DEFAULTS = Object.freeze({
  revealMs: 420,
  loadingTimeoutMs: 15e3,
  overlayOpacity: 0.55
});
var REDUCED_REVEAL_MS = 120;
var SPIN_MS = 900;
var SOFT_EDGE_RATIO = 0.22;
var MASK_PROPS = ["webkitMaskImage", "maskImage"];
var ease = (t) => 1 - (1 - t) ** 3;
var px = (n) => `${Math.round(n * 100) / 100}px`;
var setAttr = (element, name, value) => {
  try {
    element.setAttribute?.(name, value);
  } catch {
  }
};
function resolveRevealOptions(options) {
  if (options === false) return null;
  const o = options === void 0 || options === true ? {} : options;
  const invalid7 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!o || typeof o !== "object") throw invalid7("Invalid presentation options");
  const {
    revealMs = REVEAL_DEFAULTS.revealMs,
    loadingTimeoutMs = REVEAL_DEFAULTS.loadingTimeoutMs,
    overlayOpacity = REVEAL_DEFAULTS.overlayOpacity
  } = o;
  if (!Number.isFinite(revealMs) || revealMs < 0 || revealMs > 2e3)
    throw invalid7("presentation.revealMs must be 0..2000");
  if (!Number.isFinite(loadingTimeoutMs) || loadingTimeoutMs < 1 || loadingTimeoutMs > 6e5)
    throw invalid7("presentation.loadingTimeoutMs must be finite, 1..600000");
  if (!Number.isFinite(overlayOpacity) || overlayOpacity < 0.05 || overlayOpacity > 1)
    throw invalid7("presentation.overlayOpacity must be .05..1");
  return { revealMs, loadingTimeoutMs, overlayOpacity };
}
var PlanePresentation = class _PlanePresentation {
  plane;
  video;
  widthPx;
  heightPx;
  overlayOpacity;
  nowMs;
  doc;
  view;
  /** Radial-gradient masks on a video element; otherwise the same timing is a plain opacity fade. */
  isMaskable;
  layer = null;
  spinner = null;
  spin = null;
  token = 0;
  handle = null;
  mode = "idle";
  isDisposed = false;
  onEnd = null;
  /** `plane` holds `video` as its first child, and it stays so. */
  constructor(plane, video, options) {
    this.plane = plane;
    this.video = video;
    this.widthPx = options.widthPx;
    this.heightPx = options.heightPx;
    this.overlayOpacity = options.overlayOpacity ?? REVEAL_DEFAULTS.overlayOpacity;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.doc = options.document ?? plane.ownerDocument;
    this.view = this.doc?.defaultView ?? null;
    const supports = this.view?.CSS?.supports?.bind(this.view.CSS);
    this.isMaskable = Boolean(
      supports && (supports("mask-image", "radial-gradient(#000,transparent)") || supports("-webkit-mask-image", "radial-gradient(#000,transparent)"))
    );
  }
  /** The user preference, read at use time so a live system change applies to the next transition. */
  static prefersReducedMotion(view) {
    try {
      return Boolean(view?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    } catch {
      return false;
    }
  }
  get phase() {
    return this.mode;
  }
  get isReducedMotion() {
    return _PlanePresentation.prefersReducedMotion(this.view);
  }
  /** Dim layer and spinner over the plane; the video stays in place but invisible, so its first frame can composite. */
  showLoading(isReduced = false) {
    if (this.isDisposed) return;
    this.stopAnimation();
    this.removeOverlay();
    const doc = this.doc;
    const size = Math.max(
      16,
      Math.min(96, Math.round(Math.min(this.widthPx, this.heightPx) * 0.1))
    );
    const layer2 = doc.createElement("div");
    const spinner = doc.createElement("div");
    Object.assign(layer2.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "100%",
      height: "100%",
      background: `rgba(0,0,0,${this.overlayOpacity})`,
      pointerEvents: "none",
      opacity: "1"
    });
    Object.assign(spinner.style, {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: px(size),
      height: px(size),
      marginLeft: px(-size / 2),
      marginTop: px(-size / 2),
      boxSizing: "border-box",
      border: `${px(Math.max(2, size / 9))} solid rgba(255,255,255,.28)`,
      borderTopColor: "#fff",
      borderRadius: "50%",
      pointerEvents: "none",
      transformOrigin: "50% 50%"
    });
    setAttr(layer2, "data-lm-presentation", "loading");
    setAttr(layer2, "aria-hidden", "true");
    setAttr(spinner, "data-lm-spinner", isReduced ? "static" : "spinning");
    layer2.append(spinner);
    this.plane.append(layer2);
    this.layer = layer2;
    this.spinner = spinner;
    this.mode = "loading";
    this.hideVideo();
    if (!isReduced && typeof spinner.animate === "function") {
      try {
        this.spin = spinner.animate(
          [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
          {
            duration: SPIN_MS,
            iterations: Infinity
          }
        );
      } catch {
        this.spin = null;
      }
    }
  }
  /**
   * Circular reveal from the plane centre: a soft-edged radius grows from 0 to cover the farthest corner, eased out.
   * The video shows inside the circle, the dim layer only outside it. `onEnd(isCompleted)` runs once; never after
   * cancel() or dispose().
   */
  reveal(options) {
    if (this.isDisposed) return;
    const { durationMs, isReduced = false, onEnd = () => {
    } } = options;
    this.stopAnimation();
    if (!this.layer) this.showLoading(isReduced);
    const token = ++this.token;
    const start = this.nowMs();
    this.mode = "revealing";
    setAttr(this.layer, "data-lm-presentation", "revealing");
    this.stopSpin();
    const duration = isReduced ? Math.min(durationMs, REDUCED_REVEAL_MS) : durationMs;
    const useMask = this.isMaskable && !isReduced;
    const soft = Math.max(8, Math.min(this.widthPx, this.heightPx) * SOFT_EDGE_RATIO);
    const end = Math.hypot(this.widthPx, this.heightPx) / 2 + soft;
    if (!useMask) this.clearVideoMask();
    this.onEnd = onEnd;
    const frame = () => {
      this.handle = null;
      if (token !== this.token || this.isDisposed) return;
      const t = duration <= 0 ? 1 : Math.min(1, Math.max(0, (this.nowMs() - start) / duration));
      if (t >= 1) {
        this.complete(true);
        return;
      }
      const e = ease(t);
      if (this.spinner) this.spinner.style.opacity = String(Math.max(0, 1 - e * 3));
      if (useMask) {
        const r = e * end;
        const inner = Math.max(0, r - soft);
        this.setMask(
          this.video,
          `radial-gradient(circle at 50% 50%, #000 ${px(inner)}, transparent ${px(r)})`
        );
        this.setMask(
          this.layer,
          `radial-gradient(circle at 50% 50%, transparent ${px(inner)}, #000 ${px(r)})`
        );
      } else {
        this.video.style.opacity = String(e);
        this.layer.style.opacity = String(1 - e);
      }
      this.schedule(frame);
    };
    frame();
  }
  /** Snaps to the fully revealed end state; the pending onEnd runs with isCompleted false. */
  finish() {
    if (this.mode === "revealing") this.complete(false);
  }
  /** Drops the loading and reveal visuals without showing the video (release or failure); no onEnd. */
  cancel() {
    this.token++;
    this.stopAnimation();
    this.removeOverlay();
    this.onEnd = null;
    if (this.mode !== "revealed") this.mode = "idle";
  }
  dispose() {
    if (this.isDisposed) return;
    this.cancel();
    this.isDisposed = true;
    this.mode = "disposed";
  }
  /** Undoes the video hiding without any animation (used when the decoration itself could not be set up). */
  restoreVideo() {
    this.showVideo();
  }
  complete(isCompleted) {
    const onEnd = this.onEnd;
    this.onEnd = null;
    this.token++;
    this.stopAnimation();
    this.removeOverlay();
    this.showVideo();
    this.mode = "revealed";
    try {
      onEnd?.(isCompleted);
    } catch {
    }
  }
  schedule(fn) {
    const raf = this.view?.requestAnimationFrame;
    this.handle = typeof raf === "function" ? { raf: raf.call(this.view, fn) } : { timer: globalThis.setTimeout(fn, 16) };
  }
  stopAnimation() {
    const h = this.handle;
    this.handle = null;
    if (h && "raf" in h) {
      try {
        this.view?.cancelAnimationFrame?.(h.raf);
      } catch {
      }
    }
    if (h && "timer" in h) globalThis.clearTimeout(h.timer);
    this.stopSpin();
  }
  stopSpin() {
    try {
      this.spin?.cancel?.();
    } catch {
    }
    this.spin = null;
  }
  removeOverlay() {
    try {
      this.layer?.remove?.();
    } catch {
    }
    this.layer = null;
    this.spinner = null;
  }
  setMask(element, value) {
    const style = element.style;
    for (const prop of MASK_PROPS) style[prop] = value;
  }
  clearVideoMask() {
    const style = this.video.style;
    for (const prop of MASK_PROPS) style[prop] = "";
  }
  hideVideo() {
    if (this.isMaskable) {
      this.setMask(this.video, "linear-gradient(transparent, transparent)");
      this.video.style.opacity = "";
    } else this.video.style.opacity = "0";
  }
  showVideo() {
    this.clearVideoMask();
    this.video.style.opacity = "";
  }
};

// packages/renderer/src/reveal/presentation-state.ts
function presentationTelemetry(request, nowUs, failureReason) {
  const ms = (from, to) => Math.max(0, Math.round((to - from) / 100) / 10);
  return {
    requestGeneration: request.generation,
    phase: request.phase,
    readySignal: request.signal,
    elapsedMs: ms(request.startUs, nowUs),
    firstFrameMs: request.firstFrameUs === null ? null : ms(request.startUs, request.firstFrameUs),
    revealElapsedMs: request.revealStartUs === null ? null : ms(request.revealStartUs, request.revealEndUs ?? nowUs),
    revealDurationMs: request.revealDurationMs,
    isReducedMotion: request.isReduced,
    ...failureReason ? { failureReason } : {}
  };
}
function startBudget(request, nowUs, onTimeout) {
  if (!request || request.phase !== "loading" || request.timer !== null) return;
  request.clockStartUs = nowUs();
  const timer = setTimeout(() => onTimeout(request), Math.max(1, request.budgetMs));
  timer.unref?.();
  request.timer = timer;
}
function pauseBudget(request, nowUs) {
  if (!request || request.timer === null) return;
  clearTimeout(request.timer);
  request.timer = null;
  const now = nowUs();
  request.budgetMs = Math.max(1, request.budgetMs - (now - (request.clockStartUs ?? now)) / 1e3);
}

// packages/renderer/src/overlay-renderer.ts
var MAX_PRESENTABLE_PREDICTION_US = 1e5;
var TIME_UPDATE_INTERVAL_US = 1e6;
var MEDIA_STATES = ["play", "pause", "waiting", "playing", "timeupdate", "ended"];
var OverlayRenderer = class {
  targets = /* @__PURE__ */ new Map();
  bindings = new MediaBindings();
  container = null;
  sessionId = null;
  activeTarget = null;
  plane = null;
  media = null;
  isVisible = false;
  isMediaFailed = false;
  isPresentationAllowed = false;
  isDisposed = false;
  lastFrame = -1;
  /** Bumped by every stop(); an update that observes a change during an observer callback has been cancelled. */
  epoch = 0;
  /** Depth of stop() teardowns in progress; update() refuses new work meanwhile. */
  stopping = 0;
  removeMediaListeners = null;
  hold = null;
  /** The media whose play was blocked; a gesture may resume it while it is still current. */
  blockedMedia = null;
  listeners = /* @__PURE__ */ new Set();
  reveal;
  presentation = null;
  /** +1 for every media request; reported as requestGeneration. */
  requestSeq = 0;
  /** The request being released: hide() must not snap-complete it (it is reported as cancelled instead). */
  releasingPresentation = null;
  now;
  recoveries;
  constructor(options = {}) {
    this.now = options.nowUs ?? (() => performance.now() * 1e3);
    this.recoveries = options.recoveries;
    this.reveal = resolveRevealOptions(options.presentation);
  }
  onEvent(listener) {
    this.assertUsable();
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
      }
    }
  }
  /** Target plane sizes; only while stopped. */
  setTargets(targets) {
    this.assertUsable();
    if (this.sessionId)
      throw new EngineError("INVALID_CONFIG", "Stop renderer before replacing target dimensions", {
        isRecoverable: true
      });
    for (const t of targets) {
      if (!t.targetId || ![t.widthPx, t.heightPx].every((v) => Number.isFinite(v) && v > 0))
        throw new EngineError("INVALID_TARGET", "Invalid target dimensions", {
          isRecoverable: false
        });
    }
    this.targets = new Map(
      targets.map((t) => [t.targetId, { widthPx: t.widthPx, heightPx: t.heightPx }])
    );
  }
  async start(container, sessionId) {
    this.assertUsable();
    await this.stop();
    if (!container)
      throw new EngineError(
        "INVALID_CONFIG",
        "The renderer requires a positioned overlay container",
        {
          isRecoverable: false
        }
      );
    this.container = container;
    this.sessionId = sessionId;
    this.lastFrame = -1;
    container.ownerDocument.addEventListener("visibilitychange", this.onVisibility);
    container.ownerDocument.defaultView?.addEventListener("pagehide", this.onPageHide);
  }
  onPageHide = () => {
    this.hide();
    this.media?.pause();
  };
  onVisibility = () => {
    if (this.container?.ownerDocument.hidden) this.onPageHide();
  };
  emitMediaState(state, presentation) {
    if (!this.sessionId || !this.media) return;
    this.emitMediaStateFor(
      { sessionId: this.sessionId, targetId: this.activeTarget, media: this.media },
      state,
      presentation
    );
  }
  /** Explicit context, so a release can report the request it just ended after this.media was cleared. */
  emitMediaStateFor(context, state, presentation) {
    const d = context.media.getSnapshot();
    this.emit({
      type: "mediaState",
      sessionId: context.sessionId,
      targetId: context.targetId,
      timestampUs: this.now(),
      state,
      media: {
        currentTime: d.currentTime,
        decodedFrames: d.decodedFrames,
        droppedFrames: d.droppedFrames,
        readyState: Number.isFinite(d.readyState) ? d.readyState : null,
        isPaused: Boolean(d.isPaused),
        errorCode: d.errorCode,
        isLooping: d.isLooping,
        duration: d.duration,
        isEnded: d.isEnded,
        loopRecoveries: d.loopRecoveries,
        playbackPath: d.playbackPath,
        recoveryAttempts: d.recoveryAttempts,
        ...presentation ? { presentation } : {}
      }
    });
  }
  // ---- Loading and reveal: one presentation request per media request ----
  ownsPresentation(request) {
    return !this.isDisposed && this.presentation === request && this.media === request.media && this.sessionId === request.sessionId && this.activeTarget === request.targetId;
  }
  telemetry(request, failureReason) {
    return presentationTelemetry(request, this.now(), failureReason);
  }
  /** Dim layer, spinner and a readiness watch on the current media; announcing 'loading' is left to the caller. */
  startPresentation(media, overlay, sessionId, targetId) {
    const isReduced = overlay.isReducedMotion;
    const revealMs = this.reveal.revealMs;
    const request = {
      generation: ++this.requestSeq,
      media,
      overlay,
      sessionId,
      targetId,
      phase: "loading",
      signal: null,
      startUs: this.now(),
      firstFrameUs: null,
      revealStartUs: null,
      revealEndUs: null,
      isReduced,
      revealDurationMs: isReduced ? Math.min(revealMs, REDUCED_REVEAL_MS) : revealMs,
      isAnnounced: false,
      budgetMs: this.reveal.loadingTimeoutMs,
      clockStartUs: null,
      timer: null
    };
    this.presentation = request;
    overlay.showLoading(isReduced);
    try {
      media.awaitPresentableFrame((frame) => this.onFirstFrame(request, frame.signal));
    } catch {
    }
    return request;
  }
  announceLoading(request) {
    if (request.isAnnounced || request.phase !== "loading" || !this.ownsPresentation(request))
      return;
    request.isAnnounced = true;
    this.emitMediaState("loading", this.telemetry(request));
  }
  startClock(request) {
    startBudget(request, this.now, (r) => this.onLoadingTimeout(r));
  }
  pauseClock(request) {
    pauseBudget(request, this.now);
  }
  onLoadingTimeout(request) {
    request.timer = null;
    if (!this.ownsPresentation(request) || request.phase !== "loading") return;
    this.failMedia(
      request.media,
      request,
      { sessionId: request.sessionId, targetId: request.targetId, timestampUs: this.now() },
      "media-loading-timeout",
      "loading-timeout"
    );
  }
  /** Only the readiness watch of the current request gets past the ownership check. */
  onFirstFrame(request, signal) {
    if (!this.ownsPresentation(request) || request.phase !== "loading") return;
    this.pauseClock(request);
    const revealMs = this.reveal.revealMs;
    request.firstFrameUs = this.now();
    request.signal = signal;
    request.phase = "revealing";
    request.isReduced = request.overlay.isReducedMotion;
    request.revealDurationMs = request.isReduced ? Math.min(revealMs, REDUCED_REVEAL_MS) : revealMs;
    this.emitMediaState("first-frame", this.telemetry(request));
    if (!this.ownsPresentation(request) || request.phase !== "revealing") return;
    const duration = this.isVisible && !this.container?.ownerDocument.hidden ? request.revealDurationMs : 0;
    if (duration > 0) {
      request.revealStartUs = this.now();
      this.emitMediaState("reveal-start", this.telemetry(request));
      if (!this.ownsPresentation(request) || request.phase !== "revealing") return;
    }
    request.overlay.reveal({
      durationMs: duration,
      isReduced: request.isReduced,
      onEnd: () => this.onRevealEnd(request)
    });
  }
  onRevealEnd(request) {
    if (!this.ownsPresentation(request) || request.phase !== "revealing") return;
    request.phase = "revealed";
    request.revealEndUs = this.now();
    if (request.revealStartUs === null) request.revealStartUs = request.revealEndUs;
    this.emitMediaState("reveal-end", this.telemetry(request));
  }
  /** Clears spinner and mask of a request that can no longer finish loading; one already revealing completes. */
  failPresentation(request, reason) {
    if (!request || !this.ownsPresentation(request)) return;
    if (request.phase === "revealing") {
      request.overlay.finish();
      return;
    }
    if (request.phase !== "loading") return;
    this.pauseClock(request);
    request.phase = "failed";
    request.media.cancelPresentable();
    request.overlay.cancel();
    this.emitMediaState("loading-failed", this.telemetry(request, reason));
  }
  /** Media failure: clear the loading visuals, report 'error', latch, hide, pause, and report MEDIA_FAILED. */
  failMedia(media, request, context, reason, presentationReason) {
    this.failPresentation(request, presentationReason);
    if (this.media === media) {
      this.emitMediaState("error");
      if (this.media === media) {
        this.isMediaFailed = true;
        this.hide();
      }
    }
    media.pause();
    this.emit({
      type: "error",
      ...context,
      error: new EngineError("MEDIA_FAILED", reason, { isRecoverable: true })
    });
  }
  /**
   * A new request on the same media element: a gesture reload (`isForced`) or a retry after blocked playback (only
   * when that request had failed). An unfinished previous request is reported cancelled.
   */
  restartPresentation(media, isForced) {
    const old = this.presentation;
    if (!this.reveal || !old || old.media !== media || !this.ownsPresentation(old) || !isForced && old.phase !== "failed")
      return;
    let cancelled = null;
    if (old.phase === "loading" || old.phase === "revealing") {
      this.pauseClock(old);
      old.phase = "cancelled";
      old.overlay.cancel();
      cancelled = this.telemetry(old);
    }
    const request = this.startPresentation(media, old.overlay, old.sessionId, old.targetId);
    if (this.isVisible && !this.container?.ownerDocument.hidden) this.startClock(request);
    if (cancelled)
      this.emitMediaStateFor(
        { sessionId: old.sessionId, targetId: old.targetId, media },
        "reveal-cancel",
        cancelled
      );
    this.announceLoading(request);
  }
  isPresentable(result) {
    const ageUs = result.prediction.ageUs;
    return Boolean(result.targetId) && (result.state === "TRACKING" || result.state === "LIMITED") && !result.quality.isDegenerate && (result.quality.isMeasured || Number.isFinite(ageUs) && ageUs >= 0 && ageUs < MAX_PRESENTABLE_PREDICTION_US);
  }
  /** Creates the media element, session, plane and presentation of a newly active target. */
  activate(target, config) {
    const container = this.container;
    const video = container.ownerDocument.createElement("video");
    const sessionId = this.sessionId;
    const targetId = this.activeTarget;
    const media = new VideoSession(video, {
      ...this.recoveries ? { recoveries: this.recoveries } : {},
      onEvent: (event) => {
        if (this.media !== media) return;
        const context = { sessionId, targetId, timestampUs: this.now() };
        if (event.type === "playbackBlocked") {
          this.failPresentation(this.presentation, "playback-blocked");
          if (this.media !== media) return;
          this.blockedMedia = media;
          this.emit({ type: "playbackBlocked", ...context });
        } else
          this.failMedia(media, this.presentation, context, event.error.message, "media-error");
      }
    });
    this.media = media;
    let lastTimeUpdate = -Infinity;
    const handlers = /* @__PURE__ */ new Map();
    for (const state of MEDIA_STATES) {
      const listener = () => {
        if (this.media !== media) return;
        if (state === "timeupdate") {
          const now = this.now();
          if (now - lastTimeUpdate < TIME_UPDATE_INTERVAL_US) return;
          lastTimeUpdate = now;
        }
        this.emitMediaState(state);
      };
      handlers.set(state, listener);
      video.addEventListener(state, listener);
    }
    this.removeMediaListeners = () => {
      for (const [name, listener] of handlers) video.removeEventListener(name, listener);
    };
    media.configure(config);
    this.isPresentationAllowed = true;
    this.plane = new VideoPlane(container, video, {
      widthPx: target.widthPx,
      heightPx: target.heightPx,
      ...config.fit ? { fit: config.fit } : {}
    });
    if (this.reveal) {
      const overlay = new PlanePresentation(this.plane.element, video, {
        widthPx: target.widthPx,
        heightPx: target.heightPx,
        overlayOpacity: this.reveal.overlayOpacity,
        nowMs: () => this.now() / 1e3,
        document: container.ownerDocument
      });
      try {
        this.startPresentation(media, overlay, sessionId, targetId);
      } catch {
        this.presentation = null;
        try {
          overlay.cancel();
          overlay.restoreVideo();
        } catch {
        }
      }
    }
  }
  /**
   * Shows `result` with the geometry of the frame it was computed from. Invalid results hide the overlay (but leave a
   * loss hold running). Throws FRAME_FAILED when the plane cannot be placed.
   */
  async update(result, geometry) {
    this.assertUsable();
    if (this.stopping > 0 || !this.container || result.sessionId !== this.sessionId || result.frameId <= this.lastFrame)
      return;
    this.lastFrame = result.frameId;
    const epoch = this.epoch;
    if (this.container.ownerDocument.hidden || !this.isPresentable(result)) {
      if (this.hold && !this.container.ownerDocument.hidden) return;
      this.hide();
      return;
    }
    const targetId = result.targetId;
    const target = this.targets.get(targetId);
    const config = this.bindings.get(targetId);
    if (!target || !config) {
      this.releaseActive(result.frameId);
      return;
    }
    this.isPresentationAllowed = true;
    if (this.activeTarget !== targetId) {
      this.releaseActive(result.frameId);
      if (this.epoch !== epoch || !this.container || this.lastFrame !== result.frameId) return;
      this.activeTarget = targetId;
      this.activate(target, config);
    }
    try {
      const corners = result.cornersPx ?? (result.H_imageFromTarget ? [
        [0, 0],
        [target.widthPx, 0],
        [target.widthPx, target.heightPx],
        [0, target.heightPx]
      ].map(([x, y]) => project(result.H_imageFromTarget, x, y)) : null);
      if (!corners) {
        this.hide();
        return;
      }
      this.plane.place(corners, geometry.H_viewportFromStandard);
      if (this.hold) {
        this.cancelHold();
        this.emitMediaState("hold-recovered");
        if (this.epoch !== epoch || this.lastFrame !== result.frameId) return;
      }
      if (!this.isPresentationAllowed || this.isDisposed || !this.sessionId || this.isMediaFailed) {
        this.plane?.hide();
        return;
      }
      if (!this.isVisible) this.show();
    } catch (error) {
      this.hide();
      throw new EngineError("FRAME_FAILED", String(error), { isRecoverable: true, cause: error });
    }
  }
  /** First visible frame of the plane: start the loading budget, report 'shown', announce loading, play. */
  show() {
    const media = this.media;
    const session = this.sessionId;
    const target = this.activeTarget;
    this.isVisible = true;
    this.startClock(this.presentation);
    this.emitMediaState("shown");
    const isUnchanged = () => this.isVisible && this.isPresentationAllowed && !this.isDisposed && this.sessionId === session && this.activeTarget === target && this.media === media && media !== null && !this.isMediaFailed && !this.container?.ownerDocument.hidden;
    if (isUnchanged()) {
      if (this.presentation) this.announceLoading(this.presentation);
      if (isUnchanged()) void media.play();
    }
  }
  cancelHold() {
    const hold = this.hold;
    this.hold = null;
    clearHoldTimer(hold);
  }
  /**
   * Soft hide after a target loss: the last overlay pose and playback stay for `graceMs`, then hide and pause. Idempotent
   * while holding, so repeated loss notifications never re-time it. Returns false when there is nothing to hold.
   */
  holdAfterLoss(graceMs) {
    if (this.isDisposed || !this.sessionId || !isValidGrace(graceMs)) return false;
    if (this.hold) return true;
    if (!this.isVisible || !this.media || !this.activeTarget || this.isMediaFailed || !this.isPresentationAllowed || this.container?.ownerDocument.hidden)
      return false;
    const hold = {
      media: this.media,
      sessionId: this.sessionId,
      targetId: this.activeTarget,
      timer: null
    };
    this.hold = hold;
    hold.timer = setTimeout(() => this.expireHold(hold), graceMs);
    this.emitMediaState("held");
    return true;
  }
  expireHold(hold) {
    if (this.hold !== hold || this.media !== hold.media || this.sessionId !== hold.sessionId || this.activeTarget !== hold.targetId)
      return;
    this.hideInternal(true);
  }
  hide() {
    this.hideInternal(false);
  }
  hideInternal(isPauseForced) {
    const wasVisible = this.isVisible;
    const wasHolding = this.hold !== null;
    const request = this.presentation;
    this.cancelHold();
    this.isPresentationAllowed = false;
    this.plane?.hide();
    this.pauseClock(request);
    if (this.activeTarget && (isPauseForced || wasHolding || this.bindings.get(this.activeTarget)?.onLost !== "hide"))
      this.media?.pause();
    this.isVisible = false;
    if (wasVisible) this.emitMediaState("hidden");
    if (request && request.phase === "revealing" && this.presentation === request && this.releasingPresentation !== request)
      request.overlay.finish();
  }
  /** Sets or replaces one target's media (a URL, or a file the renderer owns an object URL for). */
  setTargetMedia(targetId, source, options = {}) {
    this.assertUsable();
    if (typeof source === "object" && source !== null) {
      const url = URL.createObjectURL(source);
      try {
        this.setMediaConfig(targetId, { ...options, url });
        this.bindings.own(targetId, url);
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
      return;
    }
    this.setMediaConfig(targetId, { ...options, url: source });
  }
  setMediaConfig(targetId, config) {
    if (!targetId)
      throw new EngineError("INVALID_CONFIG", "Target and media URL required", {
        isRecoverable: false
      });
    validateMediaConfig(config);
    if (this.activeTarget === targetId) this.releaseActive();
    this.bindings.set(targetId, config);
  }
  clearTargetMedia(targetId) {
    this.assertUsable();
    if (this.activeTarget === targetId) this.releaseActive();
    this.bindings.delete(targetId);
  }
  /** From a user gesture. Resolves true when playback continued with the new muted state. */
  async setMutedFromGesture(isMuted) {
    this.assertUsable();
    if (!this.media || !this.activeTarget) return false;
    this.bindings.update(this.activeTarget, { isMuted });
    this.media.setMuted(isMuted);
    if (isMuted) return true;
    if (!this.isPresentationAllowed || this.isMediaFailed || this.container?.ownerDocument.hidden)
      return false;
    const media = this.media;
    const session = this.sessionId;
    const target = this.activeTarget;
    const epoch = this.epoch;
    this.restartPresentation(media, false);
    if (!this.isStillCurrent(media, session, target, epoch) || !this.isPresentationAllowed || this.isMediaFailed || this.container?.ownerDocument.hidden)
      return false;
    return media.resumeFromGesture();
  }
  /** From a user gesture after playbackBlocked: resumes the blocked media while it is current and visible. */
  async resumeBlockedFromGesture() {
    const media = this.blockedMedia;
    if (!media) return false;
    const session = this.sessionId;
    const target = this.activeTarget;
    const epoch = this.epoch;
    if (this.media !== media || !this.isVisible) return false;
    this.restartPresentation(media, false);
    if (!this.isStillCurrent(media, session, target, epoch) || !this.isVisible) return false;
    return media.resumeFromGesture();
  }
  /** From a user gesture after a media failure: reloads the active media and plays it again. */
  async retryFromGesture() {
    this.assertUsable();
    if (!this.media || !this.isPresentationAllowed || this.container?.ownerDocument.hidden)
      return false;
    this.isMediaFailed = false;
    this.plane?.show();
    this.isVisible = true;
    const media = this.media;
    const retried = media.retryFromGesture();
    this.restartPresentation(media, true);
    return retried;
  }
  isStillCurrent(media, session, target, epoch) {
    return !this.isDisposed && this.media === media && this.sessionId === session && this.activeTarget === target && this.epoch === epoch;
  }
  getDiagnostics() {
    return {
      sessionId: this.sessionId,
      targetId: this.activeTarget,
      isVisible: this.isVisible,
      isHolding: this.hold !== null,
      isFailed: this.isMediaFailed,
      ownedFileUrls: this.bindings.ownedUrlCount,
      media: this.media?.getSnapshot() ?? null,
      presentation: this.presentation ? this.telemetry(this.presentation) : null
    };
  }
  /**
   * hide() notifies observers with the old target still active, and they may re-enter stop(), update() or
   * releaseActive(). Ownership is claimed before hide(); if the resources changed meanwhile, the re-entrant call
   * already released them (exactly once) and whatever is current now belongs to a newer operation.
   */
  releaseActive(frameId) {
    const removeListeners = this.removeMediaListeners;
    const media = this.media;
    const plane = this.plane;
    const request = this.presentation;
    const context = media && this.sessionId ? { sessionId: this.sessionId, targetId: this.activeTarget, media } : null;
    this.releasingPresentation = request;
    try {
      this.hide();
    } finally {
      this.releasingPresentation = null;
    }
    if (this.media !== media || this.plane !== plane || this.removeMediaListeners !== removeListeners)
      return;
    if (frameId !== void 0 && this.lastFrame !== frameId) return;
    this.removeMediaListeners = null;
    this.media = null;
    this.plane = null;
    this.activeTarget = null;
    this.isVisible = false;
    this.isMediaFailed = false;
    this.isPresentationAllowed = false;
    this.presentation = null;
    let cancelled = null;
    if (request) {
      this.pauseClock(request);
      if (request.phase === "loading" || request.phase === "revealing") {
        request.phase = "cancelled";
        cancelled = this.telemetry(request);
      }
      request.overlay.dispose();
    }
    removeListeners?.();
    media?.dispose();
    plane?.dispose();
    if (cancelled && context) this.emitMediaStateFor(context, "reveal-cancel", cancelled);
  }
  async stop() {
    ++this.epoch;
    this.stopping++;
    try {
      this.container?.ownerDocument.removeEventListener("visibilitychange", this.onVisibility);
      this.container?.ownerDocument.defaultView?.removeEventListener("pagehide", this.onPageHide);
      this.releaseActive();
    } finally {
      this.stopping--;
      this.container = null;
      this.sessionId = null;
      this.lastFrame = -1;
    }
  }
  async dispose() {
    if (this.isDisposed) return;
    await this.stop();
    this.bindings.dispose();
    this.listeners.clear();
    this.targets.clear();
    this.isDisposed = true;
  }
  assertUsable() {
    if (this.isDisposed)
      throw new EngineError("DISPOSED", "Renderer disposed", { isRecoverable: false });
  }
};

// packages/sdk/src/worker/embedded-worker.ts
function createEmbeddedWorkerFactory(source, env = globalThis) {
  if (typeof source !== "string" || !source) {
    throw new EngineError("INVALID_CONFIG", "Embedded worker source required", {
      isRecoverable: false
    });
  }
  return () => {
    const url = env.URL.createObjectURL(new env.Blob([source], { type: "text/javascript" }));
    let worker;
    try {
      worker = new env.Worker(url, { type: "module", name: "LiveMira vision" });
    } catch (error) {
      env.URL.revokeObjectURL(url);
      throw error;
    }
    let isRevoked = false;
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate() {
        try {
          worker.terminate();
        } finally {
          if (!isRevoked) {
            isRevoked = true;
            env.URL.revokeObjectURL(url);
          }
        }
      },
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener)
    };
  };
}
function defaultWorkerFactory() {
  const source = true ? '/*! LiveMira engine | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */\n\n// packages/contracts/src/errors.ts\nvar EngineError = class extends Error {\n  code;\n  isRecoverable;\n  constructor(code, message, options) {\n    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });\n    this.name = "EngineError";\n    this.code = code;\n    this.isRecoverable = options.isRecoverable;\n  }\n};\n\n// packages/contracts/src/math.ts\nfunction normalizeHomography(h) {\n  if (h.length !== 9 || !h.every(Number.isFinite)) {\n    throw new EngineError("INVALID_TARGET", "Homography requires nine finite elements", {\n      isRecoverable: false\n    });\n  }\n  const scale = Math.abs(h[8]) > 1e-12 ? h[8] : Math.max(...h.map(Math.abs));\n  if (!scale) throw new EngineError("INVALID_TARGET", "Zero homography", { isRecoverable: false });\n  const m = h.map((x) => x / scale);\n  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);\n  if (Math.abs(det) < 1e-12)\n    throw new EngineError("INVALID_TARGET", "Singular homography", { isRecoverable: false });\n  return m;\n}\n\n// packages/contracts/src/target.ts\nfunction validateTargetBundle(value) {\n  const t = value;\n  const fail = () => {\n    throw new EngineError("INVALID_TARGET", "Malformed, incompatible or oversized target bundle", {\n      isRecoverable: false\n    });\n  };\n  if (!t || t.schemaVersion !== 1 || !t.targetId || typeof t.targetId !== "string" || t.targetId.length > 256 || !t.compilerVersion || !t.algorithmVersion || !/^[a-f0-9]{64}$/i.test(t.imageHash ?? "") || t.orientation !== "top-left") {\n    fail();\n  }\n  if (![t.widthPx, t.heightPx].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || t.physicalWidthMeters !== null && !(Number.isFinite(t.physicalWidthMeters) && t.physicalWidthMeters > 0)) {\n    fail();\n  }\n  const f = t.features;\n  if (!f || !Array.isArray(f.points) || f.points.length > 1e5 || !Number.isInteger(f.descriptorLength) || f.descriptorLength < 1 || f.descriptorLength > 512 || !f.descriptorType || !Array.isArray(f.descriptors) || f.descriptors.length !== f.points.length * f.descriptorLength || !f.descriptors.every(Number.isFinite)) {\n    fail();\n  }\n  if (!f.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))\n    fail();\n  if (!Array.isArray(t.pyramid) || t.pyramid.length > 16 || !t.preprocessing || !Array.isArray(t.diagnostics))\n    fail();\n  let bytes = 0;\n  for (const level of t.pyramid) {\n    if (![level.width, level.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || !Number.isFinite(level.scale) || level.scale <= 0 || !Array.isArray(level.pixels) || level.pixels.length !== level.width * level.height) {\n      fail();\n    }\n    bytes += level.pixels.length;\n    if (bytes > 16777216 || !level.pixels.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))\n      fail();\n  }\n}\n\n// packages/contracts/src/tracking-result.ts\nvar MAX_MATCHED_POINTS = 512;\n\n// packages/compute/src/gray/rgba-to-gray.ts\nvar MAX_GRAY_PIXELS = 4096 * 4096;\nfunction checkLayout(data, widthPx, heightPx, strideBytes, channels) {\n  if (!(data instanceof Uint8Array) || !Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1 || widthPx * heightPx > MAX_GRAY_PIXELS || !Number.isSafeInteger(strideBytes) || strideBytes < widthPx * channels || (heightPx - 1) * strideBytes + widthPx * channels > data.length) {\n    throw new EngineError("FRAME_FAILED", "Invalid or oversized image layout", {\n      isRecoverable: false\n    });\n  }\n}\nfunction rgbaToGray(data, widthPx, heightPx, strideBytes = widthPx * 4) {\n  checkLayout(data, widthPx, heightPx, strideBytes, 4);\n  const output = new Uint8Array(widthPx * heightPx);\n  for (let y = 0; y < heightPx; y++) {\n    for (let x = 0; x < widthPx; x++) {\n      const i = y * strideBytes + x * 4;\n      output[y * widthPx + x] = 77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2] + 128 >>> 8;\n    }\n  }\n  return { data: output, widthPx, heightPx };\n}\n\n// packages/compute/src/matching/hamming-reference.ts\nvar EXACT_MATCHING_VERSION = "hamming32-mutual-ratio075-max64/1";\nvar NONE = 4294967295;\nfunction descriptorCount(bytes) {\n  if (!(bytes instanceof Uint8Array) || bytes.length % 32 || bytes.length > 512 * 32) {\n    throw new EngineError("INVALID_CONFIG", "Expected at most 512 packed 32-byte descriptors", {\n      isRecoverable: false\n    });\n  }\n  return bytes.length / 32;\n}\nfunction pack(bytes) {\n  const words = new Uint32Array(bytes.length / 4);\n  for (let i = 0; i < words.length; i++) {\n    words[i] = (bytes[4 * i] | bytes[4 * i + 1] << 8 | bytes[4 * i + 2] << 16 | bytes[4 * i + 3] << 24) >>> 0;\n  }\n  return words;\n}\nfunction popcount(v) {\n  v -= v >>> 1 & 1431655765;\n  v = (v & 858993459) + (v >>> 2 & 858993459);\n  return (v + (v >>> 4) & 252645135) * 16843009 >>> 24;\n}\nfunction pairsFromResults(data, n, m) {\n  const pairs = [];\n  for (let t = 0; t < n; t++) {\n    const f = data[t * 4];\n    const best = data[t * 4 + 1];\n    const second = data[t * 4 + 2];\n    if (f < m && best <= 64 && 4 * best < 3 * second && data[(n + f) * 4] === t) {\n      pairs.push({ targetIndex: t, frameIndex: f, distance: best });\n    }\n  }\n  return pairs;\n}\nfunction matchHammingReference(target, frame) {\n  const n = descriptorCount(target);\n  const m = descriptorCount(frame);\n  if (!n || !m) return [];\n  const a = pack(target);\n  const b = pack(frame);\n  const out = new Uint32Array((n + m) * 4);\n  for (let f = 0; f < m; f++) {\n    out[(n + f) * 4] = NONE;\n    out[(n + f) * 4 + 1] = 257;\n  }\n  for (let t = 0; t < n; t++) {\n    let index = NONE;\n    let best = 257;\n    let second = 257;\n    for (let f = 0; f < m; f++) {\n      let d = 0;\n      for (let w = 0; w < 8; w++) d += popcount(a[t * 8 + w] ^ b[f * 8 + w]);\n      if (d < best) {\n        second = best;\n        best = d;\n        index = f;\n      } else if (d < second) second = d;\n      const r = (n + f) * 4;\n      if (d < out[r + 1]) {\n        out[r] = t;\n        out[r + 1] = d;\n      } else if (d === out[r + 1]) out[r] = NONE;\n    }\n    out.set([index, best, second, 0], t * 4);\n  }\n  return pairsFromResults(out, n, m);\n}\n\n// packages/compute/src/matching/generated/exact-matching-wasm.ts\nvar EXACT_MATCHING_WASM = Object.freeze({\n  abi: 1,\n  scalar: Object.freeze({\n    source: "hamming-exact-scalar.wat",\n    byteLength: 647,\n    sha256: "5692cd0c74822126695c29720dc8ff6d283ea802487cb5629564d784fdd98fe1",\n    base64: "AGFzbQEAAAABEwNgAAF/YAR/f39/AX9gAn9/AX8DBAMAAQIFBAEBBAQHGAMGbWVtb3J5AgADYWJpAAAFbWF0Y2gAAQrBBAMEAEEBC7EDAwV/BH4EfyABQYAESyADQYAES3IgAEGAgApLIABBH3FycgRAQX8PCyAAIAFBBXRqQYCACksEQEF/DwsgAkGA8AtJIAJBgOANS3IgAkEBcXIEQEF/DwsgAiABQQZsakGA4A1LBEBBfw8LIAFFIANFcgRAQQAPCwNAQYCACyAFQQJ0aiEIIAhBgQI2AgAgCEF/NgKAICAFQQFqIgUgA0kNAAsDQCAAIARBBXRqIQYgBikDACEJIAYpAwghCiAGKQMQIQsgBikDGCEMQYECIQ5BgQIhD0F/IRBBACEFQYCACiEHA0AgCSAHKQMAhXsgCiAHKQMIhXt8IAsgBykDEIV7IAwgBykDGIV7fHynIQ0gDSAOSQRAIA4hDyANIQ4gBSEQBSANIA9JBEAgDSEPCwtBgIALIAVBAnRqIQggDSAIKAIASQRAIAggDTYCACAIIAQ2AoAgBSANIAgoAgBGBEAgCEF/NgKAIAsLIAdBIGohByAFQQFqIgUgA0kNAAtBgMALIARBDGxqIQYgBiAONgIAIAYgDzYCBCAGIBA2AgggBEEBaiIEIAFJDQALIAEgAhACC4YBAQZ/A0BBgMALIAJBDGxqIQMgAygCACEEIAMoAgghBSAFQQBOIARBwABNIARBAnQgAygCBEEDbElxcQRAQYCgCyAFQQJ0aigCACACRgRAIAEgBkEGbGohByAHIAI7AQAgByAFOwECIAcgBDsBBCAGQQFqIQYLCyACQQFqIgIgAEkNAAsgBgs="\n  }),\n  simd: Object.freeze({\n    source: "hamming-exact-simd.wat",\n    byteLength: 1197,\n    sha256: "93b68db7070a353ec49abdaf5afc852a7d8a48ba96b4deaee9f466aa38fe7c06",\n    base64: "AGFzbQEAAAABGARgAAF/YAF7AX9gBH9/f38Bf2ACf38BfwMFBAABAgMFBAEBBAQHGAMGbWVtb3J5AgADYWJpAAAFbWF0Y2gAAgrhCAQEAEEBC0EAIAAgACAA/Q0ICQoLDA0ODwABAgMEBQYH/bcBIQAgACAAIAD9DQQFBgcAAQIDDA0ODwgJCgv9twEhACAA/RsAC48HAgZ/EnsgAUGABEsgA0GABEtyIABBgIAKSyAAQR9xcnIEQEF/DwsgACABQQV0akGAgApLBEBBfw8LIAJBgPALSSACQYDgDUtyIAJBAXFyBEBBfw8LIAIgAUEGbGpBgOANSwRAQX8PCyABRSADRXIEQEEADwsDQEGAgAsgBUECdGohCCAI/QwBAQAAAQEAAAEBAAABAQAA/QsEACAI/Qz//////////////////////QsEgCAgBUEEaiIFIANJDQALIAP9ESENA0AgACAEQQV0aiEGIAb9AAQAIQsgBv0ABBAhDCAE/REhDv0MAQEAAAEBAAABAQAAAQEAACEQ/QwBAQAAAQEAAAEBAAABAQAAIRH9DP////////////////////8hEv0MAAAAAAEAAAACAAAAAwAAACEPQQAhBUGAgAohBwNAIAsgB/0ABAD9Uf1iIAwgB/0ABBD9Uf1i/W79fSEWIAsgB/0ABCD9Uf1iIAwgB/0ABDD9Uf1i/W79fSEXIAsgB/0ABED9Uf1iIAwgB/0ABFD9Uf1i/W79fSEYIAsgB/0ABGD9Uf1iIAwgB/0ABHD9Uf1i/W79fSEZIBYgF/0NAAEEBQgJDA0QERQVGBkcHSAWIBf9DQIDBgcKCw4PEhMWFxobHh/9jgEhGiAYIBn9DQABBAUICQwNEBEUFRgZHB0gGCAZ/Q0CAwYHCgsODxITFhcaGx4f/Y4BIRsgGiAb/Q0AAQQFCAkMDRARFBUYGRwdIBogG/0NAgMGBwoLDg8SExYXGhseH/2OAf1/IRMgE/0MAQEAAAEBAAABAQAAAQEAACAPIA39Ov1SIRMgEyAQ/TohFCAQIBEgE/23ASAU/VIhESATIBAgFP1SIRAgDyASIBT9UiESQYCACyAFQQJ0aiEIIAj9AAQAIRUgCCAO/Qz/////////////////////IAj9AASAICATIBX9N/1SIBMgFf06/VL9CwSAICAIIBMgFf23Af0LBAAgD/0MBAAAAAQAAAAEAAAABAAAAP2uASEPIAdBgAFqIQcgBUEEaiIFIANJDQALIBAQASEJIBAgCf0R/TchCkGAwAsgBEEMbGohBiAGIAk2AgAgBiAK/aQBaUEBSwR/IAkFIBEgECAK/VIQAQs2AgQgBiAS/Qz/////////////////////IAr9UhABNgIIIARBAWoiBCABSQ0ACyABIAIQAwuGAQEGfwNAQYDACyACQQxsaiEDIAMoAgAhBCADKAIIIQUgBUEATiAEQcAATSAEQQJ0IAMoAgRBA2xJcXEEQEGAoAsgBUECdGooAgAgAkYEQCABIAZBBmxqIQcgByACOwEAIAcgBTsBAiAHIAQ7AQQgBkEBaiEGCwsgAkEBaiICIABJDQALIAYL"\n  })\n});\n\n// packages/compute/src/matching/wasm-exact-matcher.ts\nvar ABI = 1;\nvar MEMORY_BYTES = 4 * 65536;\nvar SLOT_BYTES = 512 * 32;\nvar FRAME = 163840;\nvar OUT = 194560;\nvar OUT_SLOT = 512 * 6;\nvar MAX_TARGETS = 10;\nvar WASM_MATCHER_VARIANTS = Object.freeze([\n  "simd",\n  "scalar"\n]);\nvar aborted = () => new EngineError("ABORTED", "Matching aborted", { isRecoverable: true });\nfunction throwIfAborted(signal) {\n  if (signal?.aborted) throw aborted();\n}\nvar invalidRequest = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });\nfunction descriptorCount2(bytes) {\n  return bytes instanceof Uint8Array && bytes.length % 32 === 0 && bytes.length <= SLOT_BYTES ? bytes.length / 32 : -1;\n}\nfunction decode(base64) {\n  const text = atob(base64);\n  const bytes = new Uint8Array(text.length);\n  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);\n  return bytes;\n}\nvar WasmExactMatcher = class {\n  #match;\n  #u8;\n  #u16;\n  #variant;\n  #targets = /* @__PURE__ */ new Map();\n  #failure = null;\n  constructor(instance, variant) {\n    const e = instance?.exports;\n    if (!WASM_MATCHER_VARIANTS.includes(variant) || !(e?.memory instanceof WebAssembly.Memory) || e.memory.buffer.byteLength !== MEMORY_BYTES || typeof e.match !== "function" || typeof e.abi !== "function" || e.abi() !== ABI) {\n      throw new EngineError("UNSUPPORTED", "Invalid exact matching module", {\n        isRecoverable: false\n      });\n    }\n    this.#match = e.match;\n    this.#variant = variant;\n    this.#u8 = new Uint8Array(e.memory.buffer);\n    this.#u16 = new Uint16Array(e.memory.buffer);\n  }\n  get variant() {\n    return this.#variant;\n  }\n  get isAvailable() {\n    return this.#match !== null;\n  }\n  get diagnostics() {\n    return {\n      matchingVersion: EXACT_MATCHING_VERSION,\n      backend: this.#match ? "wasm" : "cpu",\n      variant: this.#variant,\n      fallbackReason: this.#failure,\n      targetCount: this.#targets.size\n    };\n  }\n  #live() {\n    if (!this.#match || !this.#u8 || !this.#u16) {\n      throw new EngineError("RESOURCE_FAILED", "WASM exact matcher unavailable", {\n        isRecoverable: false\n      });\n    }\n    return { match: this.#match, u8: this.#u8, u16: this.#u16 };\n  }\n  /** Replaces the resident roster: at most ten unique targets of at most 512 descriptors; fully validated before any byte is written. */\n  setTargets(targets) {\n    const { u8 } = this.#live();\n    if (!Array.isArray(targets) || targets.length > MAX_TARGETS || new Set(targets.map((t) => t?.id)).size !== targets.length) {\n      throw invalidRequest("Expected at most ten unique targets");\n    }\n    const counts = targets.map((t) => {\n      if (typeof t.id !== "string" || !t.id || t.id.length > 256)\n        throw invalidRequest("Invalid target ID");\n      const n = descriptorCount2(t.descriptors);\n      if (n < 0) throw invalidRequest("Expected at most 512 packed 32-byte descriptors");\n      return n;\n    });\n    const next = /* @__PURE__ */ new Map();\n    targets.forEach((t, slot) => {\n      u8.set(t.descriptors, slot * SLOT_BYTES);\n      next.set(t.id, { offset: slot * SLOT_BYTES, count: counts[slot] });\n    });\n    this.#targets = next;\n  }\n  /** One frame upload, then one exact pass per requested resident target. */\n  matchBatch(targetIds, frame, signal) {\n    const { match, u8, u16 } = this.#live();\n    throwIfAborted(signal);\n    if (!Array.isArray(targetIds) || targetIds.length > MAX_TARGETS || new Set(targetIds).size !== targetIds.length || targetIds.some((id) => !this.#targets.has(id))) {\n      throw invalidRequest("Expected at most ten loaded targets");\n    }\n    const m = descriptorCount2(frame);\n    if (m < 0) throw invalidRequest("Expected at most 512 packed 32-byte descriptors");\n    const start = performance.now();\n    const matches = [];\n    u8.set(frame, FRAME);\n    for (let k = 0; k < targetIds.length; k++) {\n      throwIfAborted(signal);\n      const targetId = targetIds[k];\n      const target = this.#targets.get(targetId);\n      const out = OUT + k * OUT_SLOT;\n      const count = match(target.offset, target.count, out, m);\n      if (!Number.isInteger(count) || count < 0 || count > Math.min(target.count, m)) {\n        throw new EngineError("RESOURCE_FAILED", "WASM exact matching failed", {\n          isRecoverable: false\n        });\n      }\n      const pairs = new Array(count);\n      for (let q = 0, p = out >>> 1; q < count; q++, p += 3) {\n        pairs[q] = { targetIndex: u16[p], frameIndex: u16[p + 1], distance: u16[p + 2] };\n      }\n      matches.push({ targetId, pairs });\n    }\n    throwIfAborted(signal);\n    return {\n      backend: "wasm",\n      variant: this.#variant,\n      matchingVersion: EXACT_MATCHING_VERSION,\n      matches,\n      timing: { totalMs: performance.now() - start }\n    };\n  }\n  /** Permanently disables this instance (the caller then keeps the JavaScript matcher) and records why. */\n  fail(reason) {\n    this.#failure = reason;\n    this.dispose();\n  }\n  /** Drops every reference to the instance and its memory; later calls throw. */\n  dispose() {\n    this.#match = null;\n    this.#u8 = null;\n    this.#u16 = null;\n    this.#targets.clear();\n  }\n};\nfunction selfTestCases() {\n  let seed = 625341585;\n  const rnd = () => {\n    seed ^= seed << 13;\n    seed ^= seed >>> 17;\n    seed ^= seed << 5;\n    return seed >>> 0;\n  };\n  const random = (n) => {\n    const b = new Uint8Array(n * 32);\n    for (let i = 0; i < b.length; i++) b[i] = rnd() & 255;\n    return b;\n  };\n  const flip = (src, i, bits) => {\n    const d = src.slice(i * 32, i * 32 + 32);\n    for (let k = 0; k < bits; k++) d[k % 32] ^= 1 << (k >> 5);\n    return d;\n  };\n  const join = (list) => {\n    const out = new Uint8Array(list.reduce((s, d) => s + d.length, 0));\n    let o = 0;\n    for (const d of list) {\n      out.set(d, o);\n      o += d.length;\n    }\n    return out;\n  };\n  const target = random(37);\n  const frameList = [];\n  for (let j = 0; j < 41; j++)\n    frameList.push(j % 3 === 0 ? flip(target, j * 7 % 37, j % 70) : random(1));\n  const zero = new Uint8Array(32);\n  const ones = (bits) => {\n    const d = new Uint8Array(32);\n    for (let k = 0; k < bits; k++) d[k >> 3] |= 1 << (k & 7);\n    return d;\n  };\n  const big = random(512);\n  return [\n    [target, join(frameList)],\n    [\n      join([target.slice(0, 32), target.slice(0, 32), target.slice(32, 64)]),\n      join([target.slice(0, 32), target.slice(32, 96)])\n    ],\n    [join([zero, ones(256)]), join([ones(64), ones(65)])],\n    [join([zero]), join([ones(64)])],\n    [join([zero]), join([ones(65)])],\n    [join([zero]), join([ones(30), ones(40)])],\n    [join([zero]), join([ones(30), ones(41)])],\n    [join([zero]), join([ones(30), ones(39), ones(200)])],\n    [big, join([big.slice(0, 32 * 300), random(212)])]\n  ];\n}\nfunction passesSelfTest(matcher) {\n  try {\n    for (const [target, frame] of selfTestCases()) {\n      matcher.setTargets([{ id: "self-test", descriptors: target }]);\n      const got = matcher.matchBatch(["self-test"], frame).matches[0].pairs;\n      const want = matchHammingReference(target, frame);\n      if (got.length !== want.length || got.some(\n        (p, i) => p.targetIndex !== want[i].targetIndex || p.frameIndex !== want[i].frameIndex || p.distance !== want[i].distance\n      )) {\n        return false;\n      }\n    }\n    matcher.setTargets([]);\n    return true;\n  } catch {\n    return false;\n  }\n}\nasync function selectWasmExactMatcher(options = {}) {\n  const {\n    variants = WASM_MATCHER_VARIANTS,\n    signal,\n    webAssembly = globalThis.WebAssembly,\n    binaries = EXACT_MATCHING_WASM\n  } = options;\n  throwIfAborted(signal);\n  if (!Array.isArray(variants) || !variants.length || variants.some((v) => !WASM_MATCHER_VARIANTS.includes(v))) {\n    throw invalidRequest("Unknown WASM exact matching variant");\n  }\n  const attempts = [];\n  if (typeof webAssembly?.instantiate !== "function" || typeof webAssembly.validate !== "function") {\n    return {\n      matcher: null,\n      variant: null,\n      fallbackReason: "WASM_UNAVAILABLE",\n      attempts: [{ variant: "*", outcome: "WASM_UNAVAILABLE" }]\n    };\n  }\n  for (const variant of variants) {\n    let bytes;\n    try {\n      bytes = decode(binaries[variant].base64);\n    } catch {\n      attempts.push({ variant, outcome: "WASM_MODULE_MISSING" });\n      continue;\n    }\n    if (!webAssembly.validate(bytes)) {\n      attempts.push({\n        variant,\n        outcome: variant === "simd" ? "WASM_SIMD_UNSUPPORTED" : "WASM_MODULE_INVALID"\n      });\n      continue;\n    }\n    let matcher;\n    try {\n      const { instance } = await webAssembly.instantiate(bytes, {});\n      throwIfAborted(signal);\n      matcher = new WasmExactMatcher(instance, variant);\n    } catch (error) {\n      if (error instanceof EngineError && error.code === "ABORTED") throw error;\n      attempts.push({ variant, outcome: "WASM_INIT_FAILED" });\n      continue;\n    }\n    if (!passesSelfTest(matcher)) {\n      matcher.dispose();\n      attempts.push({ variant, outcome: "WASM_SELFTEST_MISMATCH" });\n      continue;\n    }\n    attempts.push({ variant, outcome: "selected" });\n    return {\n      matcher,\n      variant,\n      fallbackReason: attempts.length > 1 ? attempts[0].outcome : null,\n      attempts\n    };\n  }\n  return {\n    matcher: null,\n    variant: null,\n    fallbackReason: attempts[0]?.outcome ?? "WASM_UNAVAILABLE",\n    attempts\n  };\n}\nfunction createWasmMatchOperator(matcher, options = {}) {\n  let roster = /* @__PURE__ */ new Map();\n  return async (targets, frameDescriptors, signal) => {\n    if (!matcher.isAvailable) return null;\n    throwIfAborted(signal);\n    if (targets.length > MAX_TARGETS || descriptorCount2(frameDescriptors) < 0 || targets.some((t) => descriptorCount2(t.descriptors) < 0)) {\n      return null;\n    }\n    try {\n      let changed = false;\n      let next = new Map(roster);\n      for (const t of targets) {\n        if (next.get(t.targetId) !== t.descriptors) {\n          changed = true;\n          next.set(t.targetId, t.descriptors);\n        }\n      }\n      if (next.size > MAX_TARGETS) {\n        next = new Map(targets.map((t) => [t.targetId, t.descriptors]));\n        changed = true;\n      }\n      if (changed) {\n        roster = /* @__PURE__ */ new Map();\n        matcher.setTargets([...next].map(([id, descriptors]) => ({ id, descriptors })));\n        roster = next;\n      }\n      return matcher.matchBatch(\n        targets.map((t) => t.targetId),\n        frameDescriptors,\n        signal\n      );\n    } catch (error) {\n      if (error instanceof EngineError && error.code === "ABORTED" || signal?.aborted)\n        throw error;\n      roster = /* @__PURE__ */ new Map();\n      matcher.fail("WASM_EXECUTION_FAILED");\n      try {\n        options.onFailure?.("WASM_EXECUTION_FAILED");\n      } catch {\n      }\n      return null;\n    }\n  };\n}\n\n// packages/compute/src/standard-image/standardize.ts\nvar STANDARD_MAX_EDGE = 4096;\nvar STANDARD_MAX_PIXELS = 4194304;\nvar RAW_MAX_EDGE = 16384;\nvar RAW_MAX_PIXELS = 16777216;\nvar SOURCE_TOO_LARGE = "Worker source frame exceeds supported size";\nvar STANDARD_TOO_LARGE = "Standard image exceeds processing limit; frames are never silently resized";\nfunction checkRawLayout(image) {\n  const { width, height, strideBytes: stride } = image;\n  const channels = image.kind === "gray8" ? 1 : image.kind === "rgba8" ? 4 : 0;\n  if (!channels || !(image.buffer instanceof ArrayBuffer) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(stride) || stride < width * channels || !Number.isSafeInteger((height - 1) * stride + width * channels) || (height - 1) * stride + width * channels > image.buffer.byteLength) {\n    throw new EngineError("FRAME_FAILED", "Invalid worker CPU layout", { isRecoverable: false });\n  }\n  if (width > RAW_MAX_EDGE || height > RAW_MAX_EDGE || width * height > RAW_MAX_PIXELS) {\n    throw new EngineError("UNSUPPORTED", SOURCE_TOO_LARGE, { isRecoverable: false });\n  }\n  return channels;\n}\nfunction checkStandardSize(width, height) {\n  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {\n    throw new EngineError("FRAME_FAILED", "Invalid standard image dimensions", {\n      isRecoverable: false\n    });\n  }\n  if (width > STANDARD_MAX_EDGE || height > STANDARD_MAX_EDGE || width * height > STANDARD_MAX_PIXELS) {\n    throw new EngineError("UNSUPPORTED", STANDARD_TOO_LARGE, { isRecoverable: false });\n  }\n}\nfunction checkGeometry(geometry) {\n  checkStandardSize(geometry.standardWidthPx, geometry.standardHeightPx);\n  const h = geometry.H_standardFromInput;\n  const invalid3 = () => {\n    throw new EngineError("FRAME_FAILED", "Invalid frame transform", { isRecoverable: false });\n  };\n  if (!h || h.length !== 9) invalid3();\n  for (let i = 0; i < 9; i++) if (typeof h[i] !== "number" || !Number.isFinite(h[i])) invalid3();\n  if (h[6] !== 0 || h[7] !== 0 || h[8] !== 1) invalid3();\n}\nvar now = () => performance.now();\nfunction drawStandard(workspace, source, geometry, stages) {\n  const began = stages ? now() : 0;\n  const width = geometry.standardWidthPx;\n  const height = geometry.standardHeightPx;\n  const h = geometry.H_standardFromInput;\n  const out = workspace.outputSurface(width, height).context;\n  try {\n    out.setTransform(1, 0, 0, 1, 0, 0);\n    out.clearRect(0, 0, width, height);\n    out.setTransform(h[0], h[3], h[1], h[4], h[2], h[5]);\n    out.drawImage(source, 0, 0);\n  } finally {\n    out.setTransform(1, 0, 0, 1, 0, 0);\n  }\n  const drawn = stages ? now() : 0;\n  const pixels = out.getImageData(0, 0, width, height).data;\n  if (stages) {\n    stages.standardDrawDurationUs += (drawn - began) * 1e3;\n    stages.readbackDurationUs += (now() - drawn) * 1e3;\n  }\n  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);\n}\nfunction standardizeCpuPixels(image, channels, geometry, workspace, convert, stages) {\n  checkGeometry(geometry);\n  if (typeof OffscreenCanvas === "undefined" || typeof ImageData === "undefined") {\n    throw new EngineError("UNSUPPORTED", "Input pixels require Worker canvas", {\n      isRecoverable: true\n    });\n  }\n  const stride = image.strideBytes;\n  const rowBytes = image.width * channels;\n  const packingStarted = stages ? now() : 0;\n  let rgba;\n  if (channels === 4 && stride === rowBytes)\n    rgba = new Uint8ClampedArray(image.buffer, 0, rowBytes * image.height);\n  else {\n    rgba = workspace.bytes(image.width * image.height * 4);\n    const source = new Uint8Array(image.buffer);\n    if (channels === 4) {\n      for (let y = 0; y < image.height; y++)\n        rgba.set(source.subarray(y * stride, y * stride + rowBytes), y * rowBytes);\n    } else {\n      for (let y = 0; y < image.height; y++) {\n        let from = y * stride;\n        let to = y * rowBytes * 4;\n        for (let x = 0; x < image.width; x++, from++, to += 4) {\n          rgba[to] = rgba[to + 1] = rgba[to + 2] = source[from];\n          rgba[to + 3] = 255;\n        }\n      }\n    }\n  }\n  const packed = stages ? now() : 0;\n  const input = workspace.inputSurface(image.width, image.height);\n  input.context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);\n  if (stages) {\n    stages.inputPackingDurationUs += (packed - packingStarted) * 1e3;\n    stages.inputUploadDurationUs += (now() - packed) * 1e3;\n  }\n  const width = geometry.standardWidthPx;\n  const height = geometry.standardHeightPx;\n  const pixels = drawStandard(workspace, input.canvas, geometry, stages);\n  const grayStarted = stages ? now() : 0;\n  const data = convert(pixels, width, height).data;\n  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;\n  return { widthPx: width, heightPx: height, data };\n}\nfunction standardizeStandardPixels(image, channels, convert, stages) {\n  checkStandardSize(image.width, image.height);\n  const width = image.width;\n  const height = image.height;\n  const stride = image.strideBytes;\n  const rowBytes = width * channels;\n  const grayStarted = stages ? now() : 0;\n  let data;\n  if (channels === 4)\n    data = convert(\n      new Uint8Array(image.buffer, 0, (height - 1) * stride + rowBytes),\n      width,\n      height,\n      stride\n    ).data;\n  else if (stride === rowBytes) data = new Uint8Array(image.buffer, 0, width * height);\n  else {\n    data = new Uint8Array(width * height);\n    const source = new Uint8Array(image.buffer);\n    for (let y = 0; y < height; y++)\n      data.set(source.subarray(y * stride, y * stride + width), y * width);\n  }\n  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;\n  return { widthPx: width, heightPx: height, data };\n}\nfunction standardize(input, workspace, convert = rgbaToGray, stages) {\n  const { image, geometry } = input;\n  if ("buffer" in image) {\n    const channels = checkRawLayout(image);\n    return geometry ? standardizeCpuPixels(image, channels, geometry, workspace, convert, stages) : standardizeStandardPixels(image, channels, convert, stages);\n  }\n  if (!geometry || typeof OffscreenCanvas === "undefined") {\n    throw new EngineError(\n      "UNSUPPORTED",\n      "Native frame conversion needs Worker OffscreenCanvas and geometry",\n      {\n        isRecoverable: true\n      }\n    );\n  }\n  const source = image.image;\n  const sourceWidth = source.displayWidth ?? source.width;\n  const sourceHeight = source.displayHeight ?? source.height;\n  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > RAW_MAX_EDGE || sourceHeight > RAW_MAX_EDGE || sourceWidth * sourceHeight > RAW_MAX_PIXELS) {\n    throw new EngineError("UNSUPPORTED", SOURCE_TOO_LARGE, { isRecoverable: false });\n  }\n  checkGeometry(geometry);\n  const width = geometry.standardWidthPx;\n  const height = geometry.standardHeightPx;\n  const pixels = drawStandard(workspace, image.image, geometry, stages);\n  const grayStarted = stages ? now() : 0;\n  const data = convert(pixels, width, height).data;\n  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;\n  return { widthPx: width, heightPx: height, data };\n}\n\n// packages/compute/src/standard-image/workspace.ts\nvar SCRATCH_CACHE_MAX_BYTES = 16 * 1048576;\nvar offscreenSurface = (widthPx, heightPx, willReadFrequently) => {\n  let canvas = null;\n  try {\n    canvas = new OffscreenCanvas(widthPx, heightPx);\n    const context = canvas.getContext(\n      "2d",\n      willReadFrequently ? { willReadFrequently: true } : void 0\n    );\n    if (context) return { canvas, context };\n  } catch {\n  }\n  if (canvas) canvas.width = canvas.height = 0;\n  throw new EngineError("UNSUPPORTED", "No worker canvas", { isRecoverable: true });\n};\nvar StandardImageWorkspace = class {\n  input = null;\n  output = null;\n  scratch = null;\n  createSurface;\n  constructor(createSurface = offscreenSurface) {\n    this.createSurface = createSurface;\n  }\n  inputSurface(widthPx, heightPx) {\n    return this.input = this.fit(this.input, widthPx, heightPx, false);\n  }\n  outputSurface(widthPx, heightPx) {\n    return this.output = this.fit(this.output, widthPx, heightPx, true);\n  }\n  fit(surface, widthPx, heightPx, willReadFrequently) {\n    if (!surface) return this.createSurface(widthPx, heightPx, willReadFrequently);\n    if (surface.canvas.width !== widthPx || surface.canvas.height !== heightPx) {\n      surface.canvas.width = widthPx;\n      surface.canvas.height = heightPx;\n    }\n    return surface;\n  }\n  /** Contents are undefined; callers overwrite every byte. Small buffers are reused across frames. */\n  bytes(length) {\n    if (length > SCRATCH_CACHE_MAX_BYTES) return new Uint8ClampedArray(length);\n    if (!this.scratch || this.scratch.byteLength < length) this.scratch = new ArrayBuffer(length);\n    return new Uint8ClampedArray(this.scratch, 0, length);\n  }\n  dispose() {\n    for (const surface of [this.input, this.output])\n      if (surface) surface.canvas.width = surface.canvas.height = 0;\n    this.input = this.output = null;\n    this.scratch = null;\n  }\n};\n\n// packages/recognition/src/features/anms.ts\nvar ANMS_ROBUSTNESS = 0.9;\nvar ANMS_POOL_LIMIT = 1024;\nvar MAX_POOL_LIMIT = 4096;\nvar ANMS_SELECTION_ID = `anms-c${ANMS_ROBUSTNESS}-pool${ANMS_POOL_LIMIT}-per-level`;\nvar byStrength = (a, b) => b.score - a.score || a.y - b.y || a.x - b.x;\nfunction anmsRadiiSquared(sorted, robustness = ANMS_ROBUSTNESS) {\n  const n = sorted.length;\n  const radii = new Array(n);\n  let stronger = 0;\n  for (let i = 0; i < n; i++) {\n    while (stronger < i && sorted[i].score < robustness * sorted[stronger].score) stronger++;\n    let best = Infinity;\n    for (let j = 0; j < stronger; j++) {\n      const dx = sorted[j].x - sorted[i].x;\n      const dy = sorted[j].y - sorted[i].y;\n      const d = dx * dx + dy * dy;\n      if (d < best) best = d;\n    }\n    radii[i] = best;\n  }\n  return radii;\n}\nfunction selectAnms(candidates, count, { robustness = ANMS_ROBUSTNESS, poolLimit = ANMS_POOL_LIMIT } = {}) {\n  const invalid3 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });\n  if (!Array.isArray(candidates)) throw invalid3("INVALID_ANMS_CANDIDATES");\n  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > MAX_POOL_LIMIT || !(robustness > 0 && robustness < 1)) {\n    throw invalid3("INVALID_ANMS_OPTIONS");\n  }\n  for (const c of candidates) {\n    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.score) || c.score <= 0) {\n      throw invalid3("INVALID_ANMS_CANDIDATE");\n    }\n  }\n  if (!count || !candidates.length) return [];\n  const pool = candidates.slice().sort(byStrength).slice(0, poolLimit);\n  const radii = anmsRadiiSquared(pool, robustness);\n  return pool.map((candidate, rank) => ({ candidate, rank, radius: radii[rank] })).sort((a, b) => (a.radius === b.radius ? 0 : b.radius - a.radius) || a.rank - b.rank).slice(0, count).map((entry) => entry.candidate);\n}\n\n// packages/recognition/src/features/brief.ts\nfunction generatePattern() {\n  let seed = 2654435769;\n  const offset = () => {\n    seed ^= seed << 13;\n    seed ^= seed >>> 17;\n    seed ^= seed << 5;\n    return (seed >>> 0) % 17 - 8;\n  };\n  return Array.from({ length: 256 }, () => [offset(), offset(), offset(), offset()]);\n}\nvar BRIEF_PATTERN = generatePattern();\nfunction briefOffsetTable(widthPx) {\n  const table = new Int32Array(512);\n  for (let bit = 0; bit < 256; bit++) {\n    const p = BRIEF_PATTERN[bit];\n    table[2 * bit] = p[1] * widthPx + p[0];\n    table[2 * bit + 1] = p[3] * widthPx + p[2];\n  }\n  return table;\n}\nfunction describe(data, center, table) {\n  const descriptor = Array(32).fill(0);\n  for (let bit = 0, k = 0; bit < 256; bit++, k += 2) {\n    if (data[center + table[k]] < data[center + table[k + 1]])\n      descriptor[bit >> 3] |= 1 << (bit & 7);\n  }\n  return descriptor;\n}\n\n// packages/recognition/src/image/gray-image.ts\nvar RECOGNITION_LIMITS = Object.freeze({\n  /** Most pixels of one image. */\n  pixels: 4194304,\n  /** Longest image edge. */\n  dimension: 4096,\n  /** Most features per image (target or frame). */\n  features: 512,\n  /** Most pyramid levels. */\n  levels: 4,\n  /** Most loaded targets. */\n  targets: 10\n});\nfunction validateGray(image) {\n  const { widthPx, heightPx, data } = image ?? {};\n  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 32 || heightPx < 32 || widthPx > RECOGNITION_LIMITS.dimension || heightPx > RECOGNITION_LIMITS.dimension || widthPx * heightPx > RECOGNITION_LIMITS.pixels || !(data instanceof Uint8Array) || data.length !== widthPx * heightPx) {\n    throw new EngineError("INVALID_CONFIG", "INVALID_GRAY8", { isRecoverable: false });\n  }\n}\n\n// packages/recognition/src/features/harris.ts\nfunction createTensorRows(widthPx) {\n  return [new Int32Array(widthPx * 3), new Int32Array(widthPx * 3), new Int32Array(widthPx * 3)];\n}\nfunction harrisScores(data, w, h, scale, roi, scores, rows) {\n  let x0 = 10;\n  let x1 = w - 10;\n  let y0 = 10;\n  let y1 = h - 10;\n  if (roi) {\n    while (x0 < x1 && (x0 + 0.5) * scale - 0.5 < roi.x) x0++;\n    while (x1 > x0 && (x1 - 0.5) * scale - 0.5 >= roi.x + roi.width) x1--;\n    while (y0 < y1 && (y0 + 0.5) * scale - 0.5 < roi.y) y0++;\n    while (y1 > y0 && (y1 - 0.5) * scale - 0.5 >= roi.y + roi.height) y1--;\n  }\n  if (x0 >= x1 || y0 >= y1) return;\n  const [xxRows, yyRows, xyRows] = rows;\n  const row = (y) => {\n    const base = y * w;\n    const slot = y % 3 * w;\n    let i = base + x0 - 1;\n    let gx = data[i + 1] - data[i - 1];\n    let gy = data[i + w] - data[i - w];\n    let ax = gx * gx;\n    let ay = gy * gy;\n    let az = gx * gy;\n    i++;\n    gx = data[i + 1] - data[i - 1];\n    gy = data[i + w] - data[i - w];\n    let bx = gx * gx;\n    let by = gy * gy;\n    let bz = gx * gy;\n    for (let x = x0; x < x1; x++) {\n      i = base + x + 1;\n      gx = data[i + 1] - data[i - 1];\n      gy = data[i + w] - data[i - w];\n      const cx = gx * gx;\n      const cy = gy * gy;\n      const cz = gx * gy;\n      xxRows[slot + x] = ax + bx + cx;\n      yyRows[slot + x] = ay + by + cy;\n      xyRows[slot + x] = az + bz + cz;\n      ax = bx;\n      ay = by;\n      az = bz;\n      bx = cx;\n      by = cy;\n      bz = cz;\n    }\n  };\n  row(y0 - 1);\n  row(y0);\n  for (let y = y0; y < y1; y++) {\n    row(y + 1);\n    const a = (y - 1) % 3 * w;\n    const b = y % 3 * w;\n    const c = (y + 1) % 3 * w;\n    for (let x = x0; x < x1; x++) {\n      const xx = xxRows[a + x] + xxRows[b + x] + xxRows[c + x];\n      const yy = yyRows[a + x] + yyRows[b + x] + yyRows[c + x];\n      const xy = xyRows[a + x] + xyRows[b + x] + xyRows[c + x];\n      scores[y * w + x] = xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;\n    }\n  }\n}\nfunction detectCorners(data, w, h, scale, roi, rows) {\n  const scores = new Float64Array(w * h);\n  const candidates = [];\n  harrisScores(data, w, h, scale, roi, scores, rows);\n  for (let y = 10; y < h - 10; y++) {\n    for (let x = 10; x < w - 10; x++) {\n      const score = scores[y * w + x];\n      if (score < 1e6) continue;\n      let peak = true;\n      nms: for (let dy = -2; dy <= 2; dy++) {\n        for (let dx = -2; dx <= 2; dx++) {\n          if (!dx && !dy) continue;\n          const other = scores[(y + dy) * w + x + dx];\n          if (other > score || other === score && (dy < 0 || dy === 0 && dx < 0)) {\n            peak = false;\n            break nms;\n          }\n        }\n      }\n      if (peak) candidates.push({ x, y, score });\n    }\n  }\n  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);\n  return candidates;\n}\n\n// packages/recognition/src/features/pyramid.ts\nfunction buildPyramid(image, levels = 3) {\n  validateGray(image);\n  if (!Number.isInteger(levels) || levels < 1 || levels > RECOGNITION_LIMITS.levels) {\n    throw new EngineError("INVALID_CONFIG", "INVALID_LEVELS", { isRecoverable: false });\n  }\n  const result = [{ ...image, scale: 1 }];\n  while (result.length < levels) {\n    const prev = result.at(-1);\n    const widthPx = Math.floor(prev.widthPx / 2);\n    const heightPx = Math.floor(prev.heightPx / 2);\n    if (Math.min(widthPx, heightPx) < 32) break;\n    const data = new Uint8Array(widthPx * heightPx);\n    for (let y = 0; y < heightPx; y++) {\n      for (let x = 0; x < widthPx; x++) {\n        const i = 2 * y * prev.widthPx + 2 * x;\n        data[y * widthPx + x] = Math.round(\n          (prev.data[i] + prev.data[i + 1] + prev.data[i + prev.widthPx] + prev.data[i + prev.widthPx + 1]) / 4\n        );\n      }\n    }\n    result.push({ widthPx, heightPx, data, scale: prev.scale * 2 });\n  }\n  return result;\n}\nfunction smoothBox3(level) {\n  const { widthPx: w, heightPx: h, data } = level;\n  const out = new Uint8Array(data);\n  const rowSums = new Uint16Array(w * 3);\n  const fillRow = (y) => {\n    const base = y * w;\n    const slot = y % 3 * w;\n    let a = data[base];\n    let b = data[base + 1];\n    for (let x = 1; x < w - 1; x++) {\n      const c = data[base + x + 1];\n      rowSums[slot + x] = a + b + c;\n      a = b;\n      b = c;\n    }\n  };\n  fillRow(0);\n  fillRow(1);\n  for (let y = 1; y < h - 1; y++) {\n    fillRow(y + 1);\n    const r0 = (y - 1) % 3 * w;\n    const r1 = y % 3 * w;\n    const r2 = (y + 1) % 3 * w;\n    const base = y * w;\n    for (let x = 1; x < w - 1; x++) {\n      const sum = rowSums[r0 + x] + rowSums[r1 + x] + rowSums[r2 + x];\n      out[base + x] = Math.round(sum / 9);\n    }\n  }\n  return out;\n}\n\n// packages/recognition/src/features/extract.ts\nfunction checkOptions(image, maxFeatures, roi) {\n  const invalid3 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });\n  if (!Number.isInteger(maxFeatures) || maxFeatures < 16 || maxFeatures > RECOGNITION_LIMITS.features) {\n    throw invalid3("INVALID_FEATURE_LIMIT");\n  }\n  if (roi && (!["x", "y", "width", "height"].every((k) => Number.isFinite(roi[k])) || roi.width <= 0 || roi.height <= 0 || roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.widthPx || roi.y + roi.height > image.heightPx)) {\n    throw invalid3("INVALID_ROI");\n  }\n}\nfunction extractFeatures(image, options) {\n  const { maxFeatures, levels } = options;\n  const roi = options.roi ?? null;\n  validateGray(image);\n  checkOptions(image, maxFeatures, roi);\n  const layers = buildPyramid(image, levels);\n  const features = [];\n  const rows = createTensorRows(image.widthPx);\n  for (let level = 0; level < layers.length; level++) {\n    const layer = layers[level];\n    const { widthPx: w, heightPx: h, scale } = layer;\n    const data = smoothBox3(layer);\n    const candidates = detectCorners(data, w, h, scale, roi, rows);\n    const quota = Math.floor(maxFeatures / layers.length) + (level < maxFeatures % layers.length ? 1 : 0);\n    const table = briefOffsetTable(w);\n    let selectedCount = 0;\n    for (const point of selectAnms(candidates, quota)) {\n      const descriptor = describe(data, point.y * w + point.x, table);\n      selectedCount++;\n      features.push({\n        x: (point.x + 0.5) * scale - 0.5,\n        y: (point.y + 0.5) * scale - 0.5,\n        level,\n        score: point.score,\n        descriptor\n      });\n      if (selectedCount >= quota) break;\n    }\n  }\n  return {\n    features,\n    pyramid: layers.map(({ widthPx, heightPx, scale }) => ({ widthPx, heightPx, scale }))\n  };\n}\n\n// packages/recognition/src/geometry/homography.ts\nfunction project(h, [x, y]) {\n  const z = h[6] * x + h[7] * y + h[8];\n  return Math.abs(z) < 1e-10 ? [Infinity, Infinity] : [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];\n}\nfunction multiply(a, b) {\n  return Array.from(\n    { length: 9 },\n    (_, i) => [0, 1, 2].reduce((s, k) => s + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + i % 3], 0)\n  );\n}\nfunction normalize(points) {\n  const cx = points.reduce((s2, p) => s2 + p[0], 0) / points.length;\n  const cy = points.reduce((s2, p) => s2 + p[1], 0) / points.length;\n  const radius = Math.sqrt(\n    points.reduce((s2, p) => s2 + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / points.length\n  );\n  if (radius < 1e-8) return null;\n  const s = Math.SQRT2 / radius;\n  return {\n    points: points.map(([x, y]) => [(x - cx) * s, (y - cy) * s]),\n    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],\n    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1]\n  };\n}\nfunction solve(a, b) {\n  const m = a.map((row, i) => [...row, b[i]]);\n  const n = b.length;\n  for (let i = 0; i < n; i++) {\n    let pivot = i;\n    for (let j = i + 1; j < n; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;\n    if (Math.abs(m[pivot][i]) < 1e-9) return null;\n    [m[i], m[pivot]] = [m[pivot], m[i]];\n    const divisor = m[i][i];\n    for (let k = i; k <= n; k++) m[i][k] /= divisor;\n    for (let j = 0; j < n; j++) {\n      if (j !== i) {\n        const f = m[j][i];\n        for (let k = i; k <= n; k++) m[j][k] -= f * m[i][k];\n      }\n    }\n  }\n  return m.map((row) => row[n]);\n}\nfunction fitHomography(pairs) {\n  if (pairs.length < 4) return null;\n  const a = normalize(pairs.map((p) => p.target));\n  const b = normalize(pairs.map((p) => p.image));\n  if (!a || !b) return null;\n  const ata = Array.from({ length: 8 }, () => Array(8).fill(0));\n  const atb = Array(8).fill(0);\n  for (let i = 0; i < pairs.length; i++) {\n    const [x, y] = a.points[i];\n    const [u, v] = b.points[i];\n    for (const [row, rhs] of [\n      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],\n      [[0, 0, 0, x, y, 1, -v * x, -v * y], v]\n    ]) {\n      for (let j = 0; j < 8; j++) {\n        atb[j] += row[j] * rhs;\n        for (let k = 0; k < 8; k++) ata[j][k] += row[j] * row[k];\n      }\n    }\n  }\n  const h = solve(ata, atb);\n  if (!h) return null;\n  const denormalized = multiply(multiply(b.inv, [...h, 1]), a.t);\n  const z = denormalized[8];\n  if (Math.abs(z) < 1e-10) return null;\n  const result = denormalized.map((v) => v / z);\n  return result.every(Number.isFinite) ? result : null;\n}\nvar cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);\nfunction hullArea(points) {\n  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);\n  if (sorted.length < 3) return 0;\n  const half = (values) => {\n    const h = [];\n    for (const p of values) {\n      while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop();\n      h.push(p);\n    }\n    return h.slice(0, -1);\n  };\n  const hull = [...half(sorted), ...half([...sorted].reverse())];\n  return Math.abs(\n    hull.reduce((s, p, i) => {\n      const q = hull[(i + 1) % hull.length];\n      return s + p[0] * q[1] - p[1] * q[0];\n    }, 0)\n  ) / 2;\n}\nfunction validateHomography(h, width, height) {\n  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return false;\n  const det = h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);\n  if (Math.abs(det) < 1e-10) return false;\n  const corners = [\n    [0, 0],\n    [width - 1, 0],\n    [width - 1, height - 1],\n    [0, height - 1]\n  ];\n  const denominators = corners.map(([x, y]) => h[6] * x + h[7] * y + h[8]);\n  if (!(denominators.every((v) => v > 1e-7) || denominators.every((v) => v < -1e-7))) return false;\n  const projected = corners.map((p) => project(h, p));\n  return projected.every((p) => p.every(Number.isFinite)) && projected.every((p, i) => cross(p, projected[(i + 1) % 4], projected[(i + 2) % 4]) > 1e-6);\n}\n\n// packages/recognition/src/geometry/ransac.ts\nfunction checkInput(pairs, width, height, options) {\n  const { iterations, threshold, minInliers, minCoverage } = options;\n  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 4096 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 20 || !Number.isInteger(minInliers) || minInliers < 4 || !Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {\n    throw new EngineError("INVALID_CONFIG", "INVALID_GEOMETRY_OPTIONS", { isRecoverable: false });\n  }\n  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || pairs.length > 512 || pairs.some(\n    (p) => ![p.target, p.image].every(\n      (q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)\n    )\n  )) {\n    throw new EngineError("FRAME_FAILED", "INVALID_PAIRS", { isRecoverable: false });\n  }\n}\nfunction verifyGeometry(pairs, width, height, options = {}) {\n  const { iterations = 256, threshold = 3, minInliers = 12, minCoverage = 0.08 } = options;\n  let seed = options.seed ?? 12345;\n  checkInput(pairs, width, height, { iterations, threshold, minInliers, minCoverage });\n  const reject2 = (reason) => ({\n    accepted: false,\n    reason,\n    H: null,\n    pairs,\n    inlierMask: pairs.map(() => false)\n  });\n  if (pairs.length < minInliers) return reject2("INSUFFICIENT_MATCHES");\n  const errors = (h) => pairs.map((p) => {\n    const q = project(h, p.target);\n    return Math.hypot(q[0] - p.image[0], q[1] - p.image[1]);\n  });\n  let best = [];\n  let bestError = Infinity;\n  const random = () => {\n    seed ^= seed << 13;\n    seed ^= seed >>> 17;\n    seed ^= seed << 5;\n    return seed >>> 0;\n  };\n  if (!(seed >>> 0)) seed = 12345;\n  for (let iteration = 0; iteration < iterations; iteration++) {\n    const indices = /* @__PURE__ */ new Set();\n    while (indices.size < 4) indices.add(random() % pairs.length);\n    const h = fitHomography([...indices].map((i) => pairs[i]));\n    if (!validateHomography(h, width, height)) continue;\n    const e = errors(h);\n    const indicesIn = e.flatMap((v, i) => v <= threshold ? [i] : []);\n    const total = indicesIn.reduce((s, i) => s + e[i] ** 2, 0);\n    if (indicesIn.length > best.length || indicesIn.length === best.length && total < bestError) {\n      best = indicesIn;\n      bestError = total;\n    }\n  }\n  if (best.length < minInliers) return reject2("NO_ROBUST_MODEL");\n  return refine(pairs, best, width, height, threshold, minInliers, minCoverage, errors, reject2);\n}\nfunction refine(pairs, best, width, height, threshold, minInliers, minCoverage, errors, reject2) {\n  let h = fitHomography(best.map((i) => pairs[i]));\n  if (!validateHomography(h, width, height)) return reject2("DEGENERATE_MODEL");\n  let e = errors(h);\n  let mask = e.map((v) => v <= threshold);\n  h = fitHomography(pairs.filter((_, i) => mask[i]));\n  if (!validateHomography(h, width, height)) return reject2("DEGENERATE_REFINEMENT");\n  e = errors(h);\n  mask = e.map((v) => v <= threshold);\n  const selected = pairs.filter((_, i) => mask[i]);\n  const inlierCount2 = selected.length;\n  const ratio = inlierCount2 / pairs.length;\n  const coverage = hullArea(selected.map((p) => p.target)) / ((width - 1) * (height - 1));\n  if (inlierCount2 < minInliers || ratio < 0.35) return reject2("LOW_INLIER_SUPPORT");\n  if (coverage < minCoverage) return reject2("LOW_SPATIAL_COVERAGE");\n  const inlierErrors = e.filter((_, i) => mask[i]);\n  return {\n    accepted: true,\n    reason: "GEOMETRY_VERIFIED",\n    H: h,\n    pairs,\n    inlierMask: mask,\n    inlierCount: inlierCount2,\n    inlierRatio: ratio,\n    coverage,\n    rmsErrorPx: Math.sqrt(inlierErrors.reduce((s, v) => s + v * v, 0) / inlierCount2),\n    maxErrorPx: Math.max(...inlierErrors)\n  };\n}\n\n// packages/recognition/src/matching/packed-matcher.ts\nfunction packDescriptors(features) {\n  const packed = new Uint32Array(features.length * 8);\n  for (let i = 0; i < features.length; i++) {\n    for (let k = 0; k < 8; k++) {\n      const d = features[i].descriptor;\n      const j = k * 4;\n      packed[i * 8 + k] = (d[j] | d[j + 1] << 8 | d[j + 2] << 16 | d[j + 3] << 24) >>> 0;\n    }\n  }\n  return packed;\n}\nfunction popcount2(v) {\n  v = v - (v >>> 1 & 1431655765);\n  v = (v & 858993459) + (v >>> 2 & 858993459);\n  return (v + (v >>> 4) & 252645135) * 16843009 >>> 24;\n}\nfunction packedDistance(a, ai, b, bi) {\n  let d = 0;\n  for (let k = 0; k < 8; k++) d += popcount2(a[ai * 8 + k] ^ b[bi * 8 + k]);\n  return d;\n}\nfunction nibbles(x) {\n  x = x - (x >>> 1 & 1431655765) | 0;\n  return (x & 858993459) + (x >>> 2 & 858993459) | 0;\n}\nfunction byteLanes(v) {\n  return (v & 252645135) + (v >>> 4 & 252645135) | 0;\n}\nvar isWords = (a, n) => (a instanceof Uint32Array || a instanceof Int32Array) && a.length >= n;\nfunction pairAt(target, frame, i, index, distance) {\n  return {\n    target: [target[i].x, target[i].y],\n    image: [frame[index].x, frame[index].y],\n    distance\n  };\n}\nfunction matchWords(target, frame, tp, fp, nt, nf) {\n  const reverse = new Int32Array(nf).fill(-1);\n  const rd = new Uint16Array(nf).fill(257);\n  const bests = new Uint16Array(nt);\n  const seconds = new Uint16Array(nt);\n  const indices = new Int32Array(nt);\n  for (let i = 0; i < nt; i++) {\n    const o = i * 8;\n    const t0 = tp[o] | 0;\n    const t1 = tp[o + 1] | 0;\n    const t2 = tp[o + 2] | 0;\n    const t3 = tp[o + 3] | 0;\n    const t4 = tp[o + 4] | 0;\n    const t5 = tp[o + 5] | 0;\n    const t6 = tp[o + 6] | 0;\n    const t7 = tp[o + 7] | 0;\n    let best = 257;\n    let second = 257;\n    let index = -1;\n    for (let j = 0, p = 0; j < nf; j++, p += 8) {\n      const a = nibbles(t0 ^ fp[p]) + nibbles(t1 ^ fp[p + 1]);\n      const b = nibbles(t2 ^ fp[p + 2]) + nibbles(t3 ^ fp[p + 3]);\n      const c = nibbles(t4 ^ fp[p + 4]) + nibbles(t5 ^ fp[p + 5]);\n      const e = nibbles(t6 ^ fp[p + 6]) + nibbles(t7 ^ fp[p + 7]);\n      let s = byteLanes(a) + byteLanes(b) + byteLanes(c) + byteLanes(e) | 0;\n      s = (s & 16711935) + (s >>> 8 & 16711935) | 0;\n      const d = (s & 65535) + (s >>> 16);\n      if (d < best) {\n        second = best;\n        best = d;\n        index = j;\n      } else if (d < second) second = d;\n      const r = rd[j];\n      if (d < r) {\n        rd[j] = d;\n        reverse[j] = i;\n      } else if (d === r) reverse[j] = -1;\n    }\n    bests[i] = best;\n    seconds[i] = second;\n    indices[i] = index;\n  }\n  const out = [];\n  for (let i = 0; i < nt; i++) {\n    const index = indices[i];\n    const best = bests[i];\n    if (index >= 0 && best <= 64 && 4 * best < 3 * seconds[i] && reverse[index] === i) {\n      out.push(pairAt(target, frame, i, index, best));\n    }\n  }\n  return out;\n}\nfunction matchGeneric(target, frame, tp, fp) {\n  const reverse = new Int32Array(frame.length).fill(-1);\n  const rd = new Uint16Array(frame.length).fill(257);\n  const nearest = [];\n  for (let i = 0; i < target.length; i++) {\n    let best = 257;\n    let second = 257;\n    let index = -1;\n    for (let j = 0; j < frame.length; j++) {\n      const d = packedDistance(tp, i, fp, j);\n      if (d < best) {\n        second = best;\n        best = d;\n        index = j;\n      } else if (d < second) second = d;\n      if (d < rd[j]) {\n        rd[j] = d;\n        reverse[j] = i;\n      } else if (d === rd[j]) reverse[j] = -1;\n    }\n    nearest.push({ best, second, index });\n  }\n  return nearest.flatMap(\n    ({ best, second, index }, i) => index >= 0 && best <= 64 && 4 * best < 3 * second && reverse[index] === i ? [pairAt(target, frame, i, index, best)] : []\n  );\n}\nfunction matchPacked(target, frame, tp = packDescriptors(target), fp = packDescriptors(frame)) {\n  const nt = target.length;\n  const nf = frame.length;\n  if (Number.isInteger(nt) && Number.isInteger(nf) && nt >= 0 && nf >= 0 && isWords(tp, nt * 8) && isWords(fp, nf * 8)) {\n    return matchWords(\n      target,\n      frame,\n      tp,\n      fp,\n      nt,\n      nf\n    );\n  }\n  return matchGeneric(target, frame, tp, fp);\n}\nvar BIT_COUNTS = Uint8Array.from({ length: 256 }, (_, value) => {\n  let n = 0;\n  while (value) {\n    value &= value - 1;\n    n++;\n  }\n  return n;\n});\nfunction hamming(a, b) {\n  let n = 0;\n  for (let i = 0; i < 32; i++) n += BIT_COUNTS[a[i] ^ b[i]];\n  return n;\n}\n\n// packages/recognition/src/scale/intermediate-scale.ts\nvar INTERMEDIATE_SCALE = Math.SQRT1_2;\nfunction intermediateScaleImage(image) {\n  validateGray(image);\n  const scale = INTERMEDIATE_SCALE;\n  const widthPx = Math.floor(image.widthPx * scale);\n  const heightPx = Math.floor(image.heightPx * scale);\n  if (widthPx < 32 || heightPx < 32) return null;\n  const source = image.data;\n  const data = new Uint8Array(widthPx * heightPx);\n  for (let y = 0; y < heightPx; y++) {\n    for (let x = 0; x < widthPx; x++) {\n      const sx = (x + 0.5) / scale - 0.5;\n      const sy = (y + 0.5) / scale - 0.5;\n      const ix = Math.floor(sx);\n      const iy = Math.floor(sy);\n      const fx = sx - ix;\n      const fy = sy - iy;\n      const i = iy * image.widthPx + ix;\n      data[y * widthPx + x] = Math.round(\n        (1 - fy) * ((1 - fx) * source[i] + fx * source[i + 1]) + fy * ((1 - fx) * source[i + image.widthPx] + fx * source[i + image.widthPx + 1])\n      );\n    }\n  }\n  return { widthPx, heightPx, data };\n}\n\n// packages/recognition/src/targets/target-validation.ts\nvar ALGORITHM_VERSION = "m0-harris-anms-brief256-v1";\nvar COMPILER_VERSION = "webar-gray8-cpu/0.3.0";\nvar TARGET_MAX_FEATURES = 384;\nvar TARGET_LEVELS = 3;\nvar RETIRED_ALGORITHMS = ["m0-harris-brief256-v1", "c-oriented-brief256-v2"];\nfunction preprocessingRecord(levels, maxFeatures) {\n  return {\n    pixelFormat: "gray8",\n    levels,\n    maxFeatures,\n    downsample: "box2-center",\n    smoothing: "box3",\n    orientation: "upright-only",\n    selection: ANMS_SELECTION_ID\n  };\n}\nvar invalid = (message) => {\n  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });\n};\nasync function sha256Hex(bytes) {\n  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));\n  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");\n}\nfunction diagnoseFeatures(features, widthPx, heightPx) {\n  const diagnostics = [];\n  const add = (code, message) => {\n    diagnostics.push({ code, message, severity: "error" });\n  };\n  if (features.length < 24)\n    add("LOW_TEXTURE", `Only ${features.length} features; require at least 24 for this baseline.`);\n  if (hullArea(features.map((f) => [f.x, f.y])) / (widthPx * heightPx) < 0.15) {\n    add("LOW_COVERAGE", "Features cover less than 15 percent of target area.");\n  }\n  const repeated = features.filter(\n    (f, i) => features.some((g, j) => i !== j && hamming(f.descriptor, g.descriptor) <= 16)\n  ).length;\n  if (features.length && repeated / features.length > 0.35) {\n    add("REPETITIVE_TEXTURE", "More than 35 percent of descriptors have a near duplicate.");\n  }\n  return diagnostics;\n}\nfunction featuresFromTarget(target) {\n  return target.features.points.map(([x, y], i) => ({\n    x,\n    y,\n    level: 0,\n    score: 1,\n    descriptor: target.features.descriptors.slice(i * 32, (i + 1) * 32)\n  }));\n}\nfunction preflightTarget(value) {\n  const candidate = value;\n  if (!candidate || !Array.isArray(candidate.features?.points) || candidate.features.points.length > RECOGNITION_LIMITS.features || !Array.isArray(candidate.features?.descriptors) || candidate.features.descriptors.length > RECOGNITION_LIMITS.features * 32 || !Array.isArray(candidate.pyramid) || candidate.pyramid.length > 8 || candidate.pyramid.some(\n    (l) => !Array.isArray(l?.pixels) || l.pixels.length > RECOGNITION_LIMITS.pixels\n  )) {\n    invalid("Target exceeds CPU baseline bounds");\n  }\n  validateTargetBundle(value);\n  const t = value;\n  if (RETIRED_ALGORITHMS.includes(t.algorithmVersion)) {\n    invalid(\n      `Target was compiled with ${t.algorithmVersion}; recompile it with ${ALGORITHM_VERSION}`\n    );\n  }\n  if (t.algorithmVersion !== ALGORITHM_VERSION || t.compilerVersion !== COMPILER_VERSION || t.features.descriptorType !== t.algorithmVersion || t.features.descriptorLength !== 32 || t.imageHashDomain !== "canonical-gray8" || t.widthPx < 32 || t.heightPx < 32 || t.widthPx > RECOGNITION_LIMITS.dimension || t.heightPx > RECOGNITION_LIMITS.dimension || t.widthPx * t.heightPx > RECOGNITION_LIMITS.pixels || t.features.points.length > RECOGNITION_LIMITS.features || t.pyramid.length < 1 || t.pyramid.length > RECOGNITION_LIMITS.levels || !t.features.descriptors.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) || !t.features.points.every(([x, y]) => x >= 0 && y >= 0 && x < t.widthPx && y < t.heightPx)) {\n    invalid("Unsupported algorithm, dimensions or feature data");\n  }\n}\nasync function validateTarget(value) {\n  preflightTarget(value);\n  const t = value;\n  const p = t.preprocessing;\n  if (p.pixelFormat !== "gray8" || p.downsample !== "box2-center" || p.smoothing !== "box3" || p.orientation !== "upright-only" || typeof p.levels !== "number" || !Number.isInteger(p.levels) || p.levels < 1 || p.levels > RECOGNITION_LIMITS.levels || typeof p.maxFeatures !== "number" || !Number.isInteger(p.maxFeatures) || p.maxFeatures < 16 || p.maxFeatures > RECOGNITION_LIMITS.features || t.features.points.length > p.maxFeatures || p.selection !== ANMS_SELECTION_ID) {\n    invalid("Unsupported preprocessing");\n  }\n  const base = t.pyramid[0];\n  if (base.width !== t.widthPx || base.height !== t.heightPx || base.scale !== 1)\n    invalid("Invalid pyramid base");\n  const expected = buildPyramid(\n    { widthPx: base.width, heightPx: base.height, data: new Uint8Array(base.pixels) },\n    p.levels\n  );\n  if (expected.length !== t.pyramid.length || expected.some((l, i) => {\n    const level = t.pyramid[i];\n    return l.widthPx !== level.width || l.heightPx !== level.height || l.scale !== level.scale || !l.data.every((v, j) => v === level.pixels[j]);\n  })) {\n    invalid("Inconsistent pyramid");\n  }\n  if (await sha256Hex(new Uint8Array(base.pixels)) !== t.imageHash)\n    invalid("Canonical gray8 hash mismatch");\n  return t;\n}\n\n// packages/recognition/src/recognizer.ts\nvar FRAME_MAX_FEATURES = 512;\nvar FRAME_LEVELS = 3;\nfunction throwIfAborted2(signal) {\n  if (signal?.aborted)\n    throw new EngineError("ABORTED", "Recognition cancelled", { isRecoverable: true });\n}\nfunction passFacts(batch, scale, prepareMs) {\n  const d = batch.facts;\n  return {\n    scale,\n    prepareMs,\n    featureMs: d.featureMs,\n    retrievalMs: d.retrievalMs,\n    matchMs: d.matchMs,\n    geometryMs: d.geometryMs,\n    totalMs: d.totalMs,\n    featureCount: d.featureCount,\n    candidateCount: d.candidateCount,\n    observationCount: batch.observations.length,\n    isAmbiguous: batch.isAmbiguous,\n    isBudgetExhausted: d.isBudgetExhausted,\n    rejected: batch.rejected.map((r) => ({ targetId: r.targetId, reason: r.reason }))\n  };\n}\nvar inlierCount = (o) => o.inliers.filter(Boolean).length;\nvar Recognizer = class {\n  #targets = [];\n  #disposed = false;\n  #generation = 0;\n  #cache = [];\n  #isPending = false;\n  #exactMatcher;\n  #scaleRetry;\n  #capturePasses;\n  constructor(options = {}) {\n    if (options.scaleRetry !== void 0 && typeof options.scaleRetry !== "boolean") {\n      throw new EngineError("INVALID_CONFIG", "scaleRetry must be a boolean", {\n        isRecoverable: false\n      });\n    }\n    if (options.capturePasses !== void 0 && typeof options.capturePasses !== "boolean") {\n      throw new EngineError("INVALID_CONFIG", "capturePasses must be a boolean", {\n        isRecoverable: false\n      });\n    }\n    this.#exactMatcher = options.exactMatcher;\n    this.#scaleRetry = options.scaleRetry ?? true;\n    this.#capturePasses = options.capturePasses === true;\n  }\n  /** Validates and snapshots the targets (1..10, unique ids), then replaces the loaded set. */\n  async loadTargets(targets) {\n    this.#alive();\n    if (this.#isPending) {\n      throw new EngineError("INVALID_CONFIG", "Cannot replace targets during recognition", {\n        isRecoverable: true\n      });\n    }\n    if (!targets.length || targets.length > RECOGNITION_LIMITS.targets || new Set(targets.map((t) => t.targetId)).size !== targets.length) {\n      throw new EngineError("INVALID_TARGET", "Require 1 to 10 unique targets", {\n        isRecoverable: false\n      });\n    }\n    const generation = ++this.#generation;\n    const next = [];\n    targets.forEach(preflightTarget);\n    for (const copy of structuredClone(targets)) {\n      await validateTarget(copy);\n      next.push(copy);\n    }\n    this.#alive();\n    if (generation !== this.#generation) {\n      throw new EngineError("ABORTED", "Target load superseded", { isRecoverable: true });\n    }\n    this.#targets = next;\n    this.#cache = next.map((t) => {\n      const features = featuresFromTarget(t);\n      return {\n        features,\n        packed: packDescriptors(features),\n        bytes: new Uint8Array(t.features.descriptors),\n        diagnostics: diagnoseFeatures(features, t.widthPx, t.heightPx)\n      };\n    });\n  }\n  #alive() {\n    if (this.#disposed)\n      throw new EngineError("DISPOSED", "Recognizer disposed", { isRecoverable: false });\n  }\n  /** Recognizes the loaded targets in one standard gray image; retries a global miss once at a half-octave scale. */\n  async recognize(image, identity, options = {}) {\n    this.#alive();\n    throwIfAborted2(options.signal);\n    if (this.#isPending) {\n      throw new EngineError("INVALID_CONFIG", "Only one recognition job may be in flight", {\n        isRecoverable: true\n      });\n    }\n    this.#isPending = true;\n    try {\n      const start = performance.now();\n      const primary = await this.#recognizeOnce(image, identity, options);\n      const first = this.#capturePasses ? passFacts(primary, 1, 0) : null;\n      if (first) primary.facts.passes = [first];\n      if (!this.#scaleRetry || options.roi || primary.observations.length || primary.isAmbiguous)\n        return primary;\n      throwIfAborted2(options.signal);\n      this.#alive();\n      const resampleStart = performance.now();\n      const scaled = intermediateScaleImage(image);\n      if (!scaled) return primary;\n      const resampleMs = performance.now() - resampleStart;\n      const secondary = await this.#recognizeOnce(scaled, identity, options, INTERMEDIATE_SCALE);\n      const second = first ? passFacts(secondary, INTERMEDIATE_SCALE, resampleMs) : null;\n      for (const key of [\n        "featureMs",\n        "retrievalMs",\n        "matchMs",\n        "geometryMs",\n        "fineComparisons"\n      ]) {\n        secondary.facts[key] += primary.facts[key];\n      }\n      secondary.facts.featureMs += resampleMs;\n      secondary.facts.totalMs = performance.now() - start;\n      secondary.facts.scalePasses = 2;\n      if (first && second) secondary.facts.passes = [first, second];\n      return secondary;\n    } finally {\n      this.#isPending = false;\n    }\n  }\n  async #recognizeOnce(image, identity, options, featureImageScale = 1) {\n    if (!this.#targets.length)\n      throw new EngineError("INVALID_TARGET", "No targets loaded", { isRecoverable: false });\n    if (!identity.sessionId || !Number.isSafeInteger(identity.frameId) || identity.frameId < 0) {\n      throw new EngineError("FRAME_FAILED", "Invalid frame identity", { isRecoverable: false });\n    }\n    const start = performance.now();\n    const algorithmVersion = this.#targets[0].algorithmVersion;\n    const { features } = extractFeatures(image, {\n      maxFeatures: FRAME_MAX_FEATURES,\n      levels: FRAME_LEVELS,\n      roi: options.roi ?? null\n    });\n    if (featureImageScale !== 1) {\n      for (const f of features) {\n        f.x = (f.x + 0.5) / featureImageScale - 0.5;\n        f.y = (f.y + 0.5) / featureImageScale - 0.5;\n      }\n    }\n    const featureMs = performance.now() - start;\n    const retrievalStart = performance.now();\n    const indices = this.#targets.map((_, i) => i);\n    const packed = packDescriptors(features);\n    const facts = {\n      algorithmVersion,\n      matchingBackend: "cpu",\n      scalePasses: 1,\n      featureMs,\n      retrievalMs: performance.now() - retrievalStart,\n      matchMs: 0,\n      geometryMs: 0,\n      totalMs: 0,\n      featureCount: features.length,\n      candidateCount: indices.length,\n      isBudgetExhausted: false,\n      fineComparisons: 0\n    };\n    const accelerated = await this.#matchExactly(indices, features, facts, options.signal);\n    const observations = [];\n    const rejected = [];\n    for (const index of indices) {\n      throwIfAborted2(options.signal);\n      const outcome = this.#verifyTarget(index, features, packed, accelerated, identity, facts);\n      if ("reason" in outcome) rejected.push(outcome);\n      else observations.push(outcome);\n    }\n    observations.sort(\n      (a, b) => inlierCount(b) - inlierCount(a) || a.reprojectionErrorPx - b.reprojectionErrorPx\n    );\n    const isAmbiguous = observations.length > 1 && inlierCount(observations[1]) >= inlierCount(observations[0]) * 0.85;\n    throwIfAborted2(options.signal);\n    if (isAmbiguous)\n      for (const o of observations)\n        rejected.push({ targetId: o.targetId, reason: "AMBIGUOUS_TARGETS" });\n    facts.totalMs = performance.now() - start;\n    return { observations: isAmbiguous ? [] : observations, isAmbiguous, rejected, facts };\n  }\n  /** Exact matching by the injected matcher for every usable target, or null when the built-in matcher must run. */\n  async #matchExactly(indices, features, facts, signal) {\n    const matcher = this.#exactMatcher;\n    if (!matcher || !indices.length) return null;\n    const requested = indices.filter((i) => !this.#cache[i].diagnostics.length).map((i) => ({ targetId: this.#targets[i].targetId, descriptors: this.#cache[i].bytes }));\n    if (!requested.length) return null;\n    const matchStart = performance.now();\n    const generation = this.#generation;\n    const output = await matcher(\n      requested,\n      new Uint8Array(features.flatMap((f) => f.descriptor)),\n      signal\n    );\n    throwIfAborted2(signal);\n    this.#alive();\n    if (generation !== this.#generation) {\n      throw new EngineError("ABORTED", "Recognition generation changed", { isRecoverable: true });\n    }\n    if (output === null) return null;\n    if (!["cpu", "wasm"].includes(output.backend) || output.matches.length !== requested.length || new Set(output.matches.map((m) => m.targetId)).size !== requested.length || output.matches.some((m) => !requested.some((r) => r.targetId === m.targetId))) {\n      throw new EngineError("FRAME_FAILED", "Invalid exact matching batch", {\n        isRecoverable: false\n      });\n    }\n    facts.matchingBackend = output.backend;\n    facts.matchMs = performance.now() - matchStart;\n    return new Map(output.matches.map((m) => [m.targetId, m.pairs]));\n  }\n  /** Matches and verifies one target; returns its observation or its rejection. */\n  #verifyTarget(index, features, packed, accelerated, identity, facts) {\n    const target = this.#targets[index];\n    const cached = this.#cache[index];\n    const targetFeatures = cached.features;\n    if (cached.diagnostics.length) {\n      return { targetId: target.targetId, reason: cached.diagnostics.map((d) => d.code).join(",") };\n    }\n    const matchStart = performance.now();\n    const external = accelerated?.get(target.targetId);\n    if (external && (!Array.isArray(external) || external.length > Math.min(targetFeatures.length, features.length) || new Set(external.map((p) => p.targetIndex)).size !== external.length || new Set(external.map((p) => p.frameIndex)).size !== external.length || external.some(\n      (p) => !Number.isInteger(p.targetIndex) || p.targetIndex < 0 || p.targetIndex >= targetFeatures.length || !Number.isInteger(p.frameIndex) || p.frameIndex < 0 || p.frameIndex >= features.length || !Number.isInteger(p.distance) || p.distance < 0 || p.distance > 64\n    ))) {\n      throw new EngineError("FRAME_FAILED", "Invalid exact match indices", {\n        isRecoverable: false\n      });\n    }\n    const pairs = external ? external.map((p) => ({\n      target: [targetFeatures[p.targetIndex].x, targetFeatures[p.targetIndex].y],\n      image: [features[p.frameIndex].x, features[p.frameIndex].y],\n      distance: p.distance\n    })) : matchPacked(targetFeatures, features, cached.packed, packed);\n    facts.matchMs += performance.now() - matchStart;\n    facts.fineComparisons += targetFeatures.length * features.length;\n    const geometryStart = performance.now();\n    const result = verifyGeometry(pairs, target.widthPx, target.heightPx);\n    facts.geometryMs += performance.now() - geometryStart;\n    if (!result.accepted || !validateHomography(result.H, target.widthPx + 1, target.heightPx + 1)) {\n      return {\n        targetId: target.targetId,\n        reason: result.accepted ? "INVALID_BOUNDARY" : result.reason\n      };\n    }\n    return {\n      sessionId: identity.sessionId,\n      frameId: identity.frameId,\n      targetId: target.targetId,\n      algorithmVersion: target.algorithmVersion,\n      H_imageFromTarget: normalizeHomography(result.H),\n      targetPoints: pairs.map((p) => p.target),\n      imagePoints: pairs.map((p) => p.image),\n      inliers: result.inlierMask,\n      reprojectionErrorPx: result.rmsErrorPx,\n      spatialCoverage: hullArea(pairs.filter((_, i) => result.inlierMask[i]).map((p) => p.target)) / (target.widthPx * target.heightPx)\n    };\n  }\n  dispose() {\n    this.#disposed = true;\n    this.#generation++;\n    this.#targets = [];\n    this.#cache = [];\n  }\n};\n\n// packages/recognition/src/trace.ts\nvar MAX_TRACE_REJECTIONS = 32;\nvar MAX_TRACE_TEXT = 64;\nvar MAX_TRACE_PASSES = 2;\nvar boundRejections = (rejected) => rejected.slice(0, MAX_TRACE_REJECTIONS).map((r) => ({ targetId: r.targetId, reason: r.reason.slice(0, MAX_TRACE_TEXT) }));\nfunction traceOf(batch, frame) {\n  const d = batch.facts;\n  const optional = d.passes ? {\n    stageMs: {\n      featureMs: d.featureMs,\n      retrievalMs: d.retrievalMs,\n      matchMs: d.matchMs,\n      geometryMs: d.geometryMs,\n      totalMs: d.totalMs\n    },\n    passes: d.passes.slice(0, MAX_TRACE_PASSES).map((p) => ({\n      scale: p.scale,\n      prepareMs: p.prepareMs,\n      featureMs: p.featureMs,\n      retrievalMs: p.retrievalMs,\n      matchMs: p.matchMs,\n      geometryMs: p.geometryMs,\n      totalMs: p.totalMs,\n      featureCount: p.featureCount,\n      candidateCount: p.candidateCount,\n      observationCount: p.observationCount,\n      isAmbiguous: p.isAmbiguous,\n      isBudgetExhausted: p.isBudgetExhausted,\n      rejected: boundRejections(p.rejected)\n    }))\n  } : {};\n  return {\n    sessionId: frame.sessionId,\n    frameId: frame.frameId,\n    algorithmVersion: d.algorithmVersion,\n    featureCount: d.featureCount,\n    candidateCount: d.candidateCount,\n    scalePasses: d.scalePasses,\n    observationCount: batch.observations.length,\n    isAmbiguous: batch.isAmbiguous,\n    isBudgetExhausted: d.isBudgetExhausted,\n    rejected: boundRejections(batch.rejected),\n    ...optional\n  };\n}\n\n// packages/target-compiler/src/compile.ts\nvar invalid2 = (message) => {\n  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });\n};\nasync function compileGrayTarget(image, options) {\n  validateGray(image);\n  const snapshot = { ...image, data: new Uint8Array(image.data) };\n  const { targetId, physicalWidthMeters = null } = options;\n  const maxFeatures = TARGET_MAX_FEATURES;\n  const levels = TARGET_LEVELS;\n  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) || physicalWidthMeters !== null && (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0)) {\n    invalid2("Invalid target identity or physical width");\n  }\n  const { features } = extractFeatures(snapshot, { maxFeatures, levels });\n  const result = {\n    schemaVersion: 1,\n    compilerVersion: COMPILER_VERSION,\n    algorithmVersion: ALGORITHM_VERSION,\n    targetId,\n    imageHash: await sha256Hex(snapshot.data),\n    imageHashDomain: "canonical-gray8",\n    widthPx: snapshot.widthPx,\n    heightPx: snapshot.heightPx,\n    physicalWidthMeters,\n    orientation: "top-left",\n    pyramid: buildPyramid(snapshot, levels).map((l) => ({\n      width: l.widthPx,\n      height: l.heightPx,\n      scale: l.scale,\n      pixels: Array.from(l.data)\n    })),\n    features: {\n      points: features.map((f) => [f.x, f.y]),\n      descriptorType: ALGORITHM_VERSION,\n      descriptorLength: 32,\n      descriptors: features.flatMap((f) => f.descriptor)\n    },\n    preprocessing: preprocessingRecord(levels, maxFeatures),\n    diagnostics: diagnoseFeatures(features, snapshot.widthPx, snapshot.heightPx)\n  };\n  validateTargetBundle(result);\n  return result;\n}\n\n// packages/sdk/src/worker/matching-selection.ts\nvar MatchingSelection = class {\n  matcher = null;\n  selection = null;\n  /** True after a mid-run WebAssembly failure until the changed capability has been announced. */\n  hasUnannouncedChange = false;\n  mode;\n  constructor(mode) {\n    this.mode = mode;\n  }\n  /** Selects SIMD, then scalar WebAssembly; any failure keeps the JavaScript matcher. */\n  async initialize() {\n    if (this.mode !== "wasm") return;\n    try {\n      const selected = await selectWasmExactMatcher();\n      this.matcher = selected.matcher;\n      this.selection = {\n        fallbackReason: selected.fallbackReason,\n        attempts: selected.attempts.map((a) => `${a.variant}:${a.outcome}`).join(",")\n      };\n    } catch {\n      this.matcher = null;\n      this.selection = { fallbackReason: "WASM_INIT_FAILED", attempts: "*:WASM_INIT_FAILED" };\n    }\n  }\n  /** The operator for the recognizer; undefined keeps the built-in JavaScript matcher. */\n  operator() {\n    if (!this.matcher) return void 0;\n    return createWasmMatchOperator(this.matcher, {\n      onFailure: () => {\n        this.hasUnannouncedChange = true;\n      }\n    });\n  }\n  get hasChangedSinceAnnounced() {\n    return this.hasUnannouncedChange;\n  }\n  /** The current capability; describing it counts as announcing any pending change. */\n  describe(execution, generation) {\n    this.hasUnannouncedChange = false;\n    if (this.mode !== "wasm") {\n      return {\n        execution,\n        generation,\n        algorithmVersion: ALGORITHM_VERSION,\n        matching: "cpu",\n        matchingSelection: "none",\n        matchingFallback: "none",\n        fallbackReason: null\n      };\n    }\n    const live = this.matcher?.isAvailable === true;\n    const reason = this.matcher?.diagnostics.fallbackReason ?? this.selection?.fallbackReason ?? (live ? null : "WASM_UNAVAILABLE");\n    return {\n      execution,\n      generation,\n      algorithmVersion: ALGORITHM_VERSION,\n      matching: live ? `wasm-${this.matcher.variant}` : "cpu",\n      matchingSelection: this.selection?.attempts ?? "none",\n      matchingFallback: reason ?? "none",\n      fallbackReason: live ? null : "WASM_MATCHING_JS_FALLBACK"\n    };\n  }\n  dispose() {\n    this.matcher?.dispose();\n    this.matcher = null;\n    this.selection = null;\n    this.hasUnannouncedChange = false;\n  }\n};\n\n// packages/sdk/src/worker/protocol.ts\nvar WORKER_PROTOCOL_VERSION = 1;\nvar DEFAULT_VISION_OPTIONS = Object.freeze({\n  collectMatchedPoints: false,\n  observeRecognition: false,\n  exactMatching: "wasm",\n  scaleRetry: true\n});\nvar WORKER_SAFE_REASONS = Object.freeze([\n  SOURCE_TOO_LARGE,\n  STANDARD_TOO_LARGE\n]);\nvar WORKER_GENERIC_REASON = "Worker operation failed";\nfunction safeWorkerReason(reason) {\n  return typeof reason === "string" && WORKER_SAFE_REASONS.includes(reason) ? reason : WORKER_GENERIC_REASON;\n}\n\n// packages/tracking/src/observation-check.ts\nvar reject = (reason) => {\n  throw new EngineError("FRAME_FAILED", reason, { isRecoverable: true });\n};\nfunction cross2(o, a, b) {\n  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);\n}\nfunction hullArea2(points) {\n  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);\n  const half = (p) => {\n    const result = [];\n    for (const v of p) {\n      while (result.length >= 2 && cross2(result.at(-2), result.at(-1), v) <= 0) result.pop();\n      result.push(v);\n    }\n    result.pop();\n    return result;\n  };\n  const hull = [...half(sorted), ...half([...sorted].reverse())];\n  return Math.abs(\n    hull.reduce((sum, p, i) => {\n      const q = hull[(i + 1) % hull.length];\n      return sum + p[0] * q[1] - p[1] * q[0];\n    }, 0)\n  ) / 2;\n}\nfunction project2(h, p) {\n  const z = h[6] * p[0] + h[7] * p[1] + h[8];\n  if (Math.abs(z) < 1e-9) reject("target-crosses-horizon");\n  const result = [\n    (h[0] * p[0] + h[1] * p[1] + h[2]) / z,\n    (h[3] * p[0] + h[4] * p[1] + h[5]) / z\n  ];\n  if (!result.every(Number.isFinite)) reject("nonfinite-projection");\n  return result;\n}\nfunction checkObservation(o, t) {\n  if (o.algorithmVersion !== t.algorithmVersion) reject("incompatible-observation");\n  const n = o.targetPoints.length;\n  if (n < 8 || n > 1e5 || o.imagePoints.length !== n || o.inliers.length !== n)\n    reject("invalid-correspondence-lengths");\n  const h = normalizeHomography(o.H_imageFromTarget);\n  const edges = [\n    [0, 0],\n    [t.widthPx, 0],\n    [t.widthPx, t.heightPx],\n    [0, t.heightPx]\n  ];\n  const denominators = edges.map((p) => h[6] * p[0] + h[7] * p[1] + h[8]);\n  if (denominators.some((v) => Math.abs(v) < 1e-9 || Math.sign(v) !== Math.sign(denominators[0]))) {\n    reject("target-crosses-horizon");\n  }\n  const corners = edges.map((p) => project2(h, p));\n  if (hullArea2(corners) < 16) reject("collapsed-projection");\n  const inliers = [];\n  let sum = 0;\n  for (let i = 0; i < n; i++) {\n    const p = o.targetPoints[i];\n    const q = o.imagePoints[i];\n    if (p.length !== 2 || q.length !== 2 || ![...p, ...q].every(Number.isFinite) || typeof o.inliers[i] !== "boolean") {\n      reject("invalid-correspondence");\n    }\n    if (p[0] < 0 || p[1] < 0 || p[0] > t.widthPx - 1 || p[1] > t.heightPx - 1)\n      reject("feature-outside-target");\n    if (o.inliers[i]) {\n      const r = project2(h, p);\n      sum += (q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2;\n      inliers.push(p);\n    }\n  }\n  const spatialCoverage = hullArea2(inliers) / (t.widthPx * t.heightPx);\n  const error = Math.sqrt(sum / inliers.length);\n  if (inliers.length < 8 || inliers.length / n < 0.6 || spatialCoverage < 0.2 || !Number.isFinite(error) || error > 2) {\n    reject("quality-gate");\n  }\n  return {\n    h,\n    corners,\n    quality: {\n      inlierCount: inliers.length,\n      inlierRatio: inliers.length / n,\n      reprojectionErrorPx: error,\n      spatialCoverage,\n      isDegenerate: false,\n      isMeasured: true\n    }\n  };\n}\n\n// packages/tracking/src/tracker.ts\nvar PREDICTION_LIMIT_US = 1e5;\nfunction inlierImagePoints(o) {\n  const points = [];\n  for (let i = 0; i < o.imagePoints.length; i++) {\n    if (o.inliers[i] === true) points.push([o.imagePoints[i][0], o.imagePoints[i][1]]);\n  }\n  return points.length >= 1 && points.length <= MAX_MATCHED_POINTS ? points : null;\n}\nvar Tracker = class {\n  targets = [];\n  session = null;\n  state = "SEARCHING";\n  /** The last measured result: the source of every prediction. It never carries matched points. */\n  last = null;\n  candidate = null;\n  count = 0;\n  firstTime = 0;\n  candidateTime = 0;\n  frameId = -1;\n  time = -Infinity;\n  seen = /* @__PURE__ */ new Set();\n  generation = 0;\n  isDisposed = false;\n  pending = null;\n  job = null;\n  recognize;\n  acquisitionGapUs;\n  collectPoints;\n  constructor(options) {\n    this.recognize = options.recognize;\n    this.acquisitionGapUs = options.maxObservationGapUs ?? 1e6;\n    if (options.collectMatchedPoints !== void 0 && typeof options.collectMatchedPoints !== "boolean") {\n      throw new EngineError("INVALID_CONFIG", "collectMatchedPoints must be a boolean", {\n        isRecoverable: false\n      });\n    }\n    this.collectPoints = options.collectMatchedPoints === true;\n    if (!Number.isFinite(this.acquisitionGapUs) || this.acquisitionGapUs < 125e3 || this.acquisitionGapUs > 2e6) {\n      throw new EngineError(\n        "INVALID_CONFIG",\n        "Acquisition observation gap must be within 125000..2000000 us",\n        {\n          isRecoverable: false\n        }\n      );\n    }\n  }\n  assertUsable() {\n    if (this.isDisposed)\n      throw new EngineError("DISPOSED", "Tracking pipeline disposed", { isRecoverable: false });\n  }\n  /** Replaces the targets (1..10, unique ids) and forgets the session; only while no frame is processed. */\n  async loadTargets(targets) {\n    this.assertUsable();\n    if (this.pending) {\n      throw new EngineError("INVALID_CONFIG", "Cannot replace targets during processing", {\n        isRecoverable: true\n      });\n    }\n    if (targets.length < 1 || targets.length > 10 || new Set(targets.map((t) => t.targetId)).size !== targets.length) {\n      throw new EngineError("INVALID_TARGET", "Require 1..10 unique targets", {\n        isRecoverable: false\n      });\n    }\n    targets.forEach(validateTargetBundle);\n    this.targets = structuredClone(targets);\n    this.clear();\n    this.session = null;\n  }\n  clear() {\n    this.state = "SEARCHING";\n    this.last = null;\n    this.candidate = null;\n    this.count = 0;\n    this.frameId = -1;\n    this.time = -Infinity;\n    this.seen.clear();\n  }\n  /** Starts a new session: cancels and awaits the frame in progress, then clears all tracking state. */\n  async reset(sessionId) {\n    this.assertUsable();\n    if (!sessionId)\n      throw new EngineError("INVALID_CONFIG", "Session required", { isRecoverable: false });\n    const generation = ++this.generation;\n    this.job?.abort();\n    await this.pending?.catch(() => {\n    });\n    this.assertUsable();\n    if (generation !== this.generation)\n      throw new EngineError("ABORTED", "Reset superseded", { isRecoverable: true });\n    this.clear();\n    this.session = sessionId;\n  }\n  async dispose() {\n    this.isDisposed = true;\n    ++this.generation;\n    this.job?.abort();\n    await this.pending?.catch(() => {\n    });\n    this.clear();\n    this.targets = [];\n    this.session = null;\n  }\n  /** Tracks one frame. Rejects a second frame while one is in progress. */\n  process(frame, signal) {\n    this.assertUsable();\n    if (this.pending) {\n      return Promise.reject(\n        new EngineError("INVALID_CONFIG", "Only one tracking frame may be in flight", {\n          isRecoverable: true\n        })\n      );\n    }\n    const controller = new AbortController();\n    this.job = controller;\n    const abort = () => controller.abort();\n    signal.addEventListener("abort", abort, { once: true });\n    if (signal.aborted) abort();\n    this.pending = this.run(frame, controller.signal, this.generation).finally(() => {\n      signal.removeEventListener("abort", abort);\n      this.pending = null;\n      this.job = null;\n    });\n    return this.pending;\n  }\n  empty(frame, time, reason) {\n    return {\n      sessionId: frame.sessionId,\n      frameId: frame.frameId,\n      observationTimeUs: time,\n      targetId: null,\n      state: this.state,\n      reason,\n      H_imageFromTarget: null,\n      cornersPx: null,\n      quality: {\n        inlierCount: 0,\n        inlierRatio: 0,\n        reprojectionErrorPx: null,\n        spatialCoverage: 0,\n        isDegenerate: false,\n        isMeasured: false\n      },\n      prediction: { ageUs: 0, lastMeasuredTimeUs: null, expiresAtUs: null }\n    };\n  }\n  /** No valid match in this frame: predict from the last measurement, or lose it once it is too old. */\n  miss(frame, time, reason) {\n    if (this.last) {\n      const age = time - this.last.observationTimeUs;\n      if (age >= PREDICTION_LIMIT_US) {\n        this.state = "LOST";\n        this.last = null;\n        this.candidate = null;\n        this.count = 0;\n        return this.empty(frame, time, "prediction-expired");\n      }\n      this.state = "LIMITED";\n      return structuredClone({\n        ...this.last,\n        frameId: frame.frameId,\n        observationTimeUs: time,\n        state: this.state,\n        quality: { ...this.last.quality, isMeasured: false },\n        prediction: { ...this.last.prediction, ageUs: age },\n        reason\n      });\n    }\n    if (reason !== "duplicate-image") {\n      this.candidate = null;\n      this.count = 0;\n      this.state = "SEARCHING";\n    }\n    return this.empty(frame, time, reason);\n  }\n  checkFrame(frame) {\n    const time = frame.observationTimeUs;\n    if (frame.sessionId !== this.session || !Number.isInteger(frame.frameId) || frame.frameId <= this.frameId) {\n      throw new EngineError("FRAME_FAILED", "Stale session or frame", { isRecoverable: true });\n    }\n    if (time == null || !Number.isFinite(time) || time < 0 || time <= this.time) {\n      throw new EngineError("FRAME_FAILED", "Require strictly increasing observation time", {\n        isRecoverable: true\n      });\n    }\n    if (!frame.pictureKey)\n      throw new EngineError("FRAME_FAILED", "Require a picture key", { isRecoverable: true });\n    return time;\n  }\n  async run(frame, signal, generation) {\n    const check = () => {\n      if (signal.aborted || generation !== this.generation || this.isDisposed) {\n        throw new EngineError("ABORTED", "Tracking job cancelled or superseded", {\n          isRecoverable: true\n        });\n      }\n    };\n    check();\n    const time = this.checkFrame(frame);\n    const duplicate = this.seen.has(frame.pictureKey);\n    let observations;\n    try {\n      observations = duplicate ? [] : await this.recognize(frame, this.targets, signal);\n    } catch (error) {\n      if (generation === this.generation && !this.last) {\n        this.candidate = null;\n        this.count = 0;\n        this.state = "SEARCHING";\n      }\n      throw error;\n    }\n    check();\n    this.frameId = frame.frameId;\n    this.time = time;\n    this.seen.add(frame.pictureKey);\n    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);\n    if (this.state === "LOST") this.state = "SEARCHING";\n    if (duplicate) return this.miss(frame, time, "duplicate-image");\n    const match = this.selectObservation(frame, observations);\n    if (!match) return this.miss(frame, time, "no-valid-original-match");\n    return this.measure(frame, time, match);\n  }\n  /** The best valid observation: the tracked target\'s own when one is tracked, otherwise the one with most inliers. */\n  selectObservation(frame, observations) {\n    const accepted = [];\n    for (const observation of observations) {\n      if (observation.sessionId !== frame.sessionId || observation.frameId !== frame.frameId)\n        continue;\n      const target = this.targets.find((t) => t.targetId === observation.targetId);\n      if (!target) continue;\n      try {\n        accepted.push({ observation, checked: checkObservation(observation, target) });\n      } catch {\n      }\n    }\n    accepted.sort(\n      (a, b) => b.checked.quality.inlierCount - a.checked.quality.inlierCount || a.observation.targetId.localeCompare(b.observation.targetId)\n    );\n    return this.last ? accepted.find((x) => x.observation.targetId === this.last.targetId) : accepted[0];\n  }\n  measure(frame, time, {\n    observation: o,\n    checked: c\n  }) {\n    if (!this.last) {\n      if (this.candidate !== o.targetId || time - this.candidateTime > this.acquisitionGapUs || time - this.firstTime > 2 * this.acquisitionGapUs) {\n        this.candidate = o.targetId;\n        this.count = 0;\n        this.firstTime = time;\n      }\n      this.candidateTime = time;\n      this.count++;\n      this.state = "ACQUIRING";\n      if (this.count < 3 || time - this.firstTime < 5e4)\n        return this.empty(frame, time, "confirming-original-match");\n    }\n    this.state = "TRACKING";\n    this.last = {\n      ...this.empty(frame, time, "original-target-measured"),\n      targetId: o.targetId,\n      H_imageFromTarget: c.h,\n      cornersPx: c.corners,\n      quality: c.quality,\n      prediction: { ageUs: 0, lastMeasuredTimeUs: time, expiresAtUs: time + PREDICTION_LIMIT_US }\n    };\n    const result = structuredClone(this.last);\n    const pointsPx = this.collectPoints ? inlierImagePoints(o) : null;\n    if (!pointsPx) return result;\n    return {\n      ...result,\n      matchedPoints: {\n        sessionId: frame.sessionId,\n        frameId: frame.frameId,\n        targetId: o.targetId,\n        pointsPx\n      }\n    };\n  }\n};\n\n// packages/sdk/src/worker/vision-core.ts\nvar VisionCore = class {\n  recognizer;\n  tracker;\n  constructor(options) {\n    const observe = options.onRecognition;\n    this.recognizer = new Recognizer({\n      ...options.exactMatcher ? { exactMatcher: options.exactMatcher } : {},\n      scaleRetry: options.scaleRetry,\n      capturePasses: observe !== void 0\n    });\n    this.tracker = new Tracker({\n      recognize: async (frame, _targets, signal) => {\n        const batch = await this.recognizer.recognize(frame.image, frame, { signal });\n        if (observe) observe(batch, { sessionId: frame.sessionId, frameId: frame.frameId });\n        return batch.observations;\n      },\n      collectMatchedPoints: options.collectMatchedPoints\n    });\n  }\n  async loadTargets(targets) {\n    await this.recognizer.loadTargets(targets);\n    await this.tracker.loadTargets(targets);\n  }\n  reset(sessionId) {\n    return this.tracker.reset(sessionId);\n  }\n  process(frame, signal) {\n    return this.tracker.process(frame, signal);\n  }\n  async dispose() {\n    await this.tracker.dispose();\n    this.recognizer.dispose();\n  }\n};\n\n// packages/sdk/src/worker/vision-runtime.ts\nvar MAX_ENCODED_TARGET_BYTES = 24e6;\nvar MAX_DECODED_TARGET_PIXELS = 33554432;\nfunction closeFrame(frame) {\n  if (frame.image.kind === "video-frame" || frame.image.kind === "image-bitmap")\n    frame.image.image.close();\n}\nfunction checkOptions2(options) {\n  const invalid3 = !options || typeof options.collectMatchedPoints !== "boolean" || typeof options.observeRecognition !== "boolean" || typeof options.scaleRetry !== "boolean" || options.exactMatching !== "wasm" && options.exactMatching !== "js";\n  if (invalid3)\n    throw new EngineError("INVALID_CONFIG", "Invalid worker options", { isRecoverable: false });\n}\nasync function compileEncoded(encodedImage, targetId, maxEdgePx) {\n  if (!encodedImage.byteLength || encodedImage.byteLength > MAX_ENCODED_TARGET_BYTES || !Number.isInteger(maxEdgePx) || maxEdgePx < 32 || maxEdgePx > 1024 || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {\n    throw new EngineError("UNSUPPORTED", "Worker image compilation unavailable or over budget", {\n      isRecoverable: true\n    });\n  }\n  const bitmap = await createImageBitmap(new Blob([encodedImage]));\n  try {\n    if (bitmap.width * bitmap.height > MAX_DECODED_TARGET_PIXELS) {\n      throw new EngineError("INVALID_TARGET", "Decoded target exceeds limit", {\n        isRecoverable: false\n      });\n    }\n    const scale = Math.min(1, maxEdgePx / Math.max(bitmap.width, bitmap.height));\n    const width = Math.round(bitmap.width * scale);\n    const height = Math.round(bitmap.height * scale);\n    const canvas = new OffscreenCanvas(width, height);\n    const context = canvas.getContext("2d", { willReadFrequently: true });\n    if (!context) throw new EngineError("UNSUPPORTED", "No worker canvas", { isRecoverable: true });\n    context.drawImage(bitmap, 0, 0, width, height);\n    const gray = rgbaToGray(\n      new Uint8Array(context.getImageData(0, 0, width, height).data),\n      width,\n      height\n    );\n    return compileGrayTarget(gray, { targetId });\n  } finally {\n    bitmap.close();\n  }\n}\nfunction createVisionRuntime(post) {\n  let isBusy = false;\n  let generation = -1;\n  let core = null;\n  let options = null;\n  let matching = null;\n  const workspace = new StandardImageWorkspace();\n  let trace = null;\n  const describe2 = () => matching.describe("worker", generation);\n  async function initialize(envelope, requested) {\n    if (core)\n      throw new EngineError("INVALID_CONFIG", "Worker already initialized", {\n        isRecoverable: false\n      });\n    checkOptions2(requested);\n    generation = envelope.generation;\n    options = requested;\n    matching = new MatchingSelection(requested.exactMatching);\n    await matching.initialize();\n    const exactMatcher = matching.operator();\n    core = new VisionCore({\n      ...exactMatcher ? { exactMatcher } : {},\n      collectMatchedPoints: requested.collectMatchedPoints,\n      scaleRetry: requested.scaleRetry,\n      ...requested.observeRecognition ? {\n        onRecognition: (batch, frame) => {\n          trace = traceOf(batch, frame);\n        }\n      } : {}\n    });\n    post({ ...envelope, type: "ready", capability: describe2() });\n  }\n  async function processFrame(envelope, frame) {\n    trace = null;\n    const stages = options.observeRecognition ? {\n      inputPackingDurationUs: 0,\n      inputUploadDurationUs: 0,\n      standardDrawDurationUs: 0,\n      readbackDurationUs: 0,\n      grayscaleDurationUs: 0\n    } : void 0;\n    const started = performance.now();\n    const image = standardize(\n      { image: frame.image, geometry: frame.geometry },\n      workspace,\n      rgbaToGray,\n      stages\n    );\n    const prepared = performance.now();\n    const result = await core.process({ ...frame.metadata, image }, new AbortController().signal);\n    const ended = performance.now();\n    const attached = trace;\n    trace = null;\n    post({\n      ...envelope,\n      type: "result",\n      result,\n      timing: {\n        ...stages ? { prepareStages: stages } : {},\n        prepareDurationUs: (prepared - started) * 1e3,\n        computeDurationUs: (ended - prepared) * 1e3,\n        totalDurationUs: (ended - started) * 1e3\n      },\n      ...matching.hasChangedSinceAnnounced ? { capability: describe2() } : {},\n      ...attached && attached.sessionId === result.sessionId && attached.frameId === result.frameId ? { trace: attached } : {}\n    });\n  }\n  async function dispose(envelope) {\n    let failure;\n    for (const release of [() => core?.dispose(), () => matching?.dispose()]) {\n      try {\n        await release();\n      } catch (cause) {\n        failure ??= cause;\n      }\n    }\n    workspace.dispose();\n    core = null;\n    matching = null;\n    options = null;\n    trace = null;\n    if (failure !== void 0) {\n      throw failure instanceof EngineError ? failure : new EngineError("RESOURCE_FAILED", "Worker disposal failed", { isRecoverable: true });\n    }\n    post({ ...envelope, type: "ack" });\n  }\n  async function dispatch(message, envelope) {\n    if (message.type === "init") return initialize(envelope, message.options);\n    if (!core || generation !== message.generation) {\n      throw new EngineError("FRAME_FAILED", "Stale worker generation", { isRecoverable: true });\n    }\n    switch (message.type) {\n      case "load-targets":\n        await core.loadTargets(message.targets);\n        post({ ...envelope, type: "ready", capability: describe2() });\n        return;\n      case "reset":\n        await core.reset(message.sessionId);\n        post({ ...envelope, type: "ready", capability: describe2() });\n        return;\n      case "dispose":\n        return dispose(envelope);\n      case "compile":\n        post({\n          ...envelope,\n          type: "compiled",\n          target: await compileEncoded(message.encodedImage, message.targetId, message.maxEdgePx)\n        });\n        return;\n      case "frame":\n        return processFrame(envelope, message.frame);\n      default:\n        throw new EngineError("FRAME_FAILED", "Unknown worker request", { isRecoverable: true });\n    }\n  }\n  return async function handle(message) {\n    const envelope = {\n      protocol: WORKER_PROTOCOL_VERSION,\n      requestId: message.requestId,\n      generation: message.generation\n    };\n    const refuse = (code = "RESOURCE_FAILED") => post({\n      ...envelope,\n      type: "error",\n      code,\n      isRecoverable: true,\n      reason: safeWorkerReason(null)\n    });\n    if (isBusy || message.protocol !== WORKER_PROTOCOL_VERSION || !Number.isSafeInteger(message.requestId) || !Number.isSafeInteger(message.generation)) {\n      if (message.type === "frame") closeFrame(message.frame);\n      refuse();\n      return;\n    }\n    isBusy = true;\n    try {\n      await dispatch(message, envelope);\n    } catch (cause) {\n      post({\n        ...envelope,\n        type: "error",\n        code: cause instanceof EngineError ? cause.code : "RESOURCE_FAILED",\n        isRecoverable: true,\n        reason: safeWorkerReason(cause instanceof EngineError ? cause.message : null)\n      });\n    } finally {\n      try {\n        if (message.type === "frame") closeFrame(message.frame);\n      } finally {\n        isBusy = false;\n      }\n    }\n  };\n}\n\n// packages/sdk/src/worker/start.ts\nfunction startVisionWorker(scope) {\n  const handle = createVisionRuntime((message) => scope.postMessage(message));\n  const listener = (event) => {\n    void handle(event.data);\n  };\n  scope.addEventListener("message", listener);\n  return () => scope.removeEventListener?.("message", listener);\n}\n\n// packages/sdk/src/worker/worker-entry.ts\nstartVisionWorker(globalThis);\n' : "";
  if (!source) {
    return () => {
      throw new EngineError(
        "UNSUPPORTED",
        "No embedded Worker in this build; provide a workerFactory",
        { isRecoverable: false }
      );
    };
  }
  return createEmbeddedWorkerFactory(source);
}

// packages/recognition/src/features/anms.ts
var ANMS_ROBUSTNESS = 0.9;
var ANMS_POOL_LIMIT = 1024;
var MAX_POOL_LIMIT = 4096;
var ANMS_SELECTION_ID = `anms-c${ANMS_ROBUSTNESS}-pool${ANMS_POOL_LIMIT}-per-level`;
var byStrength = (a, b) => b.score - a.score || a.y - b.y || a.x - b.x;
function anmsRadiiSquared(sorted, robustness = ANMS_ROBUSTNESS) {
  const n = sorted.length;
  const radii = new Array(n);
  let stronger = 0;
  for (let i = 0; i < n; i++) {
    while (stronger < i && sorted[i].score < robustness * sorted[stronger].score) stronger++;
    let best = Infinity;
    for (let j = 0; j < stronger; j++) {
      const dx = sorted[j].x - sorted[i].x;
      const dy = sorted[j].y - sorted[i].y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    radii[i] = best;
  }
  return radii;
}
function selectAnms(candidates, count, { robustness = ANMS_ROBUSTNESS, poolLimit = ANMS_POOL_LIMIT } = {}) {
  const invalid7 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Array.isArray(candidates)) throw invalid7("INVALID_ANMS_CANDIDATES");
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > MAX_POOL_LIMIT || !(robustness > 0 && robustness < 1)) {
    throw invalid7("INVALID_ANMS_OPTIONS");
  }
  for (const c of candidates) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.score) || c.score <= 0) {
      throw invalid7("INVALID_ANMS_CANDIDATE");
    }
  }
  if (!count || !candidates.length) return [];
  const pool = candidates.slice().sort(byStrength).slice(0, poolLimit);
  const radii = anmsRadiiSquared(pool, robustness);
  return pool.map((candidate, rank) => ({ candidate, rank, radius: radii[rank] })).sort((a, b) => (a.radius === b.radius ? 0 : b.radius - a.radius) || a.rank - b.rank).slice(0, count).map((entry) => entry.candidate);
}

// packages/recognition/src/features/brief.ts
function generatePattern() {
  let seed = 2654435769;
  const offset = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % 17 - 8;
  };
  return Array.from({ length: 256 }, () => [offset(), offset(), offset(), offset()]);
}
var BRIEF_PATTERN = generatePattern();
function briefOffsetTable(widthPx) {
  const table = new Int32Array(512);
  for (let bit = 0; bit < 256; bit++) {
    const p = BRIEF_PATTERN[bit];
    table[2 * bit] = p[1] * widthPx + p[0];
    table[2 * bit + 1] = p[3] * widthPx + p[2];
  }
  return table;
}
function describe(data, center, table) {
  const descriptor = Array(32).fill(0);
  for (let bit = 0, k = 0; bit < 256; bit++, k += 2) {
    if (data[center + table[k]] < data[center + table[k + 1]])
      descriptor[bit >> 3] |= 1 << (bit & 7);
  }
  return descriptor;
}

// packages/recognition/src/image/gray-image.ts
var RECOGNITION_LIMITS = Object.freeze({
  /** Most pixels of one image. */
  pixels: 4194304,
  /** Longest image edge. */
  dimension: 4096,
  /** Most features per image (target or frame). */
  features: 512,
  /** Most pyramid levels. */
  levels: 4,
  /** Most loaded targets. */
  targets: 10
});
function validateGray(image) {
  const { widthPx, heightPx, data } = image ?? {};
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 32 || heightPx < 32 || widthPx > RECOGNITION_LIMITS.dimension || heightPx > RECOGNITION_LIMITS.dimension || widthPx * heightPx > RECOGNITION_LIMITS.pixels || !(data instanceof Uint8Array) || data.length !== widthPx * heightPx) {
    throw new EngineError("INVALID_CONFIG", "INVALID_GRAY8", { isRecoverable: false });
  }
}

// packages/recognition/src/features/harris.ts
function createTensorRows(widthPx) {
  return [new Int32Array(widthPx * 3), new Int32Array(widthPx * 3), new Int32Array(widthPx * 3)];
}
function harrisScores(data, w, h, scale, roi, scores, rows) {
  let x0 = 10;
  let x1 = w - 10;
  let y0 = 10;
  let y1 = h - 10;
  if (roi) {
    while (x0 < x1 && (x0 + 0.5) * scale - 0.5 < roi.x) x0++;
    while (x1 > x0 && (x1 - 0.5) * scale - 0.5 >= roi.x + roi.width) x1--;
    while (y0 < y1 && (y0 + 0.5) * scale - 0.5 < roi.y) y0++;
    while (y1 > y0 && (y1 - 0.5) * scale - 0.5 >= roi.y + roi.height) y1--;
  }
  if (x0 >= x1 || y0 >= y1) return;
  const [xxRows, yyRows, xyRows] = rows;
  const row = (y) => {
    const base = y * w;
    const slot = y % 3 * w;
    let i = base + x0 - 1;
    let gx = data[i + 1] - data[i - 1];
    let gy = data[i + w] - data[i - w];
    let ax = gx * gx;
    let ay = gy * gy;
    let az = gx * gy;
    i++;
    gx = data[i + 1] - data[i - 1];
    gy = data[i + w] - data[i - w];
    let bx = gx * gx;
    let by = gy * gy;
    let bz = gx * gy;
    for (let x = x0; x < x1; x++) {
      i = base + x + 1;
      gx = data[i + 1] - data[i - 1];
      gy = data[i + w] - data[i - w];
      const cx = gx * gx;
      const cy = gy * gy;
      const cz = gx * gy;
      xxRows[slot + x] = ax + bx + cx;
      yyRows[slot + x] = ay + by + cy;
      xyRows[slot + x] = az + bz + cz;
      ax = bx;
      ay = by;
      az = bz;
      bx = cx;
      by = cy;
      bz = cz;
    }
  };
  row(y0 - 1);
  row(y0);
  for (let y = y0; y < y1; y++) {
    row(y + 1);
    const a = (y - 1) % 3 * w;
    const b = y % 3 * w;
    const c = (y + 1) % 3 * w;
    for (let x = x0; x < x1; x++) {
      const xx = xxRows[a + x] + xxRows[b + x] + xxRows[c + x];
      const yy = yyRows[a + x] + yyRows[b + x] + yyRows[c + x];
      const xy = xyRows[a + x] + xyRows[b + x] + xyRows[c + x];
      scores[y * w + x] = xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
    }
  }
}
function detectCorners(data, w, h, scale, roi, rows) {
  const scores = new Float64Array(w * h);
  const candidates = [];
  harrisScores(data, w, h, scale, roi, scores, rows);
  for (let y = 10; y < h - 10; y++) {
    for (let x = 10; x < w - 10; x++) {
      const score = scores[y * w + x];
      if (score < 1e6) continue;
      let peak = true;
      nms: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const other = scores[(y + dy) * w + x + dx];
          if (other > score || other === score && (dy < 0 || dy === 0 && dx < 0)) {
            peak = false;
            break nms;
          }
        }
      }
      if (peak) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return candidates;
}

// packages/recognition/src/features/pyramid.ts
function buildPyramid(image, levels = 3) {
  validateGray(image);
  if (!Number.isInteger(levels) || levels < 1 || levels > RECOGNITION_LIMITS.levels) {
    throw new EngineError("INVALID_CONFIG", "INVALID_LEVELS", { isRecoverable: false });
  }
  const result = [{ ...image, scale: 1 }];
  while (result.length < levels) {
    const prev = result.at(-1);
    const widthPx = Math.floor(prev.widthPx / 2);
    const heightPx = Math.floor(prev.heightPx / 2);
    if (Math.min(widthPx, heightPx) < 32) break;
    const data = new Uint8Array(widthPx * heightPx);
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const i = 2 * y * prev.widthPx + 2 * x;
        data[y * widthPx + x] = Math.round(
          (prev.data[i] + prev.data[i + 1] + prev.data[i + prev.widthPx] + prev.data[i + prev.widthPx + 1]) / 4
        );
      }
    }
    result.push({ widthPx, heightPx, data, scale: prev.scale * 2 });
  }
  return result;
}
function smoothBox3(level) {
  const { widthPx: w, heightPx: h, data } = level;
  const out = new Uint8Array(data);
  const rowSums = new Uint16Array(w * 3);
  const fillRow = (y) => {
    const base = y * w;
    const slot = y % 3 * w;
    let a = data[base];
    let b = data[base + 1];
    for (let x = 1; x < w - 1; x++) {
      const c = data[base + x + 1];
      rowSums[slot + x] = a + b + c;
      a = b;
      b = c;
    }
  };
  fillRow(0);
  fillRow(1);
  for (let y = 1; y < h - 1; y++) {
    fillRow(y + 1);
    const r0 = (y - 1) % 3 * w;
    const r1 = y % 3 * w;
    const r2 = (y + 1) % 3 * w;
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      const sum = rowSums[r0 + x] + rowSums[r1 + x] + rowSums[r2 + x];
      out[base + x] = Math.round(sum / 9);
    }
  }
  return out;
}

// packages/recognition/src/features/extract.ts
function checkOptions(image, maxFeatures, roi) {
  const invalid7 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Number.isInteger(maxFeatures) || maxFeatures < 16 || maxFeatures > RECOGNITION_LIMITS.features) {
    throw invalid7("INVALID_FEATURE_LIMIT");
  }
  if (roi && (!["x", "y", "width", "height"].every((k) => Number.isFinite(roi[k])) || roi.width <= 0 || roi.height <= 0 || roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.widthPx || roi.y + roi.height > image.heightPx)) {
    throw invalid7("INVALID_ROI");
  }
}
function extractFeatures(image, options) {
  const { maxFeatures, levels } = options;
  const roi = options.roi ?? null;
  validateGray(image);
  checkOptions(image, maxFeatures, roi);
  const layers = buildPyramid(image, levels);
  const features = [];
  const rows = createTensorRows(image.widthPx);
  for (let level = 0; level < layers.length; level++) {
    const layer2 = layers[level];
    const { widthPx: w, heightPx: h, scale } = layer2;
    const data = smoothBox3(layer2);
    const candidates = detectCorners(data, w, h, scale, roi, rows);
    const quota = Math.floor(maxFeatures / layers.length) + (level < maxFeatures % layers.length ? 1 : 0);
    const table = briefOffsetTable(w);
    let selectedCount = 0;
    for (const point of selectAnms(candidates, quota)) {
      const descriptor = describe(data, point.y * w + point.x, table);
      selectedCount++;
      features.push({
        x: (point.x + 0.5) * scale - 0.5,
        y: (point.y + 0.5) * scale - 0.5,
        level,
        score: point.score,
        descriptor
      });
      if (selectedCount >= quota) break;
    }
  }
  return {
    features,
    pyramid: layers.map(({ widthPx, heightPx, scale }) => ({ widthPx, heightPx, scale }))
  };
}

// packages/recognition/src/geometry/homography.ts
var cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hullArea(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const half = (values) => {
    const h = [];
    for (const p of values) {
      while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(
    hull.reduce((s, p, i) => {
      const q = hull[(i + 1) % hull.length];
      return s + p[0] * q[1] - p[1] * q[0];
    }, 0)
  ) / 2;
}

// packages/recognition/src/matching/packed-matcher.ts
var BIT_COUNTS = Uint8Array.from({ length: 256 }, (_, value) => {
  let n = 0;
  while (value) {
    value &= value - 1;
    n++;
  }
  return n;
});
function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 32; i++) n += BIT_COUNTS[a[i] ^ b[i]];
  return n;
}

// packages/recognition/src/targets/target-validation.ts
var ALGORITHM_VERSION = "m0-harris-anms-brief256-v1";
var COMPILER_VERSION = "webar-gray8-cpu/0.3.0";
var TARGET_MAX_FEATURES = 384;
var TARGET_LEVELS = 3;
var RETIRED_ALGORITHMS = ["m0-harris-brief256-v1", "c-oriented-brief256-v2"];
function preprocessingRecord(levels, maxFeatures) {
  return {
    pixelFormat: "gray8",
    levels,
    maxFeatures,
    downsample: "box2-center",
    smoothing: "box3",
    orientation: "upright-only",
    selection: ANMS_SELECTION_ID
  };
}
var invalid = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}
function diagnoseFeatures(features, widthPx, heightPx) {
  const diagnostics = [];
  const add = (code, message) => {
    diagnostics.push({ code, message, severity: "error" });
  };
  if (features.length < 24)
    add("LOW_TEXTURE", `Only ${features.length} features; require at least 24 for this baseline.`);
  if (hullArea(features.map((f) => [f.x, f.y])) / (widthPx * heightPx) < 0.15) {
    add("LOW_COVERAGE", "Features cover less than 15 percent of target area.");
  }
  const repeated = features.filter(
    (f, i) => features.some((g, j) => i !== j && hamming(f.descriptor, g.descriptor) <= 16)
  ).length;
  if (features.length && repeated / features.length > 0.35) {
    add("REPETITIVE_TEXTURE", "More than 35 percent of descriptors have a near duplicate.");
  }
  return diagnostics;
}
function preflightTarget(value) {
  const candidate = value;
  if (!candidate || !Array.isArray(candidate.features?.points) || candidate.features.points.length > RECOGNITION_LIMITS.features || !Array.isArray(candidate.features?.descriptors) || candidate.features.descriptors.length > RECOGNITION_LIMITS.features * 32 || !Array.isArray(candidate.pyramid) || candidate.pyramid.length > 8 || candidate.pyramid.some(
    (l) => !Array.isArray(l?.pixels) || l.pixels.length > RECOGNITION_LIMITS.pixels
  )) {
    invalid("Target exceeds CPU baseline bounds");
  }
  validateTargetBundle(value);
  const t = value;
  if (RETIRED_ALGORITHMS.includes(t.algorithmVersion)) {
    invalid(
      `Target was compiled with ${t.algorithmVersion}; recompile it with ${ALGORITHM_VERSION}`
    );
  }
  if (t.algorithmVersion !== ALGORITHM_VERSION || t.compilerVersion !== COMPILER_VERSION || t.features.descriptorType !== t.algorithmVersion || t.features.descriptorLength !== 32 || t.imageHashDomain !== "canonical-gray8" || t.widthPx < 32 || t.heightPx < 32 || t.widthPx > RECOGNITION_LIMITS.dimension || t.heightPx > RECOGNITION_LIMITS.dimension || t.widthPx * t.heightPx > RECOGNITION_LIMITS.pixels || t.features.points.length > RECOGNITION_LIMITS.features || t.pyramid.length < 1 || t.pyramid.length > RECOGNITION_LIMITS.levels || !t.features.descriptors.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) || !t.features.points.every(([x, y]) => x >= 0 && y >= 0 && x < t.widthPx && y < t.heightPx)) {
    invalid("Unsupported algorithm, dimensions or feature data");
  }
}
async function validateTarget(value) {
  preflightTarget(value);
  const t = value;
  const p = t.preprocessing;
  if (p.pixelFormat !== "gray8" || p.downsample !== "box2-center" || p.smoothing !== "box3" || p.orientation !== "upright-only" || typeof p.levels !== "number" || !Number.isInteger(p.levels) || p.levels < 1 || p.levels > RECOGNITION_LIMITS.levels || typeof p.maxFeatures !== "number" || !Number.isInteger(p.maxFeatures) || p.maxFeatures < 16 || p.maxFeatures > RECOGNITION_LIMITS.features || t.features.points.length > p.maxFeatures || p.selection !== ANMS_SELECTION_ID) {
    invalid("Unsupported preprocessing");
  }
  const base = t.pyramid[0];
  if (base.width !== t.widthPx || base.height !== t.heightPx || base.scale !== 1)
    invalid("Invalid pyramid base");
  const expected = buildPyramid(
    { widthPx: base.width, heightPx: base.height, data: new Uint8Array(base.pixels) },
    p.levels
  );
  if (expected.length !== t.pyramid.length || expected.some((l, i) => {
    const level = t.pyramid[i];
    return l.widthPx !== level.width || l.heightPx !== level.height || l.scale !== level.scale || !l.data.every((v, j) => v === level.pixels[j]);
  })) {
    invalid("Inconsistent pyramid");
  }
  if (await sha256Hex(new Uint8Array(base.pixels)) !== t.imageHash)
    invalid("Canonical gray8 hash mismatch");
  return t;
}

// packages/recognition/src/trace.ts
var MAX_TRACE_REJECTIONS = 32;
var MAX_TRACE_TEXT = 64;
var MAX_TRACE_PASSES = 2;
var MAX_TRACE_MS = 6e5;
var isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
var isCount = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 1e6;
var isMs = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_TRACE_MS;
var areRejections = (v) => Array.isArray(v) && v.length <= MAX_TRACE_REJECTIONS && v.every(
  (r) => r && typeof r === "object" && isText(r.targetId, 256) && isText(r.reason, MAX_TRACE_TEXT)
);
var copyRejections = (rejected) => rejected.map((r) => ({ targetId: r.targetId, reason: r.reason }));
function copyStageMs(v) {
  const s = v;
  if (!s || typeof s !== "object" || ![s.featureMs, s.retrievalMs, s.matchMs, s.geometryMs, s.totalMs].every(isMs)) {
    return null;
  }
  return {
    featureMs: s.featureMs,
    retrievalMs: s.retrievalMs,
    matchMs: s.matchMs,
    geometryMs: s.geometryMs,
    totalMs: s.totalMs
  };
}
function copyPass(v) {
  const p = v;
  const stage = copyStageMs(p);
  if (!p || !stage || typeof p.scale !== "number" || !Number.isFinite(p.scale) || p.scale <= 0 || p.scale > 1 || !isMs(p.prepareMs) || ![p.featureCount, p.candidateCount, p.observationCount].every(isCount) || typeof p.isAmbiguous !== "boolean" || typeof p.isBudgetExhausted !== "boolean" || !areRejections(p.rejected)) {
    return null;
  }
  return {
    scale: p.scale,
    prepareMs: p.prepareMs,
    ...stage,
    featureCount: p.featureCount,
    candidateCount: p.candidateCount,
    observationCount: p.observationCount,
    isAmbiguous: p.isAmbiguous,
    isBudgetExhausted: p.isBudgetExhausted,
    rejected: copyRejections(p.rejected)
  };
}
function traceForFrame(trace, identity) {
  const t = trace;
  if (!t || typeof t !== "object" || t.sessionId !== identity.sessionId || t.frameId !== identity.frameId || !isText(t.algorithmVersion, MAX_TRACE_TEXT) || ![t.featureCount, t.candidateCount, t.scalePasses, t.observationCount].every(isCount) || typeof t.isAmbiguous !== "boolean" || typeof t.isBudgetExhausted !== "boolean" || !areRejections(t.rejected)) {
    return null;
  }
  const out = {
    sessionId: t.sessionId,
    frameId: t.frameId,
    algorithmVersion: t.algorithmVersion,
    featureCount: t.featureCount,
    candidateCount: t.candidateCount,
    scalePasses: t.scalePasses,
    observationCount: t.observationCount,
    isAmbiguous: t.isAmbiguous,
    isBudgetExhausted: t.isBudgetExhausted,
    rejected: copyRejections(t.rejected)
  };
  if (t.stageMs !== void 0) {
    const stage = copyStageMs(t.stageMs);
    if (!stage) return null;
    out.stageMs = stage;
  }
  if (t.passes !== void 0) {
    if (!Array.isArray(t.passes) || t.passes.length < 1 || t.passes.length > MAX_TRACE_PASSES || t.passes.length !== t.scalePasses) {
      return null;
    }
    const passes = [];
    for (const p of t.passes) {
      const copy = copyPass(p);
      if (!copy) return null;
      passes.push(copy);
    }
    out.passes = passes;
  }
  return out;
}

// packages/sdk/src/worker/frame-transfer.ts
var aborted2 = () => new EngineError("ABORTED", "Frame preparation aborted", { isRecoverable: true });
var failed = (message) => new EngineError("FRAME_FAILED", message, { isRecoverable: true });
function copyGeometry(geometry) {
  return {
    ...geometry,
    crop: { ...geometry.crop },
    H_standardFromInput: [
      ...geometry.H_standardFromInput
    ],
    H_viewportFromStandard: [
      ...geometry.H_viewportFromStandard
    ]
  };
}
async function copyNative(frame) {
  const image = frame.image;
  const source = image.data();
  const width = source.displayWidth ?? source.width;
  const height = source.displayHeight ?? source.height;
  if (width !== frame.widthPx || height !== frame.heightPx)
    throw failed("Native Worker image dimensions do not match frame metadata");
  return image.format === "video-frame" ? source.clone() : createImageBitmap(source);
}
function copyPixels(frame) {
  const image = frame.image;
  if (image.format !== "gray8" && image.format !== "rgba8" && image.format !== "standard-rgba8")
    throw failed("Unsupported Worker image format");
  const channels = image.format === "gray8" ? 1 : 4;
  const data = image.data();
  const isStandard = image.format === "standard-rgba8";
  const width = isStandard ? frame.geometry.standardWidthPx : frame.widthPx;
  const height = isStandard ? frame.geometry.standardHeightPx : frame.heightPx;
  const rowBytes = width * channels;
  if (!(data instanceof Uint8Array) || (height - 1) * rowBytes + rowBytes > data.byteLength)
    throw failed("Invalid CPU image layout");
  const pixels = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++)
    pixels.set(data.subarray(y * rowBytes, y * rowBytes + rowBytes), y * rowBytes);
  return {
    image: {
      kind: channels === 1 ? "gray8" : "rgba8",
      buffer: pixels.buffer,
      width,
      height,
      strideBytes: rowBytes
    },
    copiedBytes: pixels.byteLength
  };
}
async function prepareTransfer(frame, signal, geometry = frame.geometry) {
  const started = performance.now();
  if (signal.aborted) throw aborted2();
  const { widthPx: width, heightPx: height } = frame;
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16384) || width * height > 16777216) {
    throw failed("Worker frame dimensions exceed limit");
  }
  if (frame.image.isReleased) throw failed("Frame already released");
  let copy = null;
  try {
    let image;
    let copiedBytes = null;
    if (frame.image.format === "video-frame" || frame.image.format === "image-bitmap") {
      if (!geometry) throw failed("Native Worker frame requires captured geometry");
      copy = await copyNative(frame);
      image = frame.image.format === "video-frame" ? { kind: "video-frame", image: copy } : { kind: "image-bitmap", image: copy };
    } else {
      ({ image, copiedBytes } = copyPixels(frame));
    }
    if (signal.aborted) throw aborted2();
    if (frame.image.format === "standard-rgba8") geometry = null;
    const metadata = {
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      pictureKey: frame.pictureKey,
      observationTimeUs: frame.timing.observationTimeUs
    };
    const transferable = copy ?? image.buffer;
    let state = "owned";
    const owned = copy;
    return {
      frame: { metadata, image, geometry: geometry ? copyGeometry(geometry) : null },
      transfer: [transferable],
      copiedBytes,
      preparationDurationUs: (performance.now() - started) * 1e3,
      markTransferred() {
        if (state === "released")
          throw new EngineError("RESOURCE_FAILED", "Frame copy already released", {
            isRecoverable: false
          });
        state = "transferred";
      },
      release() {
        if (state !== "owned") return;
        state = "released";
        owned?.close();
      }
    };
  } catch (error) {
    copy?.close();
    throw error;
  }
}

// packages/sdk/src/worker/matched-points.ts
function matchedPointsForResult(result) {
  const m = result?.matchedPoints;
  if (!m || typeof m !== "object" || result.state !== "TRACKING" && result.state !== "LIMITED" || !result.quality?.isMeasured || result.quality.isDegenerate) {
    return null;
  }
  if (!result.targetId || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId) {
    return null;
  }
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p) {
    if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))
      return null;
  }
  return p;
}
function sanitizeMatchedPoints(result, isAllowed) {
  if (result.matchedPoints !== void 0 && (!isAllowed || !matchedPointsForResult(result))) {
    delete result.matchedPoints;
  }
  return result;
}

// packages/compute/src/standard-image/standardize.ts
var SOURCE_TOO_LARGE = "Worker source frame exceeds supported size";
var STANDARD_TOO_LARGE = "Standard image exceeds processing limit; frames are never silently resized";

// packages/sdk/src/worker/protocol.ts
var WORKER_PROTOCOL_VERSION = 1;
var DEFAULT_VISION_OPTIONS = Object.freeze({
  collectMatchedPoints: false,
  observeRecognition: false,
  exactMatching: "wasm",
  scaleRetry: true
});
var WORKER_SAFE_REASONS = Object.freeze([
  SOURCE_TOO_LARGE,
  STANDARD_TOO_LARGE
]);
var WORKER_GENERIC_REASON = "Worker operation failed";
function safeWorkerReason(reason) {
  return typeof reason === "string" && WORKER_SAFE_REASONS.includes(reason) ? reason : WORKER_GENERIC_REASON;
}

// packages/sdk/src/worker/vision-client.ts
function resolveOptions(options = {}) {
  const resolved = { ...DEFAULT_VISION_OPTIONS, ...options };
  for (const key of ["collectMatchedPoints", "observeRecognition", "scaleRetry"]) {
    if (typeof resolved[key] !== "boolean") {
      throw new EngineError("INVALID_CONFIG", `${key} must be a boolean`, { isRecoverable: false });
    }
  }
  if (resolved.exactMatching !== "wasm" && resolved.exactMatching !== "js") {
    throw new EngineError("INVALID_CONFIG", "exactMatching must be 'wasm' or 'js'", {
      isRecoverable: false
    });
  }
  return Object.freeze(resolved);
}
var VisionClient = class {
  worker = null;
  generation = 0;
  requestId = 0;
  targets = [];
  sessionId = null;
  isDisposed = false;
  lastCapability = null;
  operation = null;
  pending = null;
  options;
  timeoutMs;
  config;
  constructor(config) {
    this.config = config;
    this.options = resolveOptions(config.options);
    this.timeoutMs = config.requestTimeoutMs ?? 3e4;
    if (typeof config.workerFactory !== "function" || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 12e4) {
      throw new EngineError("INVALID_CONFIG", "Invalid worker configuration", {
        isRecoverable: false
      });
    }
  }
  get visionOptions() {
    return this.options;
  }
  observe(callback, value) {
    try {
      callback?.(value);
    } catch {
    }
  }
  assertAlive() {
    if (this.isDisposed)
      throw new EngineError("DISPOSED", "Worker pipeline disposed", { isRecoverable: false });
  }
  async exclusive(action) {
    this.assertAlive();
    if (this.operation)
      throw new EngineError("RESOURCE_FAILED", "Only one worker operation may be active", {
        isRecoverable: true
      });
    const task = Promise.resolve().then(action);
    this.operation = task;
    try {
      return await task;
    } finally {
      if (this.operation === task) this.operation = null;
    }
  }
  onMessage = (event) => {
    const value = event.data;
    const pending = this.pending;
    if (!pending || !value || value.protocol !== WORKER_PROTOCOL_VERSION || value.generation !== pending.generation || value.requestId !== pending.id) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (value.type === "error") {
      pending.reject(
        new EngineError(value.code, safeWorkerReason(value.reason), { isRecoverable: true })
      );
      return;
    }
    if (value.type === "ready") {
      this.lastCapability = JSON.stringify(value.capability);
      this.observe(this.config.onCapability?.bind(this.config), value.capability);
    }
    pending.resolve(value);
  };
  onWorkerError = () => {
    const error = new EngineError("RESOURCE_FAILED", "Worker failed; restart is required", {
      isRecoverable: true
    });
    this.kill(error);
    this.observe(this.config.onFailure?.bind(this.config), error);
  };
  kill(error = new EngineError("ABORTED", "Worker operation cancelled", { isRecoverable: true })) {
    const worker = this.worker;
    this.worker = null;
    this.sessionId = null;
    ++this.generation;
    if (worker) {
      worker.removeEventListener("message", this.onMessage);
      worker.removeEventListener("error", this.onWorkerError);
      worker.removeEventListener("messageerror", this.onWorkerError);
      worker.terminate();
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
  request(body, transfer = []) {
    this.assertAlive();
    if (!this.worker || this.pending) {
      return Promise.reject(
        new EngineError("RESOURCE_FAILED", "Worker not ready or busy", { isRecoverable: true })
      );
    }
    const id = ++this.requestId;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new EngineError(
          "RESOURCE_FAILED",
          "Worker request timed out; restart is required",
          { isRecoverable: true }
        );
        this.kill(error);
        this.observe(this.config.onFailure?.bind(this.config), error);
      }, this.timeoutMs);
      this.pending = { id, generation, resolve, reject, timer };
      try {
        this.worker.postMessage(
          { ...body, protocol: WORKER_PROTOCOL_VERSION, requestId: id, generation },
          transfer
        );
      } catch {
        this.kill(
          new EngineError("RESOURCE_FAILED", "Worker transfer failed", { isRecoverable: true })
        );
      }
    });
  }
  async ensureWorker() {
    this.assertAlive();
    if (this.worker) return;
    try {
      this.worker = this.config.workerFactory();
    } catch {
      throw new EngineError("UNSUPPORTED", "Module Worker unavailable", { isRecoverable: true });
    }
    ++this.generation;
    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onWorkerError);
    this.worker.addEventListener("messageerror", this.onWorkerError);
    try {
      const ready = await this.request({ type: "init", options: this.options });
      if (ready.type !== "ready")
        throw new EngineError("START_FAILED", "Invalid worker initialization response", {
          isRecoverable: true
        });
      if (this.targets.length) await this.request({ type: "load-targets", targets: this.targets });
    } catch (error) {
      this.kill();
      throw error;
    }
  }
  /** Validates and snapshots 1..10 targets with unique ids and sends them to the Worker (starting it if needed). */
  loadTargets(targets) {
    return this.exclusive(async () => {
      if (!targets.length || targets.length > 10 || new Set(targets.map((t) => t.targetId)).size !== targets.length) {
        throw new EngineError("INVALID_TARGET", "Require 1..10 unique compatible targets", {
          isRecoverable: false
        });
      }
      targets.forEach(validateTargetBundle);
      const snapshot = structuredClone(targets);
      await this.ensureWorker();
      await this.request({ type: "load-targets", targets: snapshot });
      this.targets = snapshot;
      this.sessionId = null;
    });
  }
  /** Starts a session in the Worker (restarting a failed Worker with the loaded targets). */
  reset(sessionId) {
    return this.exclusive(async () => {
      if (!sessionId)
        throw new EngineError("INVALID_CONFIG", "Session required", { isRecoverable: false });
      await this.ensureWorker();
      await this.request({ type: "reset", sessionId });
      this.sessionId = sessionId;
    });
  }
  /** Decodes and compiles an encoded image in the Worker; aborting terminates the Worker. */
  compileEncodedImage(encodedImage, targetId, maxEdgePx = 640, signal) {
    return this.exclusive(async () => {
      if (signal?.aborted)
        throw new EngineError("ABORTED", "Compilation cancelled", { isRecoverable: true });
      if (!encodedImage.byteLength || encodedImage.byteLength > 24e6) {
        throw new EngineError("INVALID_TARGET", "Encoded target exceeds input limit", {
          isRecoverable: false
        });
      }
      const abort = () => this.kill();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await this.ensureWorker();
        if (signal?.aborted)
          throw new EngineError("ABORTED", "Compilation cancelled", { isRecoverable: true });
        const response = await this.request(
          { type: "compile", encodedImage, targetId, maxEdgePx },
          [encodedImage]
        );
        if (response.type !== "compiled")
          throw new EngineError("INVALID_TARGET", "Unexpected compile response", {
            isRecoverable: true
          });
        return response.target;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    });
  }
  /** Tracks one frame in the Worker. Aborting terminates the Worker; a reset starts a new one. */
  process(frame, signal) {
    return this.exclusive(async () => {
      if (signal.aborted)
        throw new EngineError("ABORTED", "Frame cancelled", { isRecoverable: true });
      if (!this.worker || this.sessionId !== frame.sessionId) {
        throw new EngineError("FRAME_FAILED", "Worker session requires reset", {
          isRecoverable: true
        });
      }
      let lease;
      const abort = () => this.kill();
      signal.addEventListener("abort", abort, { once: true });
      try {
        lease = await (this.config.prepareFrame ?? prepareTransfer)(frame, signal);
        if (signal.aborted || this.isDisposed)
          throw new EngineError("ABORTED", "Frame preparation cancelled", { isRecoverable: true });
        const responsePromise = this.request({ type: "frame", frame: lease.frame }, lease.transfer);
        if (this.worker && this.pending) lease.markTransferred();
        const response = await responsePromise;
        if (response.type !== "result" || response.result.sessionId !== frame.sessionId || response.result.frameId !== frame.frameId) {
          throw new EngineError("FRAME_FAILED", "Worker result identity mismatch", {
            isRecoverable: true
          });
        }
        return this.deliver(frame, response, lease);
      } finally {
        signal.removeEventListener("abort", abort);
        lease?.release();
      }
    });
  }
  /** Announces observations of one result in a fixed order: capability, timing, trace, result. */
  deliver(frame, response, lease) {
    sanitizeMatchedPoints(response.result, this.options.collectMatchedPoints);
    if (response.capability) {
      const key = JSON.stringify(response.capability);
      if (key !== this.lastCapability) {
        this.lastCapability = key;
        this.observe(this.config.onCapability?.bind(this.config), response.capability);
      }
    }
    try {
      this.config.onTiming?.(frame, this.generation, {
        ...response.timing,
        inputPreparationDurationUs: lease.preparationDurationUs,
        inputCopiedBytes: lease.copiedBytes
      });
    } catch {
    }
    if (this.options.observeRecognition && response.trace !== void 0) {
      const trace = traceForFrame(response.trace, frame);
      if (trace) this.observe(this.config.onRecognitionTrace?.bind(this.config), trace);
    }
    this.observe(this.config.onResult?.bind(this.config), structuredClone(response.result));
    return response.result;
  }
  async dispose() {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.kill();
    await this.operation?.catch(() => {
    });
    this.targets = [];
  }
};

// packages/sdk/src/engine/event-hub.ts
var EventHub = class {
  listeners = /* @__PURE__ */ new Map();
  sessionOriginUs = 0;
  hasSourceClock = false;
  clock;
  state;
  telemetry;
  onListenerError;
  constructor(options) {
    this.clock = options.clock;
    this.state = options.state;
    this.telemetry = options.telemetry;
    this.onListenerError = options.onListenerError;
  }
  on(name, listener) {
    const set = this.listeners.get(name) ?? /* @__PURE__ */ new Set();
    set.add(listener);
    this.listeners.set(name, set);
    return () => void set.delete(listener);
  }
  emit(name, event) {
    try {
      this.telemetry?.event?.(name, event);
    } catch {
    }
    for (const listener of [...this.listeners.get(name) ?? []]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
        }
      }
    }
  }
  clear() {
    this.listeners.clear();
  }
  /** A new attempt: the engine session clock starts now and the source clock is not yet known. */
  beginAttempt() {
    this.sessionOriginUs = this.clock();
    this.hasSourceClock = false;
    return this.sessionOriginUs;
  }
  context(targetId) {
    const now = this.clock();
    const sourceNow = this.state.sourceNowUs();
    if (sourceNow != null) {
      this.sessionOriginUs = now - sourceNow;
      this.hasSourceClock = true;
    }
    return {
      sessionId: this.state.sessionId,
      targetId,
      timestampUs: sourceNow ?? Math.max(0, now - this.sessionOriginUs),
      timestampDomain: this.hasSourceClock ? "source-session" : this.state.isRunning ? "engine-session" : "attempt"
    };
  }
};

// packages/sdk/src/engine/frame-records.ts
function frameRecord(frame) {
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    targetId: null,
    pictureKey: frame.pictureKey ?? null,
    arrivalTimeUs: frame.timing.arrivalTimeUs,
    submitTimeUs: null,
    resultAvailableTimeUs: null,
    renderSubmitTimeUs: null,
    queueWaitDurationUs: null,
    dropReason: null
  };
}
function reportFrame(sink, record) {
  if (!record) return;
  try {
    sink?.frame?.({ ...record });
  } catch {
  }
}

// packages/sdk/src/engine/frame-scheduler.ts
var FrameScheduler = class {
  pending = null;
  processing = null;
  lastFrameId = -1;
  lastSourceTimeUs = -Infinity;
  lastPictureKey;
  receipts = /* @__PURE__ */ new WeakMap();
  released = /* @__PURE__ */ new WeakSet();
  onReleaseFailure;
  constructor(onReleaseFailure) {
    this.onReleaseFailure = onReleaseFailure;
  }
  /** A new session: identity checks start over. */
  reset() {
    this.lastFrameId = -1;
    this.lastSourceTimeUs = -Infinity;
    this.lastPictureKey = void 0;
  }
  /** True when the frame is newer than every frame accepted so far (and not a repeated picture). */
  isFresh(frame) {
    return Number.isSafeInteger(frame.frameId) && Number.isFinite(frame.timing.sourceTimestampUs) && frame.frameId > this.lastFrameId && frame.timing.sourceTimestampUs > this.lastSourceTimeUs && !(frame.pictureKey !== void 0 && frame.pictureKey === this.lastPictureKey);
  }
  /** Records the frame as the latest accepted one and returns the candidate it replaced, if any. */
  offer(frame, receiptUs) {
    this.lastFrameId = frame.frameId;
    this.lastSourceTimeUs = frame.timing.sourceTimestampUs;
    this.lastPictureKey = frame.pictureKey;
    this.receipts.set(frame, receiptUs);
    const replaced = this.pending;
    this.pending = frame;
    return replaced;
  }
  take() {
    const frame = this.pending;
    this.pending = null;
    return frame;
  }
  receiptUs(frame) {
    return this.receipts.get(frame);
  }
  /** Releases the frame's picture once; a failing release is reported through the callback. */
  release(frame) {
    if (this.released.has(frame.image)) return;
    this.released.add(frame.image);
    try {
      frame.image.release();
    } catch {
      this.onReleaseFailure();
    }
  }
};

// packages/sdk/src/engine/loss-context.ts
var copyCorners = (corners) => corners ? corners.map((p) => [p[0], p[1]]) : null;
function copyGeometry2(g) {
  return g ? {
    ...g,
    H_standardFromInput: [...g.H_standardFromInput],
    H_viewportFromStandard: [...g.H_viewportFromStandard],
    crop: { x: g.crop.x, y: g.crop.y, width: g.crop.width, height: g.crop.height }
  } : null;
}
function captureTargetFrame(frame, result) {
  return {
    sessionId: result.sessionId,
    frameId: result.frameId,
    pictureKey: frame.pictureKey ?? null,
    observationTimeUs: result.observationTimeUs,
    arrivalTimeUs: frame.timing.arrivalTimeUs,
    targetId: result.targetId,
    state: result.state,
    isMeasured: result.quality.isMeasured && !result.quality.isDegenerate,
    predictionAgeUs: result.prediction.ageUs,
    inputWidthPx: frame.widthPx,
    inputHeightPx: frame.heightPx,
    geometry: copyGeometry2(frame.geometry),
    cornersStandardPx: copyCorners(result.cornersPx)
  };
}
function inverse(m) {
  if (m.length !== 9 || !m.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, h, i] = m;
  const adj = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d
  ];
  const det = a * adj[0] + b * adj[3] + c * adj[6];
  const magnitude = Math.max(...adj.map(Math.abs));
  if (!Number.isFinite(det) || !magnitude || Math.abs(det) < 1e-12 * magnitude) return null;
  return adj.map((v) => v / det);
}
function describeTargetFrame(sample) {
  if (!sample) return null;
  const value = {
    ...sample,
    geometry: copyGeometry2(sample.geometry),
    cornersStandardPx: copyCorners(sample.cornersStandardPx),
    cornersInputPx: null,
    boundingBoxInputPx: null,
    edgeWidthInputPx: null,
    edgeHeightInputPx: null,
    widthFraction: null,
    heightFraction: null,
    areaFraction: null,
    isFullyInsideInput: null,
    unavailableReason: null
  };
  if (!sample.cornersStandardPx) {
    value.unavailableReason = "no-target-corners";
    return value;
  }
  if (!sample.geometry) {
    value.unavailableReason = "frame-geometry-unavailable";
    return value;
  }
  const m = inverse(sample.geometry.H_standardFromInput);
  if (!m || !Number.isFinite(sample.inputWidthPx) || !Number.isFinite(sample.inputHeightPx) || sample.inputWidthPx <= 0 || sample.inputHeightPx <= 0) {
    value.unavailableReason = "invalid-frame-geometry";
    return value;
  }
  const corners = sample.cornersStandardPx.map(([x2, y2]) => {
    const w = m[6] * x2 + m[7] * y2 + m[8];
    return Math.abs(w) > 1e-12 ? [(m[0] * x2 + m[1] * y2 + m[2]) / w, (m[3] * x2 + m[4] * y2 + m[5]) / w] : [NaN, NaN];
  });
  if (!corners.flat().every(Number.isFinite)) {
    value.unavailableReason = "invalid-frame-geometry";
    return value;
  }
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  const edge = (a, b) => Math.hypot(corners[a][0] - corners[b][0], corners[a][1] - corners[b][1]);
  const area = Math.abs(
    corners.reduce((sum, p, k) => {
      const next = corners[(k + 1) % 4];
      return sum + p[0] * next[1] - p[1] * next[0];
    }, 0)
  ) / 2;
  value.cornersInputPx = corners;
  value.boundingBoxInputPx = { x, y, width, height };
  value.edgeWidthInputPx = (edge(0, 1) + edge(2, 3)) / 2;
  value.edgeHeightInputPx = (edge(1, 2) + edge(3, 0)) / 2;
  value.widthFraction = width / sample.inputWidthPx;
  value.heightFraction = height / sample.inputHeightPx;
  value.areaFraction = area / (sample.inputWidthPx * sample.inputHeightPx);
  value.isFullyInsideInput = corners.every(
    ([cx, cy]) => cx >= 0 && cy >= 0 && cx <= sample.inputWidthPx && cy <= sample.inputHeightPx
  );
  return value;
}
var LossContextTracker = class {
  lastProcessed = null;
  lastReliable = null;
  reset() {
    this.lastProcessed = null;
    this.lastReliable = null;
  }
  processed(sample) {
    this.lastProcessed = sample;
  }
  reliable(sample) {
    this.lastReliable = sample;
  }
  forgetReliable() {
    this.lastReliable = null;
  }
  describe(sessionId, targetId, trigger) {
    const preceding = this.lastProcessed?.sessionId === sessionId ? this.lastProcessed : null;
    const reliable = this.lastReliable?.sessionId === sessionId && this.lastReliable.targetId === targetId ? this.lastReliable : null;
    return {
      triggerFrame: describeTargetFrame(trigger),
      precedingFrame: describeTargetFrame(preceding),
      lastReliableFrame: describeTargetFrame(reliable),
      isPrecedingInputFrameRecorded: trigger ? Boolean(preceding && preceding.frameId === trigger.frameId - 1) : null
    };
  }
};

// packages/sdk/src/engine/motion-model.ts
var FAST_DIAGONALS_PER_S = 0.5;
var SLOW_DIAGONALS_PER_S = 0.35;
var SLOW_COUNT = 3;
var SLOW_SPAN_US = 5e4;
var FIT_POINTS = 3;
var FIT_MIN_SPAN_US = 5e4;
var MAX_SPAN_US = 1e5;
var STEP_MIN_SPAN_US = 2e4;
var diagonal = (c) => (Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) + Math.hypot(c[3][0] - c[1][0], c[3][1] - c[1][1])) / 2;
function fittedSpeed(poses) {
  const n = poses.length;
  const meanT = poses.reduce((s, p) => s + p.timeUs, 0) / n;
  const varT = poses.reduce((s, p) => s + (p.timeUs - meanT) ** 2, 0);
  let sum = 0;
  for (let corner = 0; corner < 4; corner++) {
    let vx = 0;
    let vy = 0;
    const meanX = poses.reduce((s, p) => s + p.corners[corner][0], 0) / n;
    const meanY = poses.reduce((s, p) => s + p.corners[corner][1], 0) / n;
    for (const p of poses) {
      vx += (p.timeUs - meanT) * (p.corners[corner][0] - meanX);
      vy += (p.timeUs - meanT) * (p.corners[corner][1] - meanY);
    }
    sum += Math.hypot(vx / varT, vy / varT);
  }
  return sum / 4 * 1e6;
}
function stepSpeed(a, b) {
  let sum = 0;
  for (let corner = 0; corner < 4; corner++)
    sum += Math.hypot(
      b.corners[corner][0] - a.corners[corner][0],
      b.corners[corner][1] - a.corners[corner][1]
    );
  return sum / 4 / (b.timeUs - a.timeUs) * 1e6;
}
var MotionModel = class {
  poses = [];
  slowRun = [];
  current = "unknown";
  lastSpeed = null;
  get mode() {
    return this.current;
  }
  /** Speed at the last measurement in target diagonals per second; null while unknown. */
  get speed() {
    return this.lastSpeed;
  }
  reset() {
    this.poses = [];
    this.slowRun = [];
    this.current = "unknown";
    this.lastSpeed = null;
  }
  /** Adds a measured pose (strictly later than the previous one) and updates the mode. */
  add(timeUs, corners) {
    const last = this.poses.at(-1);
    if (last && timeUs <= last.timeUs) return;
    const pose = { timeUs, corners };
    this.poses.push(pose);
    this.poses = this.poses.filter((p) => timeUs - p.timeUs <= MAX_SPAN_US).slice(-FIT_POINTS);
    const size = diagonal(corners);
    const speeds = [];
    if (this.poses.length >= FIT_POINTS) {
      const span = timeUs - this.poses[0].timeUs;
      if (span >= FIT_MIN_SPAN_US) speeds.push(fittedSpeed(this.poses));
    }
    for (let i = this.poses.length - 2; i >= 0; i--) {
      const span = timeUs - this.poses[i].timeUs;
      if (span < STEP_MIN_SPAN_US) continue;
      speeds.push(stepSpeed(this.poses[i], pose));
      break;
    }
    if (speeds.length === 0 || !(size > 0)) {
      this.lastSpeed = null;
      this.slowRun = [];
      if (this.current !== "fast") this.current = "unknown";
      return;
    }
    const speed = Math.max(...speeds) / size;
    this.lastSpeed = speed;
    if (speed >= FAST_DIAGONALS_PER_S) {
      this.current = "fast";
      this.slowRun = [];
    } else if (this.current !== "fast") {
      this.current = "slow";
    } else if (speed < SLOW_DIAGONALS_PER_S) {
      this.slowRun.push(pose);
      const first = this.slowRun.at(-SLOW_COUNT);
      if (this.slowRun.length >= SLOW_COUNT && first && timeUs - first.timeUs >= SLOW_SPAN_US) {
        this.current = "slow";
        this.slowRun = [];
      }
    } else this.slowRun = [];
  }
};

// packages/sdk/src/engine/presentation-policy.ts
var MOTION_BUDGET_DIAGONALS = 0.05;
var RECONFIRM_COUNT = 3;
var RECONFIRM_SPAN_US = 5e4;
var RECONFIRM_GAP_US = 1e5;
var PresentationPolicy = class {
  activeTarget = null;
  visibilityDeadlineUs = -Infinity;
  expiry = null;
  expiryEpoch = 0;
  host;
  predictionUs;
  graceUs;
  isMotionAdaptive;
  unknownHoldUs;
  isReconfirmAfterHide;
  /** Engine-clock base of the last measurement shown: min(its mapped observation time, its receipt). */
  measuredBaseUs = -Infinity;
  /** Until when the overlay is held after the last loss; recovery before then needs no reconfirmation. */
  holdEndUs = -Infinity;
  motion = new MotionModel();
  motionTarget = null;
  /** An overlay was hidden since a target was last shown. */
  hasHidden = false;
  /** The tracker confirmed a target anew since the hide (it reported ACQUIRING). */
  isTrackerConfirming = false;
  confirm = null;
  constructor(host, policy, modes = {}) {
    this.host = host;
    this.predictionUs = policy.maxPredictionMs * 1e3;
    this.graceUs = policy.lossDisplayGraceMs * 1e3;
    this.isMotionAdaptive = modes.isMotionAdaptive === true;
    this.unknownHoldUs = (modes.unknownMotionHoldMs ?? 0) * 1e3;
    this.isReconfirmAfterHide = modes.isReconfirmAfterHide === true;
  }
  /** Motion of the shown target at its last measurement, for diagnostics. */
  get motionMode() {
    return this.motion.mode;
  }
  /** Engine-clock time after which nothing from the last measurement may stay visible. */
  hideAtUs() {
    let budgetUs = this.predictionUs + this.graceUs;
    if (this.isMotionAdaptive) {
      const speed = this.motion.speed;
      if (this.motion.mode === "fast") budgetUs = Math.min(budgetUs, this.predictionUs);
      else if (this.motion.mode === "unknown" || speed === null)
        budgetUs = Math.min(budgetUs, this.predictionUs + this.unknownHoldUs);
      else if (speed > 0) budgetUs = Math.min(budgetUs, MOTION_BUDGET_DIAGONALS / speed * 1e6);
    }
    return this.measuredBaseUs + budgetUs;
  }
  /** True while a measured result must not be shown yet: a reconfirmation after a hide is still running. */
  isReconfirming(result) {
    if (!this.isReconfirmAfterHide || !this.hasHidden || this.isTrackerConfirming) return false;
    if (this.host.clock() < this.holdEndUs) return false;
    const timeUs = result.observationTimeUs;
    const confirm = this.confirm;
    if (!confirm || confirm.targetId !== result.targetId || timeUs - confirm.lastUs > RECONFIRM_GAP_US) {
      this.confirm = { targetId: result.targetId, firstUs: timeUs, lastUs: timeUs, count: 1 };
      return true;
    }
    confirm.count++;
    confirm.lastUs = timeUs;
    if (confirm.count < RECONFIRM_COUNT || timeUs - confirm.firstUs < RECONFIRM_SPAN_US)
      return true;
    this.confirm = null;
    return false;
  }
  /**
   * Shows a valid result (or runs the loss path for an invalid one). `onRenderSubmit` is called right before the
   * overlay update; `onReliable` after a measured result was shown.
   */
  async present(result, geometry, receiptUs, sample, onRenderSubmit) {
    const host = this.host;
    const session = host.sessionId;
    const generation = host.stopGeneration;
    const transitionEpoch = host.transitionEpoch;
    const isCancelled = () => host.isAborted || transitionEpoch !== host.transitionEpoch || host.stopGeneration !== generation || session !== host.sessionId || !host.isRunning;
    const isMeasured = result.quality.isMeasured;
    const ageUs = result.prediction.ageUs;
    const isVisible = result.targetId !== null && result.H_imageFromTarget !== null && (result.state === "TRACKING" || result.state === "LIMITED") && (isMeasured || ageUs >= 0 && ageUs < this.predictionUs);
    if (!isVisible || this.graceUs > 0 && result.quality.isDegenerate) {
      if (result.state === "ACQUIRING" && this.hasHidden) this.isTrackerConfirming = true;
      else this.confirm = null;
      this.lose(result.reason, sample, true);
      return;
    }
    if (this.isMotionAdaptive && !isMeasured && this.motion.mode === "fast" && this.activeTarget === result.targetId) {
      this.lose(result.reason, sample);
      return;
    }
    if (this.activeTarget !== result.targetId) {
      if (this.activeTarget !== null || this.graceUs === 0) this.lose("target-changed", sample);
      if (isCancelled()) return;
      if (result.state !== "TRACKING" || !isMeasured) {
        this.confirm = null;
        return;
      }
    }
    let deadline = isMeasured ? receiptUs + this.predictionUs : Math.min(this.visibilityDeadlineUs, receiptUs + this.predictionUs - ageUs);
    if (result.prediction.expiresAtUs != null) {
      const sessionNow = host.sourceNowUs();
      if (sessionNow != null)
        deadline = Math.min(deadline, host.clock() + result.prediction.expiresAtUs - sessionNow);
    }
    if (host.clock() >= deadline) {
      this.confirm = null;
      this.lose("prediction-expired", sample, true);
      return;
    }
    if (this.activeTarget !== result.targetId && this.isReconfirming(result)) return;
    onRenderSubmit();
    await host.overlay.update(result, geometry);
    if (isCancelled()) return;
    if (host.clock() >= deadline) {
      this.lose("prediction-expired", sample, this.activeTarget !== null);
      return;
    }
    if (sample.isMeasured) host.losses.reliable(sample);
    if (isMeasured) {
      this.measuredBaseUs = deadline - this.predictionUs;
      const isShownAnew = this.activeTarget !== result.targetId && host.clock() >= this.holdEndUs;
      if (this.motionTarget !== result.targetId || isShownAnew) this.motion.reset();
      this.motionTarget = result.targetId;
      if (result.cornersPx) this.motion.add(result.observationTimeUs, result.cornersPx);
    }
    if (!this.activeTarget) {
      this.holdEndUs = -Infinity;
      this.hasHidden = false;
      this.isTrackerConfirming = false;
      this.confirm = null;
      this.activeTarget = result.targetId;
      host.emit("targetFound", { ...host.context(this.activeTarget), result });
      if (isCancelled()) return;
    }
    host.emit("targetUpdated", { ...host.context(this.activeTarget), result });
    if (isCancelled()) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.visibilityDeadlineUs = deadline;
    const remainingUs = Math.max(0, deadline - host.clock());
    const epoch = ++this.expiryEpoch;
    const target = result.targetId;
    this.expiry = setTimeout(() => {
      if (epoch !== this.expiryEpoch || session !== host.sessionId || !host.isRunning || this.activeTarget !== target)
        return;
      this.lose("prediction-expired", null, true);
    }, remainingUs / 1e3);
  }
  clearExpiry() {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    ++this.expiryEpoch;
  }
  /** Synchronous hard clear for stop, dispose and cleanup; never waits and never uses the grace hold. */
  hideNow() {
    this.clearExpiry();
    this.holdEndUs = this.host.clock();
    this.motion.reset();
    try {
      this.host.overlay.hide();
    } catch {
    }
  }
  /** `isSoft`: a tracking-validity loss that may use the visual grace hold. Everything else hides at once. */
  lose(reason, trigger = null, isSoft = false) {
    const host = this.host;
    this.clearExpiry();
    this.visibilityDeadlineUs = -Infinity;
    let isHeld = false;
    const nowUs = host.clock();
    const holdUs = this.isMotionAdaptive && this.motion.mode === "fast" ? 0 : Math.min(this.graceUs, this.hideAtUs() - nowUs);
    if (isSoft && holdUs > 0 && host.isRunning && !host.isAborted && host.overlay.holdAfterLoss) {
      try {
        isHeld = host.overlay.holdAfterLoss(holdUs / 1e3) === true;
      } catch {
        isHeld = false;
      }
    }
    if (!isHeld) {
      this.holdEndUs = nowUs;
      this.motion.reset();
    } else if (nowUs >= this.holdEndUs) this.holdEndUs = nowUs + holdUs;
    if (this.activeTarget) this.hasHidden = true;
    if (!isHeld) {
      try {
        host.overlay.hide();
      } catch {
        host.emit("error", {
          ...host.context(this.activeTarget),
          error: new EngineError("RESOURCE_FAILED", "Renderer failed to hide", {
            isRecoverable: true
          })
        });
      }
    }
    if (this.activeTarget) {
      const context = host.context(this.activeTarget);
      this.activeTarget = null;
      host.emit("targetLost", {
        ...context,
        reason,
        lossContext: host.losses.describe(host.sessionId, context.targetId, trigger)
      });
    }
    host.losses.forgetReliable();
  }
};

// packages/sdk/src/engine/session-config.ts
var hex = (buffer) => Array.from(new Uint8Array(buffer), (n) => n.toString(16).padStart(2, "0")).join("");
async function mediaIdentity(targetId, source, fit) {
  const bytes = typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array(await source.arrayBuffer());
  return {
    targetId,
    identityHash: hex(await crypto.subtle.digest("SHA-256", bytes)),
    identityKind: typeof source === "string" ? "url-sha256" : "file-sha256",
    fit
  };
}
var EMPTY_FACTS = {
  requestedLongEdge: null,
  processingLongEdge: null,
  inputWidthPx: null,
  inputHeightPx: null,
  previewWidthCss: null,
  previewHeightCss: null,
  previewSurface: null,
  devicePixelRatio: null,
  geometry: null,
  cameraSettings: {},
  capture: null,
  timestampSource: null,
  cameraClockMapping: null,
  clockDomain: null
};
var SessionConfigState = class {
  targets = [];
  media = /* @__PURE__ */ new Map();
  mediaSnapshot = [];
  setTargets(targets) {
    this.targets = targets.map((t) => ({
      targetId: t.targetId,
      imageHash: t.imageHash,
      algorithmVersion: t.algorithmVersion,
      compilerVersion: t.compilerVersion,
      widthPx: t.widthPx,
      heightPx: t.heightPx
    }));
    for (const id of this.media.keys())
      if (!targets.some((t) => t.targetId === id)) this.media.delete(id);
  }
  setMedia(targetId, source, fit = "contain") {
    if (source === null) {
      this.media.delete(targetId);
      return;
    }
    const identity = mediaIdentity(targetId, source, fit);
    this.media.set(
      targetId,
      identity.catch(() => ({ targetId, identityHash: null, identityKind: null, fit }))
    );
  }
  /** Waits for the media hashes of the next session. */
  async settleMedia() {
    this.mediaSnapshot = await Promise.all(this.media.values());
  }
  snapshot(policy, facts) {
    return structuredClone({
      ...EMPTY_FACTS,
      ...facts,
      targets: this.targets,
      media: this.mediaSnapshot,
      maxPredictionMs: policy.maxPredictionMs,
      lossDisplayGraceMs: policy.lossDisplayGraceMs
    });
  }
};

// packages/sdk/src/engine/viewport-transitions.ts
var ViewportTransitions = class {
  epoch = 0;
  isGated = false;
  ready = null;
  work = Promise.resolve();
  unsubscribe = null;
  /** A new session subscription; the previous one (if any) is dropped. */
  subscribe(unsubscribe) {
    this.unsubscribe?.();
    this.isGated = false;
    this.ready = null;
    this.unsubscribe = unsubscribe;
  }
  /** Ends the subscription; throws what the source's unsubscribe threw (after clearing the state). */
  close() {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    this.isGated = false;
    this.ready = null;
    unsubscribe?.();
  }
};

// packages/sdk/src/engine/engine-core.ts
var MAX_TARGETS = 10;
var MAX_PREDICTION_MS = 100;
var MAX_LOSS_DISPLAY_GRACE_MS2 = 1e3;
var invalid2 = (message, isRecoverable = false) => new EngineError("INVALID_CONFIG", message, { isRecoverable });
var EngineCore = class {
  lifecycle = Promise.resolve();
  controller = null;
  session = null;
  sessionCounter = 0;
  stopGeneration = 0;
  attemptOriginUs = 0;
  isDisposed = false;
  isDisposing = false;
  isRunning = false;
  phase = "idle";
  wantsFrameDetail = false;
  capabilityKey = null;
  disconnectOverlay;
  hub;
  scheduler;
  transitions = new ViewportTransitions();
  losses = new LossContextTracker();
  presentation;
  sessionConfig = new SessionConfigState();
  clock;
  policy;
  config;
  constructor(config) {
    const maxPredictionMs = config.maxPredictionMs ?? MAX_PREDICTION_MS;
    if (!config.source || !config.pipeline || !config.overlay)
      throw invalid2("Provide a frame source, a vision pipeline and an overlay");
    if (!Number.isFinite(maxPredictionMs) || maxPredictionMs < 0 || maxPredictionMs > MAX_PREDICTION_MS)
      throw invalid2("maxPredictionMs must be in [0,100] ms");
    const grace = config.lossDisplayGraceMs === void 0 ? 0 : config.lossDisplayGraceMs;
    if (typeof grace !== "number" || !Number.isFinite(grace) || grace < 0 || grace > MAX_LOSS_DISPLAY_GRACE_MS2)
      throw invalid2(`lossDisplayGraceMs must be in [0,${MAX_LOSS_DISPLAY_GRACE_MS2}] ms`);
    this.config = config;
    this.policy = { maxPredictionMs, lossDisplayGraceMs: grace };
    this.clock = config.nowUs ?? (() => performance.now() * 1e3);
    const sessionNow = () => this.session;
    const runningNow = () => this.isRunning;
    this.hub = new EventHub({
      clock: this.clock,
      state: {
        get sessionId() {
          return sessionNow();
        },
        get isRunning() {
          return runningNow();
        },
        sourceNowUs: () => config.source.nowSessionUs?.() ?? null
      },
      ...config.telemetry ? { telemetry: config.telemetry } : {},
      ...config.onListenerError ? { onListenerError: config.onListenerError } : {}
    });
    this.scheduler = new FrameScheduler(
      () => this.emit("error", {
        ...this.context(),
        error: new EngineError("RESOURCE_FAILED", "Frame owner failed to release its resource", {
          isRecoverable: true
        })
      })
    );
    const isAborted = () => this.controller?.signal.aborted ?? false;
    const stopGeneration = () => this.stopGeneration;
    const transitionEpoch = () => this.transitions.epoch;
    this.presentation = new PresentationPolicy(
      {
        overlay: config.overlay,
        clock: this.clock,
        losses: this.losses,
        get sessionId() {
          return sessionNow();
        },
        get isRunning() {
          return runningNow();
        },
        get isAborted() {
          return isAborted();
        },
        get stopGeneration() {
          return stopGeneration();
        },
        get transitionEpoch() {
          return transitionEpoch();
        },
        sourceNowUs: () => config.source.nowSessionUs?.() ?? null,
        context: (targetId) => this.context(targetId ?? null),
        emit: (name, event) => this.emit(name, event)
      },
      this.policy,
      config.presentationModes
    );
    this.disconnectOverlay = config.overlay.onEvent?.((event) => {
      if (event.sessionId !== this.session || this.isDisposed) return;
      const context = this.context(event.targetId);
      if (event.type === "playbackBlocked") this.emit("playbackBlocked", context);
      else if (event.type === "error") this.emit("error", { ...context, error: event.error });
      else this.emit("mediaState", { ...context, state: event.state, media: event.media });
    });
  }
  get state() {
    if (this.isDisposed || this.isDisposing) return "disposed";
    if (this.isRunning) return "running";
    return this.phase;
  }
  get sessionId() {
    return this.session;
  }
  on(name, listener) {
    this.assertUsable();
    return this.hub.on(name, listener);
  }
  emit(name, event) {
    this.hub.emit(name, event);
  }
  context(targetId = this.presentation.activeTarget) {
    return this.hub.context(targetId);
  }
  assertUsable() {
    if (this.isDisposed || this.isDisposing)
      throw new EngineError("DISPOSED", "Engine disposed", { isRecoverable: false });
  }
  /** Called when camera or capability facts change (never per frame). */
  refreshSessionConfig() {
    if (this.session && !this.isDisposed)
      this.emit("sessionConfigUpdated", { ...this.context(), config: this.snapshot() });
  }
  /** Called when the capability changes after the session became ready. */
  refreshCapability() {
    if (!this.session || !this.isRunning || this.isDisposed || !this.config.capability) return;
    this.announceCapability(false);
  }
  /** Emits the capability; after the first one of a session, only when it changed. */
  announceCapability(isFirst) {
    const capability = this.config.capability();
    const key = JSON.stringify(capability);
    if (!isFirst && key === this.capabilityKey) return;
    this.capabilityKey = key;
    this.emit("capabilityChanged", { ...this.context(), capability });
  }
  snapshot() {
    let facts = {};
    try {
      facts = this.config.sessionFacts?.() ?? {};
    } catch {
    }
    return this.sessionConfig.snapshot(this.policy, facts);
  }
  async startupStage(stage, action) {
    const started = this.clock();
    let status = "completed";
    try {
      await action();
      if (this.controller?.signal.aborted) status = "cancelled";
    } catch (error) {
      status = this.controller?.signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      this.emit("stageTiming", {
        ...this.context(),
        stage,
        status,
        durationUs: Math.max(0, this.clock() - started),
        attemptTimeUs: Math.max(0, this.clock() - this.attemptOriginUs)
      });
    }
  }
  enqueue(action) {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.catch(() => {
    });
    return result;
  }
  /** Replaces the loaded targets (1..10 unique, valid bundles); only while stopped. */
  setTargets(targets) {
    this.assertUsable();
    if (targets.length < 1 || targets.length > MAX_TARGETS || new Set(targets.map((t) => t.targetId)).size !== targets.length)
      throw new EngineError("INVALID_TARGET", "Require 1..10 unique targets", {
        isRecoverable: false
      });
    targets.forEach(validateTargetBundle);
    return this.enqueue(async () => {
      this.assertUsable();
      if (this.isRunning) throw invalid2("Stop before replacing targets", true);
      await this.config.pipeline.loadTargets(targets);
      this.sessionConfig.setTargets(targets);
      this.config.overlay.setTargets?.(
        targets.map((t) => ({ targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx }))
      );
    });
  }
  /** Sets or clears one target's media; while running, the active media is released. */
  setTargetMedia(targetId, media) {
    this.assertUsable();
    if (!targetId) throw invalid2("Target required");
    if (media === null) {
      this.config.overlay.clearTargetMedia?.(targetId);
      this.sessionConfig.setMedia(targetId, null);
      return;
    }
    const { url, file, ...options } = media;
    const source = file !== void 0 ? file : url;
    if (!(typeof source === "string" ? source : source instanceof Blob) || options.fit !== void 0 && options.fit !== "contain" && options.fit !== "cover")
      throw invalid2("Invalid media configuration");
    this.config.overlay.setTargetMedia?.(targetId, source, options);
    this.sessionConfig.setMedia(targetId, source, options.fit ?? "contain");
  }
  start(container) {
    this.assertUsable();
    const generation = this.stopGeneration;
    return this.enqueue(async () => {
      this.assertUsable();
      if (this.isRunning || generation !== this.stopGeneration) return;
      this.phase = "starting";
      try {
        await this.run(container);
      } finally {
        if (this.phase === "starting") this.phase = "idle";
      }
    });
  }
  async run(container) {
    this.session = `${this.config.sessionIdPrefix ?? ""}session-${++this.sessionCounter}`;
    this.scheduler.reset();
    this.losses.reset();
    this.attemptOriginUs = this.hub.beginAttempt();
    const session = this.session;
    const controller = new AbortController();
    this.controller = controller;
    this.emit("attemptStart", this.context());
    this.wantsFrameDetail = this.config.telemetry?.wantsFrameDetail === true;
    const cancelled = async () => {
      if (!controller.signal.aborted) return false;
      await this.cleanup("start-cancelled");
      return true;
    };
    try {
      await this.sessionConfig.settleMedia();
      this.emit("sessionConfig", { ...this.context(), config: this.snapshot() });
      if (await cancelled()) return;
      await this.startupStage("pipeline-init", () => this.config.pipeline.reset(session));
      if (await cancelled()) return;
      await this.startupStage("renderer-init", () => this.config.overlay.start(container, session));
      if (await cancelled()) return;
      this.transitions.subscribe(null);
      this.transitions.subscribe(
        this.config.source.onViewportTransition?.(
          (event) => this.onTransition(event, controller, session)
        ) ?? null
      );
      await this.startupStage(
        "camera-init",
        () => this.config.source.start(session, (frame) => this.accept(frame), controller.signal)
      );
      if (await cancelled()) return;
      this.isRunning = true;
      if (this.config.capability) this.announceCapability(true);
      if (await cancelled()) return;
      this.refreshSessionConfig();
      if (await cancelled()) return;
      this.emit("ready", this.context());
    } catch (cause) {
      const error = new EngineError(
        cause instanceof EngineError ? cause.code : "START_FAILED",
        cause instanceof EngineError ? cause.message : "Source, pipeline or renderer initialization failed",
        { isRecoverable: true, cause }
      );
      this.emit("sessionStartFailed", {
        ...this.context(),
        code: error.code,
        attemptTimeUs: Math.max(0, this.clock() - this.attemptOriginUs)
      });
      this.emit("error", { ...this.context(), error });
      await this.cleanup("start-failed");
      throw error;
    }
  }
  stop(reason = "stopped") {
    ++this.stopGeneration;
    this.controller?.abort();
    this.presentation.hideNow();
    return this.enqueue(() => this.cleanup(reason));
  }
  dispose() {
    if (this.isDisposed || this.isDisposing) return this.lifecycle;
    this.isDisposing = true;
    ++this.stopGeneration;
    this.controller?.abort();
    this.presentation.hideNow();
    return this.enqueue(async () => {
      await this.cleanup("disposed");
      const config = this.config;
      const outcomes = await Promise.allSettled(
        [
          () => config.source.dispose(),
          () => config.pipeline.dispose(),
          () => config.overlay.dispose()
        ].map((dispose) => Promise.resolve().then(dispose))
      );
      this.isDisposed = true;
      let hasDisconnectFailed = false;
      try {
        this.disconnectOverlay?.();
      } catch {
        hasDisconnectFailed = true;
      }
      this.disconnectOverlay = void 0;
      this.hub.clear();
      if (outcomes.some((x) => x.status === "rejected") || hasDisconnectFailed)
        throw new EngineError("RESOURCE_FAILED", "One or more parts failed during disposal", {
          isRecoverable: true
        });
    });
  }
  record(frame) {
    return this.wantsFrameDetail ? frameRecord(frame) : null;
  }
  drop(frame, reason) {
    const record = this.record(frame);
    if (record) record.dropReason = reason;
    reportFrame(this.config.telemetry, record);
    this.scheduler.release(frame);
  }
  onTransition(event, controller, session) {
    if (controller !== this.controller || session !== this.session || controller.signal.aborted || this.isDisposed)
      return;
    const transitions = this.transitions;
    transitions.epoch++;
    if (event.phase === "begin") {
      transitions.isGated = true;
      transitions.ready = null;
      const pending = this.scheduler.take();
      if (pending) this.drop(pending, "viewport-transition");
      if (this.isRunning) this.presentation.lose("viewport-transition");
      else this.presentation.hideNow();
      return;
    }
    transitions.isGated = false;
    if (!this.isRunning) return;
    const epoch = transitions.epoch;
    const processing = this.scheduler.processing;
    const precedingReset = transitions.work;
    const ready = (async () => {
      await Promise.all([processing, precedingReset]);
      if (epoch !== transitions.epoch || controller.signal.aborted || !this.isRunning) return;
      await this.config.pipeline.reset(session);
    })().catch(() => {
      if (controller.signal.aborted || epoch !== transitions.epoch) return;
      transitions.isGated = true;
      const pending = this.scheduler.take();
      if (pending) this.scheduler.release(pending);
      this.presentation.hideNow();
      this.emit("error", {
        ...this.context(),
        error: new EngineError(
          "RESOURCE_FAILED",
          "Pipeline reset after viewport transition failed",
          {
            isRecoverable: true
          }
        )
      });
    });
    transitions.ready = ready;
    transitions.work = ready;
    void ready.then(() => {
      if (transitions.ready !== ready) return;
      transitions.ready = null;
      if (this.scheduler.pending && !this.scheduler.processing && this.isRunning && !transitions.isGated)
        this.startDrain();
    });
  }
  startDrain() {
    this.scheduler.processing = this.drain().finally(() => {
      this.scheduler.processing = null;
    });
  }
  accept(frame) {
    if (this.transitions.isGated) {
      this.drop(frame, "viewport-transition");
      return;
    }
    if (!this.isRunning || frame.sessionId !== this.session || this.controller?.signal.aborted || !this.scheduler.isFresh(frame)) {
      this.drop(frame, "inactive-stale-or-duplicate");
      return;
    }
    const replaced = this.scheduler.offer(frame, this.clock());
    if (replaced) this.drop(replaced, "candidate-replaced");
    if (!this.scheduler.processing && !this.transitions.ready) this.startDrain();
  }
  async drain() {
    const transitions = this.transitions;
    while (this.scheduler.pending && !transitions.isGated && !transitions.ready) {
      const frame = this.scheduler.take();
      const signal = this.controller.signal;
      const frameEpoch = transitions.epoch;
      const record = this.record(frame);
      let sample = null;
      try {
        if (record) {
          record.submitTimeUs = this.context().timestampUs;
          const receiptUs = this.scheduler.receiptUs(frame);
          record.queueWaitDurationUs = receiptUs === void 0 ? null : Math.max(0, this.clock() - receiptUs);
        }
        const result = await this.config.pipeline.process(frame, signal);
        if (record) {
          record.resultAvailableTimeUs = this.context().timestampUs;
          record.targetId = result.targetId;
        }
        if (frameEpoch !== transitions.epoch) {
          if (record) record.dropReason = "viewport-transition";
        } else if (!signal.aborted && this.isRunning && result.sessionId === this.session && result.frameId === frame.frameId) {
          sample = captureTargetFrame(frame, result);
          await this.presentation.present(
            result,
            frame.geometry,
            this.scheduler.receiptUs(frame),
            sample,
            () => {
              if (record) record.renderSubmitTimeUs = this.context().timestampUs;
            }
          );
          if (frameEpoch !== transitions.epoch && !signal.aborted) {
            this.presentation.hideNow();
            if (this.presentation.activeTarget) this.presentation.lose("viewport-transition");
          }
          if (frameEpoch === transitions.epoch && !signal.aborted && this.session === sample.sessionId)
            this.losses.processed(sample);
        } else if (record) record.dropReason = "cancelled-or-stale-result";
      } catch (cause) {
        if (frameEpoch !== transitions.epoch) {
          if (record) record.dropReason = "viewport-transition";
        } else if (!signal.aborted) {
          this.presentation.lose("frame-failed", sample);
          const isSafe = cause instanceof EngineError && WORKER_SAFE_REASONS.includes(cause.message);
          this.emit("error", {
            ...this.context(),
            error: new EngineError(
              cause instanceof EngineError ? cause.code : "FRAME_FAILED",
              isSafe ? cause.message : "Frame processing or presentation failed",
              { isRecoverable: true }
            )
          });
        }
      } finally {
        this.scheduler.release(frame);
        reportFrame(this.config.telemetry, record);
      }
    }
  }
  async cleanup(reason) {
    const errors = [];
    this.phase = "stopping";
    try {
      try {
        this.transitions.close();
      } catch (error) {
        errors.push(error);
      }
      this.isRunning = false;
      this.controller?.abort();
      this.presentation.hideNow();
      const pending = this.scheduler.take();
      if (pending) this.drop(pending, "stopped-before-processing");
      try {
        await this.config.source.stop();
      } catch (error) {
        errors.push(error);
      }
      await this.scheduler.processing;
      await this.transitions.work;
      try {
        this.presentation.lose(reason);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.config.overlay.stop();
      } catch (error) {
        errors.push(error);
      }
      const endedContext = this.context();
      this.session = null;
      this.controller = null;
      this.losses.reset();
      if (endedContext.sessionId) this.emit("sessionEnded", { ...endedContext, reason });
      for (const _ of errors)
        this.emit("error", {
          ...this.context(),
          error: new EngineError("RESOURCE_FAILED", "A part failed during stop cleanup", {
            isRecoverable: true
          })
        });
    } finally {
      this.phase = "idle";
    }
  }
  getEventContext() {
    return this.context();
  }
};

// packages/sdk/src/engine/experiments.ts
var GLOBAL_NAME = "__livemiraExperiments";
var EXPERIMENT_DEFAULTS = Object.freeze({
  /** After a loss, retain the overlay only while the target's last measured motion permits it. */
  motionAdaptiveHold: true,
  /** Require confirmation before showing a target whose overlay was hidden. */
  reconfirmAfterHide: true
});
function selectedExperiments(scope = globalThis) {
  const value = scope[GLOBAL_NAME];
  const selected = value && typeof value === "object" ? value : {};
  return Object.freeze(
    Object.fromEntries(
      Object.keys(EXPERIMENT_DEFAULTS).map((name) => [
        name,
        typeof selected[name] === "boolean" ? selected[name] : EXPERIMENT_DEFAULTS[name]
      ])
    )
  );
}

// packages/sdk/src/engine/extension-host.ts
var MAX_PRESENTABLE_PREDICTION_US2 = 1e5;
function notify(listeners, ...args) {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch {
    }
  }
}
function isPresentable(result) {
  const ageUs = result.prediction.ageUs;
  return Boolean(result.targetId) && (result.state === "TRACKING" || result.state === "LIMITED") && !result.quality.isDegenerate && (result.quality.isMeasured || Number.isFinite(ageUs) && ageUs >= 0 && ageUs < MAX_PRESENTABLE_PREDICTION_US2);
}
var HostedOverlay = class {
  overlayLayer;
  base;
  presented = /* @__PURE__ */ new Set();
  cleared = /* @__PURE__ */ new Set();
  traces = /* @__PURE__ */ new Set();
  results = /* @__PURE__ */ new Set();
  targets = [];
  epoch = 0;
  sessionId = null;
  container = null;
  lastFrame = -1;
  updating = 0;
  /** The target an extension shows, and the target of the update in flight. */
  shownTarget = null;
  pendingTarget = null;
  failedTarget = null;
  detachPage = null;
  unsubscribe;
  constructor(base, overlayLayer) {
    this.base = base;
    this.overlayLayer = overlayLayer;
    this.unsubscribe = base.onEvent((event) => this.observe(event));
  }
  // ---- ExtensionHost ----
  onPresented(listener) {
    this.presented.add(listener);
    return () => void this.presented.delete(listener);
  }
  onCleared(listener) {
    this.cleared.add(listener);
    return () => void this.cleared.delete(listener);
  }
  onRecognitionTrace(listener) {
    this.traces.add(listener);
    return () => void this.traces.delete(listener);
  }
  onResult(listener) {
    this.results.add(listener);
    return () => void this.results.delete(listener);
  }
  getTargets() {
    return this.targets.map((t) => ({ ...t }));
  }
  /** Called by the engine for every Worker result and recognition trace. */
  result(result) {
    notify(this.results, result);
  }
  trace(trace) {
    notify(this.traces, trace);
  }
  clear(reason) {
    ++this.epoch;
    this.shownTarget = null;
    notify(this.cleared, reason);
  }
  /** Presents to every extension; true when any of them now shows something. */
  present(result, geometry) {
    let isShown = false;
    for (const listener of [...this.presented]) {
      try {
        if (listener(result, geometry) === true) isShown = true;
      } catch {
      }
    }
    return isShown;
  }
  observe(event) {
    if (event.sessionId !== this.sessionId) return;
    if (event.type === "error") {
      this.failedTarget = event.targetId;
      this.clear("media-failed");
    } else if (event.type === "mediaState") {
      if ((event.state === "shown" || event.state === "playing") && event.targetId === this.failedTarget)
        this.failedTarget = null;
      if (event.state === "hidden" && this.updating === 0) this.clear("hide");
    }
  }
  attachPage(container) {
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    const onChange = () => {
      if (doc.hidden) this.clear("page-hidden");
    };
    const onHide = () => this.clear("page-hidden");
    doc.addEventListener("visibilitychange", onChange);
    view?.addEventListener("pagehide", onHide);
    this.detachPage = () => {
      doc.removeEventListener("visibilitychange", onChange);
      view?.removeEventListener("pagehide", onHide);
    };
  }
  reset(reason) {
    this.detachPage?.();
    this.detachPage = null;
    this.container = null;
    this.sessionId = null;
    this.lastFrame = -1;
    this.failedTarget = null;
    this.pendingTarget = null;
    this.clear(reason);
  }
  // ---- OverlaySink ----
  async start(container, sessionId) {
    this.reset("session");
    const epoch = this.epoch;
    await this.base.start(container, sessionId);
    if (epoch !== this.epoch) return;
    this.container = container;
    this.sessionId = sessionId;
    this.attachPage(container);
  }
  async update(result, geometry) {
    const container = this.container;
    const session = this.sessionId;
    if (!container || result.sessionId !== session || result.frameId <= this.lastFrame) {
      await this.base.update(result, geometry);
      return;
    }
    this.lastFrame = result.frameId;
    const epoch = ++this.epoch;
    const isValid = isPresentable(result) && !container.ownerDocument.hidden;
    if (!isValid) notify(this.cleared, "hide");
    this.pendingTarget = isValid ? result.targetId : null;
    this.updating++;
    try {
      await this.base.update(result, geometry);
    } catch (error) {
      if (epoch === this.epoch) this.clear("hide");
      throw error;
    } finally {
      this.updating--;
      if (epoch === this.epoch) this.pendingTarget = null;
    }
    const isCurrent = epoch === this.epoch && this.container === container && this.sessionId === session && !container.ownerDocument.hidden;
    if (!isCurrent) return;
    if (!isValid || result.targetId === this.failedTarget) {
      this.clear("hide");
      return;
    }
    if (this.present(result, geometry)) this.shownTarget = result.targetId;
    else {
      ++this.epoch;
      this.shownTarget = null;
    }
  }
  hide() {
    this.clear("hide");
    this.base.hide();
  }
  holdAfterLoss(graceMs) {
    this.clear("loss");
    return this.base.holdAfterLoss(graceMs);
  }
  setTargets(targets) {
    this.base.setTargets(targets);
    this.targets = targets.map((t) => ({
      targetId: t.targetId,
      widthPx: t.widthPx,
      heightPx: t.heightPx
    }));
  }
  /** Replacing the media of the shown or pending target voids what is shown for it. */
  setTargetMedia(targetId, source, options) {
    this.base.setTargetMedia(targetId, source, options);
    if (targetId === this.shownTarget || targetId === this.pendingTarget) this.clear("hide");
    if (targetId === this.failedTarget) this.failedTarget = null;
  }
  clearTargetMedia(targetId) {
    this.base.clearTargetMedia(targetId);
    if (targetId === this.shownTarget || targetId === this.pendingTarget) this.clear("hide");
  }
  onEvent(listener) {
    return this.base.onEvent(listener);
  }
  async stop() {
    this.reset("stop");
    await this.base.stop();
  }
  async dispose() {
    this.reset("stop");
    this.unsubscribe();
    this.presented.clear();
    this.cleared.clear();
    this.traces.clear();
    this.results.clear();
    await this.base.dispose();
  }
};

// packages/sdk/src/engine/create-engine.ts
var invalid3 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
var LONG_EDGES = [480, 640, 960, "native"];
var DEFAULT_LOSS_DISPLAY_GRACE_MS = 200;
function oneOf(value, allowed, name) {
  if (value === void 0) return void 0;
  if (!allowed.includes(value)) throw invalid3(`Invalid ${name}`);
  return value;
}
function validateCamera(camera = {}) {
  oneOf(camera.facingMode, ["environment", "user"], "camera.facingMode");
  oneOf(camera.processingLongEdge, LONG_EDGES, "camera.processingLongEdge");
  oneOf(camera.fit, ["contain", "cover"], "camera.fit");
  oneOf(camera.capture, ["auto", "canvas"], "camera.capture");
  oneOf(camera.timestamps, ["media-time", "callback"], "camera.timestamps");
  if (camera.deviceId !== void 0 && (typeof camera.deviceId !== "string" || !camera.deviceId))
    throw invalid3("Invalid camera.deviceId");
  for (const key of ["idealWidthPx", "idealHeightPx"]) {
    const value = camera[key];
    if (value !== void 0 && (!Number.isInteger(value) || value < 1 || value > 8192))
      throw invalid3(`Invalid camera.${key}`);
  }
}
function layer(doc, name, zIndex) {
  const element = doc.createElement("div");
  Object.assign(element.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: String(zIndex)
  });
  element.setAttribute("data-livemira-layer", name);
  return element;
}
function createEngine(options) {
  if (!options || typeof options !== "object") throw invalid3("Engine options required");
  const container = options.container;
  if (!container || typeof container !== "object" || !container.ownerDocument)
    throw invalid3("A container element is required");
  validateCamera(options.camera);
  const camera = { ...options.camera };
  const tracking = { ...options.tracking };
  const grace = tracking.lossDisplayGraceMs === void 0 ? DEFAULT_LOSS_DISPLAY_GRACE_MS : tracking.lossDisplayGraceMs;
  if (typeof grace !== "number" || !Number.isFinite(grace) || grace < 0 || grace > MAX_LOSS_DISPLAY_GRACE_MS)
    throw invalid3("tracking.lossDisplayGraceMs must be in [0,1000] ms");
  const extensions = [...options.extensions ?? []];
  for (const extension of extensions) {
    if (!extension || typeof extension.attach !== "function" || typeof extension.name !== "string")
      throw invalid3("Invalid extension");
  }
  const needs = {
    matchedPoints: extensions.some((e) => e.needs?.matchedPoints === true),
    recognitionTrace: extensions.some((e) => e.needs?.recognitionTrace === true)
  };
  const adapters = { ...options.adapters };
  const telemetry = options.diagnostics;
  const experiments = selectedExperiments();
  const doc = container.ownerDocument;
  const cameraLayer = layer(doc, "camera", 0);
  const overlayLayer = layer(doc, "overlay", 1);
  const extensionLayer = layer(doc, "extensions", 2);
  const cameraSource = new CameraSource({
    previewContainer: cameraLayer,
    camera: {
      facingMode: camera.facingMode ?? "environment",
      ...camera.deviceId !== void 0 ? { deviceId: camera.deviceId } : {},
      ...camera.idealWidthPx !== void 0 ? { idealWidthPx: camera.idealWidthPx } : {},
      ...camera.idealHeightPx !== void 0 ? { idealHeightPx: camera.idealHeightPx } : {},
      ...camera.capture !== void 0 ? { capture: camera.capture } : {},
      ...camera.timestamps !== void 0 ? { timestamps: camera.timestamps } : {}
    },
    geometry: { longEdge: camera.processingLongEdge ?? 640, fit: camera.fit ?? "cover" },
    ...adapters.previewSurface ? { previewSurface: adapters.previewSurface } : {},
    ...adapters.snapshot ? { snapshotStrategies: { auto: adapters.snapshot, canvas: [] } } : {}
  });
  let core = null;
  let workerCapability = null;
  let capturePath = null;
  let clockOffsetUs = null;
  let timestampFallback = null;
  const renderer = new OverlayRenderer({
    ...options.presentation !== void 0 ? { presentation: options.presentation } : {},
    ...adapters.playbackRecoveries ? { recoveries: adapters.playbackRecoveries } : {}
  });
  const hosted = new HostedOverlay(renderer, extensionLayer);
  const vision = new VisionClient({
    workerFactory: adapters.workerFactory ?? defaultWorkerFactory(),
    options: {
      collectMatchedPoints: needs.matchedPoints,
      observeRecognition: needs.recognitionTrace
    },
    onCapability: (capability2) => {
      workerCapability = capability2;
      core?.refreshCapability();
      core?.refreshSessionConfig();
    },
    onTiming: (frame, generation, timing) => {
      if (!telemetry?.wantsFrameDetail) return;
      try {
        telemetry.workerTiming?.({
          sessionId: frame.sessionId,
          frameId: frame.frameId,
          generation,
          timing: { ...timing }
        });
      } catch {
      }
    },
    onFailure: (error) => {
      if (!core || core.state !== "running") return;
      core.emit("error", { ...core.context(), error });
      void core.stop("worker-failure").catch(() => {
      });
    },
    onResult: (result) => {
      if (telemetry?.wantsFrameDetail) {
        try {
          telemetry.result?.(result);
        } catch {
        }
      }
      hosted.result(result);
    },
    onRecognitionTrace: (trace) => hosted.trace(trace)
  });
  const capability = () => {
    const diagnostics = cameraSource.getDiagnostics();
    return {
      engine: {
        version: engineBuildInfo.version,
        buildId: engineBuildInfo.buildId,
        format: engineBuildInfo.format,
        variant: engineBuildInfo.variant
      },
      previewSurface: diagnostics.preview?.surface ?? null,
      capturePath,
      capture: camera.capture ?? DEFAULT_CAPTURE,
      execution: workerCapability ? "worker" : null,
      workerGeneration: workerCapability?.generation ?? null,
      algorithmVersion: workerCapability?.algorithmVersion ?? null,
      matching: workerCapability?.matching ?? null,
      matchingSelection: workerCapability?.matchingSelection ?? null,
      matchingFallback: workerCapability?.matchingFallback ?? null,
      fallbackReason: workerCapability?.fallbackReason ?? null
    };
  };
  const sessionFacts = () => {
    const d = cameraSource.getDiagnostics();
    const isCurrent = core !== null && d.sessionId === core.sessionId && d.state === "running";
    const geometry = isCurrent ? d.geometry : null;
    const lastFrame = isCurrent ? d.lastFrame : null;
    return {
      requestedLongEdge: camera.processingLongEdge ?? 640,
      processingLongEdge: geometry ? Math.max(geometry.standardWidthPx, geometry.standardHeightPx) : null,
      inputWidthPx: lastFrame?.widthPx ?? null,
      inputHeightPx: lastFrame?.heightPx ?? null,
      previewWidthCss: isCurrent ? d.preview?.renderedWidth ?? null : null,
      previewHeightCss: isCurrent ? d.preview?.renderedHeight ?? null : null,
      previewSurface: isCurrent ? d.preview?.surface ?? null : null,
      devicePixelRatio: geometry?.devicePixelRatio ?? null,
      geometry,
      cameraSettings: isCurrent ? d.settings ?? {} : {},
      capture: camera.capture ?? DEFAULT_CAPTURE,
      timestampSource: isCurrent ? timestampFallback ?? lastFrame?.timestampSource ?? camera.timestamps ?? DEFAULT_TIMESTAMPS : null,
      cameraClockMapping: clockOffsetUs === null ? null : { sourceToSessionOffsetUs: clockOffsetUs },
      clockDomain: isCurrent ? "source-session" : null
    };
  };
  core = new EngineCore({
    source: cameraSource,
    pipeline: vision,
    overlay: hosted,
    ...tracking.maxPredictionMs !== void 0 ? { maxPredictionMs: tracking.maxPredictionMs } : {},
    lossDisplayGraceMs: grace,
    presentationModes: {
      isMotionAdaptive: experiments.motionAdaptiveHold,
      // Hold a target measured only once for at most 100 ms to limit acquisition flashes.
      unknownMotionHoldMs: 100,
      isReconfirmAfterHide: experiments.reconfirmAfterHide
    },
    ...telemetry ? { telemetry } : {},
    sessionFacts,
    capability,
    sessionIdPrefix: `${crypto.randomUUID().slice(0, 8)}-`
  });
  const engineCore = core;
  engineCore.on("attemptStart", () => {
    clockOffsetUs = null;
  });
  const onCameraEvent = (event) => {
    const context = engineCore.context();
    switch (event.type) {
      case "permission":
        engineCore.emit("cameraPermission", {
          ...context,
          phase: event.phase,
          permission: event.permission
        });
        break;
      case "ready":
        capturePath = event.capturePath;
        timestampFallback = null;
        break;
      case "timestampsChanged":
        timestampFallback = event.timestamps;
        clockOffsetUs = null;
        engineCore.refreshSessionConfig();
        break;
      case "capturePathChanged":
        capturePath = event.capturePath;
        engineCore.refreshCapability();
        break;
      case "pictureSize":
        engineCore.emit("cameraSize", {
          ...context,
          widthPx: event.widthPx,
          heightPx: event.heightPx
        });
        break;
      case "geometryChanged":
        engineCore.refreshSessionConfig();
        break;
      case "clockMapping":
        if (clockOffsetUs === null) {
          clockOffsetUs = event.sourceToSessionOffsetUs;
          engineCore.refreshSessionConfig();
        }
        break;
      case "failure":
        engineCore.emit("cameraStatus", {
          ...context,
          code: event.error.code,
          detail: event.detail
        });
        if (engineCore.state === "running") void engineCore.stop("camera-error").catch(() => {
        });
        break;
      case "suspended":
        engineCore.emit("cameraStatus", {
          ...context,
          code: "CAMERA_SUSPENDED",
          detail: "suspended"
        });
        if (engineCore.state === "running")
          void engineCore.stop("camera-suspended").catch(() => {
          });
        break;
    }
  };
  const unsubscribeCamera = cameraSource.onEvent(onCameraEvent);
  const unsubscribeTransition = cameraSource.onViewportTransition((transition) => {
    const d = cameraSource.getDiagnostics();
    const rect = cameraLayer.getBoundingClientRect?.();
    engineCore.emit("viewportTransition", {
      ...engineCore.context(),
      phase: transition.phase,
      epoch: transition.epoch,
      reason: transition.reason,
      sizes: {
        viewportWidthCss: rect ? rect.width : null,
        viewportHeightCss: rect ? rect.height : null,
        cameraWidthPx: d.preview?.intrinsicWidth ?? null,
        cameraHeightPx: d.preview?.intrinsicHeight ?? null
      }
    });
  });
  const view = doc.defaultView;
  const pageEvent = (visibility) => () => engineCore.emit("pageVisibility", { ...engineCore.context(), visibility });
  const onVisibility = () => pageEvent(doc.hidden ? "hidden" : "visible")();
  const onPageHide = pageEvent("pagehide");
  const onPageShow = pageEvent("pageshow");
  doc.addEventListener("visibilitychange", onVisibility);
  view?.addEventListener("pagehide", onPageHide);
  view?.addEventListener("pageshow", onPageShow);
  container.append(cameraLayer, overlayLayer, extensionLayer);
  const handles = [];
  for (const extension of extensions) {
    try {
      handles.push(extension.attach(hosted));
    } catch (cause) {
      for (const handle of handles) handle.detach();
      throw new EngineError("INVALID_CONFIG", `Extension ${extension.name} failed to attach`, {
        isRecoverable: false,
        cause
      });
    }
  }
  let isTornDown = false;
  const teardown = () => {
    if (isTornDown) return;
    isTornDown = true;
    for (const handle of handles) {
      try {
        handle.detach();
      } catch {
      }
    }
    unsubscribeCamera();
    unsubscribeTransition();
    doc.removeEventListener("visibilitychange", onVisibility);
    view?.removeEventListener("pagehide", onPageHide);
    view?.removeEventListener("pageshow", onPageShow);
    cameraLayer.remove();
    overlayLayer.remove();
    extensionLayer.remove();
  };
  return {
    get state() {
      return engineCore.state;
    },
    async setTargets(entries) {
      if (!Array.isArray(entries))
        throw new EngineError("INVALID_TARGET", "Targets required", { isRecoverable: false });
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || !entry.target)
          throw new EngineError("INVALID_TARGET", "Each entry needs a target", {
            isRecoverable: false
          });
      }
      await engineCore.setTargets(entries.map((e) => e.target));
      for (const entry of entries)
        engineCore.setTargetMedia(entry.target.targetId, entry.media ?? null);
    },
    setTargetMedia: (targetId, media) => engineCore.setTargetMedia(targetId, media),
    start: () => engineCore.start(overlayLayer),
    stop: (reason) => engineCore.stop(reason),
    async dispose() {
      try {
        await engineCore.dispose();
      } finally {
        teardown();
      }
    },
    on: (type, listener) => engineCore.on(type, listener),
    media: {
      setMuted: (isMuted) => renderer.setMutedFromGesture(isMuted),
      retry: () => renderer.getDiagnostics().isFailed ? renderer.retryFromGesture() : renderer.resumeBlockedFromGesture()
    },
    camera: {
      async list() {
        const devices = await cameraSource.listCameras();
        return devices.map((d) => ({ deviceId: d.deviceId, label: d.label }));
      },
      configure(change) {
        if (engineCore.state !== "idle")
          throw new EngineError("INVALID_CONFIG", "Configure the camera while the engine is idle", {
            isRecoverable: true
          });
        validateCamera(change);
        Object.assign(camera, change);
        cameraSource.configure({
          ...change.facingMode !== void 0 || change.deviceId !== void 0 ? {
            camera: {
              ...change.facingMode !== void 0 ? { facingMode: change.facingMode } : {},
              ...change.deviceId !== void 0 ? { deviceId: change.deviceId } : {}
            }
          } : {},
          ...change.processingLongEdge !== void 0 || change.fit !== void 0 ? {
            geometry: {
              ...change.processingLongEdge !== void 0 ? { longEdge: change.processingLongEdge } : {},
              ...change.fit !== void 0 ? { fit: change.fit } : {}
            }
          } : {}
        });
      }
    },
    getEventContext: () => engineCore.context(),
    getDiagnostics: () => ({
      state: engineCore.state,
      sessionId: engineCore.sessionId,
      capability: capability(),
      camera: cameraSource.getDiagnostics(),
      renderer: renderer.getDiagnostics(),
      build: engineBuildInfo,
      experiments
    })
  };
}

// packages/sdk/src/engine/targets.ts
async function compileTargetImage(image, options) {
  if (!(image instanceof Blob))
    throw new EngineError("INVALID_TARGET", "An image file is required", { isRecoverable: false });
  const maxEdgePx = options.maxEdgePx ?? 640;
  if (!Number.isInteger(maxEdgePx) || maxEdgePx < 32 || maxEdgePx > 4096)
    throw new EngineError("INVALID_CONFIG", "maxEdgePx must be an integer in 32..4096", {
      isRecoverable: false
    });
  const client = new VisionClient({
    workerFactory: options.workerFactory ?? defaultWorkerFactory()
  });
  try {
    return await client.compileEncodedImage(
      await image.arrayBuffer(),
      options.targetId,
      maxEdgePx,
      options.signal
    );
  } finally {
    await client.dispose();
  }
}

// packages/target-compiler/src/compile.ts
var invalid4 = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
async function compileGrayTarget(image, options) {
  validateGray(image);
  const snapshot = { ...image, data: new Uint8Array(image.data) };
  const { targetId, physicalWidthMeters = null } = options;
  const maxFeatures = TARGET_MAX_FEATURES;
  const levels = TARGET_LEVELS;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) || physicalWidthMeters !== null && (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0)) {
    invalid4("Invalid target identity or physical width");
  }
  const { features } = extractFeatures(snapshot, { maxFeatures, levels });
  const result = {
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    targetId,
    imageHash: await sha256Hex(snapshot.data),
    imageHashDomain: "canonical-gray8",
    widthPx: snapshot.widthPx,
    heightPx: snapshot.heightPx,
    physicalWidthMeters,
    orientation: "top-left",
    pyramid: buildPyramid(snapshot, levels).map((l) => ({
      width: l.widthPx,
      height: l.heightPx,
      scale: l.scale,
      pixels: Array.from(l.data)
    })),
    features: {
      points: features.map((f) => [f.x, f.y]),
      descriptorType: ALGORITHM_VERSION,
      descriptorLength: 32,
      descriptors: features.flatMap((f) => f.descriptor)
    },
    preprocessing: preprocessingRecord(levels, maxFeatures),
    diagnostics: diagnoseFeatures(features, snapshot.widthPx, snapshot.heightPx)
  };
  validateTargetBundle(result);
  return result;
}

// packages/target-compiler/src/serialize.ts
var MAX_SERIALIZED_BYTES = 24e6;
var encoder = new TextEncoder();
var invalid5 = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new EngineError("INVALID_TARGET", "Malformed target text", {
      isRecoverable: false,
      cause
    });
  }
}
async function serializeTarget(target) {
  preflightTarget(target);
  const snapshot = structuredClone(target);
  await validateTarget(snapshot);
  const payload = JSON.stringify(snapshot);
  if (encoder.encode(payload).byteLength > MAX_SERIALIZED_BYTES)
    invalid5("Target exceeds serialization budget");
  const text = JSON.stringify({ payload, sha256: await sha256Hex(encoder.encode(payload)) });
  if (encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES)
    invalid5("Target exceeds serialization budget");
  return text;
}
async function parseTarget(text) {
  if (typeof text !== "string" || text.length > MAX_SERIALIZED_BYTES || encoder.encode(text).byteLength > MAX_SERIALIZED_BYTES) {
    invalid5("Target exceeds serialization budget");
  }
  const envelope = parseJson(text);
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.sha256 !== "string" || await sha256Hex(encoder.encode(envelope.payload)) !== envelope.sha256) {
    invalid5("Target integrity mismatch");
  }
  return validateTarget(parseJson(envelope.payload));
}

// packages/diagnostics/src/ring.ts
var Ring = class {
  dropped = 0;
  data = [];
  head = 0;
  limit;
  constructor(limit) {
    this.limit = limit;
  }
  push(value) {
    if (this.data.length < this.limit) this.data.push(value);
    else {
      this.data[this.head] = value;
      this.head = (this.head + 1) % this.limit;
      this.dropped++;
    }
  }
  /** Oldest first. */
  values() {
    return this.head ? [...this.data.slice(this.head), ...this.data.slice(0, this.head)] : [...this.data];
  }
  get size() {
    return this.data.length;
  }
  clear() {
    this.data = [];
    this.head = 0;
    this.dropped = 0;
  }
};

// packages/diagnostics/src/sanitize.ts
var PHASES = ["loading", "revealing", "revealed", "failed", "cancelled"];
var SIGNALS = ["video-frame-callback", "time-progress"];
var FAILURES = ["media-error", "playback-blocked", "loading-timeout"];
var EVENT_FIELDS = [
  "reason",
  "code",
  "detail",
  "config",
  "state",
  "media",
  "attemptTimeUs",
  "stage",
  "durationUs",
  "status",
  "visibility",
  "phase",
  "epoch",
  "permission",
  "lossContext",
  "capability",
  "widthPx",
  "heightPx"
];
var METADATA_KEYS = /* @__PURE__ */ new Set([
  "deviceLabel",
  "browserVersion",
  "userAgent",
  "notes",
  "secureContext",
  "crossOriginIsolated",
  "devicePixelRatio",
  "cameraFacingMode",
  "requestedLongEdge",
  "maxPredictionMs",
  "lossDisplayGraceMs",
  "engineFormat",
  "engineVariant",
  "engineBuildId"
]);
var MAX_METADATA_STRING = 1024;
var boundedNumber = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null;
function sanitizePresentation(value) {
  if (!value || typeof value !== "object") return null;
  const v = value;
  const generation = boundedNumber(v.requestGeneration, 1e9);
  const elapsed = boundedNumber(v.elapsedMs, 36e5);
  const duration = boundedNumber(v.revealDurationMs, 1e4);
  if (generation === null || !Number.isInteger(generation) || elapsed === null || duration === null || !PHASES.includes(v.phase))
    return null;
  const out = {
    requestGeneration: generation,
    phase: v.phase,
    readySignal: SIGNALS.includes(v.readySignal) ? v.readySignal : null,
    elapsedMs: elapsed,
    firstFrameMs: boundedNumber(v.firstFrameMs, 36e5),
    revealElapsedMs: boundedNumber(v.revealElapsedMs, 1e4),
    revealDurationMs: duration,
    isReducedMotion: v.isReducedMotion === true
  };
  if (FAILURES.includes(v.failureReason)) out.failureReason = v.failureReason;
  return out;
}
var asContextValue = (value, check) => check(value) ? value : null;
function eventRecord(type, payload) {
  const value = payload && typeof payload === "object" ? payload : {};
  const record = {
    type,
    sessionId: asContextValue(value.sessionId, (v) => typeof v === "string"),
    targetId: asContextValue(value.targetId, (v) => typeof v === "string"),
    timestampUs: asContextValue(value.timestampUs, (v) => typeof v === "number"),
    timestampDomain: asContextValue(value.timestampDomain, (v) => typeof v === "string")
  };
  const fields = { ...value };
  const media = fields.media;
  if (media && typeof media === "object" && media.presentation !== void 0) {
    const { presentation, ...rest } = media;
    const clean = sanitizePresentation(presentation);
    fields.media = clean ? { ...rest, presentation: clean } : rest;
  }
  for (const key of EVENT_FIELDS) {
    if (fields[key] !== void 0) {
      try {
        record[key] = structuredClone(fields[key]);
      } catch {
      }
    }
  }
  const error = value.error;
  if (type === "error" && error && typeof error === "object") {
    record.code = typeof error.code === "string" ? error.code : null;
    record.isRecoverable = error.isRecoverable === true;
  }
  return record;
}
function sanitizeMetadata(values) {
  const out = {};
  for (const [key, item] of Object.entries(values)) {
    if (!METADATA_KEYS.has(key)) continue;
    if (typeof item === "string") out[key] = item.slice(0, MAX_METADATA_STRING);
    else if (typeof item === "number" || typeof item === "boolean" || item === null)
      out[key] = item;
  }
  return out;
}

// packages/diagnostics/src/diagnostic-log.ts
var DEFAULT_CAPACITY = 1e4;
var MAX_CAPACITY = 1e5;
var MAX_SECTIONS = 16;
var invalid6 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
function validLevel(level) {
  if (level !== "key" && level !== "full")
    throw invalid6("Diagnostic level must be 'key' or 'full'");
  return level;
}
function isFullOnly(type, payload) {
  return type === "targetUpdated" || type === "mediaState" && payload?.state === "timeupdate";
}
var DiagnosticLog = class {
  requestedLevel;
  sessionLevel;
  hasFullSession = false;
  capacity;
  events;
  frames;
  results;
  timings;
  metadata = {};
  targets = [];
  engine = null;
  sections = /* @__PURE__ */ new Map();
  runId;
  createdAt;
  constructor(options = {}) {
    this.requestedLevel = validLevel(options.level ?? "key");
    this.sessionLevel = this.requestedLevel;
    this.hasFullSession = this.sessionLevel === "full";
    const capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY)
      throw invalid6("Diagnostic capacity must be an integer in 1..100000");
    this.capacity = capacity;
    this.events = new Ring(capacity);
    this.frames = new Ring(capacity);
    this.results = new Ring(capacity);
    this.timings = new Ring(capacity);
    this.runId = crypto.randomUUID();
    this.createdAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  /** The requested level; it applies from the next session start. */
  get level() {
    return this.requestedLevel;
  }
  /** The level of the current (or last) session. */
  get activeLevel() {
    return this.sessionLevel;
  }
  get wantsFrameDetail() {
    return this.sessionLevel === "full";
  }
  setLevel(level) {
    this.requestedLevel = validLevel(level);
  }
  /** Host context (device label, notes, …); only allowlisted keys and primitive values are kept. */
  setMetadata(values) {
    Object.assign(this.metadata, sanitizeMetadata(values));
  }
  /** Adds or replaces a host-owned export section (deep-copied); null removes it. */
  setSection(name, value) {
    if (typeof name !== "string" || !name || name.length > 64)
      throw invalid6("Invalid section name");
    if (value === null) {
      this.sections.delete(name);
      return;
    }
    if (!this.sections.has(name) && this.sections.size >= MAX_SECTIONS)
      throw invalid6("Too many sections");
    this.sections.set(name, structuredClone(value));
  }
  event(type, payload) {
    try {
      if (type === "attemptStart") {
        this.sessionLevel = this.requestedLevel;
        if (this.sessionLevel === "full") this.hasFullSession = true;
      }
      if (this.sessionLevel === "key" && isFullOnly(type, payload)) return;
      const record = eventRecord(type, payload);
      if (type === "attemptStart") record.level = this.sessionLevel;
      this.observe(type, payload);
      this.events.push(record);
    } catch {
    }
  }
  frame(record) {
    if (this.sessionLevel !== "full") return;
    const {
      sessionId,
      frameId,
      targetId,
      pictureKey,
      arrivalTimeUs,
      submitTimeUs,
      resultAvailableTimeUs,
      renderSubmitTimeUs,
      queueWaitDurationUs,
      dropReason
    } = record;
    this.frames.push({
      sessionId,
      frameId,
      targetId,
      pictureKey,
      arrivalTimeUs,
      submitTimeUs,
      resultAvailableTimeUs,
      renderSubmitTimeUs,
      queueWaitDurationUs,
      dropReason
    });
  }
  workerTiming(record) {
    if (this.sessionLevel !== "full") return;
    try {
      this.timings.push(structuredClone(record));
    } catch {
    }
  }
  /** Matched points are display data and never retained. */
  result(result) {
    if (this.sessionLevel !== "full") return;
    const { matchedPoints: _displayOnly, ...numeric } = result;
    this.results.push(structuredClone(numeric));
  }
  /** Session configuration and capability events identify the targets and the engine build. */
  observe(type, payload) {
    const value = payload;
    if ((type === "sessionConfig" || type === "sessionConfigUpdated") && value) {
      const targets = value.config?.targets;
      if (Array.isArray(targets)) {
        this.targets = targets.map((t) => ({
          targetId: String(t.targetId),
          imageHash: String(t.imageHash),
          algorithmVersion: String(t.algorithmVersion),
          compilerVersion: String(t.compilerVersion),
          widthPx: Number(t.widthPx),
          heightPx: Number(t.heightPx)
        }));
      }
    }
    if (type === "capabilityChanged" && value) {
      const engine = value.capability?.engine;
      if (engine && typeof engine === "object") {
        this.engine = {
          version: String(engine.version),
          buildId: typeof engine.buildId === "string" ? engine.buildId : null,
          format: String(engine.format),
          variant: typeof engine.variant === "string" ? engine.variant : null
        };
      }
    }
  }
  get droppedRecords() {
    return this.events.dropped + this.frames.dropped + this.results.dropped + this.timings.dropped;
  }
  getCapacity() {
    return {
      capacity: this.capacity,
      records: this.events.size + this.frames.size + this.results.size + this.timings.size,
      dropped: this.droppedRecords
    };
  }
  export() {
    const isFull = this.hasFullSession;
    const droppedRecords = this.droppedRecords;
    return {
      schema: "livemira-diagnostics/2",
      engine: this.engine,
      runId: this.runId,
      createdAt: this.createdAt,
      level: isFull ? "full" : "key",
      metadata: { ...this.metadata },
      targets: this.targets.map((t) => ({ ...t })),
      events: this.events.values(),
      ...isFull ? {
        frames: this.frames.values(),
        results: this.results.values(),
        workerTimings: this.timings.values()
      } : {},
      isComplete: droppedRecords === 0,
      droppedRecords,
      ...this.sections.size ? { sections: Object.fromEntries(this.sections) } : {}
    };
  }
  /** Starts a new run: all records, sections and the run id are replaced; metadata and the level are kept. */
  clear() {
    this.events.clear();
    this.frames.clear();
    this.results.clear();
    this.timings.clear();
    this.sections.clear();
    this.targets = [];
    this.engine = null;
    this.hasFullSession = this.sessionLevel === "full";
    this.runId = crypto.randomUUID();
    this.createdAt = (/* @__PURE__ */ new Date()).toISOString();
  }
};
export {
  DiagnosticLog,
  ENGINE_VERSION,
  EngineError,
  PRESENTATION_FAILURE_REASONS,
  canvasPreviewSurface,
  compileGrayTarget,
  compileTargetImage,
  createEngine,
  engineBuildInfo,
  parseTarget,
  serializeTarget,
  videoPreviewSurface,
  wechatIosBridgeRecovery
};
