/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, MAX_LOSS_DISPLAY_GRACE_MS, validateTargetBundle, WORKER_SAFE_REASONS, type BackendKind, type EngineEvents, type FrameDiagnostics, type FrameGeometry, type FramePacket, type FrameSource, type ViewportTransitionEvent, type MediaConfig, type RenderSink, type SessionConfigSnapshot, type TargetBundle, type TrackingResult, type VisionPipeline } from '@livemira/contracts';
import { captureTargetFrame, describeTargetFrame } from './target-extent.js';
export type { EngineEvents, TargetBundle, MediaConfig, TrackingResult, TrackingMatchedPoints } from '@livemira/contracts';
export interface EngineConfig { source: FrameSource; pipeline: VisionPipeline; renderer: RenderSink; backend?: BackendKind; maxPredictionMs?: number; /** Visual-only overlay hold after targetLost, 0..1000 ms, default 0 (hide immediately). Independent of maxPredictionMs. */ lossDisplayGraceMs?: number; nowUs?: () => number; onListenerError?: (error: unknown) => void; onDiagnostics?: (diagnostics: FrameDiagnostics) => void; getSessionConfig?: () => Partial<SessionConfigSnapshot>; sessionIdPrefix?: string; getFrameGeometry?: (frame: FramePacket) => FrameGeometry | null }
export function createEngine(config: EngineConfig): Engine { return new Engine(config); }
export class Engine {
  private listeners = new Map<keyof EngineEvents, Set<(event: any) => void>>();
  private lifecycle: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private session: string | null = null;
  private sessionCounter = 0;
  private sessionOriginUs = 0;
  private stopGeneration = 0;
  private activeTarget: string | null = null;
  private lastProcessedFrame: ReturnType<typeof captureTargetFrame> | null = null;
  private lastReliableFrame: ReturnType<typeof captureTargetFrame> | null = null;
  private lastFrameId = -1;
  private lastSourceTime = -Infinity;
  private lastImageIdentity: string | undefined;
  private frameReceiptUs = new WeakMap<FramePacket, number>();
  private releasedHandles = new WeakSet<object>();
  private visibilityDeadlineUs = -Infinity;
  private pending: FramePacket | null = null;
  private processing: Promise<void> | null = null;
  private expiry: ReturnType<typeof setTimeout> | null = null;
  private expiryEpoch = 0;
  private disposed = false;
  private disposing = false;
  private running = false;
  private loadedTargets: SessionConfigSnapshot['targets'] = [];
  private establishedSourceClock = false;
  private attemptOriginUs = 0;
  private sessionTrackingMode: string | null = null;
  private sessionMedia = new Map<string, Promise<SessionConfigSnapshot['media'][number]>>();
  private mediaSnapshot: SessionConfigSnapshot['media'] = [];
  private readonly clock: () => number;
  private readonly predictionUs: number;
  private readonly graceUs: number;
  private disconnectRenderer: (() => void) | undefined;
  /** Viewport transitions: epoch invalidates older in-flight work; ready is the tracker-reset barrier after the source reopens. */
  private transitionEpoch = 0;
  private transitionGated = false;
  private transitionReady: Promise<void> | null = null;
  private transitionWork: Promise<void> = Promise.resolve();
  private unsubscribeTransition: (() => void) | null = null;
  constructor(private readonly config: EngineConfig) {
    const ms = config.maxPredictionMs ?? 100;
    if (!config.source || !config.pipeline || !config.renderer || !Number.isFinite(ms) || ms < 0 || ms > 100 || (config.backend && !['cpu','wasm','webgpu'].includes(config.backend))) throw new EngineError('INVALID_CONFIG', false, 'Provide source/pipeline/renderer and prediction limit in [0,100] ms');
    const grace = config.lossDisplayGraceMs === undefined ? 0 : config.lossDisplayGraceMs;
    if (typeof grace !== 'number' || !Number.isFinite(grace) || grace < 0 || grace > MAX_LOSS_DISPLAY_GRACE_MS) throw new EngineError('INVALID_CONFIG', false, `Loss display grace must be in [0,${MAX_LOSS_DISPLAY_GRACE_MS}] ms`);
    this.clock = config.nowUs ?? (() => performance.now()*1000);
    this.predictionUs = ms*1000;
    this.graceUs = grace*1000;
    this.disconnectRenderer = config.renderer.connectEvents?.({
      playbackBlocked: event => { if (event.sessionId === this.session && !this.disposed) this.emit('playbackBlocked', { ...event, ...this.context(event.targetId) }); },
      error: event => { if (event.sessionId === this.session && !this.disposed) this.emit('error', { ...event, ...this.context(event.targetId), error: new EngineError(event.error.code, event.error.recoverable, 'Renderer or media operation failed') }); },
      sessionEvent: (type, event) => { if (event.sessionId === this.session && !this.disposed) this.emit(type, { ...event, ...this.context(event.targetId) } as EngineEvents[typeof type]); },
    });
  }
  on<K extends keyof EngineEvents>(name: K, listener: (event: EngineEvents[K]) => void): () => void {
    this.assertUsable();
    const set = this.listeners.get(name) ?? new Set(); set.add(listener); this.listeners.set(name, set);
    return () => { set.delete(listener); };
  }
  private emit<K extends keyof EngineEvents>(name: K, event: EngineEvents[K]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) { try { listener(event); } catch (error) { try { this.config.onListenerError?.(error); } catch { /* Listener failures cannot interrupt resource cleanup. */ } } }
  }
  private context(targetId = this.activeTarget) {
    const now = this.clock(), sourceNow = this.config.source.nowSessionUs?.();
    if (sourceNow != null) { this.sessionOriginUs = now-sourceNow; this.establishedSourceClock = true; }
    return { sessionId: this.session, targetId, timestampUs: sourceNow ?? Math.max(0,now-this.sessionOriginUs), timestampDomain: this.establishedSourceClock ? 'source-session' as const : this.running ? 'engine-session' as const : 'attempt' as const };
  }
  private assertUsable() { if (this.disposed || this.disposing) throw new EngineError('DISPOSED', false, 'Engine disposed'); }
  getSessionContext() { return this.context(); }
  /** Adapters call this only on geometry/capability changes, never per frame. */
  refreshSessionConfig(): void {
    if (this.session && !this.disposed) this.emit('sessionConfigUpdated', {...this.context(),config:this.sessionConfigSnapshot()});
  }
  private sessionConfigSnapshot(): SessionConfigSnapshot {
    let adapter:Partial<SessionConfigSnapshot> = {};
    try { adapter = this.config.getSessionConfig?.() ?? {}; } catch { /* Unknown diagnostics stay null. */ }
    return structuredClone({
      trackingMode:this.sessionTrackingMode,backendRequested:this.config.backend??null,backendActual:null,
      media:this.mediaSnapshot,
      inputWidth:null,inputHeight:null,processingLongEdge:null,previewWidth:null,previewHeight:null,dpr:null,clockDomain:null,
      // Policy values are owned by the SDK; a diagnostics adapter cannot override what actually runs.
      ...adapter,targets:this.loadedTargets,maxPredictionMs:this.predictionUs/1000,lossDisplayGraceMs:this.graceUs/1000,
    });
  }
  private async startupStage(stage:'pipeline-init'|'renderer-init'|'camera-init',action:()=>Promise<void>):Promise<void> {
    const started=this.clock();let status:'completed'|'failed'|'cancelled'='completed';
    try {await action();if(this.controller?.signal.aborted)status='cancelled';}
    catch(error){status=this.controller?.signal.aborted?'cancelled':'failed';throw error;}
    finally {this.emit('stageTiming',{...this.context(),stage,status,durationUs:Math.max(0,this.clock()-started),attemptTimeUs:Math.max(0,this.clock()-this.attemptOriginUs)});}
  }
  private enqueue(action: () => Promise<void>): Promise<void> { const result = this.lifecycle.then(action); this.lifecycle = result.catch(() => {}); return result; }
  loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.assertUsable();
    if (targets.length < 1 || targets.length > 10 || new Set(targets.map(t => t.targetId)).size !== targets.length) throw new EngineError('INVALID_TARGET', false, 'Require 1..10 unique targets');
    targets.forEach(validateTargetBundle);
    return this.enqueue(async () => { this.assertUsable(); if (this.running) throw new EngineError('INVALID_CONFIG', true, 'Stop before replacing targets'); await this.config.pipeline.loadTargets(targets); this.loadedTargets = targets.map(t=>({targetId:t.targetId,imageHash:t.imageHash,algorithmVersion:t.algorithmVersion,compilerVersion:t.compilerVersion,widthPx:t.widthPx,heightPx:t.heightPx})); for(const id of this.sessionMedia.keys())if(!targets.some(t=>t.targetId===id))this.sessionMedia.delete(id); this.config.renderer.setTargets?.(targets); });
  }
  setTrackingMode(mode: string | null): void { this.assertUsable();if(this.running)throw new EngineError('INVALID_CONFIG',true,'Stop before changing tracking mode');this.sessionTrackingMode = mode; }
  setTargetMedia(targetId: string, media: MediaConfig): void {
    this.assertUsable();
    if (!targetId || !media.url || (media.fit && !['contain','cover'].includes(media.fit))) throw new EngineError('INVALID_CONFIG', false, 'Invalid media configuration');
    this.config.renderer.setTargetMedia(targetId, { muted: true, loop: true, fit: 'contain', lostBehavior: 'pause-and-hide', resumeBehavior: 'resume', crossOrigin: 'anonymous', ...media });
    const bytes=new TextEncoder().encode(media.url);
    const identity=crypto.subtle.digest('SHA-256',bytes).then(hash=>({targetId,identityHash:Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join(''),identityKind:'url-sha256' as const,fit:media.fit??'contain'}));
    this.sessionMedia.set(targetId,identity);

  }
  start(container: HTMLElement | null = null): Promise<void> {
    this.assertUsable();
    const generation = this.stopGeneration;
    return this.enqueue(async () => {
      this.assertUsable(); if (this.running || generation !== this.stopGeneration) return;
      this.session = `${this.config.sessionIdPrefix??''}session-${++this.sessionCounter}`; this.lastFrameId = -1; this.lastSourceTime = -Infinity; this.lastImageIdentity = undefined;
      this.lastProcessedFrame=null;this.lastReliableFrame=null;
      this.sessionOriginUs = this.clock();this.attemptOriginUs=this.sessionOriginUs;this.establishedSourceClock=false;
      const session = this.session; const controller = new AbortController(); this.controller = controller;
      this.emit('attemptStart',this.context());
      try {
        this.mediaSnapshot=await Promise.all(this.sessionMedia.values());
        this.emit('sessionConfig',{...this.context(),config:this.sessionConfigSnapshot()});
        if(controller.signal.aborted){await this.cleanup('start-cancelled');return;}
        await this.startupStage('pipeline-init',()=>this.config.pipeline.reset(session));
        if (controller.signal.aborted) { await this.cleanup('start-cancelled'); return; }
        await this.startupStage('renderer-init',()=>this.config.renderer.start(container,session));
        if (controller.signal.aborted) { await this.cleanup('start-cancelled'); return; }
        this.unsubscribeTransition?.(); this.transitionGated = false; this.transitionReady = null;
        this.unsubscribeTransition = this.config.source.onViewportTransition?.(event => this.onTransition(event, controller, session)) ?? null;
        await this.startupStage('camera-init',()=>this.config.source.start(session,frame=>this.accept(frame),controller.signal));
        if (controller.signal.aborted) { await this.cleanup('start-cancelled'); return; }
        this.running = true;
        this.emit('capabilityChanged', { ...this.context(), backend: this.config.backend ?? 'cpu', reason: 'Configured pipeline backend; runtime capability detection belongs to adapter' });
        if (controller.signal.aborted) { await this.cleanup('start-cancelled'); return; }
        this.refreshSessionConfig();
        if (controller.signal.aborted) { await this.cleanup('start-cancelled'); return; }
        this.emit('ready', this.context());
      } catch (cause) {
        const error = new EngineError(cause instanceof EngineError ? cause.code : 'START_FAILED', true, 'Source, pipeline or renderer initialization failed');
        this.emit('sessionStartFailed', { ...this.context(), code: error.code, attemptTimeUs:Math.max(0,this.clock()-this.attemptOriginUs) });
        this.emit('error', { ...this.context(), error }); await this.cleanup('start-failed'); throw error;
      }
    });
  }
  stop(reason = 'stopped'): Promise<void> { ++this.stopGeneration; this.controller?.abort(); this.hideNow(); return this.enqueue(() => this.cleanup(reason)); }
  dispose(): Promise<void> {
    if (this.disposed || this.disposing) return this.lifecycle;
    this.disposing = true; ++this.stopGeneration; this.controller?.abort(); this.hideNow();
    return this.enqueue(async () => {
      await this.cleanup('disposed');
      const outcomes = await Promise.allSettled([() => this.config.source.dispose(), () => this.config.pipeline.dispose(), () => this.config.renderer.dispose()].map(dispose => Promise.resolve().then(dispose)));
      this.disposed = true;
      let disconnectFailed = false;
      try { this.disconnectRenderer?.(); } catch { disconnectFailed = true; }
      this.disconnectRenderer = undefined; this.listeners.clear();
      const failure = outcomes.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      if (failure || disconnectFailed) throw new EngineError('RESOURCE_FAILED', true, 'One or more adapters failed during disposal');
    });
  }
  private onTransition(event: ViewportTransitionEvent, controller: AbortController, session: string): void {
    if (controller !== this.controller || session !== this.session || controller.signal.aborted || this.disposed) return;
    this.transitionEpoch++;
    if (event.phase === 'begin') {
      this.transitionGated = true; this.transitionReady = null;
      if (this.pending) { this.reportDiagnostics({ ...this.diagnostics(this.pending), dropReason: 'viewport-transition' }); this.releaseFrame(this.pending); this.pending = null; }
      if (this.running) this.lose('viewport-transition');
      else this.hideNow();
      return;
    }
    this.transitionGated = false;
    if (!this.running) return;
    const epoch = this.transitionEpoch;
    const processing = this.processing, precedingReset = this.transitionWork;
    // The old frame (if any) finishes in the same Worker; only then is stale tracker/prediction state cleared, without abort.
    const ready = (async () => {
      await Promise.all([processing, precedingReset]);
      if (epoch !== this.transitionEpoch || controller.signal.aborted || !this.running) return;
      await this.config.pipeline.reset(session);
    })().catch(() => {
      if (controller.signal.aborted || epoch !== this.transitionEpoch) return;
      this.transitionGated = true;
      if (this.pending) { this.releaseFrame(this.pending); this.pending = null; }
      this.hideNow();
      this.emit('error', { ...this.context(), error: new EngineError('RESOURCE_FAILED', true, 'Pipeline reset after viewport transition failed') });
    });
    this.transitionReady = ready; this.transitionWork = ready;
    void ready.then(() => {
      if (this.transitionReady !== ready) return;
      this.transitionReady = null;
      if (this.pending && !this.processing && this.running && !this.transitionGated) this.processing = this.drain().finally(() => { this.processing = null; });
    });
  }
  private accept(frame: FramePacket): void {
    if (this.transitionGated) { this.reportDiagnostics({ ...this.diagnostics(frame), dropReason: 'viewport-transition' }); this.releaseFrame(frame); return; }
    if (!this.running || frame.sessionId !== this.session || this.controller?.signal.aborted || !Number.isSafeInteger(frame.frameId) || !Number.isFinite(frame.sourceTimestampUs) || frame.frameId <= this.lastFrameId || frame.sourceTimestampUs <= this.lastSourceTime || (frame.imageIdentity !== undefined && frame.imageIdentity === this.lastImageIdentity)) { this.reportDiagnostics({ ...this.diagnostics(frame), dropReason: 'inactive-stale-or-duplicate' }); this.releaseFrame(frame); return; }
    this.lastFrameId = frame.frameId; this.lastSourceTime = frame.sourceTimestampUs; this.lastImageIdentity = frame.imageIdentity;
    this.frameReceiptUs.set(frame, this.clock());
    if (this.pending) { this.reportDiagnostics({ ...this.diagnostics(this.pending), dropReason: 'candidate-replaced' }); this.releaseFrame(this.pending); } this.pending = frame;
    if (!this.processing && !this.transitionReady) this.processing = this.drain().finally(() => { this.processing = null; });
  }
  private async drain(): Promise<void> {
    while (this.pending && !this.transitionGated && !this.transitionReady) {
      const frame = this.pending; this.pending = null; const signal = this.controller!.signal; const frameEpoch = this.transitionEpoch;
      const diagnostics = this.diagnostics(frame);
      let sample:ReturnType<typeof captureTargetFrame>|null=null;
      try {
        let geometry:FrameGeometry|null=null;
        try{geometry=this.config.getFrameGeometry?.(frame)??null;}catch{/* Diagnostic geometry cannot block frame processing. */}
        diagnostics.cpuSubmitTimeUs = this.context().timestampUs;
        // SDK-clock time from accept() to hand-off to the pipeline; independent of camera arrival/exposure/source clocks.
        const receiptUs = this.frameReceiptUs.get(frame);
        diagnostics.queueWaitDurationUs = receiptUs === undefined ? null : Math.max(0, this.clock() - receiptUs);
        const result = await this.config.pipeline.process(frame, signal);
        diagnostics.resultAvailableTimeUs = this.context().timestampUs; diagnostics.targetId = result.targetId;
        if (frameEpoch !== this.transitionEpoch) diagnostics.dropReason = 'viewport-transition';
        else if (!signal.aborted && this.running && result.sessionId === this.session && result.frameId === frame.frameId) {
          sample=captureTargetFrame(frame,result,geometry);
          await this.present(result, this.frameReceiptUs.get(frame)!, diagnostics,sample);
          if (frameEpoch !== this.transitionEpoch && !signal.aborted) { this.hideNow(); if (this.activeTarget) this.lose('viewport-transition'); }
          if(frameEpoch === this.transitionEpoch && !signal.aborted&&this.session===sample.sessionId)this.lastProcessedFrame=sample;
        }
        else diagnostics.dropReason = 'cancelled-or-stale-result';
      } catch (cause) { if (frameEpoch !== this.transitionEpoch) diagnostics.dropReason = 'viewport-transition'; else if (!signal.aborted) { this.lose('frame-failed',sample); this.emit('error', { ...this.context(), error: new EngineError(cause instanceof EngineError ? cause.code : 'FRAME_FAILED', true, cause instanceof EngineError && WORKER_SAFE_REASONS.includes(cause.reason) ? cause.reason : 'Frame processing or presentation failed') }); } }
      finally { this.releaseFrame(frame); this.reportDiagnostics(diagnostics); }
    }
  }
  private async present(result: TrackingResult, receiptUs: number, diagnostics: FrameDiagnostics, sample:ReturnType<typeof captureTargetFrame>): Promise<void> {
    // Identity is captured before any observer-producing loss so a stop issued from that observer cancels this presentation.
    const session = this.session;
    const generation = this.stopGeneration, tEpoch = this.transitionEpoch;
    const cancelled = () => this.controller?.signal.aborted || tEpoch !== this.transitionEpoch || this.stopGeneration !== generation || session !== this.session || !this.running;
    const visible = result.targetId !== null && result.H_imageFromTarget !== null && (result.state === 'TRACKING' || result.state === 'LIMITED') && (result.quality.measured || (result.predictionAgeUs >= 0 && result.predictionAgeUs < this.predictionUs));
    // Degenerate geometry is already hidden by the renderer; with a display hold it must not look like a live pose either.
    if (!visible || (this.graceUs > 0 && result.quality.degenerate)) { this.lose(result.reason,sample,true); return; }
    if (this.activeTarget !== result.targetId) {
      // With no active target, a visual grace hold may be showing the lost target; renderer.update() replaces it for a valid new target, so only hard-hide here when a different target is active or grace is off.
      if (this.activeTarget !== null || this.graceUs === 0) this.lose('target-changed',sample);
      if (cancelled()) return;
      if (result.state !== 'TRACKING' || !result.quality.measured) return;
    }
    let deadline = result.quality.measured ? receiptUs + this.predictionUs : Math.min(this.visibilityDeadlineUs, receiptUs + this.predictionUs-result.predictionAgeUs);
    if (result.predictionExpiresAtUs != null) {
      const sessionNow = this.config.source.nowSessionUs?.();
      if (sessionNow != null) deadline = Math.min(deadline, this.clock() + result.predictionExpiresAtUs-sessionNow);
    }
    if (this.clock() >= deadline) { this.lose('prediction-expired',sample,true); return; }
    diagnostics.renderSubmitTimeUs = this.context().timestampUs;
    await this.config.renderer.update(result);
    if (cancelled()) return;
    // A result that was rendered but never announced (no active target) must not be held visually.
    if (this.clock() >= deadline) { this.lose('prediction-expired',sample,this.activeTarget !== null); return; }
    if(sample.measured)this.lastReliableFrame=sample;
    if (!this.activeTarget) {
      this.activeTarget = result.targetId;
      this.emit('targetFound', { ...this.context(), result });
      if (cancelled()) return;
    }
    this.emit('targetUpdated', { ...this.context(), result });
    if (cancelled()) return;
    if (this.expiry) clearTimeout(this.expiry);
    this.visibilityDeadlineUs = deadline;
    const remaining = Math.max(0, deadline-this.clock());
    const epoch = ++this.expiryEpoch, target = result.targetId;
    // Stale callbacks (cleared too late, or invoked by hand) must not touch a newer session, target or timer.
    this.expiry = setTimeout(() => { if (epoch !== this.expiryEpoch || session !== this.session || !this.running || this.activeTarget !== target) return; this.lose('prediction-expired',null,true); }, remaining/1000);
  }
  /** Synchronous hard clear for stop/dispose/cleanup; never waits on source or pipeline settlement and never uses grace. */
  private hideNow(): void {
    if (this.expiry) clearTimeout(this.expiry); this.expiry = null; ++this.expiryEpoch;
    try { this.config.renderer.hide(); } catch { /* lose() reports hide failures once the lifecycle reaches it. */ }
  }
  /** soft: tracking-validity loss that may use the visual grace hold. Everything else hides immediately. */
  private lose(reason: string, triggerFrame:ReturnType<typeof captureTargetFrame>|null=null, soft=false): void {
    if (this.expiry) clearTimeout(this.expiry); this.expiry = null; ++this.expiryEpoch;
    this.visibilityDeadlineUs = -Infinity;
    let held = false;
    if (soft && this.graceUs > 0 && this.running && !this.controller?.signal.aborted && this.config.renderer.holdAfterLoss) {
      try { held = this.config.renderer.holdAfterLoss(this.graceUs/1000) === true; } catch { held = false; }
    }
    if (!held) try { this.config.renderer.hide(); } catch { this.emit('error', { ...this.context(), error: new EngineError('RESOURCE_FAILED', true, 'Renderer failed to hide') }); }
    if (this.activeTarget) {
      const context = this.context();this.activeTarget = null;
      const preceding=this.lastProcessedFrame?.sessionId===this.session?this.lastProcessedFrame:null;
      const reliable=this.lastReliableFrame?.sessionId===this.session&&this.lastReliableFrame.targetId===context.targetId?this.lastReliableFrame:null;
      this.emit('targetLost',{...context,reason,lossContext:{triggerFrame:describeTargetFrame(triggerFrame),
        precedingFrame:describeTargetFrame(preceding),lastReliableFrame:describeTargetFrame(reliable),
        precedingInputFrameRecorded:triggerFrame?Boolean(preceding&&preceding.frameId===triggerFrame.frameId-1):null}});
    }
    this.lastReliableFrame=null;
  }
  private async cleanup(reason: string): Promise<void> {
    const errors: unknown[] = [];
    try { this.unsubscribeTransition?.(); } catch (error) { errors.push(error); }
    this.unsubscribeTransition = null; this.transitionGated = false; this.transitionReady = null;
    this.running = false; this.controller?.abort(); this.hideNow(); if (this.pending) { this.reportDiagnostics({ ...this.diagnostics(this.pending), dropReason: 'stopped-before-processing' }); this.releaseFrame(this.pending); } this.pending = null;
    try { await this.config.source.stop(); } catch (error) { errors.push(error); }
    await this.processing;
    await this.transitionWork;
    try { this.lose(reason); } catch (error) { errors.push(error); }
    try { await this.config.renderer.stop(); } catch (error) { errors.push(error); }
    const endedContext = this.context();
    this.session = null; this.controller = null;
    this.lastProcessedFrame=null;this.lastReliableFrame=null;
    if(endedContext.sessionId)this.emit('sessionEnded', { ...endedContext, reason });
    for (const error of errors) this.emit('error', { ...this.context(), error: new EngineError('RESOURCE_FAILED', true, 'Adapter failed during stop cleanup') });
  }
  private releaseFrame(frame: FramePacket): void {
    if (this.releasedHandles.has(frame.imageHandle)) return;
    this.releasedHandles.add(frame.imageHandle);
    try { frame.imageHandle.release(); } catch { this.emit('error', { ...this.context(), error: new EngineError('RESOURCE_FAILED', true, 'Frame owner failed to release its resource') }); }
  }
  private diagnostics(frame: FramePacket): FrameDiagnostics { return { sessionId: frame.sessionId, frameId: frame.frameId, targetId: null, arrivalTimeUs: frame.arrivalTimeUs, sourceObservationId: frame.imageIdentity, backend: this.config.backend ?? 'cpu', cpuSubmitTimeUs: null, gpuCompleteTimeUs: null, resultAvailableTimeUs: null, renderSubmitTimeUs: null, visibleTimeUs: null, dropReason: null, queueWaitDurationUs: null }; }
  private reportDiagnostics(value: FrameDiagnostics): void { try { this.config.onDiagnostics?.({ ...value }); } catch { /* Diagnostics cannot interrupt cleanup. */ } }
}
