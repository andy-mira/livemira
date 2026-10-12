/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Optional auxiliary drawing for the engine: the recognized target boundary and the CURRENT matched inlier points, as a decorator around any existing
// RenderSink (normally CssVideoRenderSink). NOT part of the engine runtime: nothing in the engine closures imports it (the engine builder gates that), and it
// imports nothing from the engine, so it ships as its own standalone module and can be loaded only when drawing is wanted.
// Types below are structural copies of the few engine shapes it needs; the engine's own types are assignable to them and the wrapper is assignable to RenderSink.

export type Point2 = readonly [number, number];
/** Contract bound of matchedPoints.pointsPx: the shared extractors keep at most 512 features per frame. Larger payloads are invalid, never truncated. */
export const MAX_MATCHED_POINTS = 512;
export interface VisualMatchedPoints { sessionId: string; frameId: number; targetId: string; origin: 'original-target' | 'previous-frame'; pointsPx: readonly Point2[] }
/** The subset of the engine TrackingResult this module reads. */
export interface VisualResult {
  sessionId: string; frameId: number; targetId: string | null; state: string;
  H_imageFromTarget: readonly number[] | null; cornersPx: readonly Point2[] | null;
  quality: { measured: boolean; degenerate: boolean }; predictionAgeUs: number;
  matchedPoints?: VisualMatchedPoints;
}
export interface VisualGeometry { H_viewportFromStandard: readonly number[] }
export interface VisualEvent { sessionId: string | null; targetId: string | null }
export interface VisualEventSink { playbackBlocked(event: any): void; error(event: any): void; sessionEvent?(type: any, event: any): void }
/** What the wrapped renderer must offer (CssVideoRenderSink does). Optional members are forwarded only when present. */
export interface VisualBaseSink {
  start(container: HTMLElement | null, sessionId: string): Promise<void>;
  update(result: any): Promise<void>;
  hide(): void;
  holdAfterLoss?(graceMs: number): boolean;
  setTargets?(targets: readonly { targetId: string; widthPx: number; heightPx: number }[]): void;
  connectEvents?(sink: any): () => void;
  setTargetMedia(targetId: string, config: any): void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export interface TrackingVisualizationOptions { /** Recognized target quadrilateral. */ boundary?: boolean; /** Current matched inlier points (needs a pipeline created with collectMatchedPoints). */ points?: boolean }
export interface TrackingVisualRenderSinkOptions<B extends VisualBaseSink = VisualBaseSink> extends TrackingVisualizationOptions {
  /** The renderer to decorate. The decorator owns its lifecycle once the engine disposes it (dispose() disposes it too). */
  base: B;
  /** Must describe the same standard image coordinate space as the result; H_viewportFromStandard maps it to CSS pixels. Same function as the renderer's. */
  geometryForResult: (result: any) => VisualGeometry | null;
}
export type TrackingVisualsErrorCode = 'INVALID_CONFIG';
export class TrackingVisualsError extends Error {
  readonly code: TrackingVisualsErrorCode;
  constructor(message: string) { super(message); this.name = 'TrackingVisualsError'; this.code = 'INVALID_CONFIG'; }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const PREDICTION_LIMIT_US = 100000;
function parseFlags(value: unknown): { boundary: boolean; points: boolean } {
  const fail = (): never => { throw new TrackingVisualsError('visualization must be { boundary?: boolean, points?: boolean }'); };
  if (value === undefined) return { boundary: false, points: false };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'boundary' && key !== 'points') fail();
  for (const key of ['boundary', 'points']) if (record[key] !== undefined && typeof record[key] !== 'boolean') fail();
  return { boundary: record.boundary === true, points: record.points === true };
}
function project(h: readonly number[], x: number, y: number): [number, number] | null {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) return null;
  const q: [number, number] = [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
}
/**
 * Current measured inlier points of this result, or null. Valid only for a measured, non-degenerate TRACKING/LIMITED result whose matchedPoints carry
 * the same session, frame and target and at most MAX_MATCHED_POINTS finite pairs. (Same rule as the engine contract; a prediction never has points.)
 */
export function currentMatchedPoints(result: VisualResult): readonly Point2[] | null {
  const m = result?.matchedPoints;
  if (!m || typeof m !== 'object' || (result.state !== 'TRACKING' && result.state !== 'LIMITED') || !result.quality?.measured || result.quality.degenerate) return null;
  if (!result.targetId || m.sessionId !== result.sessionId || m.frameId !== result.frameId || m.targetId !== result.targetId || (m.origin !== 'original-target' && m.origin !== 'previous-frame')) return null;
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p) if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1])) return null;
  return p;
}
const dotPath = (points: readonly Point2[]): string => points.map(p => `M${p[0].toFixed(1)} ${p[1].toFixed(1)}h0`).join('');

class Layer {
  private readonly svg: SVGSVGElement;
  private readonly polygon: SVGPolygonElement;
  private readonly dots: SVGPathElement;
  shownDots = 0;
  boundaryShown = false;
  constructor(container: HTMLElement) {
    const doc = container.ownerDocument;
    this.svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('data-lm-visual', 'tracking');
    Object.assign(this.svg.style, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none', zIndex: '2', display: 'none' });
    this.polygon = doc.createElementNS(SVG_NS, 'polygon') as SVGPolygonElement;
    this.polygon.setAttribute('fill', 'rgba(0,255,136,.08)');
    this.polygon.setAttribute('stroke-width', '3');
    this.polygon.setAttribute('stroke-linejoin', 'round');
    this.dots = doc.createElementNS(SVG_NS, 'path') as SVGPathElement;
    this.dots.setAttribute('fill', 'none');
    this.dots.setAttribute('stroke', '#ffeb3b');
    this.dots.setAttribute('stroke-width', '5');
    this.dots.setAttribute('stroke-linecap', 'round');
    this.polygon.style.display = this.dots.style.display = 'none';
    this.svg.append(this.polygon, this.dots);
    container.append(this.svg);
  }
  draw(boundary: readonly Point2[] | null, points: readonly Point2[] | null, measured: boolean): void {
    this.boundaryShown = boundary !== null;
    if (boundary) {
      this.polygon.setAttribute('points', boundary.map(p => `${p[0]},${p[1]}`).join(' '));
      this.polygon.setAttribute('stroke', measured ? '#00ff88' : '#ffc65c');
      if (measured) this.polygon.removeAttribute('stroke-dasharray'); else this.polygon.setAttribute('stroke-dasharray', '7 5');
    }
    this.polygon.style.display = boundary ? 'block' : 'none';
    this.shownDots = points?.length ?? 0;
    if (points?.length) this.dots.setAttribute('d', dotPath(points)); else this.dots.removeAttribute('d');
    this.dots.style.display = points?.length ? 'block' : 'none';
    this.svg.style.display = boundary || points?.length ? 'block' : 'none';
  }
  dispose(): void { this.draw(null, null, true); this.svg.remove(); }
}

/**
 * RenderSink decorator. Everything the engine calls is forwarded to `base`; the decorator additionally draws, in CSS pixels through H_viewportFromStandard,
 * the boundary of each valid TRACKING/LIMITED result and (measured results only) that same result's own matched inlier points.
 * The drawing is cleared on hide, loss/grace hold (video may continue, geometry does not), stop, dispose, hidden page / pagehide (own listeners, so
 * any conforming base works), media failure or media replacement of the shown target, a non-valid result, and replaced entirely on every valid result,
 * so a new session or target never inherits earlier geometry. An epoch counter invalidates every in-flight update on any of those events, on a newer
 * update, and across start/stop, so a slow `base.update` can never draw late. It works for targets without configured media.
 * Both switches default to false and no DOM is created until something is drawn.
 */
export class TrackingVisualRenderSink<B extends VisualBaseSink = VisualBaseSink> implements VisualBaseSink {
  readonly base: B;
  private flags: { boundary: boolean; points: boolean };
  private layer: Layer | null = null;
  private container: HTMLElement | null = null;
  private sessionId: string | null = null;
  private lastFrame = -1;
  private epoch = 0;
  private updating = 0;
  private shownTarget: string | null = null;
  private pendingTarget: string | null = null;
  private failedTarget: string | null = null;
  private dims = new Map<string, { widthPx: number; heightPx: number }>();
  private unsubscribe: (() => void) | null = null;
  private detachPage: (() => void) | null = null;
  private disposed = false;
  private readonly geometryForResult: (result: any) => VisualGeometry | null;
  constructor(options: TrackingVisualRenderSinkOptions<B>) {
    if (!options || typeof options !== 'object' || !options.base || typeof options.base.update !== 'function' || typeof options.geometryForResult !== 'function') throw new TrackingVisualsError('base renderer and geometryForResult are required');
    this.flags = parseFlags({ boundary: options.boundary, points: options.points });
    this.base = options.base;
    this.geometryForResult = options.geometryForResult;
    // Own observation of the base; the engine's subscription (connectEvents below) is independent.
    this.unsubscribe = this.base.connectEvents?.({
      playbackBlocked() { /* not a failure */ },
      error: (event: VisualEvent) => { if (event.sessionId === this.sessionId) { this.failedTarget = event.targetId; this.invalidate(); } },
      sessionEvent: (type: string, event: VisualEvent & { state?: string }) => {
        if (type !== 'mediaState' || event.sessionId !== this.sessionId) return;
        // Media shown/playing again for the failed target: new media or a successful retry, so fresh data may draw again.
        if ((event.state === 'shown' || event.state === 'playing') && event.targetId === this.failedTarget) this.failedTarget = null;
        // The base hid or replaced its media outside of our own update (e.g. a direct setTargetMediaFile on the base): old geometry is void.
        if (event.state === 'hidden' && this.updating === 0) this.invalidate();
      },
    }) ?? null;
  }
  /** Replaces the switches (same validation as the constructor). Turning one off clears it now; turning one on draws from the next valid result. */
  setVisualization(options: TrackingVisualizationOptions): void {
    this.alive();
    const next = parseFlags(options);
    this.flags = next; this.invalidate();
    if (!next.boundary && !next.points) this.dropLayer();
  }
  getVisualization(): Readonly<{ boundary: boolean; points: boolean }> { return { ...this.flags }; }
  /** Counts only, never coordinates. */
  getVisualDiagnostics() { return { ...this.flags, shownBoundary: this.layer?.boundaryShown ?? false, shownPoints: this.layer?.shownDots ?? 0, layerAttached: this.layer !== null, mediaFailedTarget: this.failedTarget }; }
  /** Call after a successful user-gesture media retry so the drawing for the previously failed target may resume (fresh data only). */
  clearMediaFailure(): void { this.alive(); this.failedTarget = null; }
  /** Voids every in-flight update and removes what is shown. */
  private invalidate(): void { ++this.epoch; this.shownTarget = null; this.layer?.draw(null, null, true); }
  private dropLayer(): void { this.layer?.dispose(); this.layer = null; }
  private attachPage(container: HTMLElement): void {
    const doc = container.ownerDocument, view = doc.defaultView;
    const onChange = () => { if (doc.hidden) this.invalidate(); };
    const onHide = () => this.invalidate();
    doc.addEventListener('visibilitychange', onChange);
    view?.addEventListener('pagehide', onHide);
    this.detachPage = () => { doc.removeEventListener('visibilitychange', onChange); view?.removeEventListener('pagehide', onHide); };
  }
  private reset(): void {
    ++this.epoch;
    this.detachPage?.(); this.detachPage = null;
    this.dropLayer(); this.container = null; this.sessionId = null; this.lastFrame = -1; this.failedTarget = null; this.shownTarget = null; this.pendingTarget = null;
  }
  async start(container: HTMLElement | null, sessionId: string): Promise<void> {
    this.alive(); this.reset();
    const epoch = this.epoch;
    await this.base.start(container, sessionId);
    // A stop/dispose/newer start while the base was starting wins; nothing is attached for a superseded start.
    if (epoch !== this.epoch || this.disposed) return;
    this.container = container; this.sessionId = sessionId; this.lastFrame = -1;
    if (container) this.attachPage(container);
  }
  async update(result: VisualResult): Promise<void> {
    this.alive();
    const container = this.container, session = this.sessionId;
    if (!container || result.sessionId !== session || result.frameId <= this.lastFrame) { await this.base.update(result); return; }
    this.lastFrame = result.frameId;
    const epoch = ++this.epoch;
    const valid = !!result.targetId && !container.ownerDocument.hidden && (result.state === 'TRACKING' || result.state === 'LIMITED') && !result.quality.degenerate
      && (result.quality.measured || (Number.isFinite(result.predictionAgeUs) && result.predictionAgeUs >= 0 && result.predictionAgeUs < PREDICTION_LIMIT_US));
    if (!valid) this.layer?.draw(null, null, true);
    this.pendingTarget = valid ? result.targetId : null;
    this.updating++;
    try { await this.base.update(result); }
    catch (error) { if (epoch === this.epoch) this.invalidate(); throw error; }
    finally { this.updating--; if (epoch === this.epoch) this.pendingTarget = null; }
    const current = () => epoch === this.epoch && !this.disposed && this.container === container && this.sessionId === session && !container.ownerDocument.hidden;
    if (!current()) return;
    if (!valid || result.targetId === this.failedTarget || (!this.flags.boundary && !this.flags.points)) { this.invalidate(); return; }
    this.draw(result, container);
  }
  private draw(result: VisualResult, container: HTMLElement): void {
    let boundary: Point2[] | null = null, points: Point2[] | null = null;
    try {
      const h = this.geometryForResult(result)?.H_viewportFromStandard;
      if (!h || h.length !== 9 || !h.every(Number.isFinite)) { this.invalidate(); return; }
      const map = (list: readonly Point2[]): Point2[] => list.flatMap(p => { const q = project(h, p[0], p[1]); return q ? [q] : []; });
      if (this.flags.boundary) {
        const dim = this.dims.get(result.targetId!);
        const corners = result.cornersPx ?? (dim && result.H_imageFromTarget ? [[0, 0], [dim.widthPx, 0], [dim.widthPx, dim.heightPx], [0, dim.heightPx]].flatMap(([x, y]) => { const q = project(result.H_imageFromTarget!, x, y); return q ? [q] : []; }) : null);
        if (corners && corners.length === 4) { const q = map(corners as Point2[]); boundary = q.length === 4 ? q : null; }
      }
      const current = this.flags.points ? currentMatchedPoints(result) : null;
      if (current) { const q = map(current); points = q.length ? q : null; }
    } catch { boundary = points = null; }
    if (!boundary && !points) { this.invalidate(); return; }
    this.layer ??= new Layer(container);
    this.layer.draw(boundary, points, result.quality.measured);
    this.shownTarget = result.targetId;
  }
  hide(): void { if (this.disposed) return; this.invalidate(); this.base.hide(); }
  holdAfterLoss(graceMs: number): boolean { if (this.disposed) return false; this.invalidate(); return this.base.holdAfterLoss?.(graceMs) ?? false; }
  /** Validates first, delegates to the base, and only then commits its own dimensions: a refused replacement leaves everything unchanged. */
  setTargets(targets: readonly { targetId: string; widthPx: number; heightPx: number }[]): void {
    this.alive();
    if (!Array.isArray(targets)) throw new TrackingVisualsError('targets must be an array');
    const next = new Map<string, { widthPx: number; heightPx: number }>();
    for (const t of targets) {
      if (!t || typeof t.targetId !== 'string' || !t.targetId || !Number.isFinite(t.widthPx) || !Number.isFinite(t.heightPx) || t.widthPx <= 0 || t.heightPx <= 0) throw new TrackingVisualsError('Invalid target dimensions');
      next.set(t.targetId, { widthPx: t.widthPx, heightPx: t.heightPx });
    }
    this.base.setTargets?.(targets);
    this.dims = next;
  }
  connectEvents(sink: VisualEventSink): () => void { this.alive(); return this.base.connectEvents?.(sink) ?? (() => {}); }
  /** Replacing media of the shown/pending target voids its geometry; the failure latch is reset only if the base accepted the replacement. */
  setTargetMedia(targetId: string, config: any): void {
    this.alive();
    this.base.setTargetMedia(targetId, config);
    if (targetId === this.shownTarget || targetId === this.pendingTarget) this.invalidate();
    if (targetId === this.failedTarget) this.failedTarget = null;
  }
  async stop(): Promise<void> { if (this.disposed) return; this.reset(); await this.base.stop(); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.reset(); this.disposed = true;
    try { this.unsubscribe?.(); } catch { /* base may already be gone */ }
    this.unsubscribe = null;
    await this.base.dispose();
  }
  private alive(): void { if (this.disposed) throw new TrackingVisualsError('Tracking visual sink disposed'); }
}
/** Convenience factory; same as `new TrackingVisualRenderSink(options)`. */
export function createTrackingVisualRenderSink<B extends VisualBaseSink>(options: TrackingVisualRenderSinkOptions<B>): TrackingVisualRenderSink<B> { return new TrackingVisualRenderSink(options); }
