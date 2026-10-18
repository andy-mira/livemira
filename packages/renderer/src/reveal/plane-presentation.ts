/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Loading mask and circular reveal drawn inside the perspective video plane, so they follow the plane's matrix3d,
// are clipped by its overflow and let pointer events through. No media or tracking knowledge: the renderer decides
// when to show loading, reveal, finish or dispose. Nothing is added to the page, the camera view or any stylesheet.

import { EngineError } from '@livemira/contracts';

export interface RevealOptions {
  /** 0..2000, default 420. */
  readonly revealMs?: number;
  /** 1..600000, default 15000; counts only while the plane is visible. */
  readonly loadingTimeoutMs?: number;
  /** 0.05..1, default 0.55. */
  readonly overlayOpacity?: number;
}

export type ResolvedRevealOptions = Required<RevealOptions>;

export const REVEAL_DEFAULTS: ResolvedRevealOptions = Object.freeze({
  revealMs: 420,
  loadingTimeoutMs: 15000,
  overlayOpacity: 0.55,
});
/** Reduced motion replaces the expanding circle and the rotation with a short cross-fade and a static ring. */
export const REDUCED_REVEAL_MS = 120;
const SPIN_MS = 900;
const SOFT_EDGE_RATIO = 0.22;
const MASK_PROPS = ['webkitMaskImage', 'maskImage'] as const;
const ease = (t: number): number => 1 - (1 - t) ** 3;
const px = (n: number): string => `${Math.round(n * 100) / 100}px`;
const setAttr = (element: Element, name: string, value: string): void => {
  try {
    element.setAttribute?.(name, value);
  } catch {
    // Attributes are evidence only.
  }
};

/** Validates the presentation options; null when the presentation is off. Throws INVALID_CONFIG. */
export function resolveRevealOptions(
  options: RevealOptions | boolean | undefined,
): ResolvedRevealOptions | null {
  if (options === false) return null;
  const o = options === undefined || options === true ? {} : options;
  const invalid = (message: string): EngineError =>
    new EngineError('INVALID_CONFIG', message, { isRecoverable: false });
  if (!o || typeof o !== 'object') throw invalid('Invalid presentation options');
  const {
    revealMs = REVEAL_DEFAULTS.revealMs,
    loadingTimeoutMs = REVEAL_DEFAULTS.loadingTimeoutMs,
    overlayOpacity = REVEAL_DEFAULTS.overlayOpacity,
  } = o;
  if (!Number.isFinite(revealMs) || revealMs < 0 || revealMs > 2000)
    throw invalid('presentation.revealMs must be 0..2000');
  if (!Number.isFinite(loadingTimeoutMs) || loadingTimeoutMs < 1 || loadingTimeoutMs > 600000)
    throw invalid('presentation.loadingTimeoutMs must be finite, 1..600000');
  if (!Number.isFinite(overlayOpacity) || overlayOpacity < 0.05 || overlayOpacity > 1)
    throw invalid('presentation.overlayOpacity must be .05..1');
  return { revealMs, loadingTimeoutMs, overlayOpacity };
}

type View = Window & typeof globalThis;
type Handle = { raf: number } | { timer: ReturnType<typeof setTimeout> };

export type PresentationPhase = 'idle' | 'loading' | 'revealing' | 'revealed' | 'disposed';

export class PlanePresentation {
  private readonly plane: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private readonly overlayOpacity: number;
  private readonly nowMs: () => number;
  private readonly doc: Document;
  private readonly view: View | null;
  /** Radial-gradient masks on a video element; otherwise the same timing is a plain opacity fade. */
  private readonly isMaskable: boolean;
  private layer: HTMLElement | null = null;
  private spinner: HTMLElement | null = null;
  private spin: Animation | null = null;
  private token = 0;
  private handle: Handle | null = null;
  private mode: PresentationPhase = 'idle';
  private isDisposed = false;
  private onEnd: ((isCompleted: boolean) => void) | null = null;

  /** `plane` holds `video` as its first child, and it stays so. */
  constructor(
    plane: HTMLElement,
    video: HTMLVideoElement,
    options: {
      widthPx: number;
      heightPx: number;
      overlayOpacity?: number;
      nowMs?: () => number;
      document?: Document;
    },
  ) {
    this.plane = plane;
    this.video = video;
    this.widthPx = options.widthPx;
    this.heightPx = options.heightPx;
    this.overlayOpacity = options.overlayOpacity ?? REVEAL_DEFAULTS.overlayOpacity;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.doc = options.document ?? plane.ownerDocument;
    this.view = (this.doc?.defaultView as View | null | undefined) ?? null;
    const supports = this.view?.CSS?.supports?.bind(this.view.CSS);
    this.isMaskable = Boolean(
      supports &&
      (supports('mask-image', 'radial-gradient(#000,transparent)') ||
        supports('-webkit-mask-image', 'radial-gradient(#000,transparent)')),
    );
  }

  /** The user preference, read at use time so a live system change applies to the next transition. */
  static prefersReducedMotion(view: View | null): boolean {
    try {
      return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    } catch {
      return false;
    }
  }

  get phase(): PresentationPhase {
    return this.mode;
  }

  get isReducedMotion(): boolean {
    return PlanePresentation.prefersReducedMotion(this.view);
  }

  /** Dim layer and spinner over the plane; the video stays in place but invisible, so its first frame can composite. */
  showLoading(isReduced = false): void {
    if (this.isDisposed) return;
    this.stopAnimation();
    this.removeOverlay();
    const doc = this.doc;
    const size = Math.max(
      16,
      Math.min(96, Math.round(Math.min(this.widthPx, this.heightPx) * 0.1)),
    );
    const layer = doc.createElement('div');
    const spinner = doc.createElement('div');
    Object.assign(layer.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      background: `rgba(0,0,0,${this.overlayOpacity})`,
      pointerEvents: 'none',
      opacity: '1',
    });
    Object.assign(spinner.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: px(size),
      height: px(size),
      marginLeft: px(-size / 2),
      marginTop: px(-size / 2),
      boxSizing: 'border-box',
      border: `${px(Math.max(2, size / 9))} solid rgba(255,255,255,.28)`,
      borderTopColor: '#fff',
      borderRadius: '50%',
      pointerEvents: 'none',
      transformOrigin: '50% 50%',
    });
    setAttr(layer, 'data-lm-presentation', 'loading');
    setAttr(layer, 'aria-hidden', 'true');
    setAttr(spinner, 'data-lm-spinner', isReduced ? 'static' : 'spinning');
    layer.append(spinner);
    this.plane.append(layer);
    this.layer = layer;
    this.spinner = spinner;
    this.mode = 'loading';
    this.hideVideo();
    if (!isReduced && typeof spinner.animate === 'function') {
      try {
        this.spin = spinner.animate(
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
          {
            duration: SPIN_MS,
            iterations: Infinity,
          },
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
  reveal(options: {
    durationMs: number;
    isReduced?: boolean;
    onEnd?: (isCompleted: boolean) => void;
  }): void {
    if (this.isDisposed) return;
    const { durationMs, isReduced = false, onEnd = () => {} } = options;
    this.stopAnimation();
    if (!this.layer) this.showLoading(isReduced);
    const token = ++this.token;
    const start = this.nowMs();
    this.mode = 'revealing';
    setAttr(this.layer!, 'data-lm-presentation', 'revealing');
    this.stopSpin();
    const duration = isReduced ? Math.min(durationMs, REDUCED_REVEAL_MS) : durationMs;
    const useMask = this.isMaskable && !isReduced;
    const soft = Math.max(8, Math.min(this.widthPx, this.heightPx) * SOFT_EDGE_RATIO);
    const end = Math.hypot(this.widthPx, this.heightPx) / 2 + soft;
    if (!useMask) this.clearVideoMask();
    this.onEnd = onEnd;
    const frame = (): void => {
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
          `radial-gradient(circle at 50% 50%, #000 ${px(inner)}, transparent ${px(r)})`,
        );
        this.setMask(
          this.layer!,
          `radial-gradient(circle at 50% 50%, transparent ${px(inner)}, #000 ${px(r)})`,
        );
      } else {
        this.video.style.opacity = String(e);
        this.layer!.style.opacity = String(1 - e);
      }
      this.schedule(frame);
    };
    frame();
  }

  /** Snaps to the fully revealed end state; the pending onEnd runs with isCompleted false. */
  finish(): void {
    if (this.mode === 'revealing') this.complete(false);
  }

  /** Drops the loading and reveal visuals without showing the video (release or failure); no onEnd. */
  cancel(): void {
    this.token++;
    this.stopAnimation();
    this.removeOverlay();
    this.onEnd = null;
    if (this.mode !== 'revealed') this.mode = 'idle';
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.cancel();
    this.isDisposed = true;
    this.mode = 'disposed';
  }

  /** Undoes the video hiding without any animation (used when the decoration itself could not be set up). */
  restoreVideo(): void {
    this.showVideo();
  }

  private complete(isCompleted: boolean): void {
    const onEnd = this.onEnd;
    this.onEnd = null;
    this.token++;
    this.stopAnimation();
    this.removeOverlay();
    this.showVideo();
    this.mode = 'revealed';
    try {
      onEnd?.(isCompleted);
    } catch {
      // Observer isolation: the end state is already applied.
    }
  }

  private schedule(fn: () => void): void {
    const raf = this.view?.requestAnimationFrame;
    this.handle =
      typeof raf === 'function'
        ? { raf: raf.call(this.view, fn) }
        : { timer: globalThis.setTimeout(fn, 16) };
  }

  private stopAnimation(): void {
    const h = this.handle;
    this.handle = null;
    if (h && 'raf' in h) {
      try {
        this.view?.cancelAnimationFrame?.(h.raf);
      } catch {
        // The token check ignores late frames.
      }
    }
    if (h && 'timer' in h) globalThis.clearTimeout(h.timer);
    this.stopSpin();
  }

  private stopSpin(): void {
    try {
      this.spin?.cancel?.();
    } catch {
      // Already finished.
    }
    this.spin = null;
  }

  private removeOverlay(): void {
    try {
      this.layer?.remove?.();
    } catch {
      // Detached already.
    }
    this.layer = null;
    this.spinner = null;
  }

  private setMask(element: HTMLElement, value: string): void {
    const style = element.style as unknown as Record<string, string>;
    for (const prop of MASK_PROPS) style[prop] = value;
  }

  private clearVideoMask(): void {
    const style = this.video.style as unknown as Record<string, string>;
    for (const prop of MASK_PROPS) style[prop] = '';
  }

  private hideVideo(): void {
    if (this.isMaskable) {
      this.setMask(this.video, 'linear-gradient(transparent, transparent)');
      this.video.style.opacity = '';
    } else this.video.style.opacity = '0';
  }

  private showVideo(): void {
    this.clearVideoMask();
    this.video.style.opacity = '';
  }
}
