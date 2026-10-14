/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, safeWorkerReason, resolveCpuFeatureOptions, type CpuFeatureOptions, type FramePacket, type FrameGeometry, type TargetBundle, type VisionPipeline, type VisionWorkerRequest, type VisionWorkerResponse, type RecognitionTrace, type WorkerCapability, type WorkerFrame, type WorkerPipelineOptions, type WorkerPrepareStages, MAX_TRACE_REJECTIONS, MAX_TRACE_TEXT, MAX_TRACE_PASSES } from '@livemira/contracts';
import type { RecognitionBatch } from '../../recognition/src/index.js';
import { createCpuPipeline, PREPARED_GRAY_MAX_EDGE, PREPARED_GRAY_MAX_PIXELS } from './cpu.js';
import { compileGrayTarget, ALGORITHM_VERSION, ORIENTED_ALGORITHM_VERSION, SUPPORTED_ALGORITHM_VERSIONS } from '../../target-compiler/src/index.js';
import { rgbaToGray } from '../../compute/src/reference.mjs';
import { HammingMatcher } from '../../compute/src/hamming-matcher.mjs';
import { createExactMatchingAdapter, createGpuExactMatchingAdapter } from '../../compute/src/exact-matching-adapter.mjs';
import { createWasmPreprocessor } from '../../compute/src/wasm-preprocessor.mjs';
import { selectWasmExactMatcher, createWasmExactMatchingAdapter, type WasmExactMatcher } from '../../compute/src/wasm-exact-matcher.mjs';

function closeFrame(frame: WorkerFrame): void { if(frame.image.kind==='video-frame'||frame.image.kind==='image-bitmap')frame.image.image.close(); }
// Raw source layouts may be large because the geometry downsamples them; the standard (processing) image stays within the recognizer cap.
const RAW_MAX_EDGE=16384,RAW_MAX_PIXELS=16777216,WASM_MAX_PIXELS=1048576,WASM_MAX_BYTES=8*1048576,SCRATCH_CACHE_MAX_BYTES=16*1048576;
type Convert=(data:Uint8Array,width:number,height:number,stride?:number)=>{data:Uint8Array};
interface Surface { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
function openSurface(width:number,height:number,readback:boolean):Surface {
  let canvas:OffscreenCanvas|null=null;
  try{canvas=new OffscreenCanvas(width,height);const ctx=canvas.getContext('2d',readback?{willReadFrequently:true}:undefined);if(ctx)return {canvas,ctx};}catch{/* Reported below. */}
  if(canvas)canvas.width=canvas.height=0;
  throw new EngineError('UNSUPPORTED',true,'No worker canvas');
}
/** Canvases and scratch bytes owned by one worker runtime: resized only when dimensions change, released by dispose(). */
export class FrameCache {
  private input:Surface|null=null;private output:Surface|null=null;private scratch:ArrayBuffer|null=null;
  inputSurface(width:number,height:number):Surface{return this.input=this.fit(this.input,width,height,false);}
  outputSurface(width:number,height:number):Surface{return this.output=this.fit(this.output,width,height,true);}
  private fit(surface:Surface|null,width:number,height:number,readback:boolean):Surface {
    if(!surface)return openSurface(width,height,readback);
    if(surface.canvas.width!==width||surface.canvas.height!==height){surface.canvas.width=width;surface.canvas.height=height;}
    return surface;
  }
  /** Contents are undefined; callers overwrite every byte. Small buffers are reused across frames. */
  bytes(length:number):Uint8ClampedArray<ArrayBuffer> {
    if(length>SCRATCH_CACHE_MAX_BYTES)return new Uint8ClampedArray(length);
    if(!this.scratch||this.scratch.byteLength<length)this.scratch=new ArrayBuffer(length);
    return new Uint8ClampedArray(this.scratch,0,length);
  }
  dispose():void {
    for(const surface of [this.input,this.output])if(surface)surface.canvas.width=surface.canvas.height=0;
    this.input=this.output=this.scratch=null;
  }
}
function checkRawLayout(image:Extract<WorkerFrame['image'],{buffer:ArrayBuffer}>):number {
  const {width,height,strideBytes:stride}=image,channels=image.kind==='gray8'?1:image.kind==='rgba8'?4:0;
  if(!channels||!(image.buffer instanceof ArrayBuffer)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||!Number.isSafeInteger(stride)||stride<width*channels||!Number.isSafeInteger((height-1)*stride+width*channels)||(height-1)*stride+width*channels>image.buffer.byteLength)throw new EngineError('FRAME_FAILED',false,'Invalid worker CPU layout');
  if(width>RAW_MAX_EDGE||height>RAW_MAX_EDGE||width*height>RAW_MAX_PIXELS)throw new EngineError('UNSUPPORTED',false,'Worker source frame exceeds supported size');
  return channels;
}
function checkStandardSize(width:number,height:number):void {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1)throw new EngineError('FRAME_FAILED',false,'Invalid standard image dimensions');
  if(width>PREPARED_GRAY_MAX_EDGE||height>PREPARED_GRAY_MAX_EDGE||width*height>PREPARED_GRAY_MAX_PIXELS)throw new EngineError('UNSUPPORTED',false,'Standard image exceeds processing limit; frames are never silently resized');
}
function checkGeometry(geometry:FrameGeometry):void {
  checkStandardSize(geometry.standardWidth,geometry.standardHeight);
  const h=geometry.H_standardFromInput;
  if(!h||h.length!==9)throw new EngineError('FRAME_FAILED',false,'Invalid frame transform');
  for(let i=0;i<9;i++)if(typeof h[i]!=='number'||!Number.isFinite(h[i]))throw new EngineError('FRAME_FAILED',false,'Invalid frame transform');
  if(h[6]!==0||h[7]!==0||h[8]!==1)throw new EngineError('FRAME_FAILED',false,'Invalid frame transform');
}
/** Draw into the cached output canvas, cleared first so transparent pixels never keep an earlier frame; returns a byte view of its RGBA. */
function drawStandard(cache:FrameCache,source:CanvasImageSource,geometry:FrameGeometry,stages?:WorkerPrepareStages):Uint8Array {
  const began=stages?performance.now():0;
  const width=geometry.standardWidth,height=geometry.standardHeight,h=geometry.H_standardFromInput,out=cache.outputSurface(width,height).ctx;
  try{out.setTransform(1,0,0,1,0,0);out.clearRect(0,0,width,height);out.setTransform(h[0],h[3],h[1],h[4],h[2],h[5]);out.drawImage(source,0,0);}
  finally{out.setTransform(1,0,0,1,0,0);}
  const drawn=stages?performance.now():0;
  const pixels=out.getImageData(0,0,width,height).data;
  if(stages){stages.standardDrawDurationUs+=(drawn-began)*1000;stages.readbackDurationUs+=(performance.now()-drawn)*1000;}
  return new Uint8Array(pixels.buffer,pixels.byteOffset,pixels.byteLength);
}
/** Exported for tests; the runtime is the only production caller. */
export function standardFrame(frame: WorkerFrame, cache: FrameCache, convert: Convert = rgbaToGray, stages?:WorkerPrepareStages): FramePacket {
  const {image,metadata,geometry}=frame;let data:Uint8Array,width:number,height:number;
  if('buffer' in image) {
    const channels=checkRawLayout(image),stride=image.strideBytes,rowBytes=image.width*channels;
    if(!geometry&&(metadata.rotation||metadata.mirrored))throw new EngineError('UNSUPPORTED',true,'Input pixels require geometry');
    if(geometry){
      checkGeometry(geometry);
      if(typeof OffscreenCanvas==='undefined'||typeof ImageData==='undefined')throw new EngineError('UNSUPPORTED',true,'Input pixels require Worker canvas');
      // The transferred buffer is owned by this worker: tight RGBA is viewed in place, other layouts are packed once.
      const packingStarted=stages?performance.now():0;
      let rgba:Uint8ClampedArray<ArrayBuffer>;
      if(channels===4&&stride===rowBytes)rgba=new Uint8ClampedArray(image.buffer,0,rowBytes*image.height);
      else {
        rgba=cache.bytes(image.width*image.height*4);const source=new Uint8Array(image.buffer);
        if(channels===4)for(let y=0;y<image.height;y++)rgba.set(source.subarray(y*stride,y*stride+rowBytes),y*rowBytes);
        else for(let y=0;y<image.height;y++){let from=y*stride,to=y*rowBytes*4;for(let x=0;x<image.width;x++,from++,to+=4){rgba[to]=rgba[to+1]=rgba[to+2]=source[from];rgba[to+3]=255;}}
      }
      const packed=stages?performance.now():0;
      const input=cache.inputSurface(image.width,image.height);input.ctx.putImageData(new ImageData(rgba,image.width,image.height),0,0);
      if(stages){stages.inputPackingDurationUs+=(packed-packingStarted)*1000;stages.inputUploadDurationUs+=(performance.now()-packed)*1000;}
      width=geometry.standardWidth;height=geometry.standardHeight;
      const pixels=drawStandard(cache,input.canvas,geometry,stages),grayStarted=stages?performance.now():0;
      data=convert(pixels,width,height).data;
      if(stages)stages.grayscaleDurationUs+=(performance.now()-grayStarted)*1000;
    } else {
      checkStandardSize(image.width,image.height);width=image.width;height=image.height;
      const grayStarted=stages?performance.now():0;
      if(channels===4)data=convert(new Uint8Array(image.buffer,0,(height-1)*stride+rowBytes),width,height,stride).data;
      else if(stride===rowBytes)data=new Uint8Array(image.buffer,0,width*height);
      else {data=new Uint8Array(width*height);const source=new Uint8Array(image.buffer);for(let y=0;y<height;y++)data.set(source.subarray(y*stride,y*stride+width),y*width);}
      if(stages)stages.grayscaleDurationUs+=(performance.now()-grayStarted)*1000;
    }
  } else {
    if(!geometry||typeof OffscreenCanvas==='undefined')throw new EngineError('UNSUPPORTED',true,'Native frame conversion needs Worker OffscreenCanvas and geometry');
    const source=image.image as VideoFrame&ImageBitmap,sourceWidth=(source as VideoFrame).displayWidth??source.width,sourceHeight=(source as VideoFrame).displayHeight??source.height;
    if(!Number.isSafeInteger(sourceWidth)||!Number.isSafeInteger(sourceHeight)||sourceWidth<1||sourceHeight<1||sourceWidth>RAW_MAX_EDGE||sourceHeight>RAW_MAX_EDGE||sourceWidth*sourceHeight>RAW_MAX_PIXELS)throw new EngineError('UNSUPPORTED',false,'Worker source frame exceeds supported size');
    checkGeometry(geometry);width=geometry.standardWidth;height=geometry.standardHeight;
    const pixels=drawStandard(cache,image.image,geometry,stages),grayStarted=stages?performance.now():0;
    data=convert(pixels,width,height).data;
    if(stages)stages.grayscaleDurationUs+=(performance.now()-grayStarted)*1000;
  }
  return {...metadata,width,height,pixelFormat:'gray8',rotation:0,mirrored:false,imageHandle:{kind:'gray8',data,released:false,release(){}}};
}
/** Plain projection of what the recognizer already computed; bounded, no coordinates. */
function traceOf(batch:RecognitionBatch,frame:{sessionId:string;frameId:number}):RecognitionTrace {
  const d=batch.diagnostics;
  // Stage times and per-pass facts exist only when the recognizer captured them; passes were snapshotted before accumulation, so none is counted twice.
  const optional=d.passes?{stageMs:{featureMs:d.featureMs,retrievalMs:d.retrievalMs,matchMs:d.matchMs,geometryMs:d.geometryMs,totalMs:d.totalMs},
    passes:d.passes.slice(0,MAX_TRACE_PASSES).map(p=>({scale:p.scale,prepareMs:p.prepareMs,featureMs:p.featureMs,retrievalMs:p.retrievalMs,matchMs:p.matchMs,geometryMs:p.geometryMs,totalMs:p.totalMs,featureCount:p.featureCount,candidateCount:p.candidateCount,observationCount:p.observationCount,ambiguous:p.ambiguous,budgetExhausted:p.budgetExhausted,
      rejected:p.rejected.slice(0,MAX_TRACE_REJECTIONS).map(r=>({targetId:r.targetId,reason:r.reason.slice(0,MAX_TRACE_TEXT)}))}))}:{};
  return {sessionId:frame.sessionId,frameId:frame.frameId,algorithmVersion:d.algorithmVersion,featureCount:d.featureCount,candidateCount:d.candidateCount,legacyScalePasses:d.legacyScalePasses,observationCount:batch.observations.length,ambiguous:batch.ambiguous,budgetExhausted:d.budgetExhausted,
    rejected:batch.rejected.slice(0,MAX_TRACE_REJECTIONS).map(r=>({targetId:r.targetId,reason:r.reason.slice(0,MAX_TRACE_TEXT)})),...optional};
}
/** Optional assets an embedding host (for example the single-file build) supplies so the runtime never fetches or imports files. */
export interface VisionWorkerAssets { wasmModuleFactory?: () => Promise<unknown> | unknown; hammingShaderCode?: string }
export function createVisionWorkerRuntime(post: (message: VisionWorkerResponse) => void, makePipeline: typeof createCpuPipeline = createCpuPipeline, assets: VisionWorkerAssets = {}) {
  let busy=false,generation=-1,pipeline:VisionPipeline|null=null,targets:readonly TargetBundle[]=[],options:WorkerPipelineOptions={trackingMode:'absolute',backendPreference:'cpu'};
  let matcher:HammingMatcher|null=null,wasm:Awaited<ReturnType<typeof createWasmPreprocessor>>|null=null,fallbackReason:string|null=null,wasmCapFallback=false,wasmCapAnnounced=false;
  let matchingGeneration:number|undefined;
  let cpuFeatures:Readonly<CpuFeatureOptions>|undefined;
  // Effective CPU matcher: WASM unless 'js' is requested or the GPU matcher owns matching (webgpu keeps its existing behavior).
  let cpuMatchingMode:'js'|'wasm-experimental'='js';
  // WASM matching only: the selected WASM matcher (null keeps the JS matcher), how it was selected, and whether a
  // mid-run failure (WASM disabled, JS from that frame on) still has to be announced with a result.
  let exactWasm:WasmExactMatcher|null=null,exactWasmSelection:{fallbackReason:string|null;attempts:string}|null=null,exactWasmChanged=false;
  const cache=new FrameCache();
  // Only assigned when observeRecognition is on; with it off no batch is ever inspected, copied or retained.
  let trace:RecognitionTrace|null=null;
  const takeTrace=():RecognitionTrace|null=>{const taken=trace;trace=null;return taken;};
  // The optional WASM preprocessor accepts at most 1,048,576 pixels; larger frames fall back to the CPU kernel and the capability says so.
  const convert:Convert=(data,width,height,stride)=>{
    if(wasm){
      if(width*height<=WASM_MAX_PIXELS&&data.length<=WASM_MAX_BYTES)return wasm.rgbaToGray(data,width,height,stride);
      wasmCapFallback=true;
    }
    return rgbaToGray(data,width,height,stride);
  };
  // Any posted capability that includes the WASM size fallback counts as the announcement; the flag survives failed frames until one is posted.
  const capability=():WorkerCapability=>{if(wasmCapFallback)wasmCapAnnounced=true;exactWasmChanged=false;return describe();};
  // Present only when WASM matching is in effect. 'matching' names the operator really used.
  const cpuMatchingFacts=():{operators:Record<string,string>;jsFallback:boolean}|null=>{
    if(cpuMatchingMode!=='wasm-experimental')return null;
    const oriented=(targets[0]?.algorithmVersion??options.algorithmVersion)===ORIENTED_ALGORITHM_VERSION,live=exactWasm?.available===true;
    const reason=oriented?'ORIENTED_V2_USES_JS_MATCHER':exactWasm?.diagnostics.fallbackReason??exactWasmSelection?.fallbackReason??(live?null:'WASM_UNAVAILABLE');
    return {jsFallback:!live,operators:{matching:live&&!oriented?`wasm-${exactWasm!.variant}`:'cpu',cpuMatching:'wasm-experimental',matchingScope:'legacy-family',matchingSelection:exactWasmSelection?.attempts??'none',matchingFallback:reason??'none'}};
  };
  const describe=():WorkerCapability=>{const cpuMatching=cpuMatchingFacts(),algorithmVersion=targets[0]?.algorithmVersion??options.algorithmVersion??ALGORITHM_VERSION;return {execution:'worker',backend:'cpu',algorithmVersion,trackingMode:options.trackingMode,generation,fallbackReason:matcher?.diagnostics.fallbackReason??fallbackReason??(wasmCapFallback?'WASM_PIXEL_LIMIT_CPU_FALLBACK':null)??(cpuMatching?.jsFallback?'WASM_MATCHING_JS_FALLBACK':null),operators:{preprocessing:wasm?(wasmCapFallback?'wasm-scalar+cpu-fallback':'wasm-scalar'):'cpu',...(wasm?{preprocessingLimit:`wasm<=${WASM_MAX_PIXELS}px;cpu-above`}:{}),recognition:'cpu',...(cpuFeatures?.briefOffsets===true&&algorithmVersion!==ORIENTED_ALGORITHM_VERSION?{recognitionFeatures:'cpu-brief-offsets'}:{}),matching:matcher?.diagnostics.backend??'cpu',tracking:'cpu',...cpuMatching?.operators}};};
  return async function handle(message: VisionWorkerRequest):Promise<void> {
    const envelope={protocol:1 as const,requestId:message.requestId,generation:message.generation};
    const error=(code:'RESOURCE_FAILED'|'FRAME_FAILED'|'UNSUPPORTED'='RESOURCE_FAILED')=>post({...envelope,type:'error',code,recoverable:true,reason:'Worker operation failed'});
    if(busy){if(message.type==='frame')closeFrame(message.frame);error();return;}
    if(message.protocol!==1||!Number.isSafeInteger(message.requestId)||!Number.isSafeInteger(message.generation)){if(message.type==='frame')closeFrame(message.frame);error();return;}
    busy=true;
    try {
      if(message.type==='init') {
        if(pipeline)throw new EngineError('INVALID_CONFIG',false,'Worker already initialized');generation=message.generation;options=message.options;
        if(!['absolute','hybrid-experimental','subpixel-experimental'].includes(options.trackingMode)||!['cpu','wasm','webgpu'].includes(options.backendPreference))throw new EngineError('UNSUPPORTED',true,'Requested worker mode not integrated');
        if(options.collectMatchedPoints!==undefined&&typeof options.collectMatchedPoints!=='boolean')throw new EngineError('INVALID_CONFIG',false,'Invalid worker options');
        if(options.observeRecognition!==undefined&&typeof options.observeRecognition!=='boolean')throw new EngineError('INVALID_CONFIG',false,'Invalid worker options');
        if(options.legacyScaleSearch!==undefined&&typeof options.legacyScaleSearch!=='boolean')throw new EngineError('INVALID_CONFIG',false,'Invalid worker options');
        if(options.algorithmVersion!==undefined&&!SUPPORTED_ALGORITHM_VERSIONS.includes(options.algorithmVersion))throw new EngineError('INVALID_CONFIG',false,'Invalid worker options');
        cpuFeatures=resolveCpuFeatureOptions(options.cpuFeatures);
        if(options.cpuMatching!==undefined&&(!['js','wasm-experimental'].includes(options.cpuMatching)||(options.cpuMatching==='wasm-experimental'&&options.backendPreference==='webgpu')))throw new EngineError('INVALID_CONFIG',false,'Invalid worker options');
        cpuMatchingMode=options.cpuMatching==='js'||options.backendPreference==='webgpu'?'js':'wasm-experimental';
        if(cpuMatchingMode==='wasm-experimental'){
          try{const selection=await selectWasmExactMatcher();exactWasm=selection.matcher;exactWasmSelection={fallbackReason:selection.fallbackReason,attempts:selection.attempts.map(a=>`${a.variant}:${a.outcome}`).join(',')};}
          catch{exactWasm=null;exactWasmSelection={fallbackReason:'WASM_INIT_FAILED',attempts:'*:WASM_INIT_FAILED'};}
        }
        if(options.backendPreference==='wasm'){try{wasm=await createWasmPreprocessor({variant:'scalar',...(assets.wasmModuleFactory?{moduleFactory:assets.wasmModuleFactory}:{})});}catch{fallbackReason='WASM_INIT_FAILED';}}
        if(options.backendPreference==='webgpu'){matcher=new HammingMatcher();await matcher.init(assets.hammingShaderCode===undefined?{}:{shaderCode:assets.hammingShaderCode});matchingGeneration=matcher.diagnostics.generation;}
        // This runtime alone produces the gray8 it hands to the pipeline, so only this pipeline may borrow it.
        pipeline=makePipeline({experimentalLocalTracking:options.trackingMode==='hybrid-experimental',experimentalSubpixelTracking:options.trackingMode==='subpixel-experimental',exactMatching:matcher?createExactMatchingAdapter(matcher):undefined,legacyExactMatching:matcher?createGpuExactMatchingAdapter(matcher):exactWasm?createWasmExactMatchingAdapter(exactWasm,{onFailure:()=>{exactWasmChanged=true;}}):undefined,borrowPreparedGray:true,collectMatchedPoints:options.collectMatchedPoints===true,algorithmVersion:options.algorithmVersion,...(options.legacyScaleSearch!==undefined?{legacyScaleSearch:options.legacyScaleSearch}:{}),...(cpuFeatures?{cpuFeatures}:{}),...(options.observeRecognition===true?{onRecognition:(batch,frame)=>{trace=traceOf(batch,frame);}}:{})});post({...envelope,type:'ready',capability:capability()});return;
      }
      if(!pipeline||generation!==message.generation)throw new EngineError('FRAME_FAILED',true,'Stale worker generation');
      if(message.type==='load-targets'){await pipeline.loadTargets(message.targets);targets=message.targets;post({...envelope,type:'ready',capability:capability()});return;}
      if(message.type==='reset'){await pipeline.reset(message.sessionId);matchingGeneration=matcher?.diagnostics.generation;post({...envelope,type:'ready',capability:capability()});return;}
      if(message.type==='dispose'){
        // Every owner is released even when an earlier disposer rejects; the first failure is then reported.
        const owned=pipeline,active=matcher,decoder=wasm,exact=exactWasm;let failure:unknown;
        for(const release of [()=>owned.dispose(),()=>active?.dispose(),()=>decoder?.dispose(),()=>exact?.dispose()])try{await release();}catch(cause){failure??=cause;}
        cache.dispose();matcher=null;wasm=null;exactWasm=null;exactWasmSelection=null;exactWasmChanged=false;fallbackReason=null;wasmCapFallback=false;wasmCapAnnounced=false;pipeline=null;targets=[];trace=null;cpuFeatures=undefined;cpuMatchingMode='js';
        if(failure!==undefined)throw failure instanceof EngineError?failure:new EngineError('RESOURCE_FAILED',true,'Worker disposal failed');
        post({...envelope,type:'ack'});return;
      }
      if(message.type==='compile'){
        // The configured algorithm is the default; an explicit request that contradicts it is a configuration error, never a silent mix.
        const algorithm=message.algorithmVersion??options.algorithmVersion;
        if(options.algorithmVersion!==undefined&&algorithm!==options.algorithmVersion)throw new EngineError('INVALID_CONFIG',false,'Compile algorithm differs from the configured algorithm');
        if(!message.encodedImage.byteLength||message.encodedImage.byteLength>24_000_000||!Number.isInteger(message.maxEdge)||message.maxEdge<32||message.maxEdge>1024||typeof OffscreenCanvas==='undefined'||typeof createImageBitmap==='undefined')throw new EngineError('UNSUPPORTED',true,'Worker image compilation unavailable or over budget');
        const bitmap=await createImageBitmap(new Blob([message.encodedImage]));
        try {
          if(bitmap.width*bitmap.height>33554432)throw new EngineError('INVALID_TARGET',false,'Decoded target exceeds limit');
          const scale=Math.min(1,message.maxEdge/Math.max(bitmap.width,bitmap.height)),width=Math.round(bitmap.width*scale),height=Math.round(bitmap.height*scale),canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new EngineError('UNSUPPORTED',true,'No worker canvas');context.drawImage(bitmap,0,0,width,height);
          const gray=rgbaToGray(new Uint8Array(context.getImageData(0,0,width,height).data),width,height);const target=await compileGrayTarget(gray,{targetId:message.targetId,algorithmVersion:algorithm,...(cpuFeatures?{cpuFeatures}:{})});post({...envelope,type:'compiled',target});
        }finally{bitmap.close();}return;
      }
      if(message.type==='frame'){
        if(matcher&&matchingGeneration!==matcher.diagnostics.generation)throw new EngineError('DEVICE_LOST',true,'Matching device changed; reset required');
        const gpuGeneration=matcher?.diagnostics.generation;
        trace=null;
        const prepareStages:WorkerPrepareStages|undefined=options.observeRecognition===true?{inputPackingDurationUs:0,inputUploadDurationUs:0,standardDrawDurationUs:0,readbackDurationUs:0,grayscaleDurationUs:0}:undefined;
        const started=performance.now(),frame=standardFrame(message.frame,cache,convert,prepareStages),prepared=performance.now();const result=await pipeline.process(frame,new AbortController().signal);const ended=performance.now();
        if(matcher&&matcher.diagnostics.generation!==gpuGeneration){await pipeline.reset(frame.sessionId);throw new EngineError('RESOURCE_FAILED',true,'Matching device changed; restart required');}
        const attached=takeTrace();
        post({...envelope,type:'result',result,timing:{...(prepareStages?{prepareStages}:{}),prepareDurationUs:(prepared-started)*1000,computeDurationUs:(ended-prepared)*1000,totalDurationUs:(ended-started)*1000,copiedBytes:null},...((wasmCapFallback&&!wasmCapAnnounced)||exactWasmChanged?{capability:capability()}:{}),...(attached&&attached.sessionId===result.sessionId&&attached.frameId===result.frameId?{trace:attached}:{})});return;
      }
      error('FRAME_FAILED');
    }catch(cause){post({...envelope,type:'error',code:cause instanceof EngineError?cause.code:'RESOURCE_FAILED',recoverable:true,reason:cause instanceof EngineError?safeWorkerReason(cause.reason):safeWorkerReason(null)});}
    finally{try{if(message.type==='frame')closeFrame(message.frame);}finally{busy=false;}}
  };
}
