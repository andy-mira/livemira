/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { PRESENTATION_FAILURE_REASONS, type DiagnosticExport, type EngineEvents, type FrameDiagnostics, type TargetBundle, type TrackingResult, type WorkerCapability, type WorkerTiming } from '@livemira/contracts';
class Ring<T> {
  private data:T[]=[];private head=0;dropped=0;
  constructor(private limit:number){}
  push(value:T){if(this.data.length<this.limit)this.data.push(value);else{this.data[this.head]=value;this.head=(this.head+1)%this.limit;this.dropped++;}}
  values():T[]{return this.head?[...this.data.slice(this.head),...this.data.slice(0,this.head)]:[...this.data];}
}
const PHASES: readonly string[] = ['loading', 'revealing', 'revealed', 'failed', 'cancelled'], SIGNALS: readonly string[] = ['video-frame-callback', 'time-progress'], FAILURES: readonly string[] = PRESENTATION_FAILURE_REASONS;
const boundedNumber = (v: unknown, max: number): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, max) : null;
/** Closed-set copy of MediaTelemetry.presentation: enums must match, numbers are finite and bounded; anything else (URLs, text, extra keys) is dropped. */
function sanitizePresentation(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const generation = boundedNumber(v.requestGeneration, 1e9), elapsed = boundedNumber(v.elapsedMs, 3.6e6), duration = boundedNumber(v.revealDurationMs, 1e4);
  if (generation === null || !Number.isInteger(generation) || elapsed === null || duration === null || !PHASES.includes(v.phase as string)) return null;
  const out: Record<string, unknown> = {
    requestGeneration: generation, phase: v.phase, readySignal: SIGNALS.includes(v.readySignal as string) ? v.readySignal : null,
    elapsedMs: elapsed, firstFrameMs: boundedNumber(v.firstFrameMs, 3.6e6), revealElapsedMs: boundedNumber(v.revealElapsedMs, 1e4), revealDurationMs: duration, reducedMotion: v.reducedMotion === true,
  };
  if (FAILURES.includes(v.failureReason as string)) out.failureReason = v.failureReason;
  return out;
}
/** Explicit local numerical recording. Never stores frame handles, retry functions or media URLs. */
export class DiagnosticRecorder {
  private frames:Ring<FrameDiagnostics>;private results:Ring<TrackingResult>;private events:Ring<DiagnosticExport['events'][number]>;private timings:Ring<DiagnosticExport['workerTimings'][number]>;private capabilities=new Ring<WorkerCapability>(64);
  private targets:DiagnosticExport['targets']=[];private readonly runId:string;private createdAt=new Date().toISOString();
  private metadata:Record<string,string|number|boolean|null>={clockDomain:'unknown',recordingKind:'unclassified'};
  constructor(private candidateId:string, private execution:'worker'|'main'='worker',private readonly limit=10000){if(!Number.isInteger(limit)||limit<1||limit>100000)throw new RangeError('Invalid diagnostic record limit');this.frames=new Ring(limit);this.results=new Ring(limit);this.events=new Ring(limit);this.timings=new Ring(limit);this.runId=crypto.randomUUID();}
  setMetadata(value:Record<string,string|number|boolean|null>):void {
    const allowed=new Set(['clockDomain','recordingKind','deviceLabel','browserVersion','userAgent','inputWidth','inputHeight','frameRate','standardWidth','standardHeight','dpr','secureContext','crossOriginIsolated','cameraFacingMode','backendRequested','trackingMode','algorithmVersion','notes','presetId','protocolVersion','captureMode','frozenCandidate','runtimeSha256','sourceRevision','sourceSha256','requestedResolution','lossDisplayGraceMs','maxPredictionMs','engineFormat','engineVariant','engineBuildId','engineInputHash']);
    for(const [key,item] of Object.entries(value))if(allowed.has(key)&&(['string','number','boolean'].includes(typeof item)||item===null))this.metadata[key]=typeof item==='string'?item.slice(0,1024):item;
  }
  setTargets(targets:readonly TargetBundle[]):void {this.targets=targets.map(t=>({targetId:t.targetId,imageHash:t.imageHash,algorithmVersion:t.algorithmVersion,compilerVersion:t.compilerVersion,widthPx:t.widthPx,heightPx:t.heightPx}));}
  frame(value:FrameDiagnostics):void {const {sessionId,frameId,targetId,cpuSubmitTimeUs,gpuCompleteTimeUs,resultAvailableTimeUs,renderSubmitTimeUs,visibleTimeUs,arrivalTimeUs,sourceObservationId,dropReason,backend,queueWaitDurationUs}=value;this.frames.push({sessionId,frameId,targetId,cpuSubmitTimeUs,gpuCompleteTimeUs,resultAvailableTimeUs,renderSubmitTimeUs,visibleTimeUs,arrivalTimeUs,sourceObservationId,dropReason,backend,...(queueWaitDurationUs!==undefined?{queueWaitDurationUs}:{})});}
  /** Per-frame numeric log: the optional visualization points (matchedPoints) are display data and are never retained. */
  result(value:TrackingResult):void {const {matchedPoints:_visualOnly,...numeric}=value;this.results.push(structuredClone(numeric));}
  capability(value:WorkerCapability):void {this.capabilities.push(structuredClone(value));}
  workerTiming(sessionId:string,frameId:number,generation:number,timing:WorkerTiming):void {this.timings.push({sessionId,frameId,generation,timing:{...timing}});}
  event<K extends keyof EngineEvents>(type:K,value:EngineEvents[K]):void {
    const event:DiagnosticExport['events'][number]={type,sessionId:value.sessionId,targetId:value.targetId,timestampUs:value.timestampUs,timestampDomain:value.timestampDomain};
    // Explicit allowlist: never retain retry closures, native errors, frame handles or URLs.
    const payload = { ...value } as unknown as Record<string, unknown>;
    // Presentation telemetry is retained only as a closed set of bounded numbers/enums, whatever a renderer put there.
    const media = payload.media as (Record<string, unknown> | undefined);
    if (media && typeof media === 'object' && media.presentation !== undefined) {
      const { presentation, ...rest } = media;
      const clean = sanitizePresentation(presentation);
      payload.media = clean ? { ...rest, presentation: clean } : rest;
    }
    for (const key of ['originRunId','reason','code','config','state','media','attemptTimeUs','stage','durationUs','status','visibility','phase','permission','alignment','step','feedback','checks','presetId','lossContext']) {
      if (payload[key] !== undefined) (event as unknown as Record<string, unknown>)[key] = structuredClone(payload[key]);
    }
    if(type==='error')event.code=(value as EngineEvents['error']).error.code;
    this.events.push(event);
  }
  getIdentity():{runId:string;candidateId:string} {return {runId:this.runId,candidateId:this.candidateId};}
  getCapacity():{limit:number;frameRecords:number;remainingFrames:number;droppedRecords:number} {
    const count=this.frames.values().length;
    return {limit:this.limit,frameRecords:count,remainingFrames:this.limit-count,droppedRecords:this.frames.dropped+this.results.dropped+this.events.dropped+this.timings.dropped+this.capabilities.dropped};
  }
  export():DiagnosticExport {const droppedRecords=this.frames.dropped+this.results.dropped+this.events.dropped+this.timings.dropped+this.capabilities.dropped;return {schemaVersion:1,candidateId:this.candidateId,runId:this.runId,createdAt:this.createdAt,execution:this.execution,targets:this.targets,capabilities:this.capabilities.values(),frames:this.frames.values(),results:this.results.values(),events:this.events.values(),workerTimings:this.timings.values(),eventLogComplete:droppedRecords===0,truncated:droppedRecords>0,droppedRecords,metadata:{...this.metadata}};}
}
