/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Extensions: optional modules (tracking visuals, recognition diagnostics) that draw in their own layer above the video
// plane and observe results. The engine owns their lifecycle; an extension never wraps or owns the overlay.
//
// The host sits between the engine and the overlay renderer and tells extensions when a result was presented and when
// whatever they show must be cleared: on hide, on a loss hold (the video may continue, the pose does not), on stop,
// at a new session, when the page is hidden, when the shown target's media failed, and for an invalid result. An epoch
// voids every in-flight update on any of those, so a slow overlay update never presents late.

import type { FrameGeometry, TrackingResult } from '@livemira/contracts';
import type { RecognitionTrace } from '@livemira/recognition';
import type {
  MediaOptions,
  OverlayRenderer,
  RendererEvent,
  TargetMediaSource,
  TargetSize,
} from '@livemira/renderer';

import type { OverlaySink } from './engine-types.ts';

/** The prediction age beyond which a result is never shown (the tracker's prediction limit). */
const MAX_PRESENTABLE_PREDICTION_US = 100_000;

export type ClearReason = 'hide' | 'loss' | 'stop' | 'session' | 'page-hidden' | 'media-failed';

export interface ExtensionHost {
  /** A layer above the video plane, cleared with it; the extension draws only here. */
  readonly overlayLayer: HTMLElement;
  /**
   * A result was presented. The listener returns true when it now shows something for it; the host then knows which
   * target an extension shows (replacing that target's media clears it).
   */
  onPresented(
    listener: (result: TrackingResult, geometry: FrameGeometry) => boolean | void,
  ): () => void;
  onCleared(listener: (reason: ClearReason) => void): () => void;
  onRecognitionTrace(listener: (trace: RecognitionTrace) => void): () => void;
  onResult(listener: (result: TrackingResult) => void): () => void;
  getTargets(): readonly TargetSize[];
}

export interface ExtensionHandle {
  detach(): void;
}

export interface EngineExtension {
  readonly name: string;
  /** What the extension needs from the Worker; fixed for the engine's lifetime. */
  readonly needs?: { readonly matchedPoints?: boolean; readonly recognitionTrace?: boolean };
  attach(host: ExtensionHost): ExtensionHandle;
}

type Listeners<T extends unknown[]> = Set<(...args: T) => void>;

function notify<T extends unknown[]>(listeners: Listeners<T>, ...args: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args);
    } catch {
      // Extensions cannot interrupt the engine.
    }
  }
}

function isPresentable(result: TrackingResult): boolean {
  const ageUs = result.prediction.ageUs;
  return (
    Boolean(result.targetId) &&
    (result.state === 'TRACKING' || result.state === 'LIMITED') &&
    !result.quality.isDegenerate &&
    (result.quality.isMeasured ||
      (Number.isFinite(ageUs) && ageUs >= 0 && ageUs < MAX_PRESENTABLE_PREDICTION_US))
  );
}

/** The overlay seam the engine uses, with extension notifications. */
export class HostedOverlay implements OverlaySink, ExtensionHost {
  readonly overlayLayer: HTMLElement;
  private readonly base: OverlayRenderer;
  private readonly presented = new Set<
    (result: TrackingResult, geometry: FrameGeometry) => boolean | void
  >();
  private readonly cleared: Listeners<[ClearReason]> = new Set();
  private readonly traces: Listeners<[RecognitionTrace]> = new Set();
  private readonly results: Listeners<[TrackingResult]> = new Set();
  private targets: readonly TargetSize[] = [];
  private epoch = 0;
  private sessionId: string | null = null;
  private container: HTMLElement | null = null;
  private lastFrame = -1;
  private updating = 0;
  /** The target an extension shows, and the target of the update in flight. */
  private shownTarget: string | null = null;
  private pendingTarget: string | null = null;
  private failedTarget: string | null = null;
  private detachPage: (() => void) | null = null;
  private readonly unsubscribe: () => void;

  constructor(base: OverlayRenderer, overlayLayer: HTMLElement) {
    this.base = base;
    this.overlayLayer = overlayLayer;
    this.unsubscribe = base.onEvent((event) => this.observe(event));
  }

  // ---- ExtensionHost ----

  onPresented(
    listener: (result: TrackingResult, geometry: FrameGeometry) => boolean | void,
  ): () => void {
    this.presented.add(listener);
    return () => void this.presented.delete(listener);
  }

  onCleared(listener: (reason: ClearReason) => void): () => void {
    this.cleared.add(listener);
    return () => void this.cleared.delete(listener);
  }

  onRecognitionTrace(listener: (trace: RecognitionTrace) => void): () => void {
    this.traces.add(listener);
    return () => void this.traces.delete(listener);
  }

  onResult(listener: (result: TrackingResult) => void): () => void {
    this.results.add(listener);
    return () => void this.results.delete(listener);
  }

  getTargets(): readonly TargetSize[] {
    return this.targets.map((t) => ({ ...t }));
  }

  /** Called by the engine for every Worker result and recognition trace. */
  result(result: TrackingResult): void {
    notify(this.results, result);
  }

  trace(trace: RecognitionTrace): void {
    notify(this.traces, trace);
  }

  private clear(reason: ClearReason): void {
    ++this.epoch;
    this.shownTarget = null;
    notify(this.cleared, reason);
  }

  /** Presents to every extension; true when any of them now shows something. */
  private present(result: TrackingResult, geometry: FrameGeometry): boolean {
    let isShown = false;
    for (const listener of [...this.presented]) {
      try {
        if (listener(result, geometry) === true) isShown = true;
      } catch {
        // Extensions cannot interrupt the engine.
      }
    }
    return isShown;
  }

  private observe(event: RendererEvent): void {
    if (event.sessionId !== this.sessionId) return;
    if (event.type === 'error') {
      this.failedTarget = event.targetId;
      this.clear('media-failed');
    } else if (event.type === 'mediaState') {
      // Media shown or playing again for the failed target: new media or a successful retry.
      if (
        (event.state === 'shown' || event.state === 'playing') &&
        event.targetId === this.failedTarget
      )
        this.failedTarget = null;
      // The overlay hid outside of an update (page hidden, media replaced): what was shown is void.
      if (event.state === 'hidden' && this.updating === 0) this.clear('hide');
    }
  }

  private attachPage(container: HTMLElement): void {
    const doc = container.ownerDocument;
    const view = doc.defaultView;
    const onChange = (): void => {
      if (doc.hidden) this.clear('page-hidden');
    };
    const onHide = (): void => this.clear('page-hidden');
    doc.addEventListener('visibilitychange', onChange);
    view?.addEventListener('pagehide', onHide);
    this.detachPage = () => {
      doc.removeEventListener('visibilitychange', onChange);
      view?.removeEventListener('pagehide', onHide);
    };
  }

  private reset(reason: ClearReason): void {
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

  async start(container: HTMLElement, sessionId: string): Promise<void> {
    this.reset('session');
    const epoch = this.epoch;
    await this.base.start(container, sessionId);
    // A stop or a newer start while the overlay was starting wins.
    if (epoch !== this.epoch) return;
    this.container = container;
    this.sessionId = sessionId;
    this.attachPage(container);
  }

  async update(result: TrackingResult, geometry: FrameGeometry): Promise<void> {
    const container = this.container;
    const session = this.sessionId;
    if (!container || result.sessionId !== session || result.frameId <= this.lastFrame) {
      await this.base.update(result, geometry);
      return;
    }
    this.lastFrame = result.frameId;
    const epoch = ++this.epoch;
    const isValid = isPresentable(result) && !container.ownerDocument.hidden;
    if (!isValid) notify(this.cleared, 'hide');
    this.pendingTarget = isValid ? result.targetId : null;
    this.updating++;
    try {
      await this.base.update(result, geometry);
    } catch (error) {
      if (epoch === this.epoch) this.clear('hide');
      throw error;
    } finally {
      this.updating--;
      if (epoch === this.epoch) this.pendingTarget = null;
    }
    const isCurrent =
      epoch === this.epoch &&
      this.container === container &&
      this.sessionId === session &&
      !container.ownerDocument.hidden;
    if (!isCurrent) return;
    if (!isValid || result.targetId === this.failedTarget) {
      this.clear('hide');
      return;
    }
    if (this.present(result, geometry)) this.shownTarget = result.targetId;
    else {
      ++this.epoch;
      this.shownTarget = null;
    }
  }

  hide(): void {
    this.clear('hide');
    this.base.hide();
  }

  holdAfterLoss(graceMs: number): boolean {
    this.clear('loss');
    return this.base.holdAfterLoss(graceMs);
  }

  setTargets(targets: readonly TargetSize[]): void {
    this.base.setTargets(targets);
    this.targets = targets.map((t) => ({
      targetId: t.targetId,
      widthPx: t.widthPx,
      heightPx: t.heightPx,
    }));
  }

  /** Replacing the media of the shown or pending target voids what is shown for it. */
  setTargetMedia(targetId: string, source: TargetMediaSource, options?: MediaOptions): void {
    this.base.setTargetMedia(targetId, source, options);
    if (targetId === this.shownTarget || targetId === this.pendingTarget) this.clear('hide');
    if (targetId === this.failedTarget) this.failedTarget = null;
  }

  clearTargetMedia(targetId: string): void {
    this.base.clearTargetMedia(targetId);
    if (targetId === this.shownTarget || targetId === this.pendingTarget) this.clear('hide');
  }

  onEvent(listener: (event: RendererEvent) => void): () => void {
    return this.base.onEvent(listener);
  }

  async stop(): Promise<void> {
    this.reset('stop');
    await this.base.stop();
  }

  async dispose(): Promise<void> {
    this.reset('stop');
    this.unsubscribe();
    this.presented.clear();
    this.cleared.clear();
    this.traces.clear();
    this.results.clear();
    await this.base.dispose();
  }
}
