var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

// packages/engine/src/build-info.ts
var ENGINE_VERSION = true ? "0.5.0" : "0.0.0-dev";
var engineBuildInfo = Object.freeze({
  version: ENGINE_VERSION,
  buildId: true ? "fe28869596b2ae1b0f76860b85fe0edaa99ea8ff21a5d81f1ad105160c33cf77" : "development",
  variant: true ? "readable" : "development"
});

// packages/engine/src/emitter.ts
var Emitter = class {
  constructor() {
    __publicField(this, "listeners", /* @__PURE__ */ new Map());
  }
  on(type, listener) {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, set = /* @__PURE__ */ new Set());
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
  emit(type, event) {
    for (const listener of [...this.listeners.get(type) ?? []]) {
      try {
        listener(event);
      } catch (error) {
        console.error(`LiveMira: a '${String(type)}' listener threw`, error);
      }
    }
  }
  clear() {
    this.listeners.clear();
  }
};

// packages/engine/src/errors.ts
var RECOVERABLE = /* @__PURE__ */ new Set([
  "CAMERA_PERMISSION_DENIED",
  "CAMERA_START_FAILED",
  "CAMERA_ENDED",
  "WORKER_FAILED",
  "MEDIA_FAILED",
  "ABORTED",
  "UNSUITABLE_TARGET",
  "DECODE_FAILED"
]);
var EngineError = class extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    __publicField(this, "name", "EngineError");
    __publicField(this, "code");
    __publicField(this, "isRecoverable");
    __publicField(this, "missing");
    this.code = code;
    this.isRecoverable = RECOVERABLE.has(code);
    if (options.missing) this.missing = options.missing;
  }
};
function asEngineError(cause, fallback, message) {
  if (cause instanceof EngineError) return cause;
  return new EngineError(fallback, `${message}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
}

// packages/web/src/capabilities.ts
function probeMainThread(scope = globalThis) {
  const caps = /* @__PURE__ */ new Set(["dom"]);
  const g = scope;
  if (typeof g.MediaStreamTrackProcessor === "function") caps.add("mstp-window");
  if (typeof g.VideoFrame === "function") {
    caps.add("videoframe");
    if (typeof g.VideoFrame.prototype?.copyTo === "function")
      caps.add("videoframe-copyto");
  }
  if (typeof HTMLVideoElement !== "undefined" && "requestVideoFrameCallback" in HTMLVideoElement.prototype)
    caps.add("rvfc");
  if (typeof g.OffscreenCanvas === "function") caps.add("offscreen-2d");
  if (g.crossOriginIsolated === true) caps.add("cross-origin-isolated");
  if (typeof g.DeviceMotionEvent === "function") caps.add("device-motion");
  if (typeof g.Gyroscope === "function") caps.add("generic-sensor");
  if (navigator.gpu) caps.add("webgpu");
  try {
    const canvas = document.createElement("canvas");
    if (canvas.getContext("webgl2")) caps.add("webgl2");
  } catch {
  }
  try {
    const simd = Uint8Array.from([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      5,
      1,
      96,
      0,
      1,
      123,
      3,
      2,
      1,
      0,
      10,
      10,
      1,
      8,
      0,
      65,
      0,
      253,
      15,
      253,
      98,
      11
    ]);
    if (WebAssembly.validate(simd)) caps.add("wasm-simd");
  } catch {
  }
  return caps;
}
function probeWorkerTrackProcessor() {
  return new Promise((resolve) => {
    try {
      const source = "postMessage(typeof MediaStreamTrackProcessor === 'function')";
      const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      const worker = new Worker(url);
      const done = (value) => {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(value);
      };
      worker.onmessage = (event) => done(event.data === true);
      worker.onerror = () => done(false);
      setTimeout(() => done(false), 2e3);
    } catch {
      resolve(false);
    }
  });
}

// packages/web/src/diagnostics.ts
var DIAGNOSTICS = false;

// packages/web/src/fit.ts
function viewportFromStandard(sw, sh, vw, vh, fit) {
  const scale = (fit === "cover" ? Math.max : Math.min)(vw / sw, vh / sh);
  return { scale, offsetX: (vw - sw * scale) / 2, offsetY: (vh - sh * scale) / 2 };
}

// packages/web/src/orientation.ts
var UPRIGHT = { rotation: 0, flip: false };
function frameOrientation(frame) {
  const meta = frame;
  if (typeof meta.rotation !== "number") return null;
  const r = (Math.round(meta.rotation / 90) % 4 + 4) % 4;
  return { rotation: r * 90, flip: meta.flip === true };
}
function rawFromDisplay(width, height, o) {
  let m;
  switch (o.rotation) {
    case 90:
      m = [0, 1, 0, -1, 0, height];
      break;
    case 180:
      m = [-1, 0, width, 0, -1, height];
      break;
    case 270:
      m = [0, -1, width, 1, 0, 0];
      break;
    default:
      m = [1, 0, 0, 0, 1, 0];
  }
  if (o.flip) m = [-m[0], -m[1], width - m[2], m[3], m[4], m[5]];
  return m;
}
function cornerUvs(o) {
  const [a, b, c, d, e, f] = rawFromDisplay(1, 1, o);
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1]
  ].flatMap(([x, y]) => [a * x + b * y + c, d * x + e * y + f]);
}

// packages/web/src/profiles.ts
var PROFILES = {
  // Keenest: KLT prior + ESM, slow loop 3 Hz in a second Worker.
  hawk: {
    id: "hawk",
    name: "Hawk",
    capture: ["mstp-window", "mstp-worker"],
    concurrentSlowLoop: true,
    pipeline: { tracker: "klt+esm", filter: "E2", relocalizeEvery: 10, wasm: true }
  },
  // Default: ESM, slow loop 0.5 Hz in a second Worker.
  swift: {
    id: "swift",
    name: "Swift",
    capture: ["mstp-window", "mstp-worker"],
    concurrentSlowLoop: true,
    pipeline: { tracker: "esm", filter: "E2", relocalizeEvery: 60, wasm: true }
  },
  // Widest reach: main-thread frame snapshots, one Worker, light ESM, slow loop 1 Hz in the same Worker.
  wren: {
    id: "wren",
    name: "Wren",
    capture: ["videoframe"],
    concurrentSlowLoop: false,
    pipeline: { tracker: "esm", esmIterations: [5, 4, 3], filter: "E2", relocalizeEvery: 30, wasm: true }
  }
};
var PROFILE_ORDER = ["hawk", "swift", "wren"];
function missing(id, caps) {
  if (id === "wren") return caps.has("rvfc") ? [] : ["rvfc"];
  return caps.has("mstp-window") || caps.has("mstp-worker") ? [] : ["mstp-worker"];
}
function resolveProfile(preferred, caps) {
  if (!caps.has("webgl2") || !caps.has("videoframe")) return null;
  const skipped = [];
  for (const id of PROFILE_ORDER.slice(PROFILE_ORDER.indexOf(preferred))) {
    const lacks = missing(id, caps);
    if (!lacks.length) return { profile: PROFILES[id], skipped };
    skipped.push({ id, missing: lacks });
  }
  return null;
}
var HAWK_BUDGET = { budgetUs: 22e3, window: 60, warmup: 90 };

// packages/engine/src/camera.ts
function cameraError(cause) {
  const name = cause?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError")
    return new EngineError("CAMERA_PERMISSION_DENIED", "Camera access was not granted", { cause });
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError")
    return new EngineError("CAMERA_UNAVAILABLE", "No camera matches the request", { cause });
  return new EngineError("CAMERA_START_FAILED", `The camera could not start (${name || String(cause)})`, { cause });
}
async function openCamera(request, parent) {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia)
    throw new EngineError("UNSUPPORTED_DEVICE", "No camera API (the page must be served over HTTPS)", {
      missing: ["secure-context"]
    });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...request.deviceId ? { deviceId: { exact: request.deviceId } } : { facingMode: { ideal: request.facingMode } },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 }
      }
    });
  } catch (cause) {
    throw cameraError(cause);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new EngineError("CAMERA_UNAVAILABLE", "The camera stream has no video track");
  }
  const video = parent.ownerDocument.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("webkit-playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.srcObject = stream;
  Object.assign(video.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    objectFit: "cover",
    zIndex: "0",
    pointerEvents: "none"
  });
  parent.append(video);
  try {
    await video.play();
    if (!video.videoWidth)
      await new Promise((resolve) => video.addEventListener("loadedmetadata", () => resolve(), { once: true }));
  } catch (cause) {
    for (const t of stream.getTracks()) t.stop();
    video.remove();
    throw new EngineError("CAMERA_START_FAILED", "The camera picture could not be played", { cause });
  }
  return { stream, track, video };
}
function standardSize(shownWidth, shownHeight, scale) {
  const w = shownWidth || 1280;
  const h = shownHeight || 720;
  return [2 * Math.max(8, Math.round(w * scale / 2)), 2 * Math.max(8, Math.round(h * scale / 2))];
}

// packages/engine/src/media.ts
var MEDIA_ERROR_CODES = {
  1: "aborted",
  2: "network",
  3: "decode",
  4: "unsupported"
};
async function withVideoType(file) {
  if (/^video\//.test(file.type)) return file;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from, to) => String.fromCharCode(...head.subarray(from, to));
  let type = "";
  if (ascii(4, 8) === "ftyp") type = ascii(8, 10) === "qt" ? "video/quicktime" : "video/mp4";
  else if (head[0] === 26 && head[1] === 69 && head[2] === 223 && head[3] === 163) type = "video/webm";
  return type ? new Blob([file], { type }) : file;
}
var MediaPlayer = class {
  constructor(parent, media, isMuted, onState) {
    __publicField(this, "video");
    __publicField(this, "stateValue", "loading");
    /** Frames have reached the screen since the last `play()`. */
    __publicField(this, "flowing", false);
    /** A new video frame is ready to upload. */
    __publicField(this, "frameDirty", true);
    __publicField(this, "objectUrl", null);
    __publicField(this, "frameHandle", 0);
    __publicField(this, "wantsPlay", false);
    /** The browser waits for more data while playback is wanted (its 'waiting' event, until 'playing'). */
    __publicField(this, "isBuffering", false);
    __publicField(this, "disposed", false);
    __publicField(this, "onState");
    this.onState = onState;
    const video = parent.ownerDocument.createElement("video");
    video.muted = isMuted;
    video.defaultMuted = isMuted;
    video.loop = media.isLooping ?? true;
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");
    video.setAttribute("aria-hidden", "true");
    if (media.url) video.crossOrigin = media.crossOrigin ?? "anonymous";
    Object.assign(video.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: "cover",
      zIndex: "0",
      pointerEvents: "none"
    });
    this.video = video;
    video.addEventListener("loadeddata", () => {
      if (this.stateValue === "loading") this.set("ready");
    });
    video.addEventListener("error", () => {
      const code = MEDIA_ERROR_CODES[video.error?.code ?? 0] ?? "unknown";
      this.set("error", code);
    });
    video.addEventListener("playing", () => {
      this.isBuffering = false;
      if (!this.disposed && this.wantsPlay) this.set("playing");
    });
    video.addEventListener("waiting", () => {
      this.isBuffering = this.wantsPlay;
    });
    parent.append(video);
    this.watchFrames();
    if (media.url) this.load(media.url);
    else
      void withVideoType(media.file).then(
        (file) => {
          if (this.disposed) return;
          this.objectUrl = URL.createObjectURL(file);
          this.load(this.objectUrl);
        },
        () => this.set("error", "unknown")
      );
  }
  load(src) {
    this.video.src = src;
    this.video.load();
    if (this.wantsPlay) void this.play();
  }
  get state() {
    return this.stateValue;
  }
  /** Playing, with frames on screen. */
  get isFlowing() {
    return this.stateValue === "playing" && this.flowing;
  }
  get aspect() {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 0;
  }
  get hasPicture() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }
  set(state, code) {
    if (this.disposed || this.stateValue === state) return;
    this.stateValue = state;
    this.onState(state, code);
  }
  watchFrames() {
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        if (this.disposed) return;
        this.frameDirty = true;
        if (this.wantsPlay) this.flowing = true;
        this.frameHandle = video.requestVideoFrameCallback(onFrame);
      };
      this.frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      video.addEventListener("timeupdate", () => {
        this.frameDirty = true;
        if (this.wantsPlay && video.currentTime > 0) this.flowing = true;
      });
    }
  }
  /** Starts (or resumes) playback; the state tells how it went. */
  async play() {
    if (this.disposed || this.stateValue === "error" || this.wantsPlay && this.stateValue === "playing") return;
    this.wantsPlay = true;
    this.flowing = false;
    if (!this.video.getAttribute("src")) return;
    try {
      await this.video.play();
      if (!this.disposed && this.wantsPlay) this.set("playing");
    } catch (cause) {
      if (this.disposed || !this.wantsPlay) return;
      if (cause.name === "NotAllowedError") {
        this.set("blocked");
        this.retryThroughWeChat();
      } else if (cause.name !== "AbortError") this.set("error", "unknown");
    }
  }
  pause() {
    this.wantsPlay = false;
    this.flowing = false;
    this.isBuffering = false;
    if (!this.video.paused) this.video.pause();
    if (this.stateValue === "playing" || this.stateValue === "blocked") this.set("paused");
  }
  /** iOS WeChat lets a video start from its bridge's callback; tried once per refusal. */
  retryThroughWeChat() {
    if (typeof navigator === "undefined" || !/MicroMessenger/i.test(navigator.userAgent)) return;
    const again = () => {
      if (!this.disposed && this.wantsPlay && this.stateValue === "blocked") void this.play();
    };
    const bridge = globalThis.WeixinJSBridge;
    if (bridge) bridge.invoke("getNetworkType", {}, again);
    else this.video.ownerDocument.addEventListener("WeixinJSBridgeReady", again, { once: true });
  }
  setMuted(isMuted) {
    this.video.muted = isMuted;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlay = false;
    if (this.frameHandle) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
};

// packages/engine/src/presenter.ts
var clamp01 = (x) => Math.max(0, Math.min(1, x));
var easeOutCubic = (t) => 1 - (1 - t) ** 3;
var smooth = (t) => t * t * (3 - 2 * t);
var PULSE_MS = 700;
var VEIL_MS = 220;
var RING_DELAY_MS = 120;
var RING_MS = 240;
var REDUCED_REVEAL_MS = 200;
var SHAPE_MS = 260;
var BUFFERING_DELAY_MS = 400;
var PlanePresenter = class {
  constructor(timing) {
    __publicField(this, "visibleSince", null);
    __publicField(this, "waitingSince", null);
    __publicField(this, "revealStart", null);
    __publicField(this, "revealMs", 0);
    /** This video was revealed on this photo before: it comes back with the shorter reveal. */
    __publicField(this, "hasRevealed", false);
    __publicField(this, "veilAtReveal", 0);
    __publicField(this, "ringAtReveal", 0);
    __publicField(this, "shape", null);
    __publicField(this, "bufferingSince", null);
    __publicField(this, "timing");
    this.timing = timing;
  }
  /** A different video (or none): the next reveal is a first one. */
  mediaChanged() {
    this.hasRevealed = false;
    this.revealStart = null;
    this.shape = null;
  }
  /** The region's shape now: the photo's until the video's is known, then easing to it. */
  aspect(now, inputs, reduced) {
    const goal = inputs.videoAspect > 0 ? inputs.videoAspect : inputs.targetAspect;
    const at = (shape) => {
      const t = reduced ? 1 : clamp01((now - shape.at) / SHAPE_MS);
      return shape.from + (shape.to - shape.from) * smooth(t);
    };
    if (!this.shape) this.shape = { from: goal, to: goal, at: now };
    else if (goal !== this.shape.to) this.shape = { from: at(this.shape), to: goal, at: now };
    const aspect = at(this.shape);
    return { aspect, isMoving: aspect !== goal };
  }
  look(now, inputs) {
    if (inputs.presence <= 0) {
      this.visibleSince = null;
      this.waitingSince = null;
      this.revealStart = null;
      this.shape = null;
      this.bufferingSince = null;
      return null;
    }
    const reduced = this.timing.isReducedMotion();
    this.visibleSince ??= now;
    const sinceVisible = now - this.visibleSince;
    const pulse = !reduced && sinceVisible < PULSE_MS ? Math.sin(Math.PI * sinceVisible / PULSE_MS) : 0;
    let veil = 0;
    let ring = 0;
    let play = 0;
    let glow = 0.9 * pulse;
    let isAnimating = pulse > 0;
    if (inputs.isWaiting && !inputs.isPlaying) this.waitingSince ??= now;
    else if (!inputs.isPlaying) this.waitingSince = null;
    if (this.waitingSince !== null) {
      const t = now - this.waitingSince;
      veil = this.timing.veilOpacity * smooth(clamp01(t / VEIL_MS));
      ring = inputs.isBlocked ? 0 : smooth(clamp01((t - RING_DELAY_MS) / RING_MS));
      play = inputs.isBlocked ? smooth(clamp01(t / VEIL_MS)) : 0;
      if (!reduced) glow = Math.max(glow, 0.22 + 0.1 * Math.sin(now / 1e3 * 2 * Math.PI * 0.7));
      isAnimating = true;
    }
    const progress = inputs.progress;
    const ringProgress = progress !== null && Number.isFinite(progress) ? clamp01(progress) : -1;
    const spin = reduced ? 0.12 : now / 1e3 * 0.9;
    const shape = this.aspect(now, inputs, reduced);
    const aspect = shape.aspect;
    isAnimating ||= shape.isMoving;
    if (!inputs.isPlaying) this.revealStart = null;
    else if (this.revealStart === null) {
      this.revealStart = now;
      const ms = this.hasRevealed ? this.timing.resumeRevealMs : this.timing.revealMs;
      this.revealMs = reduced ? Math.min(ms, REDUCED_REVEAL_MS) : ms;
      this.veilAtReveal = veil;
      this.ringAtReveal = ring;
    }
    if (this.revealStart === null)
      return {
        alpha: inputs.presence,
        aspect,
        veil,
        reveal: 0,
        wave: 0,
        ring,
        ringProgress,
        spin,
        play,
        glow,
        showVideo: false,
        isAnimating
      };
    if (inputs.isBuffering) this.bufferingSince ??= now;
    else this.bufferingSince = null;
    const buffering = this.bufferingSince === null ? 0 : smooth(clamp01((now - this.bufferingSince - BUFFERING_DELAY_MS) / RING_MS));
    const p = this.revealMs > 0 ? clamp01((now - this.revealStart) / this.revealMs) : 1;
    if (p >= 1) {
      this.hasRevealed = true;
      this.waitingSince = null;
      return {
        alpha: inputs.presence,
        aspect,
        veil: 0,
        reveal: 1,
        wave: 0,
        ring: buffering,
        ringProgress: -1,
        spin,
        play: 0,
        glow: 0.9 * pulse,
        showVideo: true,
        isAnimating: pulse > 0 || shape.isMoving || this.bufferingSince !== null
      };
    }
    return {
      alpha: inputs.presence,
      aspect,
      veil: this.veilAtReveal,
      reveal: reduced ? 1 : easeOutCubic(p),
      wave: reduced ? 0 : Math.min(1, 2.4 * p) * (1 - p) ** 1.4,
      ring: Math.max(this.ringAtReveal * (1 - smooth(clamp01(p / 0.3))), buffering),
      ringProgress: buffering > 0 ? -1 : ringProgress,
      spin,
      play: 0,
      glow: 0.9 * pulse,
      showVideo: true,
      // With reduced motion the "reveal" is a fade of the whole plane.
      ...reduced ? { alpha: inputs.presence * p } : {},
      isAnimating: true
    };
  }
};

// packages/engine/src/renderer.ts
var QUAD_VERTEX = `#version 300 es
in vec4 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() { gl_Position = aPosition; vUv = aUv; }`;
var CAMERA_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 color;
void main() { color = vec4(texture(uTexture, vUv).rgb, 1.0); }`;
var PLANE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform vec4 uVideoRect;
uniform float uAspect;
uniform float uAlpha;
uniform float uVeil;
uniform float uReveal;
uniform float uWave;
uniform float uRing;
uniform float uRingProgress;
uniform float uSpin;
uniform float uPlay;
uniform float uGlow;
uniform vec3 uAccent;
out vec4 color;

const float PI = 3.14159265;

float aastep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

// Equilateral triangle (side 2) pointing towards +x in the plane; negative inside.
float triangle(vec2 p) {
  p = vec2(p.y, p.x);
  const float k = 1.7320508;
  p.x = abs(p.x) - 1.0;
  p.y = p.y + 1.0 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0, 0.0);
  return -length(p) * sign(p.y);
}

void over(inout vec3 rgb, inout float a, vec3 c, float ca) {
  rgb = c * ca + rgb * (1.0 - ca);
  a = ca + a * (1.0 - ca);
}

void main() {
  // Target coordinates: height 1, width uAspect, y down. The video region is the video's rect clipped to the photo;
  // q is relative to its centre.
  vec2 scale = vec2(uAspect, 1.0);
  vec4 visible = clamp(uVideoRect, 0.0, 1.0);
  vec2 halfSize = 0.5 * (visible.zw - visible.xy) * scale;
  vec2 q = (vUv - 0.5 * (visible.xy + visible.zw)) * scale;
  float shortEdge = 2.0 * min(halfSize.x, halfSize.y);
  float r = length(q);
  float corner = length(halfSize);

  // The reveal: a soft circle from the region's centre to past its farthest corner.
  float feather = 0.07 * shortEdge;
  float R = uReveal * (corner + feather);
  float inside = uReveal >= 1.0 ? 1.0 : 1.0 - smoothstep(R - feather, R, r);

  vec2 vuv = (vUv - uVideoRect.xy) / (uVideoRect.zw - uVideoRect.xy);
  vec2 d = min(vuv, 1.0 - vuv);
  float inRect = aastep(0.0, min(d.x, d.y));
  vec3 rgb = vec3(0.0);
  float a = 0.0;
  if (uHasVideo > 0.5) {
    float va = inRect * inside;
    // Inset by a fraction of a texel: codecs often leave a stray colour in the outermost row and column.
    rgb = texture(uVideo, clamp(vuv, 0.002, 0.998)).rgb * va;
    a = va;
  }
  // The region outside the revealed circle: dark and see-through while the video is on the way.
  over(rgb, a, vec3(0.0), uVeil * inRect * (1.0 - inside));

  // Recognition glow along the photo's edges, falling off inwards.
  float edge = min(min(vUv.x, 1.0 - vUv.x) * uAspect, min(vUv.y, 1.0 - vUv.y));
  float glow = uGlow * exp(-edge / (0.045 * min(uAspect, 1.0)));
  over(rgb, a, uAccent, 0.85 * glow);

  // Wavefront riding the reveal edge, inside the region: a thin white core in an accent halo.
  float x = r - (R - 0.5 * feather);
  float halo = uWave * inRect * exp(-pow(x / (0.9 * feather), 2.0));
  float core = uWave * inRect * exp(-pow(x / (0.22 * feather), 2.0));
  over(rgb, a, uAccent, clamp(0.75 * halo, 0.0, 1.0));
  over(rgb, a, vec3(1.0), clamp(0.9 * core, 0.0, 1.0));

  // Loading ring: a faint track and an arc (progress from the top, clockwise, or a spinning segment).
  float ringR = 0.1 * shortEdge;
  float ringW = 0.014 * shortEdge;
  float stroke = 1.0 - aastep(ringW, abs(r - ringR));
  float turn = fract(atan(q.x, -q.y) / (2.0 * PI) + 1.0);
  float arc;
  if (uRingProgress >= 0.0) arc = 1.0 - aastep(uRingProgress, turn);
  else arc = 1.0 - aastep(0.3, fract(turn - fract(uSpin) + 1.0));
  over(rgb, a, vec3(0.0), uRing * 0.28 * (1.0 - aastep(ringR + 2.5 * ringW, r)));
  over(rgb, a, vec3(1.0), uRing * stroke * (0.3 + 0.7 * arc));

  // Play mark (playback needs a tap): a dark disc with a white triangle.
  float disc = 1.0 - aastep(ringR * 1.25, r);
  over(rgb, a, vec3(0.0), uPlay * 0.45 * disc);
  float tri = 1.0 - aastep(0.0, triangle((q + vec2(0.12 * ringR, 0.0)) / (0.45 * ringR)));
  over(rgb, a, vec3(1.0), uPlay * tri);

  // Anti-aliased plane edges.
  vec2 e = min(vUv, 1.0 - vUv);
  vec2 w = max(fwidth(vUv), vec2(1e-5));
  float edgeAA = clamp(min(e.x / w.x, e.y / w.y), 0.0, 1.0);
  color = vec4(rgb, a) * (uAlpha * edgeAA);
}`;
function videoRect(targetAspect, videoAspect, fit) {
  if (fit === "fill" || !(videoAspect > 0) || !(targetAspect > 0)) return [0, 0, 1, 1];
  const wider = videoAspect > targetAspect;
  const fraction = wider === (fit === "contain") ? targetAspect / videoAspect : videoAspect / targetAspect;
  if (wider === (fit === "contain")) return [0, (1 - fraction) / 2, 1, (1 + fraction) / 2];
  return [(1 - fraction) / 2, 0, (1 + fraction) / 2, 1];
}
var StageRenderer = class {
  constructor(parent, standardWidth, standardHeight, options) {
    __publicField(this, "canvas");
    __publicField(this, "gl");
    __publicField(this, "programs", null);
    __publicField(this, "videoTextures", /* @__PURE__ */ new Map());
    __publicField(this, "options");
    __publicField(this, "standard");
    __publicField(this, "hasFrame", false);
    __publicField(this, "dirty", false);
    __publicField(this, "raf", 0);
    __publicField(this, "disposed", false);
    __publicField(this, "rawUploads", /* @__PURE__ */ new Map());
    __publicField(this, "cameraUvs", cornerUvs(UPRIGHT));
    __publicField(this, "isContextLost", false);
    __publicField(this, "onContextLost", (event) => {
      event.preventDefault();
      this.isContextLost = true;
      this.programs = null;
      this.videoTextures.clear();
      this.hasFrame = false;
    });
    __publicField(this, "onContextRestored", () => {
      this.isContextLost = false;
      this.rawUploads.clear();
      this.programs = this.createPrograms();
    });
    this.options = options;
    this.standard = { width: standardWidth, height: standardHeight };
    const canvas = parent.ownerDocument.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      zIndex: "1",
      display: "block",
      pointerEvents: "none"
    });
    parent.append(canvas);
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: "default"
    });
    if (!gl) {
      canvas.remove();
      throw new Error("WebGL2 unavailable");
    }
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
    this.programs = this.createPrograms();
    this.loop();
  }
  createPrograms() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
      return shader;
    };
    const link = (fragment) => {
      const program = gl.createProgram();
      gl.attachShader(program, compile(gl.VERTEX_SHADER, QUAD_VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.bindAttribLocation(program, 0, "aPosition");
      gl.bindAttribLocation(program, 1, "aUv");
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link");
      return program;
    };
    const plane = link(PLANE_FRAGMENT);
    const uniforms = /* @__PURE__ */ new Map();
    for (const name of [
      "uVideo",
      "uHasVideo",
      "uVideoRect",
      "uAspect",
      "uAlpha",
      "uVeil",
      "uReveal",
      "uWave",
      "uRing",
      "uRingProgress",
      "uSpin",
      "uPlay",
      "uGlow",
      "uAccent"
    ])
      uniforms.set(name, gl.getUniformLocation(plane, name));
    return {
      camera: link(CAMERA_FRAGMENT),
      plane,
      buffer: gl.createBuffer(),
      cameraTexture: this.texture(),
      uniforms
    };
  }
  texture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  /**
   * Whether `texImage2D` kept a quarter-turned frame's raw planes. Browsers differ (Chromium even by frame backing),
   * so the uploaded texture is checked: a raw texture has the raw width, and a pixel there exists only then.
   */
  uploadedRaw(frame, rotation, texture) {
    const w = frame.visibleRect?.width ?? frame.codedWidth;
    const h = frame.visibleRect?.height ?? frame.codedHeight;
    if (rotation % 180 === 0 || w === h) return false;
    const key = `${rotation}|${w}x${h}|${frame.format}`;
    const known = this.rawUploads.get(key);
    if (known !== void 0) return known;
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixel = new Uint8Array(4).fill(77);
    if (w > h) gl.readPixels(w - 1, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    else gl.readPixels(0, h - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    const raw = !(pixel[0] === 77 && pixel[3] === 77);
    this.rawUploads.set(key, raw);
    return raw;
  }
  /**
   * A processed camera frame becomes the picture on screen (uploaded now and closed); the planes the next draw asks
   * for must be in this frame's standard image.
   */
  presentFrame(frame) {
    const programs = this.programs;
    if (!programs || this.disposed) {
      frame.close();
      return;
    }
    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D, programs.cameraTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      const meta = frameOrientation(frame);
      const orientation = meta && this.uploadedRaw(frame, meta.rotation, programs.cameraTexture) ? meta : UPRIGHT;
      this.cameraUvs = cornerUvs(orientation);
      this.hasFrame = true;
      this.dirty = true;
    } finally {
      frame.close();
    }
  }
  setStandardSize(width, height) {
    this.standard = { width, height };
    this.dirty = true;
  }
  /** Draw again at the next display frame even if nothing seems to change (e.g. a plane appeared). */
  invalidate() {
    this.dirty = true;
  }
  loop() {
    this.raf = requestAnimationFrame((now) => {
      if (this.disposed) return;
      this.loop();
      this.draw(now);
    });
  }
  draw(now) {
    const programs = this.programs;
    if (!programs || this.isContextLost || !this.hasFrame) return;
    const planes = this.options.planes(now);
    const moving = planes.some((p) => p.look.isAnimating || p.look.showVideo && p.player?.frameDirty);
    const canvas = this.canvas;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const resized = canvas.width !== cw || canvas.height !== ch;
    if (!this.dirty && !moving && !resized) return;
    this.dirty = false;
    if (resized) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const gl = this.gl;
    const fit = viewportFromStandard(this.standard.width, this.standard.height, cw, ch, this.options.fit);
    const ndc = (x, y) => [
      2 * (fit.scale * x + fit.offsetX) / cw - 1,
      1 - 2 * (fit.scale * y + fit.offsetY) / ch
    ];
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(programs.camera);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, programs.cameraTexture);
    const sw = this.standard.width;
    const sh = this.standard.height;
    this.quad(
      [ndc(0, 0), ndc(sw, 0), ndc(sw, sh), ndc(0, sh)].flatMap(([x, y]) => [x, y, 0, 1]),
      this.cameraUvs
    );
    if (!planes.length) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(programs.plane);
    const u = (name) => programs.uniforms.get(name) ?? null;
    gl.uniform1i(u("uVideo"), 0);
    gl.uniform3f(u("uAccent"), ...this.options.accent);
    for (const plane of planes) {
      const look = plane.look;
      if (look.alpha <= 0) continue;
      let hasVideo = 0;
      if (look.showVideo && plane.player?.hasPicture) {
        const texture = this.videoTexture(plane.player);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (plane.player.frameDirty) {
          plane.player.frameDirty = false;
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plane.player.video);
          } catch {
          }
        }
        hasVideo = 1;
      }
      gl.uniform1f(u("uHasVideo"), hasVideo);
      gl.uniform4f(u("uVideoRect"), ...videoRect(plane.targetAspect, look.aspect, plane.fit));
      gl.uniform1f(u("uAspect"), plane.targetAspect);
      gl.uniform1f(u("uAlpha"), look.alpha);
      gl.uniform1f(u("uVeil"), look.veil);
      gl.uniform1f(u("uReveal"), look.reveal);
      gl.uniform1f(u("uWave"), look.wave);
      gl.uniform1f(u("uRing"), look.ring);
      gl.uniform1f(u("uRingProgress"), look.ringProgress);
      gl.uniform1f(u("uSpin"), look.spin);
      gl.uniform1f(u("uPlay"), look.play);
      gl.uniform1f(u("uGlow"), look.glow);
      this.quad(this.clipQuad(plane.corners, ndc), [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  }
  videoTexture(player) {
    let texture = this.videoTextures.get(player);
    if (!texture) {
      texture = this.texture();
      this.videoTextures.set(player, texture);
      player.frameDirty = true;
    }
    return texture;
  }
  /** The player is gone: its texture is released. */
  forget(player) {
    const texture = this.videoTextures.get(player);
    if (texture) this.gl.deleteTexture(texture);
    this.videoTextures.delete(player);
  }
  quad(positions, uvs) {
    const gl = this.gl;
    const data = new Float32Array(24);
    for (let i = 0; i < 4; i++) {
      data.set(positions.slice(4 * i, 4 * i + 4), 6 * i);
      data.set(uvs.slice(2 * i, 2 * i + 2), 6 * i + 4);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.programs.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }
  /**
   * Homogeneous clip coordinates of the corners. With the diagonals meeting at p0 + s·(p2 − p0) = p1 + t·(p3 − p1),
   * giving the corners the clip w = 1 − s, 1 − t, s, t makes the GPU's perspective-correct interpolation reproduce
   * the projective mapping across both triangles.
   */
  clipQuad(c, ndc) {
    const p = c.map(([x, y]) => ndc(x, y));
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p;
    const d = (x2 - x0) * (y3 - y1) - (y2 - y0) * (x3 - x1);
    const s = ((x1 - x0) * (y3 - y1) - (y1 - y0) * (x3 - x1)) / d;
    const t = ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)) / d;
    const w = [1 - s, 1 - t, s, t];
    if (!w.every((v) => Number.isFinite(v) && v > 1e-6)) return p.flatMap(([x, y]) => [x, y, 0, 1]);
    return p.flatMap(([x, y], i) => [x * w[i], y * w[i], 0, w[i]]);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
    this.canvas.remove();
  }
};

// packages/engine/src/visibility.ts
var TargetVisibility = class {
  constructor(graceMs) {
    /** Per target in view: the processed-frame time it was first missing at, or null while it is seen. */
    __publicField(this, "missingSince", /* @__PURE__ */ new Map());
    __publicField(this, "graceMs");
    this.graceMs = graceMs;
  }
  /** Targets with a pose in the frame processed at `nowMs`. */
  update(nowMs, seen) {
    const found = [];
    const lost = [];
    const present = new Set(seen);
    for (const id of present) {
      if (!this.missingSince.has(id)) found.push(id);
      this.missingSince.set(id, null);
    }
    for (const [id, since] of this.missingSince) {
      if (present.has(id)) continue;
      if (since === null) this.missingSince.set(id, nowMs);
      if (nowMs - (since ?? nowMs) >= this.graceMs) {
        this.missingSince.delete(id);
        lost.push(id);
      }
    }
    return { found, lost };
  }
  /** 1 while seen; after a miss it falls to 0 over the grace. */
  presence(id, nowMs) {
    if (!this.missingSince.has(id)) return 0;
    const since = this.missingSince.get(id);
    if (since === null || since === void 0) return 1;
    if (this.graceMs <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - (nowMs - since) / this.graceMs));
  }
  isVisible(id) {
    return this.missingSince.has(id);
  }
  visible() {
    return [...this.missingSince.keys()];
  }
  /** Everything counts as lost at once (a stop or a view change); returns the targets that were in view. */
  clear() {
    const ids = [...this.missingSince.keys()];
    this.missingSince.clear();
    return ids;
  }
};

// packages/engine/src/worker-source.ts
var blobUrl = null;
function embeddedUrl() {
  if (blobUrl) return blobUrl;
  if (false)
    throw new EngineError("INVALID_CONFIG", "This engine build has no embedded Worker: pass `workerUrl`");
  blobUrl = URL.createObjectURL(new Blob(['"use strict";(()=>{var $r=Object.defineProperty;var en=(r,e,t)=>e in r?$r(r,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):r[e]=t;var F=(r,e,t)=>en(r,typeof e!="symbol"?e+"":e,t);var Z=class{constructor(){F(this,"rows",new Int32Array(0));F(this,"levels",[])}build(e,t,n=24){let o=[{...e,scale:1}];for(let a=1;a<t;a++){let s=o[a-1],m=s.width>>1,l=s.height>>1;if(m<n||l<n)break;this.rows.length<s.width*l&&(this.rows=new Int32Array(s.width*l));let c=this.levels[a]=this.levels[a]&&this.levels[a].length===m*l?this.levels[a]:new Uint8Array(m*l);tn(s,m,l,this.rows,c),o.push({width:m,height:l,stride:m,data:c,scale:s.scale*2})}return{levels:o}}};function tn(r,e,t,n,o){let a=r.width,s=r.height,m=r.data,l=r.stride;for(let c=0;c<t;c++){let i=2*c,d=Math.max(0,i-1)*l,u=i*l,p=Math.min(s-1,i+1)*l,f=Math.min(s-1,i+2)*l,y=c*a;for(let g=0;g<a;g++)n[y+g]=m[d+g]+3*m[u+g]+3*m[p+g]+m[f+g]}for(let c=0;c<t;c++){let i=c*a;for(let d=0;d<e;d++){let u=2*d,p=n[i+Math.max(0,u-1)],f=n[i+u],y=n[i+Math.min(a-1,u+1)],g=n[i+Math.min(a-1,u+2)];o[c*e+d]=p+3*f+3*y+g+32>>6}}}function kt(r,e,t=24){return new Z().build(r,e,t)}function be(r,e){let{width:t,height:n,stride:o,data:a}=r,s=e&&e.gx.length===t*n?e.gx:new Float32Array(t*n),m=e&&e.gy.length===t*n?e.gy:new Float32Array(t*n);for(let l=1;l<n-1;l++){let c=(l-1)*o,i=l*o,d=(l+1)*o;for(let u=1;u<t-1;u++)s[l*t+u]=(3*(a[c+u+1]-a[c+u-1])+10*(a[i+u+1]-a[i+u-1])+3*(a[d+u+1]-a[d+u-1]))/32,m[l*t+u]=(3*(a[d+u-1]-a[c+u-1])+10*(a[d+u]-a[c+u])+3*(a[d+u+1]-a[c+u+1]))/32}return{width:t,height:n,gx:s,gy:m}}function ee(r,e,t){let n=e-.5,o=t-.5,a=Math.floor(n),s=Math.floor(o);if(a<0||s<0||a+1>=r.width||s+1>=r.height)return NaN;let m=n-a,l=o-s,c=r.data,i=s*r.stride+a,d=c[i]+m*(c[i+1]-c[i]),u=c[i+r.stride]+m*(c[i+r.stride+1]-c[i+r.stride]);return d+l*(u-d)}function Bt(r,e,t,n){let o=e-.5,a=t-.5,s=Math.floor(o),m=Math.floor(a),l=o-s,c=a-m,i=r.data,d=r.stride,u=(m-1)*d+s-1,p=u+d,f=p+d,y=f+d,g=i[u],A=i[u+1],w=i[u+2],x=i[u+3],h=i[p],v=i[p+1],I=i[p+2],E=i[p+3],M=i[f],b=i[f+1],P=i[f+2],U=i[f+3],C=i[y],O=i[y+1],T=i[y+2],B=i[y+3],R=3*(w-g)+10*(I-h)+3*(P-M),k=3*(x-A)+10*(E-v)+3*(U-b),D=3*(I-h)+10*(P-M)+3*(T-C),Q=3*(E-v)+10*(U-b)+3*(B-O),N=3*(M-g)+10*(b-A)+3*(P-w),z=3*(b-A)+10*(P-w)+3*(U-x),S=3*(C-h)+10*(O-v)+3*(T-I),L=3*(O-v)+10*(T-I)+3*(B-E),_=v+l*(I-v),W=b+l*(P-b);n[0]=_+c*(W-_);let H=R+l*(k-R),Y=D+l*(Q-D);n[1]=(H+c*(Y-H))/32;let G=N+l*(z-N),q=S+l*(L-S);n[2]=(G+c*(q-G))/32}function me(r,e,t,n){let o=t-.5,a=n-.5,s=Math.floor(o),m=Math.floor(a),l=o-s,c=a-m,i=m*e+s,d=r[i]+l*(r[i+1]-r[i]),u=r[i+e]+l*(r[i+e+1]-r[i+e]);return d+c*(u-d)}function oe(r,e,t,n,o=1){return t>=.5+o&&n>=.5+o&&t<r-.5-o&&n<e-.5-o}var or=Object.freeze({sha256:"d51fe1439175bb1343361385d7910036f36a63ed17a83311619a3b04cfa3e837",byteLength:4375,base64:"AGFzbQEAAAABKAVgCn9/f39/f39/f38Bf2AFf39/f38AYAZ/f39/f38AYAF/AX9gAAADBgUAAQIDBAUDAQARBhkDfwFBgIDAAAt/AEGQgMAAC38AQYSAwAALB2IIBm1lbW9yeQIABWZhc3Q5AAAIbmVhcmVzdDIAARBuZWFyZXN0Ml9ncm91cGVkAAIHcmVzZXJ2ZQADC19faGVhcF9iYXNlAwEKcmVzZXRfaGVhcAAECl9fZGF0YV9lbmQDAgr5HQW/EAwIfwF7BX8EewF/DXsBfwJ7AX8HewF/FXsjgICAgABBwAJrIgokgICAgABBACELAkAgAyAFTw0AIAIgBE8NAEF9IAFrIQwgAUEDbCENQQMgAWshDiABQX1sIQ9BACABQQF0IhBrIREgBkH/ASAGQf8BSRv9DyESQQAhCwNAIAMgCGwhEyAAIAMgAWxqIRQgAiEVA0ACQEH//wNBfyAEIBVrIgZ0QX9zQf//A3EgBkEPSxsiFiAUIBVqIgYgDWoiF/0AAAAiGCAG/QAAACIZIBL9cyIa/SYiGyAGIA9qIhz9AAAAIh0gGv0mIh79UCAGQX1q/QAAACIfIBr9JiIgIAb9AAADIiEgGv0mIiL9UP1OIBggGSAS/XAiGf0oIiMgHSAZ/SgiJP1QICEgGf0oIiUgHyAZ/SgiJv1Q/U79UP1kcUUNACAWICIgBiAOav0AAAAiJyAa/SYiKP1OIikgBiAQaiIqQQJq/QAAACIrIBr9JiIsIAYgAWoiLUEDav0AAAAiLiAa/SYiL/1OIjD9TiIxIB4gHEF/av0AAAAiMiAa/SYiM/1OIjQgBiARaiI1QQJq/QAAACI2IBr9JiI3IBxBAWr9AAAAIjggGv0mIjn9TiI6/U4iO/1OIBdBAWr9AAAAIjwgGv0mIj39TiAsICggN/1OIj4gLyAi/U4iP/1OIkAgMyA1QX5q/QAAACJBIBr9JiJC/U4iQyA5IB79TiJE/U4iRf1O/U4gOiAp/U4iRiBCIAYgDGr9AAAAIikgGv0mIjr9TiJHIDT9TiJI/U4gL/1OICIgPiBE/U4iPiBDIDogIP1OIi/9TiJD/U79TiA7ICAgLUF9av0AAAAiIiAa/SYiNP1OIkQgR/1OIkf9TiAo/U4gNyBFIDQgKkF+av0AAAAiKCAa/SYiO/1OIkkgL/1OIkr9Tv1OIEggOyAXQX9q/QAAACIvIBr9JiI3/U4iRSBE/U4iRP1OIDn9TiAeIEMgSSA3IBv9TiI5/U4iSP1O/U4gMyBH/U4gRSAbID39TiIe/U4iM/1OIEIgSiA9ICz9TiIsIDn9TiI5/U79TiA6IET9TiAwIB79TiIe/U4gICBIICwgP/1OIiz9Tv1OIDQgMf1OIDP9TiA7IDkgQP1O/U4gNyBG/U4gHv1OIBsgLCA+/U79Tv1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1kICUgJyAZ/SgiG/1OIkIgKyAZ/SgiHiAuIBn9KCIg/U4iOv1OIjQgJCAyIBn9KCIs/U4iOyA2IBn9KCIzIDggGf0oIjf9TiIw/U4iMf1OIDwgGf0oIjn9TiAeIBsgM/1OIj4gICAl/U4iP/1OIkAgLCBBIBn9KCI9/U4iQyA3ICT9TiJE/U4iRf1O/U4gMCBC/U4iMCA9ICkgGf0oIkL9TiJGIDv9TiI7/U4gIP1OICUgPiBE/U4iPiBDIEIgJv1OIkT9TiJD/U79TiAxICYgIiAZ/SgiIP1OIkcgRv1OIkb9TiAb/U4gMyBFICAgKCAZ/SgiG/1OIjEgRP1OIkT9Tv1OIDsgGyAvIBn9KCIl/U4iMyBH/U4iRf1OIDf9TiAkIEMgMSAlICP9TiI3/U4iO/1O/U4gLCBG/U4gMyAjIDn9TiIk/U4iLP1OID0gRCA5IB79TiIeIDf9TiIz/U79TiBCIEX9TiA6ICT9TiIk/U4gJiA7IB4gP/1OIh79Tv1OICAgNP1OICz9TiAbIDMgQP1O/U4gJSAw/U4gJP1OICMgHiA+/U79Tv1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1Q/VD9UP1kIhxycSIGRQ0AIAogMiAZ/XP9CwTwASAKIEEgGf1z/QsE4AEgCiApIBn9c/0LBNABIAogHyAZ/XP9CwTAASAKICIgGf1z/QsEsAEgCiAoIBn9c/0LBKABIAogLyAZ/XP9CwSQASAKIBggGf1z/QsEgAEgCiA8IBn9c/0LBHAgCiArIBn9c/0LBGAgCiAuIBn9c/0LBFAgCiAhIBn9c/0LBEAgCiAnIBn9c/0LBDAgCiA2IBn9c/0LBCAgCiA4IBn9c/0LBBAgCiAdIBn9c/0LBABBACEX/QwAAAAAAAAAAAAAAAAAAAAAIhkhGwNAIBsgCiAXav0ABAAiHv2KAf2OASEbIBkgHv2JAf2OASEZIBdBEGoiF0GAAkcNAAsgCiAaIDL9c/0LBPABIAogGiBB/XP9CwTgASAKIBogKf1z/QsE0AEgCiAaIB/9c/0LBMABIAogGiAi/XP9CwSwASAKIBogKP1z/QsEoAEgCiAaIC/9c/0LBJABIAogGiAY/XP9CwSAASAKIBogPP1z/QsEcCAKIBogK/1z/QsEYCAKIBogLv1z/QsEUCAKIBogIf1z/QsEQCAKIBogJ/1z/QsEMCAKIBogNv1z/QsEICAKIBogOP1z/QsEECAKIBogHf1z/QsEAEEAIRf9DAAAAAAAAAAAAAAAAAAAAAAiHiEaA0AgGiAKIBdq/QAEACIg/YoB/Y4BIRogHiAg/YkB/Y4BIR4gF0EQaiIXQYACRw0ACyAKIBv9CwSQAiAKIBn9CwSAAiAKIBr9CwSwAiAKIB79CwSgAiAcIBZxISogFSATaiEtIAkgC0ECdGohFwNAIAcgLSAGaCIcaiIWQQF0aiAKQYACaiAKQaACaiAqIBx2QQFxGyAcQQF0ai8BAEEBajsBACAXIBY2AgAgF0EEaiEXIAtBAWohCyAGQX9qIAZxIgYNAAsLIBVBEGoiFSAESQ0ACyADQQFqIgMgBUcNAAsLIApBwAJqJICAgIAAIAsL/wUGAn8CewR/AXsCfwF+AkAgAUUNAAJAIANFDQBBACEFA0AgACAFQQV0aiIG/QAAECEHIAb9AAAAIQhBfyEJQYECIQYgAiEKQQAhC0GBAiEMA0AgBiAKQRBq/QAAACAH/VH9YiAK/QAAACAI/VH9Yv1u/X39fyIN/RsAIA39GwFqIA39GwJqIA39GwNqIg4gDCAOIAxJGyAOIAZJIg8bIQwgCyAJIA8bIQkgCkEgaiEKIA4gBiAPGyIOIQYgAyALQQFqIgtHDQALIAQgBUEMbGoiBiAJNgIAIAZBCGogDDYCACAGQQRqIA42AgAgBUEBaiIFIAFHDQAMAgsLQQAhDwJAIAFBGEkNAEEAIQ8gBEEEaiIGIAFBf2qtQgx+IhCnIgpqIAZJDQAgBEEIaiIGIApqIAZJDQAgEEIgiKdBAEcNAP0MAAAAAAEAAAACAAAAAwAAACEHIAFBfHEiDyELA0AgBCAH/QwMAAAADAAAAAwAAAAMAAAA/bUBIg39GwBqIgZBfzYCACAEIA39GwFqIgpBfzYCACAEIA39GwJqIg5BfzYCACAEIA39GwNqIgxBfzYCACAGQQRqQYECNgIAIApBBGpBgQI2AgAgDkEEakGBAjYCACAMQQRqQYECNgIAIAZBCGpBgQI2AgAgCkEIakGBAjYCACAOQQhqQYECNgIAIAxBCGpBgQI2AgAgB/0MBAAAAAQAAAAEAAAABAAAAP2uASEHIAtBfGoiCw0ACyABIA9GDQELIA8hDgJAIAFBA3EiCkUNACAPIApqIQ4gBCAPQQxsaiEGA0AgBkL/////nyA3AgAgBkEIakGBAjYCACAGQQxqIQYgCkF/aiIKDQALCyAPIAFrQXxLDQAgASAOayEKIAQgDkEMbGohBgNAIAb9DP////8BAQAAAQEAAP/////9CwIAIAZBIGr9DAEBAAD/////AQEAAAEBAAD9CwIAIAZBEGr9DAEBAAABAQAA/////wEBAAD9CwIAIAZBMGohBiAKQXxqIgoNAAsLC7kGBgJ/AnsGfwF7An8BfgJAIAFFDQACQCAERQ0AQQAhBgNAIAAgBkEFdGoiB/0AABAhCCAH/QAAACEJQX8hCkGBAiELIAIhByADIQxBACENQYECIQ5BfyEPA0AgB0EQav0AAAAgCP1R/WIgB/0AAAAgCf1R/WL9bv19/X8iEP0bACAQ/RsBaiAQ/RsCaiAQ/RsDaiERAkACQCAMKAIAIhIgCkYNAAJAIBEgC08NACANIQ8gCyEOIBIhCiARIQsMAgsgESAOIBEgDkkbIQ4MAQsgESALIBEgC0kiEhshCyANIA8gEhshDwsgB0EgaiEHIAxBBGohDCAEIA1BAWoiDUcNAAsgBSAGQQxsaiIHIA82AgAgB0EIaiAONgIAIAdBBGogCzYCACAGQQFqIgYgAUcNAAwCCwtBACEPAkAgAUEYSQ0AQQAhDyAFQQRqIgcgAUF/aq1CDH4iE6ciEWogB0kNACAFQQhqIgcgEWogB0kNACATQiCIp0EARw0A/QwAAAAAAQAAAAIAAAADAAAAIQggAUF8cSIPIQsDQCAFIAj9DAwAAAAMAAAADAAAAAwAAAD9tQEiEP0bAGoiB0F/NgIAIAUgEP0bAWoiEUF/NgIAIAUgEP0bAmoiDEF/NgIAIAUgEP0bA2oiDUF/NgIAIAdBBGpBgQI2AgAgEUEEakGBAjYCACAMQQRqQYECNgIAIA1BBGpBgQI2AgAgB0EIakGBAjYCACARQQhqQYECNgIAIAxBCGpBgQI2AgAgDUEIakGBAjYCACAI/QwEAAAABAAAAAQAAAAEAAAA/a4BIQggC0F8aiILDQALIAEgD0YNAQsgDyEMAkAgAUEDcSIRRQ0AIA8gEWohDCAFIA9BDGxqIQcDQCAHQv////+fIDcCACAHQQhqQYECNgIAIAdBDGohByARQX9qIhENAAsLIA8gAWtBfEsNACABIAxrIREgBSAMQQxsaiEHA0AgB/0M/////wEBAAABAQAA//////0LAgAgB0Egav0MAQEAAP////8BAQAAAQEAAP0LAgAgB0EQav0MAQEAAAEBAAD/////AQEAAP0LAgAgB0EwaiEHIBFBfGoiEQ0ACwsLZQEDfwJAQQAoAoCAwIAAIgENAEEAQZ+AwIAAQXBxIgE2AoCAwIAACwJAIAAgAWpBD2pBcHEiAEH//wNqQRB2IgI/ACIDTQ0AIAIgA2tAAEF/Rw0AQQAPC0EAIAA2AoCAwIAAIAELFABBAEGfgMCAAEFwcTYCgIDAgAALAGwEbmFtZQAWFWxpdmVtaXJhX2tlcm5lbHMud2FzbQE5BQAFZmFzdDkBCG5lYXJlc3QyAhBuZWFyZXN0Ml9ncm91cGVkAwdyZXNlcnZlBApyZXNldF9oZWFwBxIBAA9fX3N0YWNrX3BvaW50ZXIATQlwcm9kdWNlcnMCCGxhbmd1YWdlAQRSdXN0AAxwcm9jZXNzZWQtYnkBBXJ1c3RjHTEuOTUuMCAoNTk4MDc2MTZlIDIwMjYtMDQtMTQpAJ0BD3RhcmdldF9mZWF0dXJlcwkrC2J1bGstbWVtb3J5Kw9idWxrLW1lbW9yeS1vcHQrFmNhbGwtaW5kaXJlY3Qtb3ZlcmxvbmcrCm11bHRpdmFsdWUrD211dGFibGUtZ2xvYmFscysTbm9udHJhcHBpbmctZnB0b2ludCsPcmVmZXJlbmNlLXR5cGVzKwhzaWduLWV4dCsHc2ltZDEyOA=="});function rn(r){let e=atob(r),t=new Uint8Array(e.length);for(let n=0;n<e.length;n++)t[n]=e.charCodeAt(n);return t}var Fe;function Je(){if(typeof WebAssembly>"u")return null;try{if(Fe===void 0){let r=rn(or.base64);Fe=WebAssembly.validate(r)?new WebAssembly.Module(r):null}return Fe?new WebAssembly.Instance(Fe,{}).exports:null}catch{return Fe=null,null}}var nn=[[0,-3],[1,-3],[2,-2],[3,-1],[3,0],[3,1],[2,2],[1,3],[0,3],[-1,3],[-2,2],[-3,1],[-3,0],[-3,-1],[-2,-2],[-1,-3]];function on(r,e,t,n){let o=r[e],a=o+n,s=o-n,m=r[e+t[0]],l=r[e+t[8]];if(m<=a&&m>=s&&l<=a&&l>=s)return 0;let c=r[e+t[4]],i=r[e+t[12]];if(c<=a&&c>=s&&i<=a&&i>=s)return 0;let d=0,u=0,p=0,f=0;for(let y=0;y<16;y++){let g=r[e+t[y]];g>a?(d|=1<<y,p+=g-a):g<s&&(u|=1<<y,f+=s-g)}return ar(d)?p+1:ar(u)?f+1:0}function ar(r){if(!r)return!1;let e=(r|r<<16)>>>0,t=e;for(let n=1;n<9;n++)t&=e>>>n;return t!==0}var $e=class{constructor(){F(this,"backend","js");F(this,"map",new Uint16Array(0));F(this,"image",null);F(this,"offsets",new Int32Array(16))}begin(e){return this.map.length<e.width*e.height&&(this.map=new Uint16Array(e.width*e.height)),this.image=e,this.offsets=Int32Array.from(nn.map(([t,n])=>n*e.stride+t)),this.map}score(e,t,n,o,a,s){let{width:m,stride:l,data:c}=this.image;for(let i=t;i<o;i++)for(let d=e;d<n;d++){let u=on(c,i*l+d,this.offsets,a);u>0&&(this.map[i*m+d]=u,s.push(i*m+d))}}},Rt=class{constructor(e){F(this,"backend","wasm-simd");F(this,"k");F(this,"capacity",0);F(this,"img",0);F(this,"scores",0);F(this,"found",0);F(this,"map",new Uint16Array(0));F(this,"image",null);this.k=e}begin(e){let t=e.stride*e.height;if(t>this.capacity){let n=this.k;if(n.reset_heap(),this.img=n.reserve(t+16),this.scores=n.reserve(2*t),this.found=n.reserve(4*t),!this.img||!this.scores||!this.found)throw new Error("fast9: out of memory");this.capacity=t,new Uint16Array(n.memory.buffer,this.scores,t).fill(0)}return new Uint8Array(this.k.memory.buffer,this.img,t).set(e.data.subarray(0,t)),this.map=new Uint16Array(this.k.memory.buffer,this.scores,e.width*e.height),this.image=e,this.map}score(e,t,n,o,a,s){let m=this.image,l=this.k.fast9(this.img,m.stride,e,t,n,o,a,this.scores,m.width,this.found),c=new Uint32Array(this.k.memory.buffer,this.found,l);for(let i=0;i<l;i++)s.push(c[i])}};function an(r){let n=new Uint8Array(2867),o=2654435769;for(let m=0;m<47;m++)for(let l=0;l<61;l++){o^=o<<13,o^=o>>>17,o^=o<<5;let c=(o>>>0)%64;n[m*61+l]=l<20?128:l<40?((l>>2)+(m>>2))%2?230-c:20+c:c*4}let a={width:61,height:47,stride:61,data:n},s=new $e;for(let m of[4,16,40]){let l=[],c=[],i=s.begin(a),d=r.begin(a);if(s.score(3,3,43,44,m,l),r.score(3,3,43,44,m,c),l.length!==c.length||l.some((u,p)=>u!==c[p]||i[u]!==d[u]))return!1;for(let u of l)i[u]=0;for(let u of c)d[u]=0;if(m===16&&l.length<10)return!1}return!0}var Ze=null;function sr(r=!0){if(!Ze){let e=Je(),t=null;try{t=e?new Rt(e):null,t&&!an(t)&&(t=null)}catch{t=null}Ze={wasm:t,js:new $e}}return r&&Ze.wasm||Ze.js}var ae=15,et=ae+3,Ie=32,sn=(()=>{let r=625341585,e=()=>(r^=r<<13,r>>>=0,r^=r>>>17,r^=r<<5,r>>>=0,(r+.5)/4294967296),t=()=>Math.sqrt(-2*Math.log(e()))*Math.cos(2*Math.PI*e()),n=new Int8Array(1024);for(let o=0;o<256;){let a=[0,1,2,3].map(()=>Math.round(t()*8.5));Math.hypot(a[0],a[1])>15||Math.hypot(a[2],a[3])>15||Math.hypot(a[0]-a[2],a[1]-a[3])<2||(n.set(a,4*o),o++)}return n})(),rt=2;function ln(r){return Array.from({length:Ie},(e,t)=>{let n=2*Math.PI*t/Ie,o=Math.cos(n),a=Math.sin(n),s=new Int8Array(1024);for(let m=0;m<512;m++){let l=r[2*m],c=r[2*m+1];s[2*m]=Math.round(o*l-a*c),s[2*m+1]=Math.round(a*l+o*c)}return s})}var ir=new WeakMap;function cn(r){let e=ir.get(r);if(!e){let t=r.length===1024;for(let n=0;n<512&&t;n++)t=Math.hypot(r[2*n],r[2*n+1])<=15;if(!t)throw new Error("BRIEF pattern: 256 tests with box centres within 15 px");e=ln(r),ir.set(r,e)}return e}var mn=(()=>{let r=new Int32Array(ae+1);for(let e=0;e<=ae;e++)r[e]=Math.floor(Math.sqrt(ae*ae-e*e)+.5);return r})(),tt=class{constructor(){F(this,"octaves",new Z);F(this,"halfOctaves",new Z);F(this,"horizontal",new Uint16Array(0));F(this,"blur",new Uint8Array(0));F(this,"half",new Uint8Array(0));F(this,"integral",new Int32Array(0))}},lr=new tt;function un(r,e){let t=r.width,n=r.height,o=Math.floor(t/Math.SQRT2),a=Math.floor(n/Math.SQRT2),s=r.data;e.horizontal.length<t*n&&(e.horizontal=new Uint16Array(t*n),e.blur=new Uint8Array(t*n)),e.half.length!==o*a&&(e.half=new Uint8Array(o*a));let m=e.horizontal;for(let u=0;u<n;u++){let p=u*r.stride,f=u*t;m[f]=3*s[p]+s[p+1];for(let y=1;y<t-1;y++)m[f+y]=s[p+y-1]+2*s[p+y]+s[p+y+1];m[f+t-1]=s[p+t-2]+3*s[p+t-1]}let l=e.blur;for(let u=0;u<n;u++){let p=Math.max(0,u-1)*t,f=u*t,y=Math.min(n-1,u+1)*t;for(let g=0;g<t;g++)l[f+g]=m[p+g]+2*m[f+g]+m[y+g]+8>>4}let c=new Int32Array(o),i=new Float32Array(o);for(let u=0;u<o;u++){let p=(u+.5)*Math.SQRT2-.5;c[u]=Math.min(t-2,Math.max(0,Math.floor(p))),i[u]=p-c[u]}let d=e.half;for(let u=0;u<a;u++){let p=(u+.5)*Math.SQRT2-.5,f=Math.min(n-2,Math.max(0,Math.floor(p))),y=p-f,g=f*t,A=g+t;for(let w=0;w<o;w++){let x=c[w],h=i[w],v=l[g+x]+h*(l[g+x+1]-l[g+x]),I=l[A+x]+h*(l[A+x+1]-l[A+x]);d[u*o+w]=v+y*(I-v)+.5|0}}return{width:o,height:a,stride:o,data:d}}function dn(r,e,t=new tt){let n=Math.ceil(e/2),o=t.octaves.build(r,n,24).levels,a=t.halfOctaves.build(un(r,t),n,24).levels,s=[];for(let m=0;m<n;m++)o[m]&&s.push({image:o[m],scale:2**m}),a[m]&&s.push({image:a[m],scale:Math.SQRT2*2**m});return s.slice(0,e)}function yn(r,e,t,n){let o=0,a=0,s=0;for(let m=-3;m<=3;m++)for(let l=-3;l<=3;l++){let c=(n+m)*e+t+l,i=r[c+1]-r[c-1],d=r[c+e]-r[c-e];o+=i*i,a+=d*d,s+=i*d}return o*a-s*s-.04*(o+a)**2}function fn(r,e){let t=r.width+1;e.integral.length<t*(r.height+1)&&(e.integral=new Int32Array(t*(r.height+1)));let n=e.integral;n.fill(0,0,t);for(let o=0;o<r.height;o++){n[(o+1)*t]=0;let a=0;for(let s=0;s<r.width;s++)a+=r.data[o*r.stride+s],n[(o+1)*t+s+1]=n[o*t+s+1]+a}return n}function pn(r,e,t,n,o){let{width:a,height:s,stride:m,data:l}=r,c=t.cell,i=[],d=Math.max(et,Math.floor(n.x0)),u=Math.max(et,Math.floor(n.y0)),p=Math.min(a-et,Math.ceil(n.x1)),f=Math.min(s-et,Math.ceil(n.y1));if(p<=d||f<=u)return i;let y=o.begin(r),g=[];for(let A=u;A<f;A+=c)for(let w=d;w<p;w+=c){let x=Math.min(f,A+c),h=Math.min(p,w+c);g.length=0;let v=255,I=0;for(let b=A;b<x;b+=2)for(let P=w;P<h;P+=2){let U=l[b*m+P];U<v&&(v=U),U>I&&(I=U)}if(I-v<2*t.minFastThreshold)continue;for(let b=t.fastThreshold;o.score(w,A,h,x,b,g),!(g.length>=2||b===t.minFastThreshold);b=t.minFastThreshold){for(let P of g)y[P]=0;g.length=0}let E=[];for(let b of g){let P=y[b],U=!0;for(let C=-1;C<=1&&U;C++)for(let O=-1;O<=1;O++){if(!O&&!C)continue;let T=y[b+C*a+O];if(T>P||T===P&&(C<0||C===0&&O<0)){U=!1;break}}U&&E.push({i:b,s:P})}for(let b of g)y[b]=0;E.sort((b,P)=>P.s-b.s||b.i-P.i);let M=[];for(let b of E.slice(0,8)){let P=b.i%a,U=(b.i-P)/a,C=yn(l,m,P,U);C>0&&M.push({x:P,y:U,score:C})}M.sort((b,P)=>P.score-b.score||b.y-P.y||b.x-P.x),i.push(...M.slice(0,2))}return i.sort((A,w)=>w.score-A.score||A.y-w.y||A.x-w.x),i.slice(0,e)}function An(r,e,t){let n=r.data,o=r.stride,a=0,s=0,m=t*o+e;for(let l=-ae;l<=ae;l++)s+=l*n[m+l];for(let l=1;l<=ae;l++){let c=0,i=mn[l];for(let d=-i;d<=i;d++){let u=n[m-l*o+d],p=n[m+l*o+d];c+=p-u,s+=d*(u+p)}a+=l*c}return Math.atan2(a,s)}function gn(r){return(Math.round(r*Ie/(2*Math.PI))%Ie+Ie)%Ie}function hn(r,e,t,n,o,a,s,m){let l=a[gn(o)],c=(n-2)*e+(t-2),i=5*e;for(let d=0;d<32;d++){let u=0;for(let p=0;p<8;p++){let f=4*(8*d+p),y=c+l[f+1]*e+l[f],g=c+l[f+3]*e+l[f+2],A=r[y+i+5]-r[y+5]-r[y+i]+r[y],w=r[g+i+5]-r[g+5]-r[g+i]+r[g];A<w&&(u|=1<<p)}s[m+d]=u}}function Ce(r,e={}){let t=e.budget??700,n=dn(r,e.levels??6,lr),o={fastThreshold:e.fastThreshold??16,minFastThreshold:e.minFastThreshold??4,cell:e.cell??24},a=sr(e.wasm!==!1),s=cn(e.pattern??sn),m=n.reduce((A,w)=>A+w.image.width*w.image.height,0),l=e.roi??{x:0,y:0,width:r.width,height:r.height},c=[],i=[],d=[],u=[],p=[],f=[];n.forEach((A,w)=>{let x=Math.max(16,Math.round(t*A.image.width*A.image.height/m)),h=A.scale,v=pn(A.image,x,o,{x0:l.x/h,y0:l.y/h,x1:(l.x+l.width)/h,y1:(l.y+l.height)/h},a);if(!v.length)return;let I=fn(A.image,lr),E=new Uint8Array(32*v.length);v.forEach((M,b)=>{let P=An(A.image,M.x,M.y);hn(I,A.image.width+1,M.x,M.y,P,s,E,32*b),c.push((M.x+.5)*h),i.push((M.y+.5)*h),d.push(w),u.push(P),p.push(M.score)}),f.push(E)});let y=new Uint8Array(32*c.length),g=0;for(let A of f)y.set(A,g),g+=A.length;return{count:c.length,x:Float32Array.from(c),y:Float32Array.from(i),level:Uint8Array.from(d),angle:Float32Array.from(u),score:Float32Array.from(p),descriptors:y,descriptorBytes:32}}function bn(r,e,t){let n=t*Math.PI/180,o=Math.cos(n),a=Math.sin(n),s=o*o/e+a*a,m=o*a/e-o*a,l=a*a/e+o*o,c=[[0,0],[r.width,0],[r.width,r.height],[0,r.height]].map(([I,E])=>[s*I+m*E,m*I+l*E]),i=Math.min(...c.map(I=>I[0])),d=Math.min(...c.map(I=>I[1])),u=Math.ceil(Math.max(...c.map(I=>I[0]))-i),p=Math.ceil(Math.max(...c.map(I=>I[1]))-d),f=[s,m,-i,m,l,-d],y=.8*Math.sqrt(Math.max(0,e*e-1)),g=y>.3?cr(r,y):r,A=s*l-m*m,w=l/A,x=-m/A,h=s/A,v=new Uint8Array(u*p).fill(128);for(let I=0;I<p;I++)for(let E=0;E<u;E++){let M=E+.5-f[2],b=I+.5-f[5],P=w*M+x*b-.5,U=x*M+h*b-.5,C=Math.floor(P),O=Math.floor(U);if(C<0||O<0||C+1>=r.width||O+1>=r.height)continue;let T=P-C,B=U-O,R=O*g.stride+C,k=g.data,D=k[R]+T*(k[R+1]-k[R]),Q=k[R+g.stride]+T*(k[R+g.stride+1]-k[R+g.stride]);v[I*u+E]=Math.round(D+B*(Q-D))}return{image:{width:u,height:p,stride:u,data:v},A:f}}function cr(r,e){let t=Math.ceil(3*e),n=Array.from({length:2*t+1},(l,c)=>Math.exp(-((c-t)**2)/(2*e*e))),o=n.reduce((l,c)=>l+c,0),a=n.map(l=>l/o),s=new Float32Array(r.width*r.height);for(let l=0;l<r.height;l++)for(let c=0;c<r.width;c++){let i=0;for(let d=-t;d<=t;d++)i+=a[d+t]*r.data[l*r.stride+Math.min(r.width-1,Math.max(0,c+d))];s[l*r.width+c]=i}let m=new Uint8Array(r.width*r.height);for(let l=0;l<r.height;l++)for(let c=0;c<r.width;c++){let i=0;for(let d=-t;d<=t;d++)i+=a[d+t]*s[Math.min(r.height-1,Math.max(0,l+d))*r.width+c];m[l*r.width+c]=Math.round(i)}return{width:r.width,height:r.height,stride:r.width,data:m}}function In(r,e,t,n){let o=0;for(let a=0;a<32;a++){let s=r[e+a]^t[n+a];for(;s;)s&=s-1,o++}return o}function Te(r,e={}){let t=e.tilts??[1.4,2,2.8],n=e.longitudes??[0,45,90,135],o=[{image:r.image,A:[1,0,0,0,1,0]}];for(let A of t)for(let w of n)o.push(bn(r.image,A,w));for(let A of e.blurs??[2.5])o.push({image:cr(r.image,A),A:[1,0,0,0,1,0]});let a=[],s=new Map,m=4,l=(A,w)=>Math.floor(w/m)*65536+Math.floor(A/m);o.forEach((A,w)=>{let x=Ce(A.image,{budget:900,...e.orb}),[h,v,I,E,M,b]=A.A,P=h*M-v*E;for(let U=0;U<x.count;U++){let C=x.x[U]-I,O=x.y[U]-b,T=(M*C-v*O)/P,B=(-E*C+h*O)/P;if(T<0||B<0||T>=r.info.width||B>=r.info.height)continue;let R=2+1.5*(2**(x.level[U]/2)-1),k=-1;for(let Q=-1;Q<=1&&k<0;Q++)for(let N=-1;N<=1&&k<0;N++)for(let z of s.get(l(T+N*m,B+Q*m))??[]){let S=a[z];if(Math.hypot(S.x-T,S.y-B)<=R){k=z;break}}let D=x.descriptors.slice(32*U,32*U+32);if(k<0){a.push({x:T,y:B,n:1,views:new Set([w]),score:x.score[U],desc:[D]});let Q=l(T,B);s.set(Q,[...s.get(Q)??[],a.length-1])}else{let Q=a[k];Q.views.add(w),Q.n++,Q.score=Math.max(Q.score,x.score[U]),Q.desc.push(D)}}});let c=e.maxPoints??700,i=e.descriptorsPerPoint??3,d=a.map((A,w)=>({g:A,i:w})).sort((A,w)=>w.g.views.size-A.g.views.size||w.g.score-A.g.score||A.i-w.i).slice(0,c).map(A=>A.g),u=new Float32Array(2*d.length),p=new Uint8Array(d.length),f=[],y=[];d.forEach((A,w)=>{u[2*w]=A.x,u[2*w+1]=A.y,p[w]=A.views.size;let x=[];for(let h of A.desc){if(x.length>=i)break;x.every(v=>In(v,0,h,0)>24)&&x.push(h)}for(let h of x)f.push(h),y.push(w)});let g=new Uint8Array(32*f.length);return f.forEach((A,w)=>g.set(A,32*w)),{info:r.info,points:u,repeatability:p,descriptors:g,descriptorPoint:Uint32Array.from(y)}}function ke(r,e,t){let n=r[6]*e+r[7]*t+r[8];return Math.abs(n)<1e-12?[NaN,NaN]:[(r[0]*e+r[1]*t+r[2])/n,(r[3]*e+r[4]*t+r[5])/n]}function se(r,e,t){return[ke(r,0,0),ke(r,e,0),ke(r,e,t),ke(r,0,t)]}function ue(r,e,t){for(let n=0;n<t;n++){let o=n,a=Math.abs(r[n*t+n]);for(let m=n+1;m<t;m++){let l=Math.abs(r[m*t+n]);l>a&&(a=l,o=m)}if(a<1e-12)return!1;if(o!==n){for(let l=0;l<t;l++){let c=r[n*t+l];r[n*t+l]=r[o*t+l],r[o*t+l]=c}let m=e[n];e[n]=e[o],e[o]=m}let s=r[n*t+n];for(let m=n+1;m<t;m++){let l=r[m*t+n]/s;if(l!==0){for(let c=n;c<t;c++)r[m*t+c]-=l*r[n*t+c];e[m]-=l*e[n]}}}for(let n=t-1;n>=0;n--){let o=e[n];for(let a=n+1;a<t;a++)o-=r[n*t+a]*e[a];e[n]=o/r[n*t+n]}return e.every(Number.isFinite)}function Qt(r,e){let t=new Float64Array(r),n=new Float64Array(e*e);for(let o=0;o<e;o++)n[o*e+o]=1;for(let o=0;o<e;o++){let a=o;for(let m=o+1;m<e;m++)Math.abs(t[m*e+o])>Math.abs(t[a*e+o])&&(a=m);if(Math.abs(t[a*e+o])<1e-15)return null;if(a!==o)for(let m=0;m<e;m++){let l=t[o*e+m];t[o*e+m]=t[a*e+m],t[a*e+m]=l,l=n[o*e+m],n[o*e+m]=n[a*e+m],n[a*e+m]=l}let s=t[o*e+o];for(let m=0;m<e;m++)t[o*e+m]/=s,n[o*e+m]/=s;for(let m=0;m<e;m++){if(m===o)continue;let l=t[m*e+o];if(l!==0)for(let c=0;c<e;c++)t[m*e+c]-=l*t[o*e+c],n[m*e+c]-=l*n[o*e+c]}}return n}function St(r,e){let t=new Float64Array(r),n=new Float64Array(e*e);for(let s=0;s<e;s++)n[s*e+s]=1;for(let s=0;s<50;s++){let m=0;for(let l=0;l<e;l++)for(let c=l+1;c<e;c++)m+=t[l*e+c]**2;if(m<1e-24)break;for(let l=0;l<e;l++)for(let c=l+1;c<e;c++){let i=t[l*e+c];if(Math.abs(i)<1e-300)continue;let d=(t[c*e+c]-t[l*e+l])/(2*i),u=Math.sign(d||1)/(Math.abs(d)+Math.sqrt(d*d+1)),p=1/Math.sqrt(u*u+1),f=u*p;for(let y=0;y<e;y++){let g=t[y*e+l],A=t[y*e+c];t[y*e+l]=p*g-f*A,t[y*e+c]=f*g+p*A}for(let y=0;y<e;y++){let g=t[l*e+y],A=t[c*e+y];t[l*e+y]=p*g-f*A,t[c*e+y]=f*g+p*A}for(let y=0;y<e;y++){let g=n[y*e+l],A=n[y*e+c];n[y*e+l]=p*g-f*A,n[y*e+c]=f*g+p*A}}}let o=0;for(let s=1;s<e;s++)t[s*e+s]<t[o*e+o]&&(o=s);let a=new Float64Array(e);for(let s=0;s<e;s++)a[s]=n[s*e+o];return a}function K(r,e){let t=new Float64Array(9);for(let n=0;n<3;n++)for(let o=0;o<3;o++)t[n*3+o]=r[n*3]*e[o]+r[n*3+1]*e[3+o]+r[n*3+2]*e[6+o];return t}function Be(r){let[e,t,n,o,a,s,m,l,c]=[r[0],r[1],r[2],r[3],r[4],r[5],r[6],r[7],r[8]],i=[a*c-s*l,n*l-t*c,t*s-n*a,s*m-o*c,e*c-n*m,n*o-e*s,o*l-a*m,t*m-e*l,e*a-t*o],d=e*i[0]+t*i[3]+n*i[6];return!Number.isFinite(d)||Math.abs(d)<1e-300?null:Float64Array.from(i,u=>u/d)}function mr(r){let e=r[8];if(!Number.isFinite(e)||Math.abs(e)<1e-12)return null;for(let t=0;t<9;t++)r[t]/=e;return r.every(Number.isFinite)?r:null}function at(r,e,t){let n=0,o=0;for(let s=0;s<t;s++){let m=e[s];n+=r[2*m],o+=r[2*m+1]}n/=t,o/=t;let a=0;for(let s=0;s<t;s++){let m=e[s];a+=Math.hypot(r[2*m]-n,r[2*m+1]-o)}return a/=t,a<1e-9?null:[Math.SQRT2/a,n,o]}function ur(r,e,t){let[n,o,a]=e,[s,m,l]=t,c=[n,0,-n*o,0,n,-n*a,0,0,1],i=[1/s,0,m,0,1/s,l,0,0,1];return mr(K(K(i,r),c))}function Gt(r,e,t,n,o){if(n<4)return null;let a=at(r,t,n),s=at(e,t,n);if(!a||!s)return null;let m=new Float64Array(81),l=new Float64Array(9);for(let c=0;c<n;c++){let i=t[c],d=o?o[i]:1;if(d<=0)continue;let u=a[0]*(r[2*i]-a[1]),p=a[0]*(r[2*i+1]-a[2]),f=s[0]*(e[2*i]-s[1]),y=s[0]*(e[2*i+1]-s[2]);for(let g=0;g<2;g++){g===0?l.set([u,p,1,0,0,0,-f*u,-f*p,-f]):l.set([0,0,0,u,p,1,-y*u,-y*p,-y]);for(let A=0;A<9;A++){let w=l[A]*d;if(w!==0)for(let x=A;x<9;x++)m[A*9+x]+=w*l[x]}}}for(let c=0;c<9;c++)for(let i=0;i<c;i++)m[c*9+i]=m[i*9+c];return ur(St(m,9),a,s)}var nt=new Float64Array(64),ot=new Float64Array(8);function Re(r,e,t){let n=at(r,t,4),o=at(e,t,4);if(!n||!o)return null;nt.fill(0);for(let a=0;a<4;a++){let s=t[a],m=n[0]*(r[2*s]-n[1]),l=n[0]*(r[2*s+1]-n[2]),c=o[0]*(e[2*s]-o[1]),i=o[0]*(e[2*s+1]-o[2]);nt.set([m,l,1,0,0,0,-c*m,-c*l],16*a),nt.set([0,0,0,m,l,1,-i*m,-i*l],16*a+8),ot[2*a]=c,ot[2*a+1]=i}return ue(nt,ot,8)?ur([...ot,1],n,o):null}function dr(r,e,t,n){let o=r[6]*e+r[7]*t+r[8];return o>1e-12?(n[0]=(r[0]*e+r[1]*t+r[2])/o,n[1]=(r[3]*e+r[4]*t+r[5])/o,!0):!1}var ie=new Float64Array(8),Ot=new Float64Array(2);function de(r,e,t,n=64,o=30){let a=[0,e,e,0],s=[0,0,t,t];for(let i=0;i<4;i++){if(!dr(r,a[i],s[i],Ot))return!1;ie[2*i]=Ot[0],ie[2*i+1]=Ot[1]}let m=0,l=1/0,c=0;for(let i=0;i<4;i++){let d=ie[2*i],u=ie[2*i+1],p=ie[(2*i+2)%8],f=ie[(2*i+3)%8],y=ie[(2*i+4)%8],g=ie[(2*i+5)%8];if((p-d)*(g-f)-(f-u)*(y-p)<=0)return!1;m+=d*f-p*u;let A=Math.hypot(p-d,f-u);l=Math.min(l,A),c=Math.max(c,A)}return m/2>=n&&c<=o*Math.max(l,1e-9)}function Dt(r,e,t){let n=[];for(let c=0;c<t;c++)(!e||e[c])&&n.push([r[2*c],r[2*c+1]]);if(n.length<3)return 0;n.sort((c,i)=>c[0]-i[0]||c[1]-i[1]);let o=(c,i,d)=>(i[0]-c[0])*(d[1]-c[1])-(i[1]-c[1])*(d[0]-c[0]),a=[];for(let c of n){for(;a.length>=2&&o(a.at(-2),a.at(-1),c)<=0;)a.pop();a.push(c)}let s=[];for(let c=n.length-1;c>=0;c--){let i=n[c];for(;s.length>=2&&o(s.at(-2),s.at(-1),i)<=0;)s.pop();s.push(i)}let m=[...a.slice(0,-1),...s.slice(0,-1)],l=0;for(let c=0;c<m.length;c++){let i=m[c],d=m[(c+1)%m.length];l+=i[0]*d[1]-d[0]*i[1]}return Math.abs(l)/2}var wn=(r,e)=>r<=e?1:e/r;function Lt(r,e,t,n,o,a={}){let s=a.iterations??8,m=a.huberPx??1.5,l=Float64Array.from(r.subarray(0,8)),c=.001,i=new Float64Array(64),d=new Float64Array(8),u=new Float64Array(8),p=new Float64Array(8),f=h=>{let v=0;for(let I=0;I<o;I++){if(!n[I])continue;let E=e[2*I],M=e[2*I+1],b=h[6]*E+h[7]*M+1;if(!(b>1e-12))return 1/0;let P=(h[0]*E+h[1]*M+h[2])/b-t[2*I],U=(h[3]*E+h[4]*M+h[5])/b-t[2*I+1],C=Math.hypot(P,U);v+=C<=m?C*C:2*m*C-m*m}return v},y=f(l);for(let h=0;h<s;h++){i.fill(0),d.fill(0);for(let I=0;I<o;I++){if(!n[I])continue;let E=e[2*I],M=e[2*I+1],b=l[6]*E+l[7]*M+1,P=(l[0]*E+l[1]*M+l[2])/b,U=(l[3]*E+l[4]*M+l[5])/b,C=P-t[2*I],O=U-t[2*I+1],T=wn(Math.hypot(C,O),m);u.set([E/b,M/b,1/b,0,0,0,-P*E/b,-P*M/b]),p.set([0,0,0,E/b,M/b,1/b,-U*E/b,-U*M/b]);for(let B=0;B<8;B++){d[B]+=T*(u[B]*C+p[B]*O);for(let R=B;R<8;R++)i[B*8+R]+=T*(u[B]*u[R]+p[B]*p[R])}}for(let I=0;I<8;I++)for(let E=0;E<I;E++)i[I*8+E]=i[E*8+I];let v=!1;for(let I=0;I<4&&!v;I++){let E=new Float64Array(i);for(let U=0;U<8;U++)E[U*9]*=1+c;let M=Float64Array.from(d,U=>-U);if(!ue(E,M,8)){c*=10;continue}let b=Float64Array.from(l,(U,C)=>U+M[C]),P=f(b);P<y?(l=b,y=P,c=Math.max(1e-7,c/10),v=!0):c*=10}if(!v)break}let g=0,A=0;i.fill(0);for(let h=0;h<o;h++){if(!n[h])continue;let v=e[2*h],I=e[2*h+1],E=l[6]*v+l[7]*I+1,M=(l[0]*v+l[1]*I+l[2])/E,b=(l[3]*v+l[4]*I+l[5])/E;A+=(M-t[2*h])**2+(b-t[2*h+1])**2,g++,u.set([v/E,I/E,1/E,0,0,0,-M*v/E,-M*I/E]),p.set([0,0,0,v/E,I/E,1/E,-b*v/E,-b*I/E]);for(let P=0;P<8;P++)for(let U=0;U<8;U++)i[P*8+U]+=u[P]*u[U]+p[P]*p[U]}let w=g>4?A/(2*g-8):A,x=Qt(i,8);return{H:Float64Array.from([...l,1]),rmsPx:g?Math.sqrt(A/g):1/0,paramCovariance:x?x.map(h=>h*w):null}}function xn(r){let e=r>>>0||625341585;return()=>(e^=e<<13,e>>>=0,e^=e>>>17,e^=e<<5,e>>>=0,e)}function Nt(r,e,t,n,o,a){let s=0,m=0;for(let l=0;l<n;l++){let c=e[2*l],i=e[2*l+1],d=r[6]*c+r[7]*i+r[8],u=o;if(d>1e-12){let f=(r[0]*c+r[1]*i+r[2])/d-t[2*l],y=(r[3]*c+r[4]*i+r[5])/d-t[2*l+1];u=Math.min(o,f*f+y*y)}let p=u<o;a[l]=p?1:0,p&&m++,s+=u}return{score:s,inliers:m}}function vn(r,e){let t=0;for(let o=0;o<e;o++)r[o]&&t++;let n=new Int32Array(t);for(let o=0,a=0;o<e;o++)r[o]&&(n[a++]=o);return n}function st(r,e,t,n){let o=(r[2*t]-r[2*e])*(r[2*n+1]-r[2*e+1])-(r[2*t+1]-r[2*e+1])*(r[2*n]-r[2*e]);return Math.abs(o)<.001*(1+Math.abs(r[2*e])+Math.abs(r[2*t]))}function we(r,e,t,n,o,a={}){let s=a.thresholdPx??3,m=s*s,l=a.confidence??.995,c=a.maxIterations??500,i=a.minInliers??12,d=a.minInlierRatio??.2,u=a.minCoverage??.08;if(t<Math.max(4,i))return{accepted:!1,reason:"INSUFFICIENT_MATCHES",iterations:0};let p=xn(a.seed??12345),f=new Uint8Array(t),y=new Uint8Array(t),g=null,A=1/0,w=0,x=c,h=4,v=c;for(let T=0;T<4;T++)v*=(h-T)/(t-T);let I=1,E=new Int32Array(4),M=0,b=T=>{if(!T||!de(T,n,o))return;let{score:B,inliers:R}=Nt(T,r,e,t,m,f);if(B>=A)return;g=T,A=B,w=R,y.set(f);for(let Q=0;Q<3&&w>=8;Q++){let N=Gt(r,e,vn(y,t),w);if(!N||!de(N,n,o))break;let z=Nt(N,r,e,t,m,f);if(z.score>=A)break;g=N,A=z.score,w=z.inliers,y.set(f)}let k=w/t,D=Math.log(1-l)/Math.log(Math.max(1e-12,1-k**4));x=Math.min(c,Math.max(16,Math.ceil(D)))};for(;M<x;){if(M++,M>=I&&h<t){let z=v*(h+1)/(h+1-4);h++,I+=Math.ceil(z-v),v=z}let T=I>M?h-1:h,B=0;I>M&&(E[B++]=h-1);let R=0;for(;B<4&&R++<64;){let z=p()%T,S=!1;for(let L=0;L<B;L++)E[L]===z&&(S=!0);S||(E[B++]=z)}if(B<4)continue;let[k,D,Q,N]=[E[0],E[1],E[2],E[3]];st(r,k,D,Q)||st(r,k,D,N)||st(r,k,Q,N)||st(r,D,Q,N)||b(Re(r,e,E))}if(!g||w<i)return{accepted:!1,reason:"NO_MODEL",iterations:M};let P=g,U=Lt(P,r,e,y,t,{huberPx:s/2});for(let T=0;T<2;T++){if(!de(U.H,n,o))return{accepted:!1,reason:"IMPLAUSIBLE_MODEL",iterations:M};P=U.H,w=Nt(P,r,e,t,m,y).inliers,T===0&&(U=Lt(P,r,e,y,t,{huberPx:s/2}))}let C=w/t;if(w<i||C<d)return{accepted:!1,reason:"LOW_INLIER_SUPPORT",iterations:M};let O=Dt(r,y,t)/(n*o);return O<u?{accepted:!1,reason:"LOW_SPATIAL_COVERAGE",iterations:M}:{accepted:!0,H:P,mask:y,inliers:w,ratio:C,rmsPx:U.rmsPx,coverage:O,paramCovariance:U.paramCovariance,iterations:M}}var yr=844385612;function En(r,e,t){if(r.width===e&&r.height===t)return r;let n=new Uint8Array(e*t),o=r.width/e,a=r.height/t;for(let s=0;s<t;s++){let m=Math.min(r.height-1.001,Math.max(0,(s+.5)*a-.5)),l=Math.floor(m),c=m-l;for(let i=0;i<e;i++){let d=Math.min(r.width-1.001,Math.max(0,(i+.5)*o-.5)),u=Math.floor(d),p=d-u,f=l*r.stride+u,y=r.data,g=y[f]+p*(y[f+1]-y[f]),A=y[f+r.stride]+p*(y[f+r.stride+1]-y[f+r.stride]);n[s*e+i]=Math.round(g+c*(A-g))}}return{width:e,height:t,stride:e,data:n}}function Mn(r,e){let t=Math.max(r.width,r.height)/e;if(t<=1)return r;let n=Math.round(r.width/t),o=Math.round(r.height/t),a=new Uint8Array(n*o);for(let s=0;s<o;s++)for(let m=0;m<n;m++){let l=Math.floor(m*t),c=Math.max(l+1,Math.floor((m+1)*t)),i=Math.floor(s*t),d=Math.max(i+1,Math.floor((s+1)*t)),u=0;for(let p=i;p<d;p++)for(let f=l;f<c;f++)u+=r.data[p*r.stride+f];a[s*n+m]=Math.round(u/((c-l)*(d-i)))}return{width:n,height:o,stride:n,data:a}}async function Qe(r,e,t={}){let n=Mn(e,t.templateMaxEdge??480),o=new TextEncoder().encode(r.info.id),a=r.points.length/2,s=r.descriptorPoint.length,m=10+o.length+8+8+8*a+a+4*s+32*s+4+n.width*n.height,l=new Uint8Array(m+32),c=new DataView(l.buffer),i=0;c.setUint32(i,yr,!0),c.setUint16(i+4,2,!0),c.setUint16(i+6,rt,!0),i+=8,c.setUint16(i,o.length,!0),l.set(o,i+2),i+=2+o.length,c.setUint16(i,r.info.width,!0),c.setUint16(i+2,r.info.height,!0),c.setFloat32(i+4,r.info.physicalWidthMeters??NaN,!0),i+=8,c.setUint32(i,a,!0),c.setUint32(i+4,s,!0),i+=8;for(let u=0;u<2*a;u++,i+=4)c.setFloat32(i,r.points[u],!0);l.set(r.repeatability,i),i+=a;for(let u=0;u<s;u++,i+=4)c.setUint32(i,r.descriptorPoint[u],!0);l.set(r.descriptors,i),i+=32*s,c.setUint16(i,n.width,!0),c.setUint16(i+2,n.height,!0),i+=4;for(let u=0;u<n.height;u++)l.set(n.data.subarray(u*n.stride,u*n.stride+n.width),i+u*n.width);i+=n.width*n.height;let d=new Uint8Array(await crypto.subtle.digest("SHA-256",l.subarray(0,i)));return l.set(d,i),l}async function it(r){let e=new DataView(r.buffer,r.byteOffset,r.byteLength),t=v=>{throw new Error(`Invalid target asset: ${v}`)};(r.length<64||e.getUint32(0,!0)!==yr||e.getUint16(4,!0)!==2)&&t("header");let n=e.getUint16(6,!0)&255;n!==rt&&t(`descriptor pattern v${n}, this engine uses v${rt}; recompile the target`);let o=r.subarray(0,r.length-32);new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(o))).every((v,I)=>v===r[r.length-32+I])||t("checksum");let s=8,m=e.getUint16(s,!0),l=new TextDecoder().decode(r.subarray(s+2,s+2+m));s+=2+m;let c=e.getUint16(s,!0),i=e.getUint16(s+2,!0),d=e.getFloat32(s+4,!0);s+=8;let u=e.getUint32(s,!0),p=e.getUint32(s+4,!0);s+=8;let f=new Float32Array(2*u);for(let v=0;v<2*u;v++,s+=4)f[v]=e.getFloat32(s,!0);let y=r.slice(s,s+u);s+=u;let g=new Uint32Array(p);for(let v=0;v<p;v++,s+=4)g[v]=e.getUint32(s,!0);let A=r.slice(s,s+32*p);s+=32*p;let w=e.getUint16(s,!0),x=e.getUint16(s+2,!0);s+=4;let h={width:w,height:x,stride:w,data:r.slice(s,s+w*x)};return{compiled:{info:{id:l,width:c,height:i,physicalWidthMeters:Number.isNaN(d)?null:d},points:f,repeatability:y,descriptors:A,descriptorPoint:g},template:En(h,c,i)}}function zt(r,e){let t=r.length/32,n=e.length/32,o=new Uint32Array(3*t),a=new Uint32Array(r.buffer,r.byteOffset,r.length/4),s=new Uint32Array(e.buffer,e.byteOffset,e.length/4);for(let m=0;m<t;m++){let l=257,c=257,i=4294967295,d=8*m;for(let u=0;u<n;u++){let p=8*u,f=0;for(let y=0;y<8;y++){let g=(a[d+y]^s[p+y])>>>0;g-=g>>>1&1431655765,g=(g&858993459)+(g>>>2&858993459),f+=(g+(g>>>4)&252645135)*16843009>>>24}f<l?(c=l,l=f,i=u):f<c&&(c=f)}o[3*m]=i,o[3*m+1]=l,o[3*m+2]=c}return o}function _t(r,e,t){let n=r.length/32,o=e.length/32,a=new Uint32Array(3*n),s=new Uint32Array(r.buffer,r.byteOffset,r.length/4),m=new Uint32Array(e.buffer,e.byteOffset,e.length/4);for(let l=0;l<n;l++){let c=257,i=4294967295,d=257,u=4294967295,p=8*l;for(let f=0;f<o;f++){let y=8*f,g=0;for(let w=0;w<8;w++){let x=(s[p+w]^m[y+w])>>>0;x-=x>>>1&1431655765,x=(x&858993459)+(x>>>2&858993459),g+=(x+(x>>>4)&252645135)*16843009>>>24}let A=t[f];A===i?g<c&&(c=g,u=f):g<c?(d=c,c=g,i=A,u=f):g<d&&(d=g)}a[3*l]=u,a[3*l+1]=c,a[3*l+2]=d}return a}var lt=class r{constructor(e){F(this,"backend");F(this,"kernel");this.kernel=e,this.backend=e?"wasm-simd":"js"}static create(e={}){let t=e.allowWasm===!1?null:Je();if(!t)return new r(null);try{let n=new r(t);return n.selfTest()?n:new r(null)}catch{return new r(null)}}selfTest(){let e=19088743,t=i=>Uint8Array.from({length:i},()=>(e^=e<<13,e^=e>>>17,e^=e<<5,e&255)),n=t(1184),o=new Uint8Array(352);o.set(t(320)),o.set(n.subarray(160,192),320);let a=zt(o,n),s=this.nearest2(o,n),m=Uint32Array.from({length:37},(i,d)=>d>>1),l=_t(o,n,m),c=this.nearest2Grouped(o,n,m);return s.length===a.length&&s.every((i,d)=>i===a[d])&&c.length===l.length&&c.every((i,d)=>i===l[d])}nearest2(e,t){let n=this.kernel;if(!n)return zt(e,t);let o=e.length/32,a=t.length/32;n.reset_heap();let s=n.reserve(e.length),m=n.reserve(t.length),l=n.reserve(12*o);return!s||!m||!l?zt(e,t):(new Uint8Array(n.memory.buffer).set(e,s),new Uint8Array(n.memory.buffer).set(t,m),n.nearest2(s,o,m,a,l),new Uint32Array(n.memory.buffer.slice(l,l+12*o)))}nearest2Grouped(e,t,n){let o=this.kernel;if(!o)return _t(e,t,n);let a=e.length/32;o.reset_heap();let s=o.reserve(e.length),m=o.reserve(t.length),l=o.reserve(n.byteLength),c=o.reserve(12*a);if(!s||!m||!l||!c)return _t(e,t,n);let i=o.memory.buffer;return new Uint8Array(i).set(e,s),new Uint8Array(i).set(t,m),new Uint8Array(i).set(new Uint8Array(n.buffer,n.byteOffset,n.byteLength),l),o.nearest2_grouped(s,a,m,l,t.length/32,c),new Uint32Array(o.memory.buffer.slice(c,c+12*a))}};var Pn=r=>Math.max(700,Math.round(700*r.width*r.height/(640*360))),Un=36e4;function Fn(r,e,t,n){let o=Math.min(t,3,Math.sqrt(Un/(e.width*e.height)));if(o<1.2)return null;let a=Math.round(e.width*o),s=Math.round(e.height*o),m=new Uint8Array(a*s),l=r.width-1.001,c=r.height-1.001;for(let d=0;d<s;d++){let u=Math.min(c,Math.max(.5,e.y+(d+.5)/o));for(let p=0;p<a;p++)m[d*a+p]=Math.round(ee(r,Math.min(l,Math.max(.5,e.x+(p+.5)/o)),u))}let i=Ce({width:a,height:s,stride:a,data:m},{budget:500,...n});return{...i,x:i.x.map(d=>e.x+(d+.5)/o-.5),y:i.y.map(d=>e.y+(d+.5)/o-.5)}}var ye=class{constructor(e={}){F(this,"info",{id:"C1.orb-views",layer:"L2",route:"light",determinism:"bit-exact",requires:[]});F(this,"options");F(this,"matcher");F(this,"targets",[]);this.options=e,this.matcher=lt.create(e.allowWasm===!1?{allowWasm:!1}:{})}get backend(){return this.matcher.backend}probe(e){return{isAvailable:!0}}async load(e){let t=[];this.targets=[];for(let n of e){let o=performance.now(),a=Te(n,this.options.compile),s=await Qe(a,n.image,{templateMaxEdge:this.options.templateMaxEdge??480}),m=await it(s);this.targets.push(m.compiled),t.push({id:n.info.id,compileUs:(performance.now()-o)*1e3,serialized:s,template:m.template})}return{targets:t}}async loadEncoded(e){let t=[];this.targets=[];for(let n of e){let o=performance.now(),a=await it(n);this.targets.push(a.compiled),t.push({id:a.compiled.info.id,compileUs:(performance.now()-o)*1e3,serialized:n,template:a.template,info:a.compiled.info})}return{targets:t}}async detect(e,t={}){if(e.image.kind!=="cpu-gray")throw new Error("OrbDetector needs cpu-gray frames");let n=t.roi??null,o=(n&&(t.upscale??1)>1?Fn(e.image.image,n,t.upscale,this.options.orb??{}):null)??Ce(e.image.image,{budget:n?500:Pn(e.image.image),...this.options.orb,roi:n});if(o.count<8)return[];let a=this.options.ratio??.85,s=this.options.maxDistance??80,m=[];for(let l of this.targets){let c=this.matcher.nearest2Grouped(o.descriptors,l.descriptors,l.descriptorPoint),i=new Map;for(let y=0;y<o.count;y++){let g=c[3*y+1],A=c[3*y+2];if(g>s||a<1&&g>=a*A)continue;let w=l.descriptorPoint[c[3*y]],x=g/Math.max(1,A),h=i.get(w);(!h||x<h.r)&&i.set(w,{q:y,r:x})}let d=[...i].sort((y,g)=>y[1].r-g[1].r||y[0]-g[0]);if(d.length<12)continue;let u=new Float64Array(2*d.length),p=new Float64Array(2*d.length);d.forEach(([y,{q:g}],A)=>{u[2*A]=l.points[2*y],u[2*A+1]=l.points[2*y+1],p[2*A]=o.x[g],p[2*A+1]=o.y[g]});let f=we(u,p,d.length,l.info.width,l.info.height,{thresholdPx:this.options.thresholdPx??4,maxIterations:1e3,minInliers:12,minInlierRatio:.1,minCoverage:.05});f.accepted&&m.push({inliers:f.inliers,pose:{targetId:l.info.id,frameId:e.frameId,timeUs:e.time.captureUs,H_imageFromTarget:f.H,corners:se(f.H,l.info.width,l.info.height),covariance:null,quality:{support:f.inliers,ratio:f.ratio,residual:f.rmsPx,residualKind:"px",coverage:f.coverage},origin:"detector"}})}return m.sort((l,c)=>c.inliers-l.inliers||l.pose.targetId.localeCompare(c.pose.targetId)),m.length>1&&m[1].inliers>=.85*m[0].inliers?[]:m.map(l=>l.pose)}};function ct(r,e){let t=Float64Array.from([0,0,r.width,0,r.width,r.height,0,r.height]);return Re(t,Float64Array.from(e),[0,1,2,3])}function xe(r){return Float64Array.from([r[0][0],r[0][1],r[1][0],r[1][1],r[2][0],r[2][1],r[3][0],r[3][1]])}function fr(r){return[[r[0],r[1]],[r[2],r[3]],[r[4],r[5]],[r[6],r[7]]]}function fe(r,e,t,n,o){let a=ct(e,t);return a?{...r,H_imageFromTarget:a,corners:fr(t),timeUs:n,origin:o}:null}var Se=class{constructor(e,t={}){F(this,"info",{id:"E2.kalman-cv",layer:"L4",route:"light",determinism:"bit-exact",requires:[]});F(this,"targets",new Map);F(this,"states",new Map);F(this,"q");F(this,"trackerSigma");F(this,"detectorSigma");F(this,"gate");F(this,"maxPredictionUs");F(this,"resetGapUs");for(let n of e)this.targets.set(n.id,n);this.q=t.accelerationNoise??1e6,this.trackerSigma=t.trackerSigmaPx??.15,this.detectorSigma=t.detectorSigmaPx??1.5,this.gate=t.gate??25,this.maxPredictionUs=t.maxPredictionUs??1e5,this.resetGapUs=t.resetGapUs??3e5}probe(e){return{isAvailable:!0}}start(e,t,n){let o=xe(e.corners);return this.states.set(e.targetId,{info:t,timeUs:e.timeUs,x:o,v:new Float64Array(8),pp:new Float64Array(8).fill(n),pv:new Float64Array(8),vv:new Float64Array(8).fill(1e6),last:e}),{...e,origin:"filter"}}update(e){let t=this.targets.get(e.targetId);if(!t)return e;let n=e.origin==="tracker"?this.trackerSigma:this.detectorSigma,o=n*n,a=this.states.get(e.targetId);if(!a||e.timeUs<=a.timeUs||e.timeUs-a.timeUs>this.resetGapUs)return this.start(e,t,o);let s=(e.timeUs-a.timeUs)/1e6,m=xe(e.corners),l=this.q,c=new Float64Array(8),i=new Float64Array(8),d=new Float64Array(8),u=new Float64Array(8),p=0;for(let y=0;y<8;y++)c[y]=a.x[y]+s*a.v[y],i[y]=a.pp[y]+2*s*a.pv[y]+s*s*a.vv[y]+l*s**3/3,d[y]=a.pv[y]+s*a.vv[y]+l*s*s/2,u[y]=a.vv[y]+l*s,p=Math.max(p,(m[y]-c[y])**2/(i[y]+o));if(p>this.gate)return this.start(e,t,o);for(let y=0;y<8;y++){let g=1/(i[y]+o),A=i[y]*g,w=d[y]*g,x=m[y]-c[y];a.x[y]=c[y]+A*x,a.v[y]=a.v[y]+w*x,a.pp[y]=(1-A)*i[y],a.pv[y]=(1-A)*d[y],a.vv[y]=u[y]-w*d[y]}a.timeUs=e.timeUs;let f=fe(e,t,a.x,e.timeUs,"filter")??e;return a.last=f,f}predict(e,t){let n=this.states.get(e);return n?pr(n,t,this.maxPredictionUs):null}snapshot(e){let t=this.states.get(e);if(!t)return null;let n={...t,x:new Float64Array(t.x),v:new Float64Array(t.v)};return o=>pr(n,o,this.maxPredictionUs)}reset(e){e?this.states.delete(e):this.states.clear()}};function pr(r,e,t){let n=Math.max(0,Math.min(t,e-r.timeUs))/1e6,o=Float64Array.from(r.x,(a,s)=>a+r.v[s]*n);return fe(r.last,r.info,o,e,"predicted")}var Ar=(r,e)=>1/(1+1/(2*Math.PI*r)/e),Oe=class{constructor(e,t={}){F(this,"info",{id:"E1.one-euro",layer:"L4",route:"light",determinism:"bit-exact",requires:[]});F(this,"targets",new Map);F(this,"states",new Map);F(this,"minCutoff");F(this,"beta");F(this,"dCutoff");F(this,"maxPredictionUs");F(this,"resetGapUs");for(let n of e)this.targets.set(n.id,n);this.minCutoff=t.minCutoffHz??.7,this.beta=t.beta??.15,this.dCutoff=t.derivativeCutoffHz??4,this.maxPredictionUs=t.maxPredictionUs??1e5,this.resetGapUs=t.resetGapUs??3e5}probe(e){return{isAvailable:!0}}update(e){let t=this.targets.get(e.targetId);if(!t)return e;let n=xe(e.corners),o=this.states.get(e.targetId);if(!o||e.timeUs<=o.timeUs||e.timeUs-o.timeUs>this.resetGapUs)return this.states.set(e.targetId,{info:t,timeUs:e.timeUs,x:n,dx:new Float64Array(8),last:e}),{...e,origin:"filter"};let a=(e.timeUs-o.timeUs)/1e6,s=Ar(this.dCutoff,a);for(let i=0;i<8;i++){let d=(n[i]-o.x[i])/a;o.dx[i]=s*d+(1-s)*o.dx[i]}let m=0;for(let i=0;i<4;i++)m+=Math.hypot(o.dx[2*i],o.dx[2*i+1]);let l=Ar(this.minCutoff+this.beta*(m/4),a);for(let i=0;i<8;i++)o.x[i]=l*n[i]+(1-l)*o.x[i];o.timeUs=e.timeUs;let c=fe(e,t,o.x,e.timeUs,"filter")??e;return o.last=c,c}predict(e,t){let n=this.states.get(e);return n?gr(n,t,this.maxPredictionUs):null}snapshot(e){let t=this.states.get(e);if(!t)return null;let n={...t,x:new Float64Array(t.x),dx:new Float64Array(t.dx)};return o=>gr(n,o,this.maxPredictionUs)}reset(e){e?this.states.delete(e):this.states.clear()}};function gr(r,e,t){let n=Math.max(0,Math.min(t,e-r.timeUs))/1e6,o=Float64Array.from(r.x,(a,s)=>a+r.dx[s]*n);return fe(r.last,r.info,o,e,"predicted")}function Ge(r,e=240){let t=r.corners,n=0;for(let a=0;a<4;a++)n=Math.max(n,Math.hypot(t[(a+1)%4][0]-t[a][0],t[(a+1)%4][1]-t[a][1]));let o=n>0?e/n:1;return o>=1.2?Math.min(3,o):1}var mt=r=>typeof r=="object"&&r!==null&&"H_imageFromTarget"in r;function hr(r,e){let t=0;for(let n=0;n<4;n++)t+=Math.hypot(r.corners[n][0]-e.corners[n][0],r.corners[n][1]-e.corners[n][1]);return t/4}function br(r){let e=r.corners;return(Math.hypot(e[2][0]-e[0][0],e[2][1]-e[0][1])+Math.hypot(e[3][0]-e[1][0],e[3][1]-e[1][1]))/2}var De=class{constructor(e,t={}){F(this,"info");F(this,"parts");F(this,"options");F(this,"workspaces",[new Z,new Z]);F(this,"flip",0);F(this,"targets",new Map);F(this,"filter",null);F(this,"state","SEARCHING");F(this,"measured",[]);F(this,"previousFrame",null);F(this,"processed",0);F(this,"late",null);F(this,"lost",null);this.parts=e,this.options={pyramidLevels:t.pyramidLevels??4,relocalizeEvery:t.relocalizeEvery??10,roiMargin:t.roiMargin??.35,coastUs:t.coastUs??15e4,reinitDisagreement:t.reinitDisagreement??.04,degradedRatio:t.degradedRatio??.75,asyncRelocalization:t.asyncRelocalization??!1,asyncDelayFrames:t.asyncDelayFrames??2,lostSearchUs:t.lostSearchUs??2e6,smallTargetPx:t.smallTargetPx??240},this.info={id:e.id,layer:"L3",route:"light",determinism:"bit-exact",requires:[...e.detector.info.requires,...e.tracker.info.requires]}}probe(e){let t=this.parts.detector.probe(e);return t.isAvailable?this.parts.tracker.probe(e):t}async load(e){this.targets=new Map(e.map(s=>[s.info.id,s.info]));let t=await this.parts.detector.load(e),n=performance.now(),o=e.map(s=>{let m=t.targets.find(l=>l.id===s.info.id)?.template;return m?{info:s.info,image:m}:s});this.parts.tracker.prepare(o);let a=(performance.now()-n)*1e3/Math.max(1,e.length);return this.filter=this.parts.filter?this.parts.filter(e.map(s=>s.info)):null,{targets:t.targets.map(s=>({...s,compileUs:s.compileUs+a}))}}async loadEncoded(e){if(!this.parts.detector.loadEncoded)throw new Error("Detector cannot load encoded assets");let t=await this.parts.detector.loadEncoded(e),n=t.targets.map(s=>{if(!s.info||!s.template)throw new Error("Encoded asset without info or template");return{info:s.info,image:s.template}});this.targets=new Map(n.map(s=>[s.info.id,s.info]));let o=performance.now();this.parts.tracker.prepare(n);let a=(performance.now()-o)*1e3/Math.max(1,n.length);return this.filter=this.parts.filter?this.parts.filter(n.map(s=>s.info)):null,{targets:t.targets.map(s=>({...s,compileUs:s.compileUs+a}))}}deliverRelocalization(e,t){e&&e.targetId===t.targetId&&(this.late={applyAt:this.processed,detected:e,tracked:t})}reset(e){this.late=null,this.lost=null,this.state="SEARCHING",this.measured=[],this.previousFrame=null,this.processed=0,this.filter?.reset()}prior(e){let t=this.measured.at(-1);if(!t)return null;let n=this.targets.get(t.targetId),o=this.measured.at(-2);if(!o||t.timeUs-o.timeUs>15e4||t.timeUs<=o.timeUs)return t;let a=Math.min(e-t.timeUs,1e5)/(t.timeUs-o.timeUs),s=[];for(let l=0;l<4;l++)for(let c=0;c<2;c++)s.push(t.corners[l][c]+a*(t.corners[l][c]-o.corners[l][c]));let m=ct(n,s);return m?{...t,H_imageFromTarget:m,corners:se(m,n.width,n.height),timeUs:e,origin:"predicted"}:t}roi(e,t,n,o=0){let a=e.corners.map(f=>f[0]),s=e.corners.map(f=>f[1]),m=Math.max(...a)-Math.min(...a),l=Math.max(...s)-Math.min(...s),c=this.options.roiMargin+o,i=Math.max(0,Math.floor(Math.min(...a)-c*m)),d=Math.max(0,Math.floor(Math.min(...s)-c*l)),u=Math.min(t,Math.ceil(Math.max(...a)+c*m)),p=Math.min(n,Math.ceil(Math.max(...s)+c*l));return{x:i,y:d,width:Math.max(1,u-i),height:Math.max(1,p-d)}}async process(e){if(e.image.kind!=="cpu-gray")throw new Error("DualLoopPipeline needs cpu-gray frames");let t={},n=performance.now(),a=this.workspaces[this.flip^=1].build(e.image.image,this.options.pyramidLevels),s=performance.now();t.pyramid=(s-n)*1e3;let m=e.time.captureUs,l=this.measured.at(-1)??null,c=l&&this.previousFrame&&l.frameId===this.previousFrame.frameId?{pyramid:this.previousFrame.pyramid,pose:l}:null,i=null,d=this.prior(m),u=d!==null&&l!==null&&m-l.timeUs<=this.options.coastUs;if(u){let h=this.parts.tracker.track({frame:e,pyramid:a,prior:{...d,frameId:e.frameId},previous:c});mt(h)&&(i=h)}let p=performance.now();if(t.track=(p-s)*1e3,this.late&&this.processed>=this.late.applyAt){let{detected:h,tracked:v}=this.late;this.late=null;let I=Be(v.H_imageFromTarget);if(i&&I&&h.targetId===i.targetId){let E=K(h.H_imageFromTarget,I),M=K(E,i.H_imageFromTarget),b=this.targets.get(i.targetId),P={...i,H_imageFromTarget:M,corners:se(M,b.width,b.height),origin:"detector"};if(hr(P,i)>this.options.reinitDisagreement*br(i)){let U=this.parts.tracker.track({frame:e,pyramid:a,prior:P,previous:null});mt(U)&&(i=U)}}}let f=this.options.relocalizeEvery,y=i!==null&&f>0&&this.processed%f===f-1;if(y&&this.options.asyncRelocalization&&this.parts.relocalizer)this.parts.relocalizer({frame:e,roi:this.roi(i,a.levels[0].width,a.levels[0].height),tracked:i});else if(y&&this.options.asyncRelocalization){let h=performance.now(),v=this.roi(i,a.levels[0].width,a.levels[0].height),I=Ge(i,this.options.smallTargetPx),E=(await this.parts.detector.detect(e,{roi:v,upscale:I})).find(M=>M.targetId===i.targetId);E&&(this.late={applyAt:this.processed+this.options.asyncDelayFrames,detected:E,tracked:i}),t.background=(performance.now()-h)*1e3}if(!i||y&&!this.options.asyncRelocalization){let h=!u&&this.lost&&m-this.lost.timeUs<=this.options.lostSearchUs?this.lost:null,v=u?i??d:h&&this.processed%3!==0?h.pose:null,I=h&&!u?(m-h.timeUs)/1e6:0,E=v?this.roi(v,a.levels[0].width,a.levels[0].height,I):null,M=v?Ge(v,this.options.smallTargetPx):1,b=await this.parts.detector.detect(e,{roi:E,upscale:M}),P=u?d.targetId:null,U=b.filter(C=>!P||C.targetId===P).sort((C,O)=>O.quality.support-C.quality.support||C.targetId.localeCompare(O.targetId))[0];if(U&&(!i||hr(U,i)>this.options.reinitDisagreement*br(i))){let C=this.parts.tracker.track({frame:e,pyramid:a,prior:U,previous:null});mt(C)?i=C:i||(i=U)}t.detect=(performance.now()-p)*1e3}this.processed++,this.previousFrame={frameId:e.frameId,pyramid:a};let A=[],w=[];if(i)this.lost=null,l&&l.targetId!==i.targetId&&(this.measured=[],this.filter?.reset()),this.measured=[...this.measured.slice(-2),i],this.state=i.quality.ratio<this.options.degradedRatio?"DEGRADED":"TRACKING",w.push(i),A=[this.filter?this.filter.update(i):i];else if(u&&d)this.state="COASTING",A=[{...this.filter?.predict(d.targetId,m)??d,frameId:e.frameId,origin:"predicted"}];else{this.state=this.measured.length?"LOST":"SEARCHING";let h=this.measured.at(-1);h&&(this.lost={pose:h,timeUs:h.timeUs}),this.measured=[],this.filter?.reset()}let x=this.filter?A.map(h=>this.filter.snapshot(h.targetId)).filter(h=>h!==null):[];return t.total=(performance.now()-n)*1e3-(t.background??0),{frameId:e.frameId,timeUs:m,state:this.state,poses:w,display:A,...x.length?{predict:h=>x.map(v=>v(h)).filter(v=>v!==null)}:{},timings:t}}async detect(e){if(e.image.kind!=="cpu-gray")throw new Error("DualLoopPipeline needs cpu-gray frames");let t=await this.parts.detector.detect(e);if(!t.length)return t;let n=new Z().build(e.image.image,this.options.pyramidLevels);return t.map(o=>{let a=this.parts.tracker.track({frame:e,pyramid:n,prior:o,previous:null});return mt(a)?a:o})}dispose(){this.measured=[],this.previousFrame=null}};function Cn(r){let e=Float64Array.from([1,0,0,0,1,0,0,0,1]),t=Float64Array.from([1,0,0,0,1,0,0,0,1]);for(let n=1;n<=4;n++){t=K(t,r).map(o=>o/n);for(let o=0;o<9;o++)e[o]+=t[o]}return e}function Tn(r){return Float64Array.from([r[4],r[2],r[0],r[3],-r[4]-r[5],r[1],r[6],r[7],r[5]])}var ut=r=>[r,0,0,0,r,0,0,0,1];function Wt(r,e,t){let n=e/2,o=t/2,a=r[6]*n+r[7]*o+r[8],s=(r[0]*n+r[1]*o+r[2])/a,m=(r[3]*n+r[4]*o+r[5])/a,l=(r[0]-s*r[6])/a,c=(r[1]-s*r[7])/a,i=(r[3]-m*r[6])/a,d=(r[4]-m*r[7])/a;return Math.sqrt(Math.abs(l*d-c*i))}var ve=new Float64Array(100),qt=new Float64Array(10),Le=new Float64Array(10),dt=new Float64Array(3);function Ir(r,e,t,n,o={}){let a=o.iterations??[8,6,5],s=o.minDiagonalPx??56,{width:m,height:l}=r.info,c=Wt(n,m,l),i=c*Math.hypot(m,l),d=Math.min(a.length-1,e.levels.length-1);for(;d>0&&i/2**d<s;)d--;let u=new Float64Array(n),p=1,f=0,y=0,g=null;for(let A=d;A>=0;A--){let w=e.levels[A],x=o.gradients==="field"?t(A):null,h=c/2**A,v=Math.max(0,Math.min(r.esm.length-1,Math.round(Math.log2(1/Math.max(h,1e-6))))),I=r.esm[v];if(I.count<30)continue;let E=[I.s,0,I.cx,0,I.s,I.cy,0,0,1],M=[1/I.s,0,-I.cx/I.s,0,1/I.s,-I.cy/I.s,0,0,1],b=K(K(K(ut(2**-A),u),ut(2**v)),E),P=12,U=a[a.length-1-A]??a.at(-1);for(let O=0;O<U;O++){y++,ve.fill(0),qt.fill(0);let T=0,B=0,R=0,k=0,D=0,Q=0,N=0,z=0,S=1.5*P;for(let G=0;G<I.count;G++){let q=I.pn[2*G],$=I.pn[2*G+1],te=b[6]*q+b[7]*$+b[8];if(!(te>1e-9))continue;let J=(b[0]*q+b[1]*$+b[2])/te,j=(b[3]*q+b[4]*$+b[5])/te;if(!oe(w.width,w.height,J,j,1.5))continue;let ce,Ve,je;x?(ce=ee(w,J,j),Ve=me(x.gx,x.width,J,j),je=me(x.gy,x.width,J,j)):(Bt(w,J,j,dt),ce=dt[0],Ve=dt[1],je=dt[2]);let Vr=(b[0]-J*b[6])/te,jr=(b[1]-J*b[7])/te,Xr=(b[3]-j*b[6])/te,Yr=(b[4]-j*b[7])/te,he=I.value[G],Jr=.5*(Ve*Vr+je*Xr+p*I.gu[G]),Zr=.5*(Ve*jr+je*Yr+p*I.gv[G]),tr=16*G;for(let X=0;X<8;X++)Le[X]=Jr*I.jwjg[tr+X]+Zr*I.jwjg[tr+8+X];Le[8]=-he,Le[9]=-1;let Xe=ce-(p*he+f),Tt=Math.abs(Xe),rr=Tt<=S?1:S/Tt;for(let X=0;X<10;X++){let nr=rr*Le[X];qt[X]+=nr*Xe;for(let Ye=X;Ye<10;Ye++)ve[X*10+Ye]+=nr*Le[Ye]}T++,B+=Tt,z+=rr*Xe*Xe,R+=ce,k+=he,D+=ce*ce,Q+=he*he,N+=ce*he}if(T<24)return null;for(let G=0;G<10;G++)for(let q=0;q<G;q++)ve[G*10+q]=ve[q*10+G];for(let G=0;G<10;G++)ve[G*11]*=1+1e-6;let L=Float64Array.from(qt,G=>-G);if(!ue(ve,L,10))return null;b=K(b,Cn(Tn(L))),p=Math.min(4,Math.max(.15,p+L[8])),f+=L[9],P=Math.max(4,1.25*B/T);let _=D-R*R/T,W=Q-k*k/T,H=N-R*k/T;g={ncc:_>0&&W>0?H/Math.sqrt(_*W):0,validRatio:T/I.count,rms:Math.sqrt(z/T),valid:T};let Y=0;for(let G=0;G<8;G++)Y=Math.max(Y,Math.abs(L[G]));if(Y<2e-5)break}u=K(K(K(ut(2**A),b),M),ut(2**-v));let C=u[8];if(!(Math.abs(C)>1e-12))return null;u=u.map(O=>O/C)}return!g||!u.every(Number.isFinite)?null:{H:u,...g,gain:p,bias:f,iterations:y}}var yt=new Float32Array(1681),wr=new Float32Array(6561);function xr(r,e,t,n,o={}){let a=Math.min(20,o.halfSize??6),s=Math.min(20,o.radius??8),m=o.minScore??.7,l=2*a+1,c=2*(a+s)+1,i=Be(t),d=r.pyramid.levels[n],u=2**n,p=r.anchors,f=p.length/2,y=[],g=[],A=[];if(!i)return{target:new Float64Array(0),image:new Float64Array(0),score:new Float64Array(0),count:0};for(let w=0;w<f;w++){let x=p[2*w],h=p[2*w+1],v=t[6]*x+t[7]*h+t[8];if(!(v>0))continue;let I=(t[0]*x+t[1]*h+t[2])/v,E=(t[3]*x+t[4]*h+t[5])/v,M=Math.round(I-.5)+.5,b=Math.round(E-.5)+.5;if(M-a-s<1||b-a-s<1||M+a+s>e.width-1||b+a+s>e.height-1)continue;let P=0,U=!0;for(let S=0,L=0;S<l;S++)for(let _=0;_<l;_++,L++){let W=M-a+_,H=b-a+S,Y=i[6]*W+i[7]*H+i[8],G=(i[0]*W+i[1]*H+i[2])/Y/u,q=(i[3]*W+i[4]*H+i[5])/Y/u,$=ee(d,G,q);if(Number.isNaN($)){U=!1;break}yt[L]=$,P+=$}if(!U)continue;P/=l*l;let C=0;for(let S=0;S<l*l;S++)yt[S]-=P,C+=yt[S]**2;if(C<l*l*25)continue;let O=M-.5-a-s,T=b-.5-a-s;for(let S=0;S<c;S++)for(let L=0;L<c;L++)wr[S*c+L]=e.data[(T+S)*e.stride+O+L];let B=-2,R=0,k=0,D=new Float32Array((2*s+1)**2);for(let S=0;S<=2*s;S++)for(let L=0;L<=2*s;L++){let _=0,W=0,H=0;for(let q=0,$=0;q<l;q++){let te=(S+q)*c+L;for(let J=0;J<l;J++,$++){let j=wr[te+J];_+=j,W+=j*j,H+=j*yt[$]}}let Y=W-_*_/(l*l),G=Y>1e-6?H/Math.sqrt(Y*C):-1;D[S*(2*s+1)+L]=G,G>B&&(B=G,R=L,k=S)}if(B<m||R===0||k===0||R===2*s||k===2*s)continue;let Q=(S,L)=>D[L*(2*s+1)+S],N=(Q(R-1,k)-Q(R+1,k))/(2*(Q(R-1,k)-2*B+Q(R+1,k))||1),z=(Q(R,k-1)-Q(R,k+1))/(2*(Q(R,k-1)-2*B+Q(R,k+1))||1);y.push(x,h),g.push(M+R-s+Math.max(-.5,Math.min(.5,N)),b+k-s+Math.max(-.5,Math.min(.5,z))),A.push(B)}return{target:Float64Array.from(y),image:Float64Array.from(g),score:Float64Array.from(A),count:A.length}}var Kt=961,vr=new Float32Array(Kt),Er=new Float32Array(Kt),Mr=new Float32Array(Kt);function Pr(r,e,t,n,o,a={}){let s=Math.min(15,a.radius??5),m=a.iterations??10,l=a.epsilon??.01,c=(a.minEigen??2)*(2*s+1)**2,i=Math.min(a.maxLevel??3,r.levels.length-1,t.levels.length-1),d=n.length/2,u=new Float64Array(2*d),p=new Uint8Array(d);for(let f=0;f<d;f++){let y=o[2*f]/2**i,g=o[2*f+1]/2**i,A=!0;for(let w=i;w>=0&&A;w--){let x=r.levels[w],h=t.levels[w],v=e(w),I=n[2*f]/2**w,E=n[2*f+1]/2**w;if(!oe(x.width,x.height,I-s,E-s,1.5)||!oe(x.width,x.height,I+s,E+s,1.5)){w===0&&(A=!1),y*=2,g*=2;continue}let M=0,b=0,P=0,U=0;for(let k=-s;k<=s;k++)for(let D=-s;D<=s;D++,U++){let Q=I+D,N=E+k,z=me(v.gx,v.width,Q,N),S=me(v.gy,v.width,Q,N);vr[U]=ee(x,Q,N),Er[U]=z,Mr[U]=S,M+=z*z,b+=S*S,P+=z*S}let C=(M+b)/2,O=C-Math.sqrt(Math.max(0,C*C-(M*b-P*P))),T=M*b-P*P;if(O<c||T<=0){w===0&&(A=!1),y*=2,g*=2;continue}let B=0,R=0;for(let k=0;k<m;k++){let D=0,Q=0;U=0;let N=I+y+B,z=E+g+R;if(!oe(h.width,h.height,N-s,z-s,1)||!oe(h.width,h.height,N+s,z+s,1)){A=w>0;break}for(let _=-s;_<=s;_++)for(let W=-s;W<=s;W++,U++){let H=vr[U]-ee(h,N+W,z+_);D+=H*Er[U],Q+=H*Mr[U]}let S=(b*D-P*Q)/T,L=(M*Q-P*D)/T;if(B+=S,R+=L,S*S+L*L<l*l)break}w>0?(y=2*(y+B),g=2*(g+R)):(y+=B,g+=R)}u[2*f]=n[2*f]+y,u[2*f+1]=n[2*f+1]+g,p[f]=A&&Number.isFinite(y)&&Number.isFinite(g)?1:0}return{positions:u,status:p}}function Ur(r,e,t,n,o,a,s,m={}){let l=Pr(r,e,t,o,a,m),c=Float64Array.from(l.positions,(f,y)=>o[y]-f),i=Pr(t,n,r,l.positions,c,m),d=o.length/2,u=new Float64Array(d),p=new Uint8Array(d);for(let f=0;f<d;f++)u[f]=Math.hypot(i.positions[2*f]-o[2*f],i.positions[2*f+1]-o[2*f+1]),p[f]=l.status[f]&&i.status[f]&&u[f]<=s?1:0;return{positions:l.positions,status:p,error:u}}function kn(r,e,t,n){let{width:o,height:a}=r,s=be(r),m=4,l=[];for(let x=m;x<a-m;x+=n)for(let h=m;h<o-m;h+=n){let v=[];for(let I=x;I<Math.min(a-m,x+n);I++)for(let E=h;E<Math.min(o-m,h+n);E++){let M=I*o+E,b=Math.hypot(s.gx[M],s.gy[M]);b<6||v.push({i:M,m:b})}v.sort((I,E)=>E.m-I.m||I.i-E.i),v=v.slice(0,3),l.push(...v)}l.sort((x,h)=>h.m-x.m||x.i-h.i);let c=l.slice(0,t).sort((x,h)=>x.i-h.i),i=c.length,d=o/2,u=a/2,p=Math.max(o,a)/2,f=new Float32Array(2*i),y=new Float32Array(i),g=new Float32Array(i),A=new Float32Array(i),w=new Float32Array(16*i);return c.forEach(({i:x},h)=>{let v=x%o,I=(x-v)/o,E=(v+.5-d)/p,M=(I+.5-u)/p;f[2*h]=E,f[2*h+1]=M,y[h]=r.data[I*r.stride+v],g[h]=s.gx[x]*p,A[h]=s.gy[x]*p,w.set([1,0,M,0,E,-E,-E*E,-E*M,0,1,0,E,-M,-2*M,-E*M,-M*M],16*h)}),{level:e,width:o,height:a,cx:d,cy:u,s:p,count:i,pn:f,value:y,gu:g,gv:A,jwjg:w}}function Bn(r,e){let{width:t,height:n}=r,o=be(r),a=new Float32Array(t*n);for(let c=4;c<n-4;c++)for(let i=4;i<t-4;i++){let d=0,u=0,p=0;for(let y=-2;y<=2;y++)for(let g=-2;g<=2;g++){let A=(c+y)*t+i+g;d+=o.gx[A]**2,u+=o.gy[A]**2,p+=o.gx[A]*o.gy[A]}let f=(d+u)/2;a[c*t+i]=f-Math.sqrt(Math.max(0,f*f-(d*u-p*p)))}let s=Math.max(12,Math.round(Math.sqrt(t*n/(e*1.5)))),m=[];for(let c=8;c<n-8;c+=s)for(let i=8;i<t-8;i+=s){let d={x:0,y:0,r:0};for(let u=c;u<Math.min(n-8,c+s);u++)for(let p=i;p<Math.min(t-8,i+s);p++){let f=a[u*t+p];f>d.r&&(d={x:p,y:u,r:f})}d.r>50&&m.push(d)}m.sort((c,i)=>i.r-c.r||c.y-i.y||c.x-i.x);let l=m.slice(0,e);return Float64Array.from(l.flatMap(c=>[c.x+.5,c.y+.5]))}function Fr(r,e={}){let t=kt(r.image,e.levels??5,16),n=t.levels.map((o,a)=>kn(o,a,e.esmPixels??3e3,e.esmCell??8));return{info:r.info,pyramid:t,esm:n,anchors:Bn(r.image,e.anchors??160)}}var ft=class{constructor(){F(this,"slots",[{pyramid:null,current:[],buffers:[]},{pyramid:null,current:[],buffers:[]}]);F(this,"next",0)}of(e){let t=this.slots.find(o=>o.pyramid===e);t||(t=this.slots[this.next],this.next^=1,t.pyramid=e,t.current=[]);let n=t;return o=>{let a=n.current[o];if(a)return a;let s=e.levels[o],m=n.buffers[o],l=be(s,m&&m.gx.length===s.width*s.height?m:void 0);return n.current[o]=l,n.buffers[o]=l,l}}};function Ht(r,e,t,n){return{targetId:r.info.id,frameId:t.frame.frameId,timeUs:t.frame.time.captureUs,H_imageFromTarget:e,corners:se(e,r.info.width,r.info.height),covariance:null,quality:n,origin:"tracker"}}function Cr(r,e,t){let n=r[6]*e+r[7]*t+r[8];return[(r[0]*e+r[1]*t+r[2])/n,(r[3]*e+r[4]*t+r[5])/n]}var Ne=class{constructor(e={}){F(this,"info");F(this,"models",new Map);F(this,"gradients",new ft);F(this,"options");F(this,"mode");this.options=e,this.mode=e.mode??"klt+esm",this.info={id:{klt:"D1.klt",esm:"D2.esm","klt+esm":"D1+D2.klt-esm",ncc:"D3.ncc"}[this.mode],layer:"L3",route:"light",determinism:"bit-exact",requires:[]}}probe(e){return{isAvailable:!0}}prepare(e){this.models.clear();for(let t of e)this.models.set(t.info.id,Fr(t,this.options.model))}model(e){return this.models.get(e)}trackNcc(e,t,n){let{width:o,height:a}=e.info,s=Wt(n,o,a),m=Math.max(0,Math.min(e.pyramid.levels.length-1,Math.round(Math.log2(1/Math.max(s,1e-6))))),l=xr(e,t.pyramid.levels[0],n,m,this.options.ncc);if(l.count<10)return{targetId:e.info.id,reason:"NCC_TOO_FEW"};let c=Array.from({length:l.count},(p,f)=>f).sort((p,f)=>l.score[f]-l.score[p]||p-f),i=Float64Array.from(c.flatMap(p=>[l.target[2*p],l.target[2*p+1]])),d=Float64Array.from(c.flatMap(p=>[l.image[2*p],l.image[2*p+1]])),u=we(i,d,l.count,o,a,{thresholdPx:1.5,maxIterations:100,minInliers:10,minInlierRatio:.4,minCoverage:.05});return u.accepted?Ht(e,u.H,t,{support:u.inliers,ratio:u.ratio,residual:u.rmsPx,residualKind:"px",coverage:u.coverage}):{targetId:e.info.id,reason:`NCC_${u.reason}`}}track(e){let t=this.models.get(e.prior.targetId);if(!t)return{targetId:e.prior.targetId,reason:"UNKNOWN_TARGET"};let{width:n,height:o}=t.info,a=e.prior.H_imageFromTarget;if(this.mode==="ncc")return this.trackNcc(t,e,a);let s=null;if(this.mode!=="esm"&&e.previous&&e.previous.pose.targetId===t.info.id){let l=e.previous.pose.H_imageFromTarget,c=t.anchors,i=c.length/2,d=new Float64Array(2*i),u=new Float64Array(2*i),p=e.previous.pyramid.levels[0],f=0,y=[];for(let g=0;g<i;g++){let[A,w]=Cr(l,c[2*g],c[2*g+1]);if(!(A>8&&w>8&&A<p.width-8&&w<p.height-8))continue;let[x,h]=Cr(a,c[2*g],c[2*g+1]);d[2*f]=A,d[2*f+1]=w,u[2*f]=x-A,u[2*f+1]=h-w,y.push(g),f++}if(f>=12){let g=Ur(e.previous.pyramid,this.gradients.of(e.previous.pyramid),e.pyramid,this.gradients.of(e.pyramid),d.subarray(0,2*f),u.subarray(0,2*f),1,this.options.klt),A=[],w=[],x=[];for(let M=0;M<f;M++){if(!g.status[M])continue;let b=y[M];A.push(c[2*b],c[2*b+1]),w.push(g.positions[2*M],g.positions[2*M+1]),x.push(g.error[M])}let h=x.map((M,b)=>b).sort((M,b)=>x[M]-x[b]||M-b),v=Float64Array.from(h.flatMap(M=>[A[2*M],A[2*M+1]])),I=Float64Array.from(h.flatMap(M=>[w[2*M],w[2*M+1]])),E=h.length>=12?we(v,I,h.length,n,o,{thresholdPx:2,maxIterations:100,minInliers:10,minInlierRatio:.5,minCoverage:.05}):null;E?.accepted&&(a=E.H,s={support:E.inliers,ratio:E.ratio,residual:E.rmsPx,residualKind:"px",coverage:E.coverage})}if(this.mode==="klt")return s?Ht(t,a,e,s):{targetId:t.info.id,reason:"KLT_LOST"}}let m=Ir(t,e.pyramid,this.gradients.of(e.pyramid),a,this.options.esm);return m?m.ncc<(this.options.minNcc??.6)||m.validRatio<(this.options.minValidRatio??.2)?{targetId:t.info.id,reason:"ESM_LOW_QUALITY"}:de(m.H,n,o)?Ht(t,m.H,e,{support:m.valid,ratio:m.ncc,residual:m.rms,residualKind:"gray",coverage:m.validRatio}):{targetId:t.info.id,reason:"ESM_IMPLAUSIBLE"}:{targetId:t.info.id,reason:"ESM_FAILED"}}};function kr(r=globalThis){r.addEventListener("message",Rn)}var Tr=null,pt=Promise.resolve();function Rn(r){let e=r.data;if(e.type==="targets"){let o=e.assets.map(a=>new Uint8Array(a));pt=pt.then(async()=>{await Tr?.loadEncoded(o)});return}if(e.type!=="init")return;let t=new ye(e.wasm===!1?{allowWasm:!1,orb:{wasm:!1},compile:{orb:{wasm:!1}}}:{});Tr=t,pt=(async()=>{e.assets?.length?await t.loadEncoded(e.assets.map(o=>new Uint8Array(o))):await t.load(e.targets.map(o=>({info:o.info,image:{width:o.info.width,height:o.info.height,stride:o.info.width,data:new Uint8Array(o.gray)}})))})();let n=e.port;n.addEventListener("message",o=>{let a=o.data;(async()=>{await pt;let s=performance.now(),m=await t.detect({sessionId:"relocalize",frameId:a.frameId,time:{captureUs:a.captureUs,receiveUs:s*1e3,source:"videoframe-timestamp"},image:{kind:"cpu-gray",image:{width:a.width,height:a.height,stride:a.width,data:new Uint8Array(a.gray)}}},{roi:a.roi,upscale:Ge(a.tracked)}),l={type:"relocalized",id:a.id,detected:m.find(c=>c.targetId===a.tracked.targetId)??null,tracked:a.tracked,detectUs:(performance.now()-s)*1e3};n.postMessage(l)})()}),n.start()}var pe={rotation:0,flip:!1};function Br(r){let e=r;return typeof e.rotation!="number"?null:{rotation:(Math.round(e.rotation/90)%4+4)%4*90,flip:e.flip===!0}}function At(r,e,t){return t.rotation%180?[e,r]:[r,e]}function Vt(r,e,t){let n;switch(t.rotation){case 90:n=[0,1,0,-1,0,e];break;case 180:n=[-1,0,r,0,-1,e];break;case 270:n=[0,-1,r,1,0,0];break;default:n=[1,0,0,0,1,0]}return t.flip&&(n=[-n[0],-n[1],r-n[2],n[3],n[4],n[5]]),n}function Rr(r){return`${r.flip?"flip+":""}r${r.rotation}`}var bt=new Set(["I420","I420A","I422","I444","NV12"]),It={RGBA:[0,1,2],RGBX:[0,1,2],BGRA:[2,1,0],BGRX:[2,1,0]},V=new Uint8Array(0),jt=new Uint8Array(0),Ee=null,gt=new Uint8Array(0);function Qn(r,e,t,n,o,a,s,m,l){let c=e/o,i=t/o,d=r,u=n;if(o>1){gt.length<c*i&&(gt=new Uint8Array(c*i));let v=o===2?2:4,I=o*o>>1;for(let E=0;E<i;E++)for(let M=0;M<c;M++){let b=0;for(let P=0;P<o;P++){let U=(E*o+P)*n+M*o;for(let C=0;C<o;C++)b+=r[U+C]}gt[E*c+M]=b+I>>v}d=gt,u=c}if(l.rotation===0&&!l.flip){for(let v=0;v<s;v++)m.set(d.subarray(v*u,v*u+a),v*a);return}let[p,f,y,g,A,w]=Vt(c,i,l),x=Math.round(.5*p+.5*f+y-.5),h=Math.round(.5*g+.5*A+w-.5);for(let v=0;v<s;v++){let I=x+f*v,E=h+A*v,M=v*a;for(let b=0;b<a;b++)m[M+b]=d[E*u+I],I+=p,E+=g}}function Yt(r,e,t,n,o,a,s,m=pe){let[l,c]=At(e,t,m),i=l/o;if((i===1||i===2||i===4)&&c===i*a&&e%i===0&&t%i===0){Qn(r,e,t,n,i,o,a,s,m);return}if(m.rotation!==0||m.flip){let[p,f]=At(e,t,m),[y,g,A,w,x,h]=Vt(e,t,m),v=p/o,I=f/a;for(let E=0;E<a;E++){let M=(E+.5)*I;for(let b=0;b<o;b++){let P=(b+.5)*v,U=Math.min(e-1.001,Math.max(0,y*P+g*M+A-.5)),C=Math.min(t-1.001,Math.max(0,w*P+x*M+h-.5)),O=Math.floor(U),T=Math.floor(C),B=U-O,R=C-T,k=T*n+O,D=r[k]+B*(r[k+1]-r[k]),Q=r[k+n]+B*(r[k+n+1]-r[k+n]);s[E*o+b]=D+R*(Q-D)+.5|0}}return}let d=e/o,u=t/a;for(let p=0;p<a;p++){let f=Math.min(t-1.001,Math.max(0,(p+.5)*u-.5)),y=Math.floor(f),g=f-y;for(let A=0;A<o;A++){let w=Math.min(e-1.001,Math.max(0,(A+.5)*d-.5)),x=Math.floor(w),h=w-x,v=y*n+x,I=r[v]+h*(r[v+1]-r[v]),E=r[v+n]+h*(r[v+n+1]-r[v+n]);s[p*o+A]=I+g*(E-I)+.5|0}}}async function Qr(r,e,t,n,o=pe){let a=n&&n.length===e*t?n:new Uint8Array(e*t),s=r.visibleRect??{x:0,y:0,width:r.codedWidth,height:r.codedHeight},m=r.format;if(m&&(bt.has(m)||It[m])){let i=r.allocationSize({rect:s});V.length<i&&(V=new Uint8Array(i));let u=(await r.copyTo(V,{rect:s}))[0];if(bt.has(m))return Yt(V.subarray(u.offset),s.width,s.height,u.stride,e,t,a,o),{image:{width:e,height:t,stride:e,data:a},path:"yuv-plane"};let[p,f,y]=It[m];jt.length<s.width*s.height&&(jt=new Uint8Array(s.width*s.height));let g=jt;for(let A=0;A<s.height;A++){let w=u.offset+A*u.stride;for(let x=0;x<s.width;x++){let h=w+4*x;g[A*s.width+x]=77*V[h+p]+150*V[h+f]+29*V[h+y]+128>>8}}return Yt(g,s.width,s.height,s.width,e,t,a,o),{image:{width:e,height:t,stride:e,data:a},path:"rgb-convert"}}Ee??=new OffscreenCanvas(e,t),(Ee.width!==e||Ee.height!==t)&&(Ee.width=e,Ee.height=t);let l=Ee.getContext("2d",{willReadFrequently:!0});if(!l)throw new Error("No OffscreenCanvas 2D context for frame conversion");l.drawImage(r,0,0,e,t);let c=l.getImageData(0,0,e,t).data;for(let i=0;i<e*t;i++)a[i]=77*c[4*i]+150*c[4*i+1]+29*c[4*i+2]+128>>8;return{image:{width:e,height:t,stride:e,data:a},path:"canvas"}}function Sn(r,e){let t=r.length,n=0,o=0;for(let i=0;i<t;i++)n+=r[i],o+=e[i];let a=n/t,s=o/t,m=0,l=0,c=0;for(let i=0;i<t;i++){let d=r[i]-a,u=e[i]-s;m+=d*u,l+=d*d,c+=u*u}return l>0&&c>0?m/Math.sqrt(l*c):0}var Sr=(r,e)=>{for(let t=0;t<e.length;t++)e[t]=77*r[4*t]+150*r[4*t+1]+29*r[4*t+2]+128>>8;return e},ht=null;function On(r,e,t){ht??=new OffscreenCanvas(e,t),ht.width=e,ht.height=t;let n=ht.getContext("2d",{willReadFrequently:!0});if(!n)throw new Error("no 2d context");return n.imageSmoothingQuality="high",n.drawImage(r,0,0,e,t),Sr(n.getImageData(0,0,e,t).data,new Uint8Array(e*t))}var Xt=null;function Gn(r,e,t){if(!Xt){let l=new OffscreenCanvas(e,t),c=l.getContext("webgl2",{antialias:!1,preserveDrawingBuffer:!0});if(!c)throw new Error("no webgl2 context");let i=(p,f)=>{let y=c.createShader(p);if(c.shaderSource(y,f),c.compileShader(y),!c.getShaderParameter(y,c.COMPILE_STATUS))throw new Error(c.getShaderInfoLog(y)??"shader");return y},d=c.createProgram();if(c.attachShader(d,i(c.VERTEX_SHADER,`#version 300 es\nout vec2 uv;\nvoid main() {\n  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);\n  gl_Position = vec4(p, 0.0, 1.0);\n  uv = vec2(0.5 * p.x + 0.5, 0.5 - 0.5 * p.y);\n}`)),c.attachShader(d,i(c.FRAGMENT_SHADER,`#version 300 es\nprecision mediump float;\nin vec2 uv;\nuniform sampler2D picture;\nout vec4 color;\nvoid main() { color = texture(picture, uv); }`)),c.linkProgram(d),!c.getProgramParameter(d,c.LINK_STATUS))throw new Error(c.getProgramInfoLog(d)??"link");c.useProgram(d);let u=c.createTexture();c.bindTexture(c.TEXTURE_2D,u),c.texParameteri(c.TEXTURE_2D,c.TEXTURE_MIN_FILTER,c.LINEAR_MIPMAP_LINEAR),c.texParameteri(c.TEXTURE_2D,c.TEXTURE_MAG_FILTER,c.LINEAR),c.texParameteri(c.TEXTURE_2D,c.TEXTURE_WRAP_S,c.CLAMP_TO_EDGE),c.texParameteri(c.TEXTURE_2D,c.TEXTURE_WRAP_T,c.CLAMP_TO_EDGE),Xt={canvas:l,gl:c,texture:u}}let{canvas:n,gl:o,texture:a}=Xt;(n.width!==e||n.height!==t)&&(n.width=e,n.height=t),o.viewport(0,0,e,t),o.bindTexture(o.TEXTURE_2D,a),o.texImage2D(o.TEXTURE_2D,0,o.RGBA,o.RGBA,o.UNSIGNED_BYTE,r),o.generateMipmap(o.TEXTURE_2D),o.drawArrays(o.TRIANGLES,0,3);let s=new Uint8Array(4*e*t);o.readPixels(0,0,e,t,o.RGBA,o.UNSIGNED_BYTE,s);let m=new Uint8Array(s.length);for(let l=0;l<t;l++)m.set(s.subarray((t-1-l)*4*e,(t-l)*4*e),l*4*e);return Sr(m,new Uint8Array(e*t))}function Dn(r,e,t,n,o,a,s){let m=new Uint8Array(16*o*a);Yt(r,e,t,n,4*o,4*a,m,s);let l=new Uint8Array(o*a);for(let c=0;c<a;c++)for(let i=0;i<o;i++){let d=0;for(let u=0;u<4;u++)for(let p=0;p<4;p++)d+=m[(4*c+u)*4*o+4*i+p];l[c*o+i]=d+8>>4}return l}async function Or(r,e,t,n=!1){let o=r.format,a=r.visibleRect??{x:0,y:0,width:r.codedWidth,height:r.codedHeight},s={format:o,raw:[a.width,a.height]};if(!o||!(bt.has(o)||It[o])||typeof OffscreenCanvas>"u")return{...s,orientation:null,reference:null,scores:{}};let m=Math.max(16,Math.round(e/8)),l=Math.max(16,Math.round(t/8)),c=r.allocationSize({rect:a});V.length<c&&(V=new Uint8Array(c));let i=(await r.copyTo(V,{rect:a}))[0],d=V.subarray(i.offset),u={stride:i.stride};if(!bt.has(o)){let[x,h,v]=It[o];d=new Uint8Array(a.width*a.height);for(let I=0;I<a.height;I++){let E=i.offset+I*i.stride;for(let M=0;M<a.width;M++){let b=E+4*M;d[I*a.width+M]=77*V[b+x]+150*V[b+h]+29*V[b+v]+128>>8}}u={stride:a.width}}let p=t>e,f=[0,90,180,270].map(x=>({rotation:x,flip:!1})).filter(x=>{let[h,v]=At(a.width,a.height,x);return v>h===p}).map(x=>({o:x,thumb:Dn(d,a.width,a.height,u.stride,m,l,x)})),y={},g={},A=null;for(let[x,h]of[["webgl",Gn],["2d",On]]){let v;try{v=h(r,m,l)}catch(b){y[x]=`error: ${String(b instanceof Error?b.message:b).slice(0,80)}`;continue}!1;let I=f.map(b=>({o:b.o,score:Sn(b.thumb,v)})).sort((b,P)=>P.score-b.score);y[x]=Object.fromEntries(I.map(b=>[`r${b.o.rotation}`,Math.round(b.score*1e3)/1e3]));let E=I[0],M=I[1]?.score??-1;E&&E.score>.7&&1-M>3*(1-E.score)+.02&&(!A||E.score>A.score)&&(A={o:E.o,reference:x,score:E.score})}return{...s,orientation:A?.o??null,reference:A?.reference??null,scores:y}}var wt={tracker:"esm",filter:"E2",relocalizeEvery:60,wasm:!0};var Zt=globalThis,re=null,vt=0,xt=0,Lr=0,We=640,Ke=360,Ln=()=>We,Nn=()=>Ke,Et=!1,$t=!1,Pt=0,Ue=!1,Ut=!1,Ae=null;function ne(r,e=[]){Zt.postMessage(r,e)}function zn(r,e){let t=e?.(r.timeUs+1e4).find(o=>o.targetId===r.targetId);if(!t)return new Array(8).fill(0);let n=[];for(let o=0;o<4;o++)for(let a=0;a<2;a++)n.push((t.corners[o][a]-r.corners[o][a])/.01);return n}var qe=null,ze=wt,Mt=null;async function Jt(r){let e=new ye(r.wasm?{}:{allowWasm:!1,orb:{wasm:!1},compile:{orb:{wasm:!1}}}),t=Mt,n=new De({id:"vision",detector:e,tracker:new Ne({mode:r.tracker,...r.esmIterations?{esm:{iterations:r.esmIterations}}:{}}),filter:a=>r.filter==="E1"?new Oe(a):new Se(a),...t?{relocalizer:({frame:a,roi:s,tracked:m})=>{if(a.image.kind!=="cpu-gray")return;let l=a.image.image.data.slice().buffer,c={type:"relocalize",id:vt++,gray:l,width:a.image.image.width,height:a.image.image.height,frameId:a.frameId,captureUs:a.time.captureUs,roi:s,tracked:m};t.postMessage(c,[l])}}:{}},{relocalizeEvery:r.relocalizeEvery,asyncRelocalization:!!t}),o;if(qe?.assets?.length)o=(await n.loadEncoded(qe.assets.map(s=>new Uint8Array(s)))).targets.map(s=>s.info);else{let a=(qe?.targets??[]).map(s=>({info:s.info,image:{width:s.info.width,height:s.info.height,stride:s.info.width,data:new Uint8Array(s.gray)}}));await n.load(a),o=a.map(s=>s.info)}return n.reset(`web-${++Lr}`),{pipeline:n,matcher:e.backend,infos:o}}var Me=pe,Pe="assumed",Ft="",er=-1/0,_e=null,Ct=!1,_n=30;async function qn(r){let e=Br(r);if(e)return Pe="metadata",Me=e;if(Pt-er>=_n){er=Pt;let t=null;try{t=await Or(r,We,Ke,!1)}catch(n){Pe="error",Ft=String(n instanceof Error?n.message:n).slice(0,120)}if(t){!1;let n=JSON.stringify(t.scores);if(t.orientation)Me=t.orientation,Pe=`detected[${t.reference}]`;else{let o=t.raw[0]>t.raw[1]!=We>Ke;Me=o?{rotation:90,flip:!1}:pe,Pe=o?"fallback":"assumed"}Ft=`${t.format} ${t.raw.join("x")} ${n}`}}return Me}async function Nr(r,e,t){if(!re){r?.close();return}let n=Ln(),o=Nn(),a=performance.now(),s="gray",m;if(r){let A=await Qr(r,n,o,void 0,await qn(r));m=A.image.data,s=A.path}else m=new Uint8Array(e);let l=performance.now(),c={sessionId:"web",frameId:Pt,time:{captureUs:t,receiveUs:a*1e3,source:r?"videoframe-timestamp":"callback"},image:{kind:"cpu-gray",image:{width:n,height:o,stride:n,data:m}}},i=await re.process(c),d=performance.now(),u=i.display.map(A=>({targetId:A.targetId,corners:A.corners,velocity:zn(A,i.predict),timeUs:A.timeUs})),p;if(!1){p=new Uint8Array(1024);for(let A=0;A<8;A++)p.set(m.subarray((o-8+A)*n,(o-8+A)*n+128),128*A)}let f=r&&Math.abs(a*1e3-t)<5e6?a*1e3-t:null,y={type:"result",sequence:Pt++,captureUs:t,state:i.state,size:[n,o],poses:u,stats:{lumaUs:(l-a)*1e3,processUs:(d-l)*1e3,arrivalUs:f,lumaPath:s,orientation:r?`${Rr(Me)}/${Pe}`:"gray",...r&&Ft?{orientationDetail:Ft}:{}},...{},...Et&&r?{frame:r}:{},...{},...{}};!1;let g=[];Et&&r&&g.push(r),ne(y,g),Et||r?.close()}var Gr=-1/0;function Wn(r){let e=r.timestamp,t=Number.isFinite(e)&&e>Gr?e:performance.now()*1e3;return Gr=t,t}async function Dr(r){let e=r.getReader(),t=null,n=!1,o=async()=>{for(n=!0;!Ut;){let{value:s,done:m}=await e.read();if(m)break;t?.close(),t=s,Ue||a()}n=!1},a=async()=>{for(Ue=!0;t&&!Ut;){let s=t;t=null;try{await Nr(s,null,Wn(s))}catch(m){ne({type:"error",message:String(m)})}}Ue=!1};n||await o()}async function Kn(){for(Ue=!0;Ae&&!Ut;){let r=Ae;Ae=null;try{await Nr(r.frame,r.gray,r.captureUs)}catch(e){r.frame?.close(),ne({type:"error",message:String(e)})}}Ue=!1}function zr(r=globalThis){Zt=r,Zt.addEventListener("message",Hn)}function Hn(r){let e=r.data;switch(e.type){case"init":{(async()=>{We=e.width,Ke=e.height,Et=e.returnFrames,$t=!1,Mt=e.relocalizer??null,Mt?.addEventListener("message",o=>{o.data.id>=xt&&re?.deliverRelocalization(o.data.detected,o.data.tracked)}),Mt?.start(),qe={targets:e.targets,assets:e.assets??null};let t=performance.now();ze={...wt,...e.pipeline};let n=await Jt(ze);re=n.pipeline,ne({type:"ready",matcher:n.matcher,compileMs:performance.now()-t,targets:n.infos})})().catch(t=>ne({type:"error",message:String(t)}));return}case"reconfigure":{(async()=>{ze={...wt,...e.pipeline};let t=await Jt(ze);xt=vt,re?.dispose(),re=t.pipeline})().catch(t=>ne({type:"error",message:`reconfigure: ${String(t)}`}));return}case"targets":{qe={targets:[],assets:e.assets},(async()=>{let t=await Jt(ze);xt=vt,re?.dispose(),re=t.pipeline,ne({type:"targets",targets:t.infos})})().catch(t=>ne({type:"error",message:`targets: ${String(t)}`}));return}case"stream":Dr(e.readable);return;case"track":{if(typeof MediaStreamTrackProcessor!="function"){ne({type:"error",message:"MediaStreamTrackProcessor unavailable in Worker"});return}Dr(new MediaStreamTrackProcessor({track:e.track,maxBufferSize:1}).readable);return}case"frame":case"gray":{Ae?.frame?.close(),Ae=e.type==="frame"?{frame:e.frame,gray:null,captureUs:e.captureUs}:{frame:null,gray:e.gray,captureUs:e.captureUs},Ue||Kn();return}case"resize":{We=e.width,Ke=e.height,xt=vt,re?.reset(`web-${++Lr}`),er=-1/0,Me=pe,Pe="assumed";break}case"stop":Ut=!0,Ae?.frame?.close(),Ae=null;return}}var Vn=48,jn=64,ge=class extends Error{constructor(t,n,o){super(n,o);F(this,"code");this.name="PictureError",this.code=t}};function Xn(r,e,t){let n=Math.min(1,t/Math.max(r,e));return[Math.max(1,Math.round(r*n)),Math.max(1,Math.round(e*n))]}function Yn(r,e,t){let n=new Uint8Array(e*t);for(let o=0;o<n.length;o++)n[o]=77*r[4*o]+150*r[4*o+1]+29*r[4*o+2]+128>>8;return n}function _r(){try{return typeof OffscreenCanvas=="function"&&!!new OffscreenCanvas(1,1).getContext("2d")}catch{return!1}}async function qr(r,e){let t;try{t=await createImageBitmap(r,{imageOrientation:"from-image"})}catch{try{t=await createImageBitmap(r)}catch(n){throw new ge("DECODE_FAILED",`The picture cannot be decoded: ${String(n)}`,{cause:n})}}try{let[n,o]=Xn(t.width,t.height,e),a=t,s=t.width,m=t.height;for(;s>2*n&&m>2*o;){let d=new OffscreenCanvas(Math.ceil(s/2),Math.ceil(m/2)),u=d.getContext("2d");u.imageSmoothingQuality="high",u.drawImage(a,0,0,d.width,d.height),a=d,s=d.width,m=d.height}let c=new OffscreenCanvas(n,o).getContext("2d",{willReadFrequently:!0});c.imageSmoothingQuality="high",c.drawImage(a,0,0,n,o);let i=c.getImageData(0,0,n,o).data;return{width:n,height:o,stride:n,data:Yn(i,n,o)}}finally{t.close()}}async function Wr(r,e){if(Math.min(e.width,e.height)<jn)throw new ge("UNSUITABLE_TARGET",`The picture is too small (${e.width}×${e.height} px)`);let t=Te({info:{id:r,width:e.width,height:e.height,physicalWidthMeters:null},image:e}),n=t.points.length/2;if(n<Vn)throw new ge("UNSUITABLE_TARGET",`The picture has too little detail (${n} recognition points)`);return{bytes:await Qe(t,e),pointCount:n}}function Kr(r){let e=Promise.resolve();r.addEventListener("message",t=>{let n=t.data;n.type==="compile"&&(e=e.then(async()=>{try{let o;if(n.gray)o={width:n.gray.width,height:n.gray.height,stride:n.gray.width,data:new Uint8Array(n.gray.data)};else if(_r())o=await qr(n.image,n.maxEdgePx);else{r.postMessage({type:"need-gray",id:n.id});return}let{bytes:a,pointCount:s}=await Wr(n.targetId,o),m=a.buffer;r.postMessage({type:"compiled",id:n.id,bytes:m,widthPx:o.width,heightPx:o.height,pointCount:s},[m])}catch(o){r.postMessage({type:"failed",id:n.id,code:o instanceof ge?o.code:"INVALID_TARGET",message:o instanceof Error?o.message:String(o)})}}))})}var He=globalThis;function Hr(r){let e=r.data;e?.type==="role"&&(He.removeEventListener("message",Hr),e.role==="vision"?zr(He):e.role==="relocalizer"?kr(He):Kr(He))}He.addEventListener("message",Hr);})();\n'], { type: "text/javascript" }));
  return blobUrl;
}
function spawnWorker(role, workerUrl) {
  let worker;
  try {
    worker = new Worker(workerUrl ?? embeddedUrl(), { name: `LiveMira ${role}` });
  } catch (cause) {
    if (cause instanceof EngineError) throw cause;
    throw new EngineError("WORKER_FAILED", `Cannot start the ${role} Worker (a CSP may forbid blob: Workers)`, {
      cause
    });
  }
  worker.postMessage({ type: "role", role });
  return worker;
}

// packages/engine/src/session.ts
function missingCapabilities(caps) {
  const missing2 = ["webgl2", "videoframe"].filter((c) => !caps.has(c));
  if (!caps.has("mstp-window") && !caps.has("mstp-worker") && !caps.has("rvfc")) missing2.push("rvfc");
  return missing2;
}
async function chooseProfile(preferred) {
  const caps = probeMainThread();
  if (await probeWorkerTrackProcessor()) caps.add("mstp-worker");
  const choice = resolveProfile(preferred, caps);
  if (!choice) {
    const missing2 = missingCapabilities(caps);
    throw new EngineError(
      "UNSUPPORTED_DEVICE",
      `This device cannot run recognition: it lacks ${missing2.join(", ") || "a supported capture path"} (WebGL2 is required)`,
      { missing: missing2 }
    );
  }
  return {
    profile: choice.profile.id,
    caps,
    fallbacks: choice.skipped.map((s) => ({ profile: s.id, missing: [...s.missing] }))
  };
}
var prefersReducedMotion = (doc) => {
  try {
    return !!doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
var VIEW_SETTLE_MS = 280;
var STALL_MS = 600;
var Session = class {
  constructor(settings, host, profile) {
    __publicField(this, "settings");
    __publicField(this, "host");
    __publicField(this, "aborted", false);
    __publicField(this, "ended", false);
    __publicField(this, "profile");
    __publicField(this, "camera", null);
    __publicField(this, "layer", null);
    __publicField(this, "vision", null);
    __publicField(this, "relocalizer", null);
    __publicField(this, "renderer", null);
    __publicField(this, "stopCapture", null);
    /** Track clones handed to capture; stopped with the session. */
    __publicField(this, "clones", []);
    __publicField(this, "resizeObserver", null);
    __publicField(this, "width", 640);
    __publicField(this, "height", 360);
    __publicField(this, "inFlight", 0);
    __publicField(this, "frames", 0);
    __publicField(this, "lastResultAt", 0);
    __publicField(this, "recent", []);
    __publicField(this, "visibility");
    __publicField(this, "presenters", /* @__PURE__ */ new Map());
    __publicField(this, "players", /* @__PURE__ */ new Map());
    __publicField(this, "corners", /* @__PURE__ */ new Map());
    __publicField(this, "aspects", /* @__PURE__ */ new Map());
    __publicField(this, "targetIds", []);
    __publicField(this, "transition", null);
    __publicField(this, "layoutKey", "");
    __publicField(this, "pendingTargets", null);
    /**
     * The view changes shape (rotation, resize, the address bar): nothing is drawn on targets until it settles and a
     * frame in the new standard size has been processed; the targets in view count as lost meanwhile.
     */
    __publicField(this, "onLayoutChange", () => {
      if (this.ended) return;
      const key = this.currentLayoutKey();
      if (key === this.layoutKey && !this.transition) return;
      this.layoutKey = key;
      if (!this.transition) {
        this.transition = { timer: null, settled: false };
        for (const id of this.visibility.clear()) this.targetLost(id, "viewport");
        this.renderer?.invalidate();
        this.host.emit("viewport", { phase: "begin" });
      }
      const t = this.transition;
      t.settled = false;
      if (t.timer) clearTimeout(t.timer);
      t.timer = setTimeout(() => {
        t.timer = null;
        const video = this.camera?.video;
        if (!video) return;
        const [w, h] = standardSize(video.videoWidth, video.videoHeight, this.settings.processingScale);
        if (w !== this.width || h !== this.height) {
          this.width = w;
          this.height = h;
          this.send({ type: "resize", width: w, height: h });
          this.renderer?.setStandardSize(w, h);
        }
        t.settled = true;
      }, VIEW_SETTLE_MS);
    });
    __publicField(this, "onTrackEnded", () => {
      this.fail(new EngineError("CAMERA_ENDED", "The camera stopped"), "camera-ended");
    });
    this.settings = settings;
    this.host = host;
    this.profile = profile;
    this.visibility = new TargetVisibility(settings.lossGraceMs);
  }
  check() {
    if (this.aborted) throw new EngineError("ABORTED", "The start was cancelled by a stop");
  }
  async start(targets, caps) {
    const s = this.settings;
    const profile = PROFILES[this.profile];
    this.vision = spawnWorker("vision", s.workerUrl);
    if (profile.concurrentSlowLoop) this.relocalizer = spawnWorker("relocalizer", s.workerUrl);
    const layer = s.container.ownerDocument.createElement("div");
    layer.setAttribute("data-livemira-stage", "");
    Object.assign(layer.style, { position: "absolute", inset: "0", overflow: "hidden", background: "#000" });
    s.container.append(layer);
    this.layer = layer;
    this.camera = await openCamera(
      { facingMode: s.facingMode, ...s.deviceId ? { deviceId: s.deviceId } : {} },
      layer
    );
    this.check();
    const { video, track } = this.camera;
    [this.width, this.height] = standardSize(video.videoWidth, video.videoHeight, s.processingScale);
    this.renderer = new StageRenderer(layer, this.width, this.height, {
      fit: s.fit,
      accent: s.accent,
      planes: (now) => this.planes(now)
    });
    this.setTargetsInfo(targets);
    const ready = new Promise((resolve, reject) => {
      const vision = this.vision;
      vision.onmessage = (event) => {
        const m = event.data;
        if (m.type === "ready") resolve();
        else if (m.type === "result") this.onResult(m);
        else if (m.type === "targets") this.onTargetsLoaded();
        else if (m.type === "error") {
          const error = new EngineError("WORKER_FAILED", `Recognition failed: ${m.message}`);
          if (this.frames) this.fail(error, "worker-failure");
          else reject(error);
        }
      };
      vision.onerror = (event) => {
        event.preventDefault();
        const error = new EngineError("WORKER_FAILED", `The vision Worker failed: ${event.message}`);
        if (this.frames) this.fail(error, "worker-failure");
        else reject(error);
      };
    });
    const assets = targets.map((t) => t.bytes.slice().buffer);
    let port = null;
    if (this.relocalizer) {
      const channel = new MessageChannel();
      this.relocalizer.postMessage(
        { type: "init", targets: [], assets: assets.map((a) => a.slice(0)), port: channel.port2 },
        [channel.port2]
      );
      this.relocalizer.onerror = (event) => {
        event.preventDefault();
        this.fail(
          new EngineError("WORKER_FAILED", `The relocalisation Worker failed: ${event.message}`),
          "worker-failure"
        );
      };
      port = channel.port1;
    }
    this.send(
      {
        type: "init",
        targets: [],
        assets,
        width: this.width,
        height: this.height,
        returnFrames: true,
        probe: DIAGNOSTICS,
        ...port ? { relocalizer: port } : {},
        pipeline: profile.pipeline
      },
      port ? [port] : []
    );
    await ready;
    this.check();
    track.addEventListener("ended", this.onTrackEnded);
    video.addEventListener("resize", this.onLayoutChange);
    this.resizeObserver = new ResizeObserver(() => this.onLayoutChange());
    this.resizeObserver.observe(s.container);
    this.layoutKey = this.currentLayoutKey();
    const capture = this.startCapture(caps, profile.capture);
    this.check();
    for (const id of this.targetIds) this.mediaChanged(id);
    return capture;
  }
  send(message, transfer = []) {
    this.vision?.postMessage(message, transfer);
  }
  /** Reads frames: the profile's capture paths in order, the first the platform supports. */
  startCapture(caps, order) {
    const { video, track } = this.camera;
    for (const path of order) {
      try {
        if (path === "mstp-window" && caps.has("mstp-window")) {
          const clone = track.clone();
          this.clones.push(clone);
          const processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 });
          this.send({ type: "stream", readable: processor.readable }, [processor.readable]);
          return path;
        }
        if (path === "mstp-worker" && caps.has("mstp-worker")) {
          const clone = track.clone();
          this.clones.push(clone);
          this.send({ type: "track", track: clone }, [clone]);
          return path;
        }
        if (path === "videoframe" && caps.has("videoframe") && caps.has("rvfc")) {
          let handle = 0;
          let active = true;
          const onFrame = (now, metadata) => {
            if (!active) return;
            handle = video.requestVideoFrameCallback(onFrame);
            if (this.inFlight > 0) return;
            const captureUs = (metadata.captureTime ?? now) * 1e3;
            const frame = new VideoFrame(video, { timestamp: Math.round(captureUs) });
            this.send({ type: "frame", frame, captureUs }, [frame]);
            this.inFlight++;
          };
          handle = video.requestVideoFrameCallback(onFrame);
          this.stopCapture = () => {
            active = false;
            video.cancelVideoFrameCallback(handle);
          };
          return path;
        }
      } catch {
      }
    }
    throw new EngineError("UNSUPPORTED_DEVICE", "No way to read camera frames on this device", { missing: ["rvfc"] });
  }
  onResult(m) {
    if (this.ended) {
      m.frame?.close();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.frames++;
    this.lastResultAt = performance.now();
    this.stepDown(m.stats.processUs);
    if (this.currentLayoutKey() !== this.layoutKey) this.onLayoutChange();
    const current = m.size[0] === this.width && m.size[1] === this.height;
    const poses = current && !this.transition ? m.poses : [];
    if (m.frame) {
      if (current) this.renderer?.presentFrame(m.frame);
      else m.frame.close();
    }
    if (this.transition?.settled && current) this.endTransition();
    if (this.transition) return;
    for (const p of poses) this.corners.set(p.targetId, p.corners);
    const { found, lost } = this.visibility.update(
      performance.now(),
      poses.map((p) => p.targetId)
    );
    for (const id of lost) this.targetLost(id, "out-of-view");
    if (DIAGNOSTICS)
      this.host.emit("trace", {
        timeMs: performance.now(),
        wallMs: Date.now(),
        state: m.state,
        size: m.size,
        poses: poses.map((p) => ({ targetId: p.targetId, corners: p.corners })),
        visible: this.visibility.visible(),
        processUs: m.stats.processUs,
        lumaUs: m.stats.lumaUs,
        ...m.trace ? { measured: m.trace.measured, timings: m.trace.timings } : {}
      });
    for (const id of found) {
      this.host.emit("targetFound", { targetId: id });
      const player = this.players.get(id);
      if (player && player.state !== "error") void player.play();
    }
  }
  /** Hawk that cannot keep up with the camera steps down to Swift (same capture, lighter pipeline). */
  stepDown(processUs) {
    if (this.profile !== "hawk") return;
    this.recent.push(processUs);
    if (this.recent.length > HAWK_BUDGET.window) this.recent.shift();
    const mean = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    if (this.frames > HAWK_BUDGET.warmup && this.recent.length === HAWK_BUDGET.window && mean > HAWK_BUDGET.budgetUs) {
      this.profile = "swift";
      this.send({ type: "reconfigure", pipeline: PROFILES.swift.pipeline });
      this.host.emit("profileChange", {
        from: "hawk",
        to: "swift",
        reason: `processing ${(mean / 1e3).toFixed(1)} ms/frame > ${HAWK_BUDGET.budgetUs / 1e3} ms`
      });
    }
  }
  targetLost(id, reason) {
    this.corners.delete(id);
    this.players.get(id)?.pause();
    this.host.emit("targetLost", { targetId: id, reason });
  }
  currentLayoutKey() {
    const video = this.camera?.video;
    const c = this.settings.container;
    return `${c.clientWidth}x${c.clientHeight}|${video?.videoWidth ?? 0}x${video?.videoHeight ?? 0}`;
  }
  endTransition() {
    this.transition = null;
    this.host.emit("viewport", { phase: "end" });
  }
  fail(error, reason) {
    if (this.ended) return;
    this.host.failed(error, reason);
  }
  // ---- Targets and their videos ----
  setTargetsInfo(targets) {
    this.targetIds = targets.map((t) => t.targetId);
    this.aspects = new Map(targets.map((t) => [t.targetId, t.widthPx / t.heightPx]));
  }
  /** New targets while running: loaded in the background; resolves once they are recognised. */
  loadTargets(targets) {
    const removed = this.targetIds.filter((id) => !targets.some((t) => t.targetId === id));
    for (const id of this.visibility.clear()) this.targetLost(id, "out-of-view");
    this.setTargetsInfo(targets);
    for (const id of removed) this.mediaChanged(id);
    const assets = targets.map((t) => t.bytes.slice().buffer);
    this.relocalizer?.postMessage({ type: "targets", assets: assets.map((a) => a.slice(0)) });
    this.send({ type: "targets", assets }, assets);
    this.pendingTargets?.resolve();
    return new Promise((resolve) => {
      this.pendingTargets = { resolve, ids: [...this.targetIds] };
    });
  }
  onTargetsLoaded() {
    const pending = this.pendingTargets;
    this.pendingTargets = null;
    if (!pending) return;
    pending.resolve();
    this.host.emit("targetsReady", { targetIds: pending.ids });
  }
  /** The target's video changed (set, replaced or cleared): its player is rebuilt. */
  mediaChanged(id) {
    const old = this.players.get(id);
    if (old) {
      this.renderer?.forget(old);
      old.dispose();
      this.players.delete(id);
    }
    this.presenters.get(id)?.mediaChanged();
    const media = this.targetIds.includes(id) ? this.host.media(id) : null;
    if (!media || !this.layer) {
      if (old) this.host.emit("media", { targetId: id, state: "none" });
      return;
    }
    const player = new MediaPlayer(this.layer, media, this.host.isMuted(), (state, code) => {
      if (this.players.get(id) !== player) return;
      this.host.emit("media", { targetId: id, state, ...code ? { code } : {} });
      if (state === "blocked") this.host.emit("playbackBlocked", { targetId: id });
      if (state === "ready" && this.visibility.isVisible(id)) void player.play();
      this.renderer?.invalidate();
    });
    this.players.set(id, player);
    this.host.emit("media", { targetId: id, state: "loading" });
    if (this.visibility.isVisible(id)) void player.play();
  }
  setMuted(isMuted) {
    for (const p of this.players.values()) p.setMuted(isMuted);
  }
  /** From a tap: plays the video of the photo in view (reloading it after an error). */
  async retry() {
    const id = this.visibility.visible()[0];
    if (!id) return false;
    let player = this.players.get(id);
    if (!player) return false;
    if (player.state === "error") {
      this.mediaChanged(id);
      player = this.players.get(id);
      if (!player) return false;
      return true;
    }
    await player.play();
    return player.state === "playing";
  }
  /** The video of a visible target (for sound changes from a tap). */
  activePlayer() {
    const id = this.visibility.visible()[0];
    return id && this.players.get(id) || null;
  }
  // ---- Drawing ----
  planes(now) {
    if (this.transition) return [];
    if (this.lastResultAt && now - this.lastResultAt > STALL_MS && this.visibility.visible().length)
      for (const id of this.visibility.clear()) this.targetLost(id, "out-of-view");
    const out = [];
    const presentation = this.settings.presentation;
    for (const id of this.visibility.visible()) {
      const corners = this.corners.get(id);
      if (!corners) continue;
      const presence = this.visibility.presence(id, now);
      const player = this.players.get(id) ?? null;
      const targetAspect = this.aspects.get(id) ?? 1;
      let look;
      if (presentation) {
        let presenter = this.presenters.get(id);
        if (!presenter)
          this.presenters.set(
            id,
            presenter = new PlanePresenter({
              ...presentation,
              isReducedMotion: () => prefersReducedMotion(this.settings.container.ownerDocument)
            })
          );
        const progress = this.host.progress(id);
        look = presenter.look(now, {
          presence,
          isPlaying: !!player?.isFlowing,
          isWaiting: progress !== null || !!player && player.state !== "error" && player.state !== "none",
          isBlocked: player?.state === "blocked",
          isBuffering: !!player?.isBuffering,
          progress,
          targetAspect,
          videoAspect: player?.aspect ?? 0
        });
      } else {
        const playing = !!player?.isFlowing;
        look = {
          alpha: presence,
          aspect: player?.aspect || targetAspect,
          veil: 0,
          reveal: playing ? 1 : 0,
          wave: 0,
          ring: 0,
          ringProgress: -1,
          spin: 0,
          play: 0,
          glow: 0,
          showVideo: playing,
          isAnimating: presence < 1
        };
      }
      if (!look) continue;
      out.push({
        targetId: id,
        corners,
        targetAspect,
        look,
        player,
        fit: this.host.media(id)?.fit ?? "contain"
      });
    }
    return out;
  }
  /** Releases everything; the targets in view are reported lost. Idempotent. */
  dispose() {
    this.aborted = true;
    if (this.ended) return;
    this.ended = true;
    for (const id of this.visibility.clear()) this.targetLost(id, "stopped");
    if (this.transition?.timer) clearTimeout(this.transition.timer);
    this.transition = null;
    this.pendingTargets?.resolve();
    this.pendingTargets = null;
    this.resizeObserver?.disconnect();
    this.stopCapture?.();
    try {
      this.send({ type: "stop" });
    } catch {
    }
    this.vision?.terminate();
    this.relocalizer?.terminate();
    for (const clone of this.clones)
      try {
        clone.stop();
      } catch {
      }
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.renderer?.dispose();
    if (this.camera) {
      this.camera.track.removeEventListener("ended", this.onTrackEnded);
      this.camera.video.removeEventListener("resize", this.onLayoutChange);
      for (const t of this.camera.stream.getTracks()) t.stop();
      this.camera.video.srcObject = null;
    }
    this.layer?.remove();
  }
};

// packages/imaging/src/pyramid.ts
var PyramidWorkspace = class {
  constructor() {
    __publicField(this, "rows", new Int32Array(0));
    __publicField(this, "levels", []);
  }
  /** Builds up to `levels` levels (stopping before a side drops below `minSize`); level 0 is the input itself. */
  build(image, levels, minSize = 24) {
    const out = [{ ...image, scale: 1 }];
    for (let l = 1; l < levels; l++) {
      const prev = out[l - 1];
      const w = prev.width >> 1;
      const h = prev.height >> 1;
      if (w < minSize || h < minSize) break;
      if (this.rows.length < prev.width * h) this.rows = new Int32Array(prev.width * h);
      const buf = this.levels[l] = this.levels[l] && this.levels[l].length === w * h ? this.levels[l] : new Uint8Array(w * h);
      downsample(prev, w, h, this.rows, buf);
      out.push({ width: w, height: h, stride: w, data: buf, scale: prev.scale * 2 });
    }
    return { levels: out };
  }
};
function downsample(src, w, h, rows, dst) {
  const sw = src.width;
  const sh = src.height;
  const s = src.data;
  const stride = src.stride;
  for (let y = 0; y < h; y++) {
    const c = 2 * y;
    const r0 = Math.max(0, c - 1) * stride;
    const r1 = c * stride;
    const r2 = Math.min(sh - 1, c + 1) * stride;
    const r3 = Math.min(sh - 1, c + 2) * stride;
    const o = y * sw;
    for (let x = 0; x < sw; x++) rows[o + x] = s[r0 + x] + 3 * s[r1 + x] + 3 * s[r2 + x] + s[r3 + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * sw;
    for (let x = 0; x < w; x++) {
      const c = 2 * x;
      const a = rows[o + Math.max(0, c - 1)];
      const b = rows[o + c];
      const d = rows[o + Math.min(sw - 1, c + 1)];
      const e = rows[o + Math.min(sw - 1, c + 2)];
      dst[y * w + x] = a + 3 * b + 3 * d + e + 32 >> 6;
    }
  }
}

// packages/features/src/orb.ts
var PATCH = 15;
var BORDER = PATCH + 3;
var GAUSSIAN_PATTERN = (() => {
  let s = 625341585;
  const uniform = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const out = new Int8Array(1024);
  for (let i = 0; i < 256; ) {
    const p = [0, 1, 2, 3].map(() => Math.round(gauss() * 8.5));
    if (Math.hypot(p[0], p[1]) > 15 || Math.hypot(p[2], p[3]) > 15 || Math.hypot(p[0] - p[2], p[1] - p[3]) < 2)
      continue;
    out.set(p, 4 * i);
    i++;
  }
  return out;
})();
var PATTERN_VERSION = 2;
var UMAX = (() => {
  const u = new Int32Array(PATCH + 1);
  for (let v = 0; v <= PATCH; v++) u[v] = Math.floor(Math.sqrt(PATCH * PATCH - v * v) + 0.5);
  return u;
})();
var OrbWorkspace = class {
  constructor() {
    __publicField(this, "octaves", new PyramidWorkspace());
    __publicField(this, "halfOctaves", new PyramidWorkspace());
    __publicField(this, "horizontal", new Uint16Array(0));
    __publicField(this, "blur", new Uint8Array(0));
    __publicField(this, "half", new Uint8Array(0));
    __publicField(this, "integral", new Int32Array(0));
  }
};
var WORKSPACE = new OrbWorkspace();

// packages/features/src/format.ts
var MAGIC = 844385612;
function resample(src, width, height) {
  if (src.width === width && src.height === height) return src;
  const out = new Uint8Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const v = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
    const j = Math.floor(v);
    const fy = v - j;
    for (let x = 0; x < width; x++) {
      const u = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
      const i = Math.floor(u);
      const fx = u - i;
      const o = j * src.stride + i;
      const d = src.data;
      const top = d[o] + fx * (d[o + 1] - d[o]);
      const bottom = d[o + src.stride] + fx * (d[o + src.stride + 1] - d[o + src.stride]);
      out[y * width + x] = Math.round(top + fy * (bottom - top));
    }
  }
  return { width, height, stride: width, data: out };
}
async function decodeTarget(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why) => {
    throw new Error(`Invalid target asset: ${why}`);
  };
  if (bytes.length < 64 || view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 2) fail("header");
  const pattern = view.getUint16(6, true) & 255;
  if (pattern !== PATTERN_VERSION)
    fail(`descriptor pattern v${pattern}, this engine uses v${PATTERN_VERSION}; recompile the target`);
  const body = bytes.subarray(0, bytes.length - 32);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
  if (!digest.every((v, i) => v === bytes[bytes.length - 32 + i])) fail("checksum");
  let o = 8;
  const idLength = view.getUint16(o, true);
  const id = new TextDecoder().decode(bytes.subarray(o + 2, o + 2 + idLength));
  o += 2 + idLength;
  const width = view.getUint16(o, true);
  const height = view.getUint16(o + 2, true);
  const physical = view.getFloat32(o + 4, true);
  o += 8;
  const n = view.getUint32(o, true);
  const d = view.getUint32(o + 4, true);
  o += 8;
  const points = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++, o += 4) points[i] = view.getFloat32(o, true);
  const repeatability = bytes.slice(o, o + n);
  o += n;
  const descriptorPoint = new Uint32Array(d);
  for (let i = 0; i < d; i++, o += 4) descriptorPoint[i] = view.getUint32(o, true);
  const descriptors = bytes.slice(o, o + 32 * d);
  o += 32 * d;
  const tw = view.getUint16(o, true);
  const th = view.getUint16(o + 2, true);
  o += 4;
  const stored = { width: tw, height: th, stride: tw, data: bytes.slice(o, o + tw * th) };
  return {
    compiled: {
      info: { id, width, height, physicalWidthMeters: Number.isNaN(physical) ? null : physical },
      points,
      repeatability,
      descriptors,
      descriptorPoint
    },
    template: resample(stored, width, height)
  };
}

// packages/web/src/picture.ts
var PictureError = class extends Error {
  constructor(code, message, options) {
    super(message, options);
    __publicField(this, "code");
    this.name = "PictureError";
    this.code = code;
  }
};
function scaledSize(width, height, maxEdge) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}
function grayFromRgba(rgba, width, height) {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++)
    gray[i] = 77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2] + 128 >> 8;
  return gray;
}
async function decodePictureOnPage(blob, maxEdge) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (cause) {
    throw new PictureError("DECODE_FAILED", "The picture cannot be decoded", { cause });
  }
  const [width, height] = scaledSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const gray = grayFromRgba(context.getImageData(0, 0, width, height).data, width, height);
  return { width, height, data: gray.buffer };
}

// packages/engine/src/targets.ts
var ID_RULE = /^[A-Za-z0-9_.-]{1,128}$/;
function isValidTargetId(id) {
  return typeof id === "string" && ID_RULE.test(id);
}
function assertTargetId(id) {
  if (!isValidTargetId(id))
    throw new EngineError("INVALID_TARGET", `Invalid target id ${JSON.stringify(id)}: 1..128 of A–Z a–z 0–9 _ . -`);
}
var IDLE_MS = 4e3;
var CompilerPool = class {
  constructor(workerUrl) {
    __publicField(this, "slots", []);
    __publicField(this, "queue", []);
    __publicField(this, "byId", /* @__PURE__ */ new Map());
    __publicField(this, "nextId", 1);
    __publicField(this, "idleTimer", null);
    __publicField(this, "size");
    __publicField(this, "workerUrl");
    this.workerUrl = workerUrl;
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    this.size = Math.max(1, Math.min(3, cores - 1));
  }
  run(request, signal) {
    return new Promise((resolve, reject) => {
      const job = { request, resolve, reject, slot: null };
      if (signal) {
        if (signal.aborted) return reject(new EngineError("ABORTED", "Compilation aborted"));
        signal.addEventListener(
          "abort",
          () => {
            const i = this.queue.indexOf(job);
            if (i >= 0) this.queue.splice(i, 1);
            if (job.slot) {
              job.slot.job = null;
              job.slot = null;
              this.pump();
            }
            reject(new EngineError("ABORTED", "Compilation aborted"));
          },
          { once: true }
        );
      }
      this.queue.push(job);
      this.pump();
    });
  }
  pump() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) {
        try {
          slot = this.spawn();
        } catch (error) {
          for (const job2 of this.queue.splice(0))
            job2.reject(error instanceof EngineError ? error : new EngineError("WORKER_FAILED", String(error)));
          return;
        }
      }
      if (!slot) break;
      const job = this.queue.shift();
      this.assign(slot, job);
    }
    if (!this.queue.length && this.slots.every((s) => !s.job)) this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
  }
  assign(slot, job) {
    const id = this.nextId++;
    slot.job = job;
    job.slot = slot;
    this.byId.set(id, job);
    const message = { ...job.request, id };
    slot.worker.postMessage(message);
  }
  spawn() {
    const worker = spawnWorker("compiler", this.workerUrl);
    const slot = { worker, job: null };
    worker.onmessage = (event) => void this.answer(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      const job = slot.job;
      this.slots.splice(this.slots.indexOf(slot), 1);
      worker.terminate();
      if (job) {
        job.slot = null;
        job.reject(new EngineError("WORKER_FAILED", `The compiler Worker failed: ${event.message}`));
      }
      this.pump();
    };
    this.slots.push(slot);
    return slot;
  }
  async answer(slot, m) {
    const job = this.byId.get(m.id);
    this.byId.delete(m.id);
    if (!job || job.slot !== slot) return this.pump();
    if (m.type === "need-gray") {
      try {
        const gray = await decodePictureOnPage(job.request.image, job.request.maxEdgePx);
        if (job.slot !== slot) return this.pump();
        this.byId.set(m.id, job);
        slot.worker.postMessage({ ...job.request, id: m.id, image: null, gray }, [gray.data]);
      } catch (error) {
        slot.job = null;
        job.slot = null;
        job.reject(
          error instanceof PictureError ? new EngineError(error.code, error.message, { cause: error.cause }) : new EngineError("DECODE_FAILED", String(error))
        );
        this.pump();
      }
      return;
    }
    slot.job = null;
    job.slot = null;
    if (m.type === "compiled") job.resolve(m);
    else if (m.type === "failed") job.reject(new EngineError(m.code, m.message));
    this.pump();
  }
  close() {
    this.idleTimer = null;
    for (const slot of this.slots.splice(0)) slot.worker.terminate();
  }
};
var pools = /* @__PURE__ */ new Map();
var poolFor = (workerUrl) => {
  const key = workerUrl ? String(workerUrl) : "";
  let pool = pools.get(key);
  if (!pool) pools.set(key, pool = new CompilerPool(workerUrl));
  return pool;
};
async function compileTargetImage(image, options) {
  if (!(typeof Blob !== "undefined" && image instanceof Blob))
    throw new EngineError("INVALID_CONFIG", "compileTargetImage needs a Blob or File");
  assertTargetId(options?.targetId);
  const maxEdgePx = options.maxEdgePx ?? 640;
  if (!Number.isInteger(maxEdgePx) || maxEdgePx < 64 || maxEdgePx > 2048)
    throw new EngineError("INVALID_CONFIG", "maxEdgePx must be an integer 64..2048");
  if (image.size === 0) throw new EngineError("DECODE_FAILED", "The picture file is empty");
  const result = await poolFor(options.workerUrl).run(
    { type: "compile", targetId: options.targetId, maxEdgePx, image, gray: null },
    options.signal
  );
  return Object.freeze({
    format: "livemira-target/2",
    targetId: options.targetId,
    widthPx: result.widthPx,
    heightPx: result.heightPx,
    pointCount: result.pointCount,
    bytes: new Uint8Array(result.bytes)
  });
}
async function parseTarget(bytes) {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  let asset;
  try {
    asset = await decodeTarget(data);
  } catch (cause) {
    throw new EngineError("INVALID_TARGET", cause instanceof Error ? cause.message : String(cause), { cause });
  }
  const info = asset.compiled.info;
  assertTargetId(info.id);
  return Object.freeze({
    format: "livemira-target/2",
    targetId: info.id,
    widthPx: info.width,
    heightPx: info.height,
    pointCount: asset.compiled.points.length / 2,
    bytes: data
  });
}
function checkTargets(targets) {
  if (!Array.isArray(targets)) throw new EngineError("INVALID_CONFIG", "setTargets needs an array");
  if (targets.length > 10) throw new EngineError("INVALID_CONFIG", "At most 10 targets");
  const ids = /* @__PURE__ */ new Set();
  for (const t of targets) {
    if (t?.format !== "livemira-target/2" || !(t.bytes instanceof Uint8Array))
      throw new EngineError("INVALID_TARGET", "Not a target bundle (use compileTargetImage or parseTarget)");
    assertTargetId(t.targetId);
    if (ids.has(t.targetId)) throw new EngineError("INVALID_CONFIG", `Duplicate target id ${t.targetId}`);
    ids.add(t.targetId);
  }
}

// packages/engine/src/engine.ts
var PROFILE_NAMES = ["hawk", "swift", "wren"];
var invalid = (message) => new EngineError("INVALID_CONFIG", message);
function inRange(value, min, max, name) {
  if (value === void 0) return void 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw invalid(`${name} must be a number ${min}..${max}`);
  return value;
}
function parseAccent(color) {
  if (color === void 0) return [192 / 255, 103 / 255, 74 / 255];
  if (typeof color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(color))
    throw invalid("presentation.accent must be a #rrggbb colour");
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255);
}
function settingsFrom(options) {
  if (!options || typeof options !== "object") throw invalid("createEngine needs options");
  const container = options.container;
  if (typeof HTMLElement === "undefined" || !(container instanceof HTMLElement))
    throw invalid("container must be an HTMLElement");
  const profile = options.profile ?? "swift";
  if (!PROFILE_NAMES.includes(profile)) throw invalid(`profile must be one of ${PROFILE_NAMES.join(", ")}`);
  const camera = options.camera ?? {};
  const facingMode = camera.facingMode ?? "environment";
  if (facingMode !== "environment" && facingMode !== "user")
    throw invalid("camera.facingMode must be 'environment' or 'user'");
  const fit = camera.fit ?? "cover";
  if (fit !== "cover" && fit !== "contain") throw invalid("camera.fit must be 'cover' or 'contain'");
  if (camera.deviceId !== void 0 && typeof camera.deviceId !== "string")
    throw invalid("camera.deviceId must be a string");
  const processingScale = camera.processingScale ?? 1;
  if (![1, 0.75, 0.5].includes(processingScale)) throw invalid("camera.processingScale must be 1, 0.75 or 0.5");
  const lossGraceMs = inRange(options.tracking?.lossGraceMs, 0, 1e3, "tracking.lossGraceMs") ?? 200;
  const p = options.presentation;
  const presentation = p === false ? null : {
    revealMs: inRange(p?.revealMs, 0, 3e3, "presentation.revealMs") ?? 900,
    resumeRevealMs: inRange(p?.resumeRevealMs, 0, 3e3, "presentation.resumeRevealMs") ?? 320,
    veilOpacity: inRange(p?.veilOpacity, 0, 1, "presentation.veilOpacity") ?? 0.5
  };
  return {
    container,
    profile,
    facingMode,
    deviceId: camera.deviceId,
    fit,
    processingScale,
    lossGraceMs,
    presentation,
    accent: parseAccent(p === false ? void 0 : p?.accent),
    workerUrl: options.workerUrl
  };
}
function checkMedia(media) {
  if (!media || typeof media !== "object") throw invalid("media must be an object or null");
  const hasFile = typeof Blob !== "undefined" && media.file instanceof Blob;
  const hasUrl = typeof media.url === "string" && media.url.length > 0;
  if (hasFile === hasUrl) throw invalid("media needs exactly one of file (a Blob) and url");
  if (hasFile && media.file.size === 0) throw new EngineError("MEDIA_FAILED", "The video file is empty");
  if (media.fit !== void 0 && !["contain", "cover", "fill"].includes(media.fit))
    throw invalid("media.fit must be 'contain', 'cover' or 'fill'");
  return { ...media };
}
var LiveMiraEngine = class {
  constructor(settings) {
    __publicField(this, "stateValue", "idle");
    __publicField(this, "settings");
    __publicField(this, "events", new Emitter());
    __publicField(this, "targets", []);
    __publicField(this, "mediaSpecs", /* @__PURE__ */ new Map());
    __publicField(this, "progressValues", /* @__PURE__ */ new Map());
    __publicField(this, "muted", true);
    __publicField(this, "session", null);
    /** Lifecycle operations run one after another. */
    __publicField(this, "queue", Promise.resolve());
    __publicField(this, "disposing", null);
    __publicField(this, "media");
    this.settings = settings;
    const engine = this;
    this.media = {
      get isMuted() {
        return engine.muted;
      },
      setMuted: (isMuted) => this.setMuted(isMuted),
      retry: () => this.session?.retry() ?? Promise.resolve(false)
    };
  }
  get state() {
    return this.stateValue;
  }
  get profile() {
    return this.stateValue === "running" ? this.session?.profile ?? null : null;
  }
  setState(state) {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.events.emit("state", { state });
  }
  on(type, listener) {
    return this.events.on(type, listener);
  }
  assertUsable() {
    if (this.stateValue === "disposed") throw new EngineError("DISPOSED", "The engine was disposed");
  }
  async setTargets(targets) {
    this.assertUsable();
    checkTargets(targets);
    const ids = new Set(targets.map((t) => t.targetId));
    for (const id of [...this.mediaSpecs.keys()]) if (!ids.has(id)) this.mediaSpecs.delete(id);
    for (const id of [...this.progressValues.keys()]) if (!ids.has(id)) this.progressValues.delete(id);
    this.targets = [...targets];
    if (this.session && (this.stateValue === "running" || this.stateValue === "starting"))
      await this.session.loadTargets(this.targets);
  }
  setTargetMedia(targetId, media) {
    this.assertUsable();
    if (!isValidTargetId(targetId)) throw invalid(`Invalid target id ${JSON.stringify(targetId)}`);
    if (media === null) this.mediaSpecs.delete(targetId);
    else this.mediaSpecs.set(targetId, checkMedia(media));
    if (this.stateValue === "running") this.session?.mediaChanged(targetId);
  }
  setTargetProgress(targetId, progress) {
    if (progress === null) this.progressValues.delete(targetId);
    else if (typeof progress === "number") this.progressValues.set(targetId, progress);
  }
  async setMuted(isMuted) {
    this.muted = isMuted;
    this.session?.setMuted(isMuted);
    const player = this.session?.activePlayer();
    if (!player || isMuted) return true;
    try {
      await player.video.play();
      return true;
    } catch {
      this.muted = true;
      this.session?.setMuted(true);
      return false;
    }
  }
  start() {
    this.assertUsable();
    if (this.stateValue === "running" || this.stateValue === "starting") return this.queue;
    const run = this.queue.then(() => this.runStart());
    this.queue = run.catch(() => {
    });
    return run;
  }
  async runStart() {
    if (this.stateValue === "disposed") throw new EngineError("DISPOSED", "The engine was disposed");
    if (this.stateValue === "running") return;
    this.setState("starting");
    let session = null;
    try {
      const { profile, caps, fallbacks } = await chooseProfile(this.settings.profile);
      session = new Session(this.settings, this.host(), profile);
      this.session = session;
      const targets = this.targets;
      const capture = await session.start(targets, caps);
      if (this.session !== session) throw new EngineError("ABORTED", "The start was cancelled by a stop");
      this.setState("running");
      this.events.emit("ready", { profile: session.profile, capture, fallbacks });
      if (targets.length) this.events.emit("targetsReady", { targetIds: targets.map((t) => t.targetId) });
    } catch (cause) {
      const error = asEngineError(cause, "CAMERA_START_FAILED", "The engine could not start");
      session?.dispose();
      if (this.session === session) this.session = null;
      this.setState("idle");
      this.events.emit("ended", error.code === "ABORTED" ? { reason: "stopped" } : { reason: "start-failed", error });
      if (error.code !== "ABORTED") this.events.emit("error", { error });
      throw error;
    }
  }
  host() {
    return {
      emit: (type, event) => this.events.emit(type, event),
      media: (id) => this.mediaSpecs.get(id) ?? null,
      progress: (id) => this.progressValues.get(id) ?? null,
      isMuted: () => this.muted,
      failed: (error, reason) => {
        const session = this.session;
        if (!session) return;
        this.session = null;
        session.dispose();
        if (this.stateValue === "running" || this.stateValue === "starting") this.setState("idle");
        this.events.emit("ended", { reason, error });
        this.events.emit("error", { error });
      }
    };
  }
  stop(reason = "stopped") {
    if (this.stateValue === "disposed") return Promise.resolve();
    const session = this.session;
    if (this.stateValue === "starting" && session) {
      this.session = null;
      session.dispose();
    }
    const run = this.queue.then(() => this.runStop(reason));
    this.queue = run.catch(() => {
    });
    return run;
  }
  async runStop(reason) {
    const session = this.session;
    if (!session || this.stateValue !== "running") return;
    this.setState("stopping");
    this.session = null;
    session.dispose();
    this.setState("idle");
    this.events.emit("ended", { reason });
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.disposing = this.stop("disposed").then(() => {
      this.mediaSpecs.clear();
      this.progressValues.clear();
      this.targets = [];
      this.setState("disposed");
      this.events.clear();
    });
    return this.disposing;
  }
};
function createEngine(options) {
  return new LiveMiraEngine(settingsFrom(options));
}
async function probeDevice() {
  try {
    const { profile } = await chooseProfile("swift");
    return { isSupported: true, missing: [], profile };
  } catch (error) {
    return {
      isSupported: false,
      missing: [...error.missing ?? ["unknown"]],
      profile: null
    };
  }
}
export {
  ENGINE_VERSION,
  EngineError,
  compileTargetImage,
  createEngine,
  engineBuildInfo,
  parseTarget,
  probeDevice
};
