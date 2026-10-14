/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, recognitionTraceForResult, sanitizeMatchedPoints, snapshotCpuFeatureOptions, validateTargetBundle, safeWorkerReason, WORKER_PROTOCOL_VERSION, type FramePacket, type TargetBundle, type TrackingResult, type VisionPipeline, type RecognitionTrace, type VisionWorkerRequest, type VisionWorkerResponse, type WorkerCapability, type WorkerFrameLease, type WorkerPipelineOptions, type WorkerTiming } from '@livemira/contracts';

export interface WorkerEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
  removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: any) => void): void;
}
export interface WorkerPipelineConfig {
  prepareFrame: (frame: FramePacket, signal: AbortSignal) => Promise<WorkerFrameLease>;
  options?: Partial<WorkerPipelineOptions>; requestTimeoutMs?: number;
  workerFactory?: () => WorkerEndpoint;
  onCapability?: (capability: WorkerCapability) => void;
  onTiming?: (sessionId: string, frameId: number, generation: number, timing: WorkerTiming) => void;
  onFailure?: (error: EngineError) => void;
  onResult?: (result: TrackingResult) => void;
  /** Only called when options.observeRecognition is true: the validated, bounded trace of the recognition pass behind the result of the same frame (delivered just before onResult). */
  onRecognitionTrace?: (trace: RecognitionTrace) => void;
}
type RequestBody = VisionWorkerRequest extends infer R ? R extends VisionWorkerRequest ? Omit<R,'protocol'|'requestId'|'generation'> : never : never;
export function createWorkerPipeline(config: WorkerPipelineConfig): WorkerVisionPipeline { return new WorkerVisionPipeline(config); }

// The single-file build defines __LM_EMBEDDED__ = true and always supplies workerFactory, so the file-backed Worker URL is removed from that bundle.
declare const __LM_EMBEDDED__: boolean | undefined;
function createDefaultWorker(): WorkerEndpoint {
  return typeof __LM_EMBEDDED__ !== 'undefined' && __LM_EMBEDDED__ ? missingEmbeddedFactory() : fileBackedWorker();
}
function missingEmbeddedFactory(): never { throw new EngineError('UNSUPPORTED', false, 'Embedded builds require a workerFactory'); }
function fileBackedWorker(): WorkerEndpoint { return new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module', name: 'LiveMira vision' }); }

/** One real worker and one request. SDK owns frame scheduling; this class never adds a frame queue. */
export class WorkerVisionPipeline implements VisionPipeline {
  private worker: WorkerEndpoint | null = null;
  private generation = 0;
  private requestId = 0;
  private targets: readonly TargetBundle[] = [];
  private sessionId: string | null = null;
  private disposed = false;
  private lastCapability: string | null = null;
  private operation: Promise<unknown> | null = null;
  private pending: { id: number; generation: number; resolve: (value: VisionWorkerResponse) => void; reject: (error: EngineError) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly options: WorkerPipelineOptions;
  private readonly timeout: number;
  constructor(private readonly config: WorkerPipelineConfig) {
    // cpuFeatures is replaced by a validated frozen copy so later caller mutation cannot change the Worker configuration.
    const options = { ...config.options };
    const cpuFeatures = snapshotCpuFeatureOptions(options.cpuFeatures);
    this.options = { trackingMode: 'absolute', backendPreference: 'cpu', ...options, ...(cpuFeatures ? { cpuFeatures } : {}) };
    if (this.options.collectMatchedPoints !== undefined && typeof this.options.collectMatchedPoints !== 'boolean') throw new EngineError('INVALID_CONFIG',false,'collectMatchedPoints must be a boolean');
    if (this.options.observeRecognition !== undefined && typeof this.options.observeRecognition !== 'boolean') throw new EngineError('INVALID_CONFIG',false,'observeRecognition must be a boolean');
    if (this.options.legacyScaleSearch !== undefined && typeof this.options.legacyScaleSearch !== 'boolean') throw new EngineError('INVALID_CONFIG',false,'legacyScaleSearch must be a boolean');
    if (this.options.cpuMatching !== undefined && this.options.cpuMatching !== 'js' && this.options.cpuMatching !== 'wasm-experimental') throw new EngineError('INVALID_CONFIG',false,"cpuMatching must be 'js' or 'wasm-experimental'");
    if (this.options.cpuMatching === 'wasm-experimental' && this.options.backendPreference === 'webgpu') throw new EngineError('INVALID_CONFIG',false,"cpuMatching 'wasm-experimental' cannot be combined with backendPreference 'webgpu'");
    this.timeout = config.requestTimeoutMs ?? 30000;
    if (!config.prepareFrame || !Number.isFinite(this.timeout) || this.timeout < 100 || this.timeout > 120000) throw new EngineError('INVALID_CONFIG',false,'Invalid worker configuration');
  }
  private observe<T>(callback: ((value: T) => void) | undefined, value: T): void { try { callback?.(value); } catch { /* Observers cannot own worker progress. */ } }
  private alive() { if (this.disposed) throw new EngineError('DISPOSED',false,'Worker pipeline disposed'); }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.alive(); if (this.operation) throw new EngineError('RESOURCE_FAILED',true,'Only one worker operation may be active');
    const task = Promise.resolve().then(action); this.operation = task;
    try { return await task; } finally { if (this.operation === task) this.operation = null; }
  }
  private message = (event: { data: VisionWorkerResponse }): void => {
    const value = event.data, pending = this.pending;
    if (!pending || !value || value.protocol !== WORKER_PROTOCOL_VERSION || value.generation !== pending.generation || value.requestId !== pending.id) return;
    clearTimeout(pending.timer); this.pending = null;
    if (value.type === 'error') pending.reject(new EngineError(value.code,true,safeWorkerReason(value.reason)));
    else { if (value.type === 'ready') { this.lastCapability = JSON.stringify(value.capability); this.observe(this.config.onCapability,value.capability); } pending.resolve(value); }
  };
  private failure = (): void => { const error = new EngineError('RESOURCE_FAILED',true,'Worker failed; restart is required'); this.kill(error); this.observe(this.config.onFailure,error); };
  private kill(error = new EngineError('ABORTED',true,'Worker operation cancelled')): void {
    const worker = this.worker; this.worker = null; this.sessionId = null; ++this.generation;
    if (worker) { worker.removeEventListener('message',this.message); worker.removeEventListener('error',this.failure); worker.removeEventListener('messageerror',this.failure); worker.terminate(); }
    if (this.pending) { const pending = this.pending; this.pending = null; clearTimeout(pending.timer); pending.reject(error); }
  }
  private request(body: RequestBody, transfer: Transferable[] = []): Promise<VisionWorkerResponse> {
    this.alive(); if (!this.worker || this.pending) return Promise.reject(new EngineError('RESOURCE_FAILED',true,'Worker not ready or busy'));
    const id = ++this.requestId, generation = this.generation;
    return new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>{const error=new EngineError('RESOURCE_FAILED',true,'Worker request timed out; restart is required');this.kill(error);this.observe(this.config.onFailure,error);},this.timeout);
      this.pending = {id,generation,resolve,reject,timer};
      try { this.worker!.postMessage({ ...body, protocol: WORKER_PROTOCOL_VERSION, requestId: id, generation },transfer); }
      catch { this.kill(new EngineError('RESOURCE_FAILED',true,'Worker transfer failed')); }
    });
  }
  private async ensureWorker(): Promise<void> {
    this.alive(); if (this.worker) return;
    try { this.worker = this.config.workerFactory ? this.config.workerFactory() : createDefaultWorker(); }
    catch { throw new EngineError('UNSUPPORTED',true,'Module Worker unavailable'); }
    ++this.generation;
    this.worker.addEventListener('message',this.message);this.worker.addEventListener('error',this.failure);this.worker.addEventListener('messageerror',this.failure);
    try {
      const ready = await this.request({type:'init',options:this.options});
      if (ready.type !== 'ready') throw new EngineError('START_FAILED',true,'Invalid worker initialization response');
      if (this.targets.length) await this.request({type:'load-targets',targets:this.targets});
    } catch (error) { this.kill(); throw error; }
  }
  loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    return this.exclusive(async()=>{
      if (!targets.length || targets.length>10 || new Set(targets.map(t=>t.targetId)).size!==targets.length || new Set(targets.map(t=>t.algorithmVersion)).size!==1 || (this.options.algorithmVersion!==undefined && targets[0].algorithmVersion!==this.options.algorithmVersion)) throw new EngineError('INVALID_TARGET',false,'Require 1..10 unique compatible targets');
      targets.forEach(validateTargetBundle); const snapshot = structuredClone(targets);
      await this.ensureWorker(); await this.request({type:'load-targets',targets:snapshot}); this.targets = snapshot; this.sessionId = null;
    });
  }
  reset(sessionId: string): Promise<void> {
    return this.exclusive(async()=>{if(!sessionId)throw new EngineError('INVALID_CONFIG',false,'Session required');await this.ensureWorker();await this.request({type:'reset',sessionId});this.sessionId=sessionId;});
  }
  compileEncodedImage(encodedImage: ArrayBuffer, targetId: string, maxEdge = 640, signal?: AbortSignal, algorithmVersion = this.options.algorithmVersion): Promise<TargetBundle> {
    return this.exclusive(async()=>{
      if (signal?.aborted) throw new EngineError('ABORTED',true,'Compilation cancelled');
      if (!encodedImage.byteLength || encodedImage.byteLength>24_000_000) throw new EngineError('INVALID_TARGET',false,'Encoded target exceeds input limit');
      const abort = ()=>this.kill();signal?.addEventListener('abort',abort,{once:true});
      try { await this.ensureWorker(); if(signal?.aborted)throw new EngineError('ABORTED',true,'Compilation cancelled');const response=await this.request({type:'compile',encodedImage,targetId,maxEdge,algorithmVersion},[encodedImage]);if(response.type!=='compiled')throw new EngineError('INVALID_TARGET',true,'Unexpected compile response');return response.target; }
      finally { signal?.removeEventListener('abort',abort); }
    });
  }
  process(frame: FramePacket, signal: AbortSignal): Promise<TrackingResult> {
    return this.exclusive(async()=>{
      if(signal.aborted)throw new EngineError('ABORTED',true,'Frame cancelled');
      if(!this.worker || this.sessionId!==frame.sessionId)throw new EngineError('FRAME_FAILED',true,'Worker session requires reset');
      let lease: WorkerFrameLease | undefined;
      const abort=()=>this.kill();signal.addEventListener('abort',abort,{once:true});
      try {
        lease=await this.config.prepareFrame(frame,signal);
        if(signal.aborted || this.disposed)throw new EngineError('ABORTED',true,'Frame preparation cancelled');
        const responsePromise=this.request({type:'frame',frame:lease.frame},lease.transfer);
        if(this.worker && this.pending)lease.markTransferred();
        const response=await responsePromise;
        if(response.type!=='result' || response.result.sessionId!==frame.sessionId || response.result.frameId!==frame.frameId)throw new EngineError('FRAME_FAILED',true,'Worker result identity mismatch');
        // Auxiliary points cross the Worker boundary only when requested and only if they describe exactly this result.
        sanitizeMatchedPoints(response.result,this.options.collectMatchedPoints===true);
        // A capability change discovered while processing (e.g. WASM→CPU size fallback) is announced once, before the result resolves.
        if (response.capability && response.capability.execution === 'worker') { const key = JSON.stringify(response.capability); if (key !== this.lastCapability) { this.lastCapability = key; this.observe(this.config.onCapability, response.capability); } }
        try { this.config.onTiming?.(frame.sessionId,frame.frameId,this.generation,{...response.timing,inputPreparationDurationUs:lease.preparationDurationUs,inputCopiedBytes:lease.copiedBytes}); } catch { /* Numeric observer only. */ }
        // Traces cross to the observer only when requested and only if they describe exactly this result.
        if(this.options.observeRecognition===true&&response.trace!==undefined){const trace=recognitionTraceForResult(response.trace,frame);if(trace)this.observe(this.config.onRecognitionTrace,trace);}
        this.observe(this.config.onResult,structuredClone(response.result));
        return response.result;
      } finally {signal.removeEventListener('abort',abort);lease?.release();}
    });
  }
  async dispose(): Promise<void> { if(this.disposed)return;this.disposed=true;this.kill();await this.operation?.catch(()=>{});this.targets=[]; }
}
