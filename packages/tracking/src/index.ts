/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, MAX_MATCHED_POINTS, validateTargetBundle, type FramePacket, type RecognitionObservation, type TargetBundle, type TrackingResult, type TrackingState, type VisionPipeline } from '@livemira/contracts';
import { validateObservation } from './geometry.js';
import { trackGrayPoints } from './cpu-points.js';
import { robustFit } from '../experimental/homography.mjs';
import type { Point2 } from '@livemira/contracts';
import {trackSubpixelGrayPoints} from './subpixel-points.js';
import {robustPlane} from './robust-plane.js';

// A module-local injection point using only frozen contract payload types.
// The callback borrows the frame and must settle only after all frame work is safe.
export interface TrackingAcquisitionOptions {
  /** Maximum gap between independent valid observations; default 1 s, bounded to 0.125..2 s. */
  maxObservationGapUs?: number;
  /** Default false. When true, a measured TRACKING result carries the inlier image points of its own accepted observation as matchedPoints. */
  collectMatchedPoints?: boolean;
}
/** Inlier image points of an observation already accepted by validateObservation; null when none or above the contract bound. */
function inlierImagePoints(o: RecognitionObservation): Point2[]|null {
  const points: Point2[]=[];
  for(let i=0;i<o.imagePoints.length;i++)if(o.inliers[i]===true)points.push([o.imagePoints[i][0],o.imagePoints[i][1]]);
  return points.length>=1&&points.length<=MAX_MATCHED_POINTS?points:null;
}
export function createTrackingPipeline(recognize: (frame: FramePacket, targets: readonly TargetBundle[], signal: AbortSignal) => Promise<readonly RecognitionObservation[]>, options: TrackingAcquisitionOptions = {}): VisionPipeline {
  return new RecognitionTrackingPipeline(recognize,false,options);
}
class RecognitionTrackingPipeline implements VisionPipeline {
  private targets: readonly TargetBundle[]=[];
  private session: string|null=null;
  private state: TrackingState='SEARCHING';
  private last: TrackingResult|null=null;
  private absoluteTime: number|null=null;
  private candidate: string|null=null;
  private count=0;
  private firstTime=0;
  private candidateTime=0;
  private readonly acquisitionGapUs:number;
  private readonly collectPoints:boolean;
  private frameId=-1;
  private time=-Infinity;
  private seen=new Set<string>();
  private generation=0;
  private disposed=false;
  private pending: Promise<TrackingResult>|null=null;
  private job: AbortController|null=null;
  constructor(private recognize: (frame: FramePacket, targets: readonly TargetBundle[], signal: AbortSignal)=>Promise<readonly RecognitionObservation[]>, private allowFlow=false,options:TrackingAcquisitionOptions={}) {
    this.acquisitionGapUs=options.maxObservationGapUs??1000000;
    if(options.collectMatchedPoints!==undefined && typeof options.collectMatchedPoints!=='boolean')throw new EngineError('INVALID_CONFIG',false,'collectMatchedPoints must be a boolean');
    this.collectPoints=options.collectMatchedPoints===true;
    if(!Number.isFinite(this.acquisitionGapUs) || this.acquisitionGapUs<125000 || this.acquisitionGapUs>2000000)throw new EngineError('INVALID_CONFIG',false,'Acquisition observation gap must be within 125000..2000000 us');
  }
  private usable() {if(this.disposed)throw new EngineError('DISPOSED',false,'Tracking pipeline disposed');}
  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.usable();
    if(this.pending)throw new EngineError('INVALID_CONFIG',true,'Cannot replace targets during processing');
    if(targets.length<1 || targets.length>10 || new Set(targets.map(t=>t.targetId)).size!==targets.length)throw new EngineError('INVALID_TARGET',false,'Require 1..10 unique targets');
    targets.forEach(validateTargetBundle);this.targets=structuredClone(targets);this.clear();this.session=null;
  }
  private clear() {this.state='SEARCHING';this.last=null;this.absoluteTime=null;this.candidate=null;this.count=0;this.frameId=-1;this.time=-Infinity;this.seen.clear();}
  async reset(sessionId: string): Promise<void> {
    this.usable();if(!sessionId)throw new EngineError('INVALID_CONFIG',false,'Session required');
    const generation=++this.generation;this.job?.abort();await this.pending?.catch(()=>{});
    this.usable();if(generation!==this.generation)throw new EngineError('ABORTED',true,'Reset superseded');
    this.clear();this.session=sessionId;
  }
  async dispose(): Promise<void> {this.disposed=true;++this.generation;this.job?.abort();await this.pending?.catch(()=>{});this.clear();this.targets=[];this.session=null;}
  process(frame: FramePacket, signal: AbortSignal): Promise<TrackingResult> {
    this.usable();
    if(this.pending) return Promise.reject(new EngineError('INVALID_CONFIG',true,'Only one tracking frame may be in flight'));
    const controller=new AbortController();this.job=controller;
    const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    this.pending=this.run(frame,controller.signal,this.generation).finally(()=>{signal.removeEventListener('abort',abort);this.pending=null;this.job=null;});
    return this.pending;
  }
  private empty(frame: FramePacket,time: number,reason: string): TrackingResult {
    return {sessionId:frame.sessionId,frameId:frame.frameId,observationTimeUs:time,targetId:null,state:this.state,H_imageFromTarget:null,cornersPx:null,T_cameraFromTarget:null,poseMetricValid:false,
      quality:{inlierCount:0,inlierRatio:0,reprojectionErrorPx:null,spatialCoverage:0,degenerate:false,measured:false},predictionAgeUs:0,reason,lastReliableObservationTimeUs:null,predictionExpiresAtUs:null,absoluteCorrectionAgeUs:null};
  }
  private miss(frame: FramePacket,time: number,reason: string): TrackingResult {
    if(this.last) {
      const age=time-this.last.observationTimeUs;
      if(age>=100000){this.state='LOST';this.last=null;this.candidate=null;this.count=0;return this.empty(frame,time,'prediction-expired');}
      this.state='LIMITED';
      return structuredClone({...this.last,frameId:frame.frameId,observationTimeUs:time,state:this.state,quality:{...this.last.quality,measured:false},predictionAgeUs:age,absoluteCorrectionAgeUs:this.absoluteTime===null?null:time-this.absoluteTime,reason});
    }
    if(reason!=='duplicate-image'){this.candidate=null;this.count=0;this.state='SEARCHING';}
    return this.empty(frame,time,reason);
  }
  private async run(frame: FramePacket,signal: AbortSignal,generation: number): Promise<TrackingResult> {
    const time=frame.mappedObservationTimeUs;
    const check=()=>{if(signal.aborted || generation!==this.generation || this.disposed)throw new EngineError('ABORTED',true,'Tracking job cancelled or superseded');};
    check();
    if(frame.sessionId!==this.session || !Number.isInteger(frame.frameId) || frame.frameId<=this.frameId)throw new EngineError('FRAME_FAILED',true,'Stale session or frame');
    if(time==null || !Number.isFinite(time) || time<0 || time<=this.time)throw new EngineError('FRAME_FAILED',true,'Require strictly increasing mapped observation time');
    if(!frame.imageIdentity || frame.imageHandle.released)throw new EngineError('FRAME_FAILED',true,'Require image identity and live borrowed handle');
    const duplicate=this.seen.has(frame.imageIdentity);
    let observations:readonly RecognitionObservation[]=[];
    try {observations=duplicate?[]:await this.recognize(frame,this.targets,signal);}
    catch(error){if(generation===this.generation && !this.last){this.candidate=null;this.count=0;this.state='SEARCHING';}throw error;}
    check();
    this.frameId=frame.frameId;this.time=time;
    this.seen.add(frame.imageIdentity);if(this.seen.size>128)this.seen.delete(this.seen.values().next().value!);
    if(this.state==='LOST')this.state='SEARCHING';
    if(duplicate)return this.miss(frame,time,'duplicate-image');
    const accepted: {observation: RecognitionObservation; checked: ReturnType<typeof validateObservation>}[]=[];
    for(const observation of observations) {
      if(observation.sessionId!==frame.sessionId || observation.frameId!==frame.frameId)continue;
      const target=this.targets.find(t=>t.targetId===observation.targetId);if(!target)continue;
      const flowAllowed=this.allowFlow && this.last!==null && observation.targetId===this.last.targetId && observation.sourceFrameId===this.last.frameId && this.absoluteTime!==null && time-this.absoluteTime<200000;
      try {accepted.push({observation,checked:validateObservation(observation,target,flowAllowed)});} catch { /* Invalid candidate is not evidence of tracking. */ }
    }
    accepted.sort((a,b)=>b.checked.quality.inlierCount-a.checked.quality.inlierCount || a.observation.targetId.localeCompare(b.observation.targetId));
    const match=this.last?accepted.find(x=>x.observation.targetId===this.last!.targetId):accepted[0];
    if(!match)return this.miss(frame,time,'no-valid-original-match');
    const {observation:o,checked:c}=match;
    if(!this.last) {
      // Three observations span two inter-observation gaps. Bound both, rather
      // than making a fixed 250 ms window impossible below 8 processed fps.
      if(this.candidate!==o.targetId || time-this.candidateTime>this.acquisitionGapUs || time-this.firstTime>2*this.acquisitionGapUs){this.candidate=o.targetId;this.count=0;this.firstTime=time;}
      this.candidateTime=time;
      this.count++;this.state='ACQUIRING';
      if(this.count<3 || time-this.firstTime<50000)return this.empty(frame,time,'confirming-original-match');
    }
    this.state='TRACKING';
    if(o.correspondenceOrigin==='original-target')this.absoluteTime=time;
    this.last={...this.empty(frame,time,o.correspondenceOrigin==='original-target'?'original-target-measured':'point-track-measured'),targetId:o.targetId,H_imageFromTarget:c.h,cornersPx:c.corners,quality:c.quality,lastReliableObservationTimeUs:time,predictionExpiresAtUs:time+100000,absoluteCorrectionAgeUs:this.absoluteTime===null?null:time-this.absoluteTime};
    // `last` (the source of every later prediction) never holds points: they exist only on the result of the frame that measured them.
    const result=structuredClone(this.last);
    const pointsPx=this.collectPoints?inlierImagePoints(o):null;
    if(pointsPx)result.matchedPoints={sessionId:frame.sessionId,frameId:frame.frameId,targetId:o.targetId,origin:o.correspondenceOrigin as 'original-target'|'previous-frame',pointsPx};
    return result;
  }
}

/** Opt-in experiment: raw gray point tracking, with mandatory original rematches. */
export function createHybridTrackingPipeline(recognize: (frame: FramePacket, targets: readonly TargetBundle[], signal: AbortSignal)=>Promise<readonly RecognitionObservation[]>,options:TrackingAcquisitionOptions={}): VisionPipeline {
  return new HybridTrackingPipeline(recognize,false,options);
}
/** Opt-in subpixel variant of the hybrid tracker; not the default, and its accuracy benefit is not established. */
export function createSubpixelTrackingPipeline(recognize: (frame: FramePacket, targets: readonly TargetBundle[], signal: AbortSignal)=>Promise<readonly RecognitionObservation[]>,options:TrackingAcquisitionOptions={}): VisionPipeline {
  return new HybridTrackingPipeline(recognize,true,options);
}
type Seed={frame: FramePacket; observation: RecognitionObservation; absoluteTime: number; intervalUs:number};
class HybridTrackingPipeline implements VisionPipeline {
  private seed: Seed|null=null;
  private candidates: readonly RecognitionObservation[]=[];
  private generation=0;
  private pending: Promise<TrackingResult>|null=null;
  private core: RecognitionTrackingPipeline;
  constructor(private recognize: (frame: FramePacket,targets: readonly TargetBundle[],signal: AbortSignal)=>Promise<readonly RecognitionObservation[]>,private subpixel=false,options:TrackingAcquisitionOptions={}) {
    this.core=new RecognitionTrackingPipeline((frame,targets,signal)=>this.observe(frame,targets,signal),true,options);
  }
  private async observe(frame: FramePacket,targets: readonly TargetBundle[],signal: AbortSignal): Promise<readonly RecognitionObservation[]> {
    this.candidates=[];
    const seed=this.seed,time=frame.mappedObservationTimeUs!;
    if(seed && time-seed.absoluteTime<seed.intervalUs && time-seed.frame.mappedObservationTimeUs!<100000) {
      try {
        const tracks=this.subpixel?trackSubpixelGrayPoints(seed.frame,frame,seed.observation.imagePoints,signal):trackGrayPoints(seed.frame,frame,seed.observation.imagePoints);
        const pairs=tracks.points.flatMap((point,i)=>tracks.valid[i]?[[...seed.observation.targetPoints[i],...point]]:[]);
        const {h}=this.subpixel?robustPlane(pairs as [number,number,number,number][],1.5):robustFit(pairs,1.5,64);
        const inliers=tracks.points.map((point,i)=>{
          if(!tracks.valid[i])return false;
          const [x,y]=seed.observation.targetPoints[i],z=h[6]*x+h[7]*y+h[8];
          return Math.hypot((h[0]*x+h[1]*y+h[2])/z-point[0],(h[3]*x+h[4]*y+h[5])/z-point[1])<=1.5;
        });
        const observation: RecognitionObservation={...seed.observation,sessionId:frame.sessionId,frameId:frame.frameId,H_imageFromTarget:h as unknown as RecognitionObservation['H_imageFromTarget'],imagePoints:tracks.points,inliers,correspondenceOrigin:'previous-frame',sourceFrameId:seed.frame.frameId};
        const target=targets.find(t=>t.targetId===observation.targetId)!;
        const checked=validateObservation(observation,target,true);
        if(this.subpixel && (checked.quality.inlierRatio<.75 || checked.quality.reprojectionErrorPx!>.8))throw new Error('adaptive-rematch-low-quality');
        observation.reprojectionErrorPx=checked.quality.reprojectionErrorPx!;observation.spatialCoverage=checked.quality.spatialCoverage;
        this.candidates=[observation];return this.candidates;
      } catch { /* Any failed point/geometry gate triggers same-frame absolute rematching. */ }
    }
    this.candidates=await this.recognize(frame,targets,signal);return this.candidates;
  }
  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    if(this.pending)throw new EngineError('INVALID_CONFIG',true,'Cannot load targets during hybrid work');
    await this.core.loadTargets(targets);this.seed=null;this.candidates=[];
  }
  async reset(sessionId: string): Promise<void> {++this.generation;await this.core.reset(sessionId);await this.pending?.catch(()=>{});this.seed=null;this.candidates=[];}
  async dispose(): Promise<void> {++this.generation;await this.core.dispose();await this.pending?.catch(()=>{});this.seed=null;this.candidates=[];}
  process(frame: FramePacket,signal: AbortSignal): Promise<TrackingResult> {
    if(this.pending)return Promise.reject(new EngineError('INVALID_CONFIG',true,'One hybrid frame at a time'));
    const generation=this.generation;
    this.pending=this.core.process(frame,signal).then(result=>{
      if(generation!==this.generation || signal.aborted)throw new EngineError('ABORTED',true,'Hybrid generation superseded');
      const observation=this.candidates.find(o=>o.targetId===result.targetId && o.frameId===frame.frameId);
      if(result.state==='TRACKING' && result.quality.measured && observation && frame.pixelFormat==='gray8' && frame.imageHandle.data instanceof Uint8Array && frame.width*frame.height<=1048576 && frame.imageHandle.data.length===frame.width*frame.height) {
        // A private owned snapshot survives SDK release; only one previous image is retained.
        const data=new Uint8Array(frame.imageHandle.data);
        const ids=observation.inliers.flatMap((valid,i)=>valid?[i]:[]);
        const step=Math.max(1,Math.ceil(ids.length/64));let selected=ids.filter((_,i)=>i%step===0).slice(0,64);
        if(this.subpixel && ids.length>64) {
          // Farthest-point sampling spreads support across the original plane.
          selected=[ids[0]];const distances=new Map(ids.map(i=>[i,Infinity]));
          while(selected.length<64){const p=observation.targetPoints[selected.at(-1)!];let best=-1,distance=-1;
            for(const i of ids){const q=observation.targetPoints[i],d=Math.min(distances.get(i)!,Math.hypot(p[0]-q[0],p[1]-q[1]));distances.set(i,d);if(!selected.includes(i) && d>distance){distance=d;best=i;}}
            if(best<0)break;selected.push(best);
          }
        }
        const targetPoints=selected.map(i=>[...observation.targetPoints[i]] as Point2),imagePoints=selected.map(i=>[...observation.imagePoints[i]] as Point2);
        this.seed={frame:{...frame,imageHandle:{kind:'gray8',data,released:false,release(){}}},observation:{...observation,targetPoints,imagePoints,inliers:selected.map(()=>true)},absoluteTime:frame.mappedObservationTimeUs!-(result.absoluteCorrectionAgeUs??0),intervalUs:this.subpixel && (result.quality.spatialCoverage<.35 || result.quality.reprojectionErrorPx!>.5)?100000:200000};
      } else this.seed=null;
      return result;
    }).catch(error=>{if(generation===this.generation){this.seed=null;this.candidates=[];}throw error;}).finally(()=>{this.pending=null;});
    return this.pending;
  }
}
