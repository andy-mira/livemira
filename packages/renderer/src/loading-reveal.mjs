/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Loading mask and circular reveal drawn INSIDE the perspective video plane (a child of PerspectiveVideoRenderer.plane), so they follow the
 * plane's matrix3d, are clipped by its overflow and inherit pointer-events:none. It has no media or tracking knowledge: the renderer decides
 * when to show loading, reveal, finish or dispose. Nothing is appended to the page, the camera view or any stylesheet.
 */
export const REVEAL_DEFAULTS = Object.freeze({ revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: .55 });
/** Reduced motion replaces the expanding circle and the rotation with a short opacity cross-fade and a static ring. */
export const REDUCED_REVEAL_MS = 120;
const SPIN_MS = 900;
const SOFT_EDGE_RATIO = .22;
const MASK_PROPS = ['webkitMaskImage', 'maskImage'];
const ease = t => 1 - (1 - t) ** 3;
const setAttr = (el, name, value) => { try { el.setAttribute?.(name, value); } catch { /* Attributes are evidence only. */ } };
const px = n => `${Math.round(n * 100) / 100}px`;

/** Validates user options; throws RangeError on values that would allow an unbounded spinner or an invisible mask. */
export function normalizePresentationOptions(options) {
  if (options === false) return null;
  const o = options === undefined || options === true ? {} : options;
  if (!o || typeof o !== 'object') throw new RangeError('Invalid presentation options');
  const { revealMs = REVEAL_DEFAULTS.revealMs, loadingTimeoutMs = REVEAL_DEFAULTS.loadingTimeoutMs, overlayOpacity = REVEAL_DEFAULTS.overlayOpacity } = o;
  if (!Number.isFinite(revealMs) || revealMs < 0 || revealMs > 2000) throw new RangeError('presentation.revealMs must be 0..2000');
  if (!Number.isFinite(loadingTimeoutMs) || loadingTimeoutMs < 1 || loadingTimeoutMs > 600000) throw new RangeError('presentation.loadingTimeoutMs must be finite, 1..600000');
  if (!Number.isFinite(overlayOpacity) || overlayOpacity < .05 || overlayOpacity > 1) throw new RangeError('presentation.overlayOpacity must be .05..1');
  return { revealMs, loadingTimeoutMs, overlayOpacity };
}

export class PlanePresentation {
  /**
   * @param plane the plane element (video is its first child and stays so)
   * @param video the plane's video element
   * @param opts { width, height, overlayOpacity, now: () => ms, document }
   */
  constructor(plane, video, { width, height, overlayOpacity = REVEAL_DEFAULTS.overlayOpacity, now = () => performance.now(), document: doc = plane.ownerDocument }) {
    this.plane = plane; this.video = video; this.width = width; this.height = height; this.overlayOpacity = overlayOpacity; this.now = now;
    this.doc = doc; this.view = this.doc?.defaultView ?? null;
    this.layer = null; this.spinner = null; this.spin = null; this.token = 0; this.handle = null; this.mode = 'idle'; this.disposed = false;
    // The mask path needs radial-gradient mask support on a video element; otherwise the same timing is a plain opacity fade.
    const supports = this.view?.CSS?.supports?.bind(this.view.CSS);
    this.maskable = Boolean(supports && (supports('mask-image', 'radial-gradient(#000,transparent)') || supports('-webkit-mask-image', 'radial-gradient(#000,transparent)')));
  }
  /** User preference, read at use time so a live OS change applies to the next transition. */
  static prefersReducedMotion(view) {
    try { return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches); } catch { return false; }
  }
  get phase() { return this.mode; }
  get reducedMotion() { return PlanePresentation.prefersReducedMotion(this.view); }
  /** Dim layer + spinner on top of the plane; the video is kept invisible (not removed) so its first frame can still be composited. */
  showLoading(reduced = false) {
    if (this.disposed) return;
    this.stopAnimation(); this.removeOverlay();
    const doc = this.doc, size = Math.max(16, Math.min(96, Math.round(Math.min(this.width, this.height) * .1)));
    const layer = doc.createElement('div'), spinner = doc.createElement('div');
    Object.assign(layer.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', background: `rgba(0,0,0,${this.overlayOpacity})`, pointerEvents: 'none', opacity: '1' });
    Object.assign(spinner.style, { position: 'absolute', left: '50%', top: '50%', width: px(size), height: px(size), marginLeft: px(-size / 2), marginTop: px(-size / 2), boxSizing: 'border-box',
      border: `${px(Math.max(2, size / 9))} solid rgba(255,255,255,.28)`, borderTopColor: '#fff', borderRadius: '50%', pointerEvents: 'none', transformOrigin: '50% 50%' });
    setAttr(layer, 'data-lm-presentation', 'loading'); setAttr(layer, 'aria-hidden', 'true'); setAttr(spinner, 'data-lm-spinner', reduced ? 'static' : 'spinning');
    layer.append(spinner); this.plane.append(layer);
    this.layer = layer; this.spinner = spinner; this.mode = 'loading';
    this.hideVideo();
    if (!reduced && typeof spinner.animate === 'function') {
      try { this.spin = spinner.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: SPIN_MS, iterations: Infinity }); } catch { this.spin = null; }
    }
  }
  /**
   * Circular reveal from the plane centre: a soft-edged radius grows from 0 to cover the farthest corner, eased out. The video shows inside the circle,
   * the dim layer only outside it. `onEnd(completed)` runs once; it is not called after cancel()/dispose().
   */
  reveal({ durationMs, reduced = false, onEnd = () => {} }) {
    if (this.disposed) return;
    this.stopAnimation();
    if (!this.layer) this.showLoading(reduced);
    const token = ++this.token, start = this.now();
    this.mode = 'revealing'; setAttr(this.layer, 'data-lm-presentation', 'revealing');
    this.stopSpin();
    const duration = reduced ? Math.min(durationMs, REDUCED_REVEAL_MS) : durationMs;
    const useMask = this.maskable && !reduced;
    const soft = Math.max(8, Math.min(this.width, this.height) * SOFT_EDGE_RATIO);
    const end = Math.hypot(this.width, this.height) / 2 + soft;
    if (!useMask) this.clearVideoMask();
    this.onEnd = onEnd;
    const frame = () => {
      this.handle = null;
      if (token !== this.token || this.disposed) return;
      const t = duration <= 0 ? 1 : Math.min(1, Math.max(0, (this.now() - start) / duration));
      if (t >= 1) { this.complete(true); return; }
      const e = ease(t);
      if (this.spinner) this.spinner.style.opacity = String(Math.max(0, 1 - e * 3));
      if (useMask) {
        const r = e * end, inner = Math.max(0, r - soft);
        this.setMask(this.video, `radial-gradient(circle at 50% 50%, #000 ${px(inner)}, transparent ${px(r)})`);
        this.setMask(this.layer, `radial-gradient(circle at 50% 50%, transparent ${px(inner)}, #000 ${px(r)})`);
      } else {
        this.video.style.opacity = String(e); this.layer.style.opacity = String(1 - e);
      }
      this.schedule(frame);
    };
    frame();
  }
  /** Snaps to the fully revealed end state (video fully visible, overlay removed). The pending onEnd runs with completed=false. */
  finish() { if (this.mode === 'revealing') this.complete(false); }
  /** Drops the loading/reveal visuals without showing the video (release/failure); no onEnd. */
  cancel() { this.token++; this.stopAnimation(); this.removeOverlay(); this.onEnd = null; if (this.mode !== 'revealed') this.mode = 'idle'; }
  dispose() { if (this.disposed) return; this.cancel(); this.disposed = true; this.mode = 'disposed'; }

  complete(completed) {
    const onEnd = this.onEnd; this.onEnd = null;
    this.token++; this.stopAnimation(); this.removeOverlay(); this.showVideo(); this.mode = 'revealed';
    try { onEnd?.(completed); } catch { /* Observer isolation: the end state is already applied. */ }
  }
  schedule(fn) {
    const raf = this.view?.requestAnimationFrame;
    this.handle = typeof raf === 'function' ? { raf: raf.call(this.view, fn) } : { timer: globalThis.setTimeout(fn, 16) };
  }
  stopAnimation() {
    const h = this.handle; this.handle = null;
    if (h?.raf !== undefined) { try { this.view?.cancelAnimationFrame?.(h.raf); } catch { /* Token check ignores late frames. */ } }
    if (h?.timer !== undefined) globalThis.clearTimeout(h.timer);
    this.stopSpin();
  }
  stopSpin() { try { this.spin?.cancel?.(); } catch { /* Already finished. */ } this.spin = null; }
  removeOverlay() { try { this.layer?.remove?.(); } catch { /* Detached already. */ } this.layer = null; this.spinner = null; }
  setMask(el, value) { for (const prop of MASK_PROPS) el.style[prop] = value; }
  clearVideoMask() { for (const prop of MASK_PROPS) this.video.style[prop] = ''; }
  hideVideo() {
    if (this.maskable) { this.setMask(this.video, 'linear-gradient(transparent, transparent)'); this.video.style.opacity = ''; } else this.video.style.opacity = '0';
  }
  showVideo() { this.clearVideoMask(); this.video.style.opacity = ''; }
  /** Undoes the video hiding without any animation (used when the decoration itself could not be set up). */
  restoreVideo() { this.showVideo(); }
}
