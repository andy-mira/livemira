/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, MAX_LOSS_DISPLAY_GRACE_MS, type EngineEvents, type FrameGeometry, type MediaConfig, type MediaPresentationTelemetry, type MediaState, type PresentationFailureReason, type RendererEventSink, type RenderSink, type TargetBundle, type TrackingResult } from '@livemira/contracts';
import { PerspectiveVideoRenderer, project } from './perspective.mjs';
import { VideoSession } from '../../media/src/video-session.mjs';
import { PlanePresentation, REDUCED_REVEAL_MS, normalizePresentationOptions, type PresentationOptions } from './loading-reveal.mjs';

export interface RendererOptions {
  /** Must describe the same standard image coordinate space as this result. */
  geometryForResult: (result: TrackingResult) => FrameGeometry;
  nowUs?: () => number;
  onPlaybackBlocked?: (event: EngineEvents['playbackBlocked']) => void;
  onError?: (event: EngineEvents['error']) => void;
  /**
   * Loading mask + circular reveal on the video plane. Default ON (true / omitted / an options object); `false` restores the previous behaviour
   * (video simply appears, no extra DOM, no presentation telemetry). Invalid numbers throw INVALID_CONFIG.
   */
  presentation?: PresentationOptions | boolean;
}

/** State of ONE media request's loading → first frame → reveal. Every async continuation re-checks that it is still this.presentation. */
interface Presentation {
  generation:number;media:VideoSession;overlay:PlanePresentation;sessionId:string;targetId:string;
  phase:MediaPresentationTelemetry['phase'];signal:MediaPresentationTelemetry['readySignal'];
  startUs:number;firstFrameUs:number|null;revealStartUs:number|null;revealEndUs:number|null;
  reduced:boolean;revealDurationMs:number;announced:boolean;
  /** Visible-loading time left; the timer only runs while the plane is visible. */
  budgetMs:number;clockStartUs:number|null;timer:ReturnType<typeof setTimeout>|null;
}

interface LossHold {media:VideoSession;sessionId:string;targetId:string;timer:ReturnType<typeof setTimeout>|null}

/** CPU-metadata-only RenderSink; no camera image borrowing and no shared GPU device. */
export class CssVideoRenderSink implements RenderSink {
  private targets = new Map<string, Pick<TargetBundle,'widthPx'|'heightPx'>>();
  private configs = new Map<string,MediaConfig>();
  private container: HTMLElement | null = null;
  private sessionId: string | null = null;
  private activeTarget: string | null = null;
  private plane: PerspectiveVideoRenderer | null = null;
  private media: VideoSession | null = null;
  private visible = false;
  private mediaFailed = false;
  private presentationAllowed = false;
  private ownedUrls = new Map<string,string>();
  private disposed = false;
  private lastFrame = -1;
  /** Bumped by every stop(); an update that observes a change during an observer callback has been cancelled. */
  private epoch = 0;
  /** Depth of stop() teardowns in progress; update() refuses new work meanwhile. */
  private stopping = 0;
  private mediaListeners: (()=>void) | null = null;
  /** Visual-only loss grace: the overlay and playback continue unchanged; never a tracking state. */
  private hold: LossHold|null = null;
  private eventSinks = new Set<RendererEventSink>();
  private readonly presentationOptions: ReturnType<typeof normalizePresentationOptions>;
  private presentation: Presentation|null = null;
  /** Increments for every media request/attempt; reported as MediaPresentationTelemetry.requestGeneration. */
  private requestSeq = 0;
  /** Presentation being released by releaseActive: hide() must not snap-complete it (it is reported as cancelled instead). */
  private releasingPresentation: Presentation|null = null;
  private readonly now: () => number;
  private readonly options: RendererOptions;
  constructor(options: RendererOptions) {
    this.options=options;this.now = options.nowUs ?? (()=>performance.now()*1000);
    let presentation: ReturnType<typeof normalizePresentationOptions>;
    try{presentation=normalizePresentationOptions(options.presentation);}catch(error){throw new EngineError('INVALID_CONFIG',false,String((error as Error).message));}
    this.presentationOptions=presentation;
  }
  connectEvents(sink: RendererEventSink): () => void {
    this.assertUsable();this.eventSinks.add(sink);
    return ()=>{this.eventSinks.delete(sink);};
  }
  private emitBlocked(event: EngineEvents['playbackBlocked']): void {
    for(const sink of [...this.eventSinks]) {try{sink.playbackBlocked(event);}catch{/* Observers cannot interrupt media cleanup or other observers. */}}
    try{this.options.onPlaybackBlocked?.(event);}catch{/* Preserve compatibility callbacks without coupling playback to UI errors. */}
  }
  private emitError(event: EngineEvents['error']): void {
    for(const sink of [...this.eventSinks]) {try{sink.error(event);}catch{/* Observer isolation matches SDK event dispatch. */}}
    try{this.options.onError?.(event);}catch{/* Observer isolation. */}
  }
  setTargets(targets: readonly Pick<TargetBundle,'targetId'|'widthPx'|'heightPx'>[]): void {
    this.assertUsable();
    if(this.sessionId) throw new EngineError('INVALID_CONFIG',true,'Stop renderer before replacing target dimensions');
    for(const t of targets) if(!t.targetId || ![t.widthPx,t.heightPx].every(v=>Number.isFinite(v)&&v>0)) throw new EngineError('INVALID_TARGET',false,'Invalid target dimensions');
    this.targets = new Map(targets.map(t=>[t.targetId,{widthPx:t.widthPx,heightPx:t.heightPx}]));
  }
  async start(container: HTMLElement | null, sessionId: string): Promise<void> {
    this.assertUsable(); await this.stop();
    if(!container) throw new EngineError('INVALID_CONFIG',false,'CSS renderer requires a positioned overlay container');
    this.container=container;this.sessionId=sessionId;this.lastFrame=-1;
    container.ownerDocument.addEventListener('visibilitychange',this.onVisibility);
    container.ownerDocument.defaultView?.addEventListener('pagehide',this.onPageHide);
  }
  private onPageHide = ():void => {this.hide();this.media?.pause();};
  private onVisibility = ():void => {if(this.container?.ownerDocument.hidden)this.onPageHide();};
  private emitMediaState(state:MediaState,presentation?:MediaPresentationTelemetry):void {
    if(!this.sessionId||!this.media)return;
    this.emitMediaStateFor({sessionId:this.sessionId,targetId:this.activeTarget,media:this.media},state,presentation);
  }
  /** Explicit context so a release can report the request it just ended after this.media was already cleared. */
  private emitMediaStateFor(context:{sessionId:string;targetId:string|null;media:VideoSession},state:MediaState,presentation?:MediaPresentationTelemetry):void {
    const d=context.media.getDiagnostics();
    const event:EngineEvents['mediaState']={sessionId:context.sessionId,targetId:context.targetId,timestampUs:this.now(),state,
      media:{currentTime:d.currentTime,decodedFrames:d.decodedFrames,droppedFrames:d.droppedFrames,readyState:Number.isFinite(d.readyState)?d.readyState:null,paused:Boolean(d.paused),errorCode:d.errorCode,loop:d.loop,duration:d.duration,ended:d.ended,loopRecoveries:d.loopRecoveries,...(d.playbackPath!==undefined?{playbackPath:d.playbackPath}:{}),...(d.wechatRecoveryAttempts!==undefined?{wechatRecoveryAttempts:d.wechatRecoveryAttempts}:{}),...(presentation?{presentation}:{})}};
    for(const sink of [...this.eventSinks]){try{sink.sessionEvent?.('mediaState',event);}catch{/* Observer isolation. */}}
  }
  // ---- Loading / reveal presentation: one Presentation per media request (see MediaPresentationTelemetry) ----
  private ownsPresentation(pres:Presentation):boolean {
    return !this.disposed&&this.presentation===pres&&this.media===pres.media&&this.sessionId===pres.sessionId&&this.activeTarget===pres.targetId;
  }
  private presentationTelemetry(pres:Presentation,failureReason?:PresentationFailureReason):MediaPresentationTelemetry {
    const ms=(from:number,to:number)=>Math.max(0,Math.round((to-from)/100)/10),t=this.now();
    return {requestGeneration:pres.generation,phase:pres.phase,readySignal:pres.signal,elapsedMs:ms(pres.startUs,t),
      firstFrameMs:pres.firstFrameUs===null?null:ms(pres.startUs,pres.firstFrameUs),
      revealElapsedMs:pres.revealStartUs===null?null:ms(pres.revealStartUs,pres.revealEndUs??t),
      revealDurationMs:pres.revealDurationMs,reducedMotion:pres.reduced,...(failureReason?{failureReason}:{})};
  }
  /** Dim layer + spinner and a readiness watch on the CURRENT media; announcing 'loading' is left to the caller (it runs observers). */
  private startPresentation(media:VideoSession,overlay:PlanePresentation,sessionId:string,targetId:string):Presentation {
    const reduced=overlay.reducedMotion,revealMs=this.presentationOptions!.revealMs;
    const pres:Presentation={generation:++this.requestSeq,media,overlay,sessionId,targetId,phase:'loading',signal:null,startUs:this.now(),firstFrameUs:null,revealStartUs:null,revealEndUs:null,
      reduced,revealDurationMs:reduced?Math.min(revealMs,REDUCED_REVEAL_MS):revealMs,announced:false,budgetMs:this.presentationOptions!.loadingTimeoutMs,clockStartUs:null,timer:null};
    this.presentation=pres;
    overlay.showLoading(reduced);
    try{media.awaitPresentableFrame(info=>this.onFirstFrame(pres,info.signal));}catch{/* A disposed media session can never become ready. */}
    return pres;
  }
  private announceLoading(pres:Presentation):void {
    if(pres.announced||pres.phase!=='loading'||!this.ownsPresentation(pres))return;
    pres.announced=true;this.emitMediaState('loading',this.presentationTelemetry(pres));
  }
  /** The loading budget counts visible time only: it runs while the plane is shown and pauses while hidden. */
  private startClock(pres:Presentation|null):void {
    if(!pres||pres.phase!=='loading'||pres.timer!==null)return;
    pres.clockStartUs=this.now();
    const timer=setTimeout(()=>this.onLoadingTimeout(pres),Math.max(1,pres.budgetMs));
    // A pending budget must not keep a Node host (tests, SSR tooling) alive; browsers return a number and ignore this.
    (timer as unknown as {unref?:()=>void}).unref?.();
    pres.timer=timer;
  }
  private pauseClock(pres:Presentation|null):void {
    if(!pres||pres.timer===null)return;
    clearTimeout(pres.timer);pres.timer=null;
    pres.budgetMs=Math.max(1,pres.budgetMs-(this.now()-(pres.clockStartUs??this.now()))/1000);
  }
  private onLoadingTimeout(pres:Presentation):void {
    pres.timer=null;
    if(!this.ownsPresentation(pres)||pres.phase!=='loading')return;
    this.failMedia(pres.media,pres,{sessionId:pres.sessionId,targetId:pres.targetId,timestampUs:this.now()},'media-loading-timeout','loading-timeout');
  }
  /** Only the readiness watch of the current request reaches here; a stale or released request's callback fails the ownership check. */
  private onFirstFrame(pres:Presentation,signal:'video-frame-callback'|'time-progress'):void {
    if(!this.ownsPresentation(pres)||pres.phase!=='loading')return;
    this.pauseClock(pres);
    const revealMs=this.presentationOptions!.revealMs;
    pres.firstFrameUs=this.now();pres.signal=signal;pres.phase='revealing';
    pres.reduced=pres.overlay.reducedMotion;pres.revealDurationMs=pres.reduced?Math.min(revealMs,REDUCED_REVEAL_MS):revealMs;
    this.emitMediaState('first-frame',this.presentationTelemetry(pres));
    if(!this.ownsPresentation(pres)||pres.phase!=='revealing')return;
    // Hidden at the first frame: nothing to animate, the finished video is simply there when the plane shows again.
    const duration=this.visible&&!this.container?.ownerDocument.hidden?pres.revealDurationMs:0;
    if(duration>0){
      pres.revealStartUs=this.now();
      this.emitMediaState('reveal-start',this.presentationTelemetry(pres));
      if(!this.ownsPresentation(pres)||pres.phase!=='revealing')return;
    }
    pres.overlay.reveal({durationMs:duration,reduced:pres.reduced,onEnd:()=>this.onRevealEnd(pres)});
  }
  private onRevealEnd(pres:Presentation):void {
    if(!this.ownsPresentation(pres)||pres.phase!=='revealing')return;
    pres.phase='revealed';pres.revealEndUs=this.now();if(pres.revealStartUs===null)pres.revealStartUs=pres.revealEndUs;
    this.emitMediaState('reveal-end',this.presentationTelemetry(pres));
  }
  /** Clears spinner and mask of a request that can no longer finish loading; one already revealing just completes. */
  private failPresentation(pres:Presentation|null,reason:PresentationFailureReason):void {
    if(!pres||!this.ownsPresentation(pres))return;
    if(pres.phase==='revealing'){pres.overlay.finish();return;}
    if(pres.phase!=='loading')return;
    // A failed request must not keep a hidden readiness watcher (rVFC callback or fallback poll) alive; a retry arms a new one.
    this.pauseClock(pres);pres.phase='failed';pres.media.cancelPresentable();pres.overlay.cancel();
    this.emitMediaState('loading-failed',this.presentationTelemetry(pres,reason));
  }
  /** Existing media failure contract (error mediaState, latch, hide, pause, RESOURCE_FAILED error) preceded by clearing the loading visuals. */
  private failMedia(media:VideoSession,pres:Presentation|null,context:{sessionId:string|null;targetId:string|null;timestampUs:number},reason:string,presentationReason:PresentationFailureReason):void {
    this.failPresentation(pres,presentationReason);
    // Observers run inside every emit and may replace the active target. Only state still owned by `media` is changed; once it was
    // replaced, the failure is still reported with the old context but nothing of the newer target is latched, hidden or paused.
    if(this.media===media){
      this.emitMediaState('error');
      if(this.media===media){this.mediaFailed=true;this.hide();}
    }
    media.pause();
    this.emitError({...context,error:new EngineError('RESOURCE_FAILED',true,reason)});
  }
  /**
   * A new request on the SAME media element: a gesture reload (force) or a retry after blocked playback (only when that request had failed).
   * An unfinished previous request is reported cancelled; an already presentable one is left alone unless the element is reloaded.
   */
  private restartPresentation(media:VideoSession,force:boolean):void {
    const old=this.presentation;
    if(!this.presentationOptions||!old||old.media!==media||!this.ownsPresentation(old)||(!force&&old.phase!=='failed'))return;
    let cancelled:MediaPresentationTelemetry|null=null;
    if(old.phase==='loading'||old.phase==='revealing'){this.pauseClock(old);old.phase='cancelled';old.overlay.cancel();cancelled=this.presentationTelemetry(old);}
    const pres=this.startPresentation(media,old.overlay,old.sessionId,old.targetId);
    if(this.visible&&!this.container?.ownerDocument.hidden)this.startClock(pres);
    if(cancelled)this.emitMediaStateFor({sessionId:old.sessionId,targetId:old.targetId,media},'reveal-cancel',cancelled);
    this.announceLoading(pres);
  }
  async update(result: TrackingResult): Promise<void> {
    this.assertUsable();
    if(this.stopping>0||!this.container || result.sessionId!==this.sessionId || result.frameId<=this.lastFrame) return;
    this.lastFrame=result.frameId;
    const epoch=this.epoch;
    if(this.container.ownerDocument.hidden || !result.targetId || !['TRACKING','LIMITED'].includes(result.state) || result.quality.degenerate || (!result.quality.measured && (!Number.isFinite(result.predictionAgeUs) || result.predictionAgeUs<0 || result.predictionAgeUs>=100000))) {
      // An invalid result during a grace hold neither cancels nor extends it; the timer or a hard clear ends it.
      if(this.hold&&!this.container.ownerDocument.hidden)return;
      this.hide();return;
    }
    const target=this.targets.get(result.targetId),config=this.configs.get(result.targetId);
    if(!target||!config){this.releaseActive(result.frameId);return;}
    this.presentationAllowed=true;
    if(this.activeTarget!==result.targetId){
      this.releaseActive(result.frameId);
      // Cancelled by stop/dispose, or superseded by a newer frame submitted from an observer: that frame owns the display now.
      if(this.epoch!==epoch||!this.container||this.lastFrame!==result.frameId) return;
      this.activeTarget=result.targetId;
      const video=this.container.ownerDocument.createElement('video');
      const sessionId=this.sessionId,targetId=this.activeTarget;
      const media=new VideoSession(video,event=>{
        if(this.media!==media) return;
        const context={sessionId,targetId,timestampUs:this.now()};
        if(event.type==='playbackBlocked') {
          this.failPresentation(this.presentation,'playback-blocked');
          if(this.media!==media) return;
          this.emitBlocked({...context,retry:async()=>{
            const session=this.sessionId,target=this.activeTarget,epoch=this.epoch;
            if(this.media!==media||!this.visible)return;
            this.restartPresentation(media,false);
            // An observer of the new 'loading' may have stopped or switched: then this retry is inert, never a call on a released request.
            if(!this.stillCurrent(media,session,target,epoch)||!this.visible)return;
            await media.resumeFromGesture();
          }});
        }
        else this.failMedia(media,this.presentation,context,event.reason,'media-error');
      });
      this.media=media;
      let lastTimeUpdate=-Infinity;
      const handlers=new Map<string,()=>void>();
      for(const state of ['play','pause','waiting','playing','timeupdate','ended'] as const){
        const listener=()=>{
          if(this.media!==media)return;
          if(state==='timeupdate'){const now=this.now();if(now-lastTimeUpdate<1000000)return;lastTimeUpdate=now;}
          this.emitMediaState(state);
        };
        handlers.set(state,listener);video.addEventListener(state,listener);
      }
      this.mediaListeners=()=>{for(const [name,listener]of handlers)video.removeEventListener(name,listener);};
      media.configure(config);
      this.presentationAllowed=true;
      this.plane=new PerspectiveVideoRenderer(this.container,video,{width:target.widthPx,height:target.heightPx,fit:config.fit});
      if(this.presentationOptions){
        // Decoration must never cost the video: if it cannot be set up, play without it.
        const overlay=new PlanePresentation(this.plane.plane,video,{width:target.widthPx,height:target.heightPx,overlayOpacity:this.presentationOptions.overlayOpacity,now:()=>this.now()/1000,document:this.container.ownerDocument});
        try{this.startPresentation(media,overlay,sessionId as string,targetId as string);}
        catch{this.presentation=null;try{overlay.cancel();overlay.restoreVideo();}catch{/* Nothing more to undo. */}}
      }
    }
    try {
      const corners=result.cornersPx ?? (result.H_imageFromTarget ? [[0,0],[target.widthPx,0],[target.widthPx,target.heightPx],[0,target.heightPx]].map(([x,y])=>project(result.H_imageFromTarget!,x,y)) : null);
      if(!corners){this.hide();return;}
      this.plane!.setGroundTruth(corners,this.options.geometryForResult(result).H_viewportFromStandard);
      if(this.hold){this.cancelHold();this.emitMediaState('hold-recovered');if(this.epoch!==epoch||this.lastFrame!==result.frameId)return;}
      if(!this.presentationAllowed || this.disposed || !this.sessionId || this.mediaFailed){this.plane?.hide();return;}
      if(!this.visible){
        const currentMedia=this.media;
        const currentSession=this.sessionId;
        const currentTarget=this.activeTarget;
        this.visible=true;
        this.startClock(this.presentation);
        this.emitMediaState('shown');
        const unchanged=()=>this.visible && this.presentationAllowed && !this.disposed && this.sessionId===currentSession && this.activeTarget===currentTarget && this.media===currentMedia && currentMedia && !this.mediaFailed && !this.container?.ownerDocument.hidden;
        if(unchanged()){
          if(this.presentation)this.announceLoading(this.presentation);
          if(unchanged())void currentMedia!.play();
        }
      }
    }catch(error){this.hide();throw new EngineError('FRAME_FAILED',true,String(error));}
  }
  private cancelHold():void {
    const hold=this.hold;this.hold=null;
    if(hold?.timer!=null)clearTimeout(hold.timer);
  }
  /**
   * Soft hide after targetLost: the last overlay pose and playback stay for graceMs, then hide and pause (even for hide-only media).
   * Idempotent while holding, so repeated loss notifications never re-time it. Returns false when there is nothing to hold.
   */
  holdAfterLoss(graceMs:number):boolean {
    if(this.disposed||!this.sessionId||typeof graceMs!=='number'||!Number.isFinite(graceMs)||graceMs<=0||graceMs>MAX_LOSS_DISPLAY_GRACE_MS)return false;
    if(this.hold)return true;
    if(!this.visible||!this.media||!this.activeTarget||this.mediaFailed||!this.presentationAllowed||this.container?.ownerDocument.hidden)return false;
    const hold={media:this.media,sessionId:this.sessionId,targetId:this.activeTarget,timer:null as ReturnType<typeof setTimeout>|null};
    this.hold=hold;
    hold.timer=setTimeout(()=>this.expireHold(hold),graceMs);
    this.emitMediaState('held');
    return true;
  }
  private expireHold(hold:LossHold):void {
    // A cleared hold, switched media, new session or new target makes this callback a no-op even if it runs late.
    if(this.hold!==hold||this.media!==hold.media||this.sessionId!==hold.sessionId||this.activeTarget!==hold.targetId)return;
    this.hideInternal(true);
  }
  hide():void {this.hideInternal(false);}
  private hideInternal(forcePause:boolean):void {
    const wasVisible=this.visible,wasHolding=this.hold!==null,pres=this.presentation;
    this.cancelHold();
    this.presentationAllowed=false;
    this.plane?.hide();
    this.pauseClock(pres);
    // Ending a visual grace hold (timer, or any hard clear during it) always pauses, so hide-only media never keeps playing unseen.
    if(this.activeTarget && (forcePause||wasHolding||this.configs.get(this.activeTarget)?.lostBehavior!=='hide')) this.media?.pause();
    this.visible=false;
    if(wasVisible)this.emitMediaState('hidden');
    // A reveal in progress completes at once while hidden: the media is presentable, so reacquisition shows the finished video, not a replay.
    // Last on purpose: observers of 'hidden' may already have released or replaced this request, which the ownership check in onRevealEnd honours.
    if(pres&&pres.phase==='revealing'&&this.presentation===pres&&this.releasingPresentation!==pres)pres.overlay.finish();
  }
  setTargetMedia(targetId:string,config:MediaConfig):void {
    this.assertUsable();
    if(!targetId||!config.url) throw new EngineError('INVALID_CONFIG',false,'Target and media URL required');
    if((config.fit!==undefined&&!['contain','cover'].includes(config.fit))||(config.lostBehavior!==undefined&&!['pause-and-hide','hide'].includes(config.lostBehavior))||(config.resumeBehavior!==undefined&&!['resume','restart'].includes(config.resumeBehavior))||(config.wechatPlaybackRecovery!==undefined&&!['auto','off'].includes(config.wechatPlaybackRecovery))||(config.crossOrigin!==undefined&&config.crossOrigin!==null&&!['anonymous','use-credentials'].includes(config.crossOrigin)))throw new EngineError('INVALID_CONFIG',false,'Invalid media policy');
    if(this.activeTarget===targetId)this.releaseActive();
    const owned=this.ownedUrls.get(targetId);if(owned&&owned!==config.url){URL.revokeObjectURL(owned);this.ownedUrls.delete(targetId);}
    this.configs.set(targetId,{...config});
  }
  setTargetMediaFile(targetId:string,file:Blob,config:Omit<MediaConfig,'url'>={}):void {
    this.assertUsable();const url=URL.createObjectURL(file);
    try{this.setTargetMedia(targetId,{...config,url});this.ownedUrls.set(targetId,url);}catch(error){URL.revokeObjectURL(url);throw error;}
  }
  clearTargetMedia(targetId:string):void {
    this.assertUsable();if(this.activeTarget===targetId)this.releaseActive();this.configs.delete(targetId);
    const url=this.ownedUrls.get(targetId);if(url)URL.revokeObjectURL(url);this.ownedUrls.delete(targetId);
  }
  async setMutedFromGesture(muted:boolean):Promise<boolean> {
    this.assertUsable();if(!this.media||!this.activeTarget)return false;
    const config=this.configs.get(this.activeTarget)!;this.configs.set(this.activeTarget,{...config,muted});this.media.setMuted(muted);
    if(muted)return true;
    if(!this.presentationAllowed||this.mediaFailed||this.container?.ownerDocument.hidden)return false;
    // Same retry-after-blocked-playback rule as the playbackBlocked retry(): a request that failed as blocked starts a new one; anything else is left alone.
    // The 'loading' observer may stop, switch or hide: resume only the exact request captured here, and only if it is still the current one.
    const media=this.media,session=this.sessionId,target=this.activeTarget,epoch=this.epoch;
    this.restartPresentation(media,false);
    if(!this.stillCurrent(media,session,target,epoch)||!this.presentationAllowed||this.mediaFailed||this.container?.ownerDocument.hidden)return false;
    return media.resumeFromGesture();
  }
  /** True while `media` is still the sink's active request for the same session/target and no stop() happened since `epoch` was read. */
  private stillCurrent(media:VideoSession,session:string|null,target:string|null,epoch:number):boolean {
    return !this.disposed&&this.media===media&&this.sessionId===session&&this.activeTarget===target&&this.epoch===epoch;
  }
  async retryActiveMediaFromGesture():Promise<boolean> {
    this.assertUsable();if(!this.media||!this.presentationAllowed||this.container?.ownerDocument.hidden)return false;
    this.mediaFailed=false;this.plane?.show();this.visible=true;
    const media=this.media,retried=media.retryFromGesture();
    // The element was reloaded: a new request, so the old picture is not presentable until a new first frame arrives.
    this.restartPresentation(media,true);
    return retried;
  }
  getMediaDiagnostics() {return {sessionId:this.sessionId,targetId:this.activeTarget,visible:this.visible,holding:this.hold!==null,failed:this.mediaFailed,ownedFileUrls:this.ownedUrls.size,media:this.media?.getDiagnostics()??null,presentation:this.presentation?this.presentationTelemetry(this.presentation):null};}
  /**
   * hide() notifies observers with the old target still active, and they may re-enter stop()/update()/releaseActive().
   * Ownership is claimed before hide(); if the resources changed meanwhile, the re-entrant call already released them
   * (exactly once) and whatever is current now belongs to a newer operation, so nothing more is disposed here.
   */
  private releaseActive(frameId?:number):void {
    const listeners=this.mediaListeners,media=this.media,plane=this.plane,pres=this.presentation;
    const context=media&&this.sessionId?{sessionId:this.sessionId,targetId:this.activeTarget,media}:null;
    this.releasingPresentation=pres;
    try{this.hide();}finally{this.releasingPresentation=null;}
    if(this.media!==media||this.plane!==plane||this.mediaListeners!==listeners)return;
    // An update-initiated release is superseded when an observer accepted a newer frame meanwhile: that frame may reuse these very
    // resources (same target), so identity alone cannot show ownership. Unconditional callers (stop, media replacement) pass no frame.
    if(frameId!==undefined&&this.lastFrame!==frameId)return;
    this.mediaListeners=null;this.media=null;this.plane=null;this.activeTarget=null;this.visible=false;this.mediaFailed=false;this.presentationAllowed=false;this.presentation=null;
    // An unfinished request is reported as cancelled with its own ids: its callbacks already fail the ownership check.
    let cancelled:MediaPresentationTelemetry|null=null;
    if(pres){
      this.pauseClock(pres);
      if(pres.phase==='loading'||pres.phase==='revealing'){pres.phase='cancelled';cancelled=this.presentationTelemetry(pres);}
      pres.overlay.dispose();
    }
    listeners?.();media?.dispose();plane?.dispose();
    if(cancelled&&context)this.emitMediaStateFor(context,'reveal-cancel',cancelled);
  }
  async stop():Promise<void> {
    ++this.epoch;
    // Cancellation is effective before any observer runs: updates submitted from callbacks during this teardown are refused.
    this.stopping++;
    try {
      this.container?.ownerDocument.removeEventListener('visibilitychange',this.onVisibility);this.container?.ownerDocument.defaultView?.removeEventListener('pagehide',this.onPageHide);
      this.releaseActive();
    } finally {
      this.stopping--;
      this.container=null;this.sessionId=null;this.lastFrame=-1;
    }
  }
  async dispose():Promise<void> {if(this.disposed)return;await this.stop();for(const url of this.ownedUrls.values())URL.revokeObjectURL(url);this.ownedUrls.clear();this.eventSinks.clear();this.configs.clear();this.targets.clear();this.disposed=true;}
  private assertUsable():void {if(this.disposed)throw new EngineError('DISPOSED',false,'Renderer disposed');}
}
