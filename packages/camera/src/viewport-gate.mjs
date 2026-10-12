/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Orientation/viewport stabilization. Any trigger (orientation, container/viewport resize, intrinsic video resize,
 * geometry change, or a frame whose measured geometry differs from the open one) immediately masks the camera region and
 * bumps an epoch. Capture work that began under an older epoch is dropped. The gate reopens only on fresh frames: N
 * consecutive frames captured under the current epoch with identical geometry, measured view equal to the view at capture,
 * a quiet period since the last trigger, and (after orientation changes) an intrinsic swap or a bounded wait.
 * Timers are never used; the decision is taken on frames, so a debounce alone can never reopen the gate.
 */
export const DEFAULT_VIEWPORT_STABILIZATION = Object.freeze({ stableFrames: 2, quietMs: 100, orientationIntrinsicWaitMs: 400 });

export class ViewportGate {
  constructor({ env, container = null, nowUs, onTransition = () => {}, setMask = () => {}, options = {} }) {
    const o = { ...DEFAULT_VIEWPORT_STABILIZATION, ...options };
    this.env = env; this.container = container; this.nowUs = nowUs; this.onTransition = onTransition; this.setMask = setMask;
    if (!Number.isSafeInteger(o.stableFrames) || o.stableFrames < 1 || !Number.isFinite(o.quietMs) || o.quietMs < 0 || !Number.isFinite(o.orientationIntrinsicWaitMs) || o.orientationIntrinsicWaitMs < 0) throw new RangeError('Invalid viewport stabilization options');
    this.stableFrames = o.stableFrames; this.quietUs = o.quietMs * 1000; this.intrinsicWaitUs = o.orientationIntrinsicWaitMs * 1000;
    this.epoch = 0; this.gated = false; this.disposed = false;
    this.stable = 0; this.lastSig = null; this.openSig = null; this.openDims = null;
    this.stableSinceUs = 0; this.lastTriggerUs = 0; this.intrinsicWaitUntilUs = 0; this.preDims = null;
    this.view = this.measure();
    this.stats = { transitions: 0, triggers: 0, droppedFrames: 0, staleEpochDrops: 0, lastReason: null, lastOpenedEpoch: null };
    this.cleanups = [];
    const on = (target, name, fn) => {
      if (typeof target?.addEventListener !== 'function') return;
      target.addEventListener(name, fn);
      this.cleanups.push(() => target.removeEventListener?.(name, fn));
    };
    on(env.screen?.orientation, 'change', () => this.trigger('orientation', true));
    on(env, 'orientationchange', () => this.trigger('orientation', true));
    on(env, 'resize', () => this.check('resize'));
    on(env.visualViewport, 'resize', () => this.check('visual-viewport'));
    if (container && typeof env.ResizeObserver === 'function') {
      const observer = new env.ResizeObserver(() => this.check('container'));
      observer.observe(container);
      this.cleanups.push(() => observer.disconnect());
    }
  }
  attachVideo(video) {
    if (this.disposed || typeof video?.addEventListener !== 'function') return;
    const fn = () => this.trigger('intrinsic', false);
    video.addEventListener('resize', fn);
    this.cleanups.push(() => video.removeEventListener?.('resize', fn));
  }
  viewportGeometry() {
    if (!this.container) return null;
    const rect = this.container.getBoundingClientRect?.();
    const cssWidth = rect?.width ?? this.container.clientWidth;
    const cssHeight = rect?.height ?? this.container.clientHeight;
    if (!Number.isFinite(cssWidth) || !Number.isFinite(cssHeight) || cssWidth <= 0 || cssHeight <= 0) return null;
    return { cssWidth, cssHeight, dpr: this.env.devicePixelRatio ?? 1 };
  }
  measure() {
    const rect = this.container?.getBoundingClientRect?.();
    const vv = this.env.visualViewport, r2 = n => Math.round((n ?? 0) * 100) / 100;
    return JSON.stringify([r2(rect?.width ?? this.container?.clientWidth), r2(rect?.height ?? this.container?.clientHeight),
      r2(vv?.width ?? this.env.innerWidth), r2(vv?.height ?? this.env.innerHeight), this.env.screen?.orientation?.angle ?? this.env.orientation ?? null,
      this.env.devicePixelRatio ?? 1]);
  }
  /** Resize-class events only trigger when the measured view really changed. */
  check(reason) {
    if (this.disposed) return;
    const view = this.measure();
    if (view !== this.view) this.trigger(reason, false);
  }
  trigger(reason, orientation) {
    if (this.disposed) return;
    this.view = this.measure();
    const now = this.nowUs();
    this.epoch++; this.stable = 0; this.lastSig = null; this.lastTriggerUs = now; this.stableSinceUs = now;
    this.stats.triggers++; this.stats.lastReason = reason;
    if (orientation) { this.preDims ??= this.openDims; this.intrinsicWaitUntilUs = now + this.intrinsicWaitUs; }
    if (!this.gated) { this.gated = true; this.stats.transitions++; }
    this.setMask(true);
    this.onTransition({ phase: 'begin', epoch: this.epoch, reason });
  }
  /** Taken when a capture starts; the result is only valid while the epoch and view are unchanged. */
  begin() { return { epoch: this.epoch, view: this.measure() }; }
  /** Called with a fully captured frame; true means the frame may be delivered. */
  admit(token, sig, dims) {
    if (this.disposed) return false;
    if (token.epoch !== this.epoch) { this.stats.staleEpochDrops++; this.stats.droppedFrames++; return false; }
    if (this.container && !this.viewportGeometry()) { if (!this.gated) this.trigger('empty-container', false); this.stats.droppedFrames++; return false; }
    const view = this.measure();
    if (view !== token.view || view !== this.view) { this.trigger('frame-view', false); this.stats.droppedFrames++; return false; }
    if (!this.gated) {
      if (this.openSig !== null && sig !== this.openSig) { this.trigger('frame-geometry', false); this.stats.droppedFrames++; return false; }
      this.openSig = sig; this.openDims = dims; return true;
    }
    const now = this.nowUs();
    if (sig !== this.lastSig) { this.stable = 1; this.stableSinceUs = now; }
    else this.stable++;
    this.lastSig = sig;
    const intrinsicOk = now >= this.intrinsicWaitUntilUs || !this.preDims || dims !== this.preDims;
    if (this.stable < this.stableFrames || now - this.stableSinceUs < this.quietUs || !intrinsicOk) { this.stats.droppedFrames++; return false; }
    this.gated = false; this.openSig = sig; this.openDims = dims; this.preDims = null; this.stats.lastOpenedEpoch = this.epoch;
    this.setMask(false);
    this.onTransition({ phase: 'end', epoch: this.epoch, reason: this.stats.lastReason });
    return !this.disposed && !this.gated && token.epoch === this.epoch;
  }
  getDiagnostics() {
    return { state: this.gated ? 'gated' : 'open', epoch: this.epoch, stableFrames: this.stable, requiredStableFrames: this.stableFrames, ...this.stats };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0)) { try { cleanup(); } catch { /* Teardown continues. */ } }
    this.setMask(false);
  }
}
