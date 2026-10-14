/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const MATCHING_VERSION = 'hamming32-mutual-ratio075-max64/1';
const NONE = 0xffffffff;
function descriptors(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length % 32 || bytes.length > 512*32) throw new RangeError('Expected at most 512 packed 32-byte descriptors');
  return bytes.length / 32;
}
function abort(signal) { if(signal?.aborted) throw Object.assign(new Error('Matching aborted'),{code:'ABORTED'}); }
function pack(bytes) {
  const words = new Uint32Array(bytes.length/4);
  for(let i=0;i<words.length;i++)words[i]=(bytes[4*i]|bytes[4*i+1]<<8|bytes[4*i+2]<<16|bytes[4*i+3]<<24)>>>0;
  return words;
}
function popcount(v) { v-= (v>>>1)&0x55555555;v=(v&0x33333333)+((v>>>2)&0x33333333);return (((v+(v>>>4))&0x0f0f0f0f)*0x01010101)>>>24; }
function pairsFromResults(data,n,m) {
  const pairs=[];
  for(let t=0;t<n;t++) {
    const f=data[t*4],best=data[t*4+1],second=data[t*4+2];
    if(f<m && best<=64 && 4*best<3*second && data[(n+f)*4]===t) pairs.push({targetIndex:t,frameIndex:f,distance:best});
  }
  return pairs;
}
export function matchHamming32(target,frame) {
  const n=descriptors(target),m=descriptors(frame);
  if(!n || !m)return [];
  const a=pack(target),b=pack(frame),out=new Uint32Array((n+m)*4);
  for(let f=0;f<m;f++){out[(n+f)*4]=NONE;out[(n+f)*4+1]=257;}
  for(let t=0;t<n;t++) {
    let index=NONE,best=257,second=257;
    for(let f=0;f<m;f++) {
      let d=0;for(let w=0;w<8;w++)d+=popcount(a[t*8+w]^b[f*8+w]);
      if(d<best){second=best;best=d;index=f;}else if(d<second)second=d;
      const r=(n+f)*4;
      if(d<out[r+1]){out[r]=t;out[r+1]=d;}else if(d===out[r+1])out[r]=NONE;
    }
    out.set([index,best,second,0],t*4);
  }
  return pairsFromResults(out,n,m);
}

/** Worker-safe exact matcher. GPU targets persist; a batch of up to ten of them shares one frame upload and one submission, and only the
 * per-descriptor result reductions are read back. */
export class HammingMatcher {
  #device=null; #pipeline=null; #targets=new Map(); #active=null; #disposed=false;
  #generation=1; #fallbackReason=null; #listeners=new Set();
  get diagnostics(){return {matchingVersion:MATCHING_VERSION,backend:this.#device?'webgpu':'cpu',generation:this.#generation,fallbackReason:this.#fallbackReason,targetCount:this.#targets.size};}
  onCapabilityChanged(listener){this.#listeners.add(listener);return()=>this.#listeners.delete(listener);}
  #disable(reason){
    const device=this.#device;this.#device=null;this.#pipeline=null;this.#generation++;this.#fallbackReason=reason;
    for(const t of this.#targets.values()){t.buffer?.destroy();t.buffer=null;}
    device?.destroy();
    for(const listener of this.#listeners){try{listener(this.diagnostics);}catch{/* Diagnostics cannot prevent cleanup. */}}
  }
  async init(options={}){
    if(this.#disposed||this.#active)throw new Error('Matcher not idle');
    const job=this.#initialize(options);this.#active=job;
    try{return await job;}finally{this.#active=null;}
  }
  async #initialize({gpu=globalThis.navigator?.gpu,shaderCode,signal}={}){
    if(this.#disposed)throw new Error('Matcher disposed');abort(signal);
    if(this.#device || this.#active || this.#targets.size)throw new Error('Initialize once before targets');
    if(!gpu){this.#fallbackReason='WEBGPU_UNAVAILABLE';return this.diagnostics;}
    let device;
    try {
      const adapter=await gpu.requestAdapter();abort(signal);if(this.#disposed)throw new Error('Matcher disposed');
      if(!adapter){this.#fallbackReason='NO_ADAPTER';return this.diagnostics;}
      device=await adapter.requestDevice();abort(signal);
      const code=shaderCode ?? await fetch(new URL('../shaders/hamming.wgsl',import.meta.url)).then(r=>{if(!r.ok)throw new Error('Shader unavailable');return r.text();});
      device.pushErrorScope('validation');
      let pipeline;
      try{pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code}),entryPoint:'main'}});}
      finally{const error=await device.popErrorScope();if(error)throw new Error('Shader validation failed');}
      abort(signal);if(this.#disposed)throw new Error('Matcher disposed');
      this.#device=device;this.#pipeline=pipeline;
      device.lost.then(()=>{if(this.#device===device)this.#disable('DEVICE_LOST');});
      return this.diagnostics;
    }catch(error){device?.destroy();if(signal?.aborted){abort(signal);}if(this.#disposed)throw new Error('Matcher disposed');this.#fallbackReason='GPU_INIT_FAILED';return this.diagnostics;}
  }
  setTargets(targets){
    if(this.#disposed || this.#active)throw new Error('Matcher not idle');
    if(!Array.isArray(targets)||targets.length>10||new Set(targets.map(t=>t.id)).size!==targets.length)throw new RangeError('Expected at most ten unique targets');
    const next=new Map();
    try{
      for(const t of targets){if(typeof t.id!=='string'||!t.id||t.id.length>256)throw new RangeError('Invalid target ID');const n=descriptors(t.descriptors);next.set(t.id,{data:t.descriptors.slice(),count:n,buffer:null});}
      if(this.#device)for(const t of next.values())if(t.count){t.buffer=this.#device.createBuffer({size:t.data.length,usage:128|8});this.#device.queue.writeBuffer(t.buffer,0,pack(t.data));}
    }catch(error){for(const t of next.values())t.buffer?.destroy();throw error;}
    for(const t of this.#targets.values())t.buffer?.destroy();this.#targets=next;
  }
  async matchBatch(targetIds,frame,signal){
    if(this.#disposed)throw new Error('Matcher disposed');abort(signal);
    if(this.#active)throw new Error('One matching batch at a time');
    if(!Array.isArray(targetIds)||targetIds.length>10||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>!this.#targets.has(id)))throw new RangeError('Expected at most ten loaded targets');
    descriptors(frame);const start=performance.now(),owned=frame.slice(),ids=[...targetIds];
    const cpu=()=>ids.map(targetId=>({targetId,pairs:matchHamming32(this.#targets.get(targetId).data,owned)}));
    const job=Promise.resolve().then(async()=>{
      abort(signal);if(this.#disposed)throw new Error('Matcher disposed');
      if(this.#device){
        try{return await this.#gpuBatch(ids,owned,signal,start);}
        catch(error){abort(signal);if(this.#disposed)throw error;this.#disable('GPU_EXECUTION_FAILED');}
      }
      const matches=cpu();abort(signal);
      return {backend:'cpu',matchingVersion:MATCHING_VERSION,matches,timing:{totalMs:performance.now()-start,uploadSubmitMs:null,gpuCompleteMs:null,readbackMs:null},fallbackReason:this.#fallbackReason};
    });
    this.#active=job;
    try{const result=await job;if(this.#disposed)throw new Error('Matcher disposed');result.timing.totalMs=performance.now()-start;return result;}finally{this.#active=null;}
  }
  async #gpuBatch(ids,frame,signal,start){
    const device=this.#device,pipeline=this.#pipeline,generation=this.#generation,m=frame.length/32,buffers=[],jobs=[];
    const allocate=(size,usage)=>{const b=device.createBuffer({size:Math.max(4,size),usage});buffers.push(b);return b;};
    device.pushErrorScope('out-of-memory');device.pushErrorScope('validation');
    try{
      const uploadStart=performance.now(),fb=allocate(frame.length,128|8);if(frame.length)device.queue.writeBuffer(fb,0,pack(frame));
      const encoder=device.createCommandEncoder();
      for(const targetId of ids){
        const target=this.#targets.get(targetId),n=target.count;
        if(!n||!m){jobs.push({targetId,n,readback:null});continue;}
        const size=(n+m)*16,output=allocate(size,128|4),readback=allocate(size,1|8),params=allocate(16,64|8);
        device.queue.writeBuffer(params,0,Uint32Array.of(n,m,0,0));
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:target.buffer}},{binding:1,resource:{buffer:fb}},{binding:2,resource:{buffer:output}},{binding:3,resource:{buffer:params}}]});
        const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil((n+m)/64));pass.end();
        encoder.copyBufferToBuffer(output,0,readback,0,size);jobs.push({targetId,n,readback});
      }
      device.queue.submit([encoder.finish()]);const submitted=performance.now();
      await device.queue.onSubmittedWorkDone();const complete=performance.now();
      const maps=await Promise.allSettled(jobs.filter(j=>j.readback).map(j=>j.readback.mapAsync(1)));
      if(maps.some(r=>r.status==='rejected'))throw new Error('Readback failed');
      abort(signal);if(this.#disposed||this.#device!==device||this.#generation!==generation)throw new Error('GPU generation invalidated');
      const matches=jobs.map(j=>({targetId:j.targetId,pairs:j.readback?pairsFromResults(new Uint32Array(j.readback.getMappedRange()),j.n,m):[]}));
      for(const j of jobs)j.readback?.unmap();
      return {backend:'webgpu',matchingVersion:MATCHING_VERSION,matches,timing:{totalMs:performance.now()-start,uploadSubmitMs:submitted-uploadStart,gpuCompleteMs:complete-submitted,readbackMs:performance.now()-complete},fallbackReason:null};
    }finally{
      for(const b of buffers)b.destroy();
      const validation=await device.popErrorScope(),oom=await device.popErrorScope();
      if(validation||oom)throw new Error('GPU validation or allocation failure');
    }
  }
  /** Invalidates GPU generation; next/active non-aborted batch returns exact CPU results. */
  invalidateGpu(){if(this.#device)this.#disable('DEVICE_INVALIDATED');}
  async dispose(){this.#disposed=true;try{await this.#active;}catch{}this.#disable('DISPOSED');this.#targets.clear();this.#listeners.clear();}
}
