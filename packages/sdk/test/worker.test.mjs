import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerPipeline} from '../../../dist/sdk/src/worker-pipeline.js';
import {DiagnosticRecorder} from '../../../dist/sdk/src/diagnostics.js';
import {createVisionWorkerRuntime} from '../../../dist/sdk/src/worker-runtime.js';
import {prepareWorkerFrame} from '../../camera/src/index.mjs';
import {mockFrame} from '../../../dist/sdk/src/mock.js';
import {compileGrayTarget} from '../../target-compiler/index.mjs';
import {texture} from '../../../tests/recognition/fixtures.mjs';
class Endpoint {
  listeners=new Map();terminated=false;hang=false;posted=[];
  constructor(){this.runtime=createVisionWorkerRuntime(data=>queueMicrotask(()=>this.emit('message',{data})));}
  addEventListener(type,fn){this.listeners.set(type,fn);}removeEventListener(type){this.listeners.delete(type);}
  emit(type,event){this.listeners.get(type)?.(event);}
  postMessage(message,transfer=[]){const clone=structuredClone(message,{transfer});this.posted.push(clone);if(this.hang&&message.type==='frame')return;queueMicrotask(()=>this.runtime(clone));}
  terminate(){this.terminated=true;}
}
test('worker protocol transfers a copy, preserves original and returns actual CPU recognition',async()=>{
  const endpoints=[],pipeline=createWorkerPipeline({prepareFrame:(f,s)=>prepareWorkerFrame(f,null,s),workerFactory:()=>{const e=new Endpoint();endpoints.push(e);return e;}});
  const image=texture();await pipeline.loadTargets([await compileGrayTarget(image,{targetId:'worker'})]);await pipeline.reset('s');let result;
  for(let i=0;i<3;i++){const frame={...mockFrame('s',i+1),width:image.width,height:image.height,mappedObservationTimeUs:i*33333,imageIdentity:`image-${i}`,imageHandle:{kind:'gray8',data:image.data,released:false,release(){throw new Error('Borrowed original');}}};result=await pipeline.process(frame,new AbortController().signal);assert.equal(image.data.byteLength,image.width*image.height);}
  assert.equal(result.state,'TRACKING');assert.equal(result.targetId,'worker');await pipeline.dispose();assert.equal(endpoints[0].terminated,true);
});
test('hard abort terminates active worker; next reset restores targets and ignores obsolete messages',async()=>{
  const endpoints=[],pipeline=createWorkerPipeline({prepareFrame:(f,s)=>prepareWorkerFrame(f,null,s),workerFactory:()=>{const e=new Endpoint();endpoints.push(e);return e;}});
  const target=await compileGrayTarget(texture(),{targetId:'recovery'});await pipeline.loadTargets([target]);await pipeline.reset('old');endpoints[0].hang=true;
  const signal=new AbortController(),frame=mockFrame('old',1);const pending=pipeline.process(frame,signal.signal);await new Promise(r=>setImmediate(r));
  signal.abort();await assert.rejects(pending,e=>e.code==='ABORTED');assert.equal(frame.imageHandle.released,false);assert.equal(endpoints[0].terminated,true);
  await pipeline.reset('new');assert.equal(endpoints.length,2);assert.ok(endpoints[1].posted.some(p=>p.type==='load-targets'));assert.equal(endpoints[1].posted.at(-1).sessionId,'new');await pipeline.dispose();
});
test('worker request budget rejects concurrency, times out and can be reset explicitly',async()=>{
  const endpoints=[],pipeline=createWorkerPipeline({prepareFrame:(f,s)=>prepareWorkerFrame(f,null,s),requestTimeoutMs:100,workerFactory:()=>{const e=new Endpoint();endpoints.push(e);return e;}});
  await pipeline.reset('s');endpoints[0].hang=true;const pending=pipeline.process(mockFrame('s',1),new AbortController().signal);
  await assert.rejects(pipeline.process(mockFrame('s',2),new AbortController().signal),e=>e.code==='RESOURCE_FAILED');await assert.rejects(pending,/timed out/);assert.equal(endpoints[0].terminated,true);await pipeline.reset('new');await pipeline.dispose();
});
test('diagnostic ring preserves null timings, bounds records and excludes callbacks/URLs/handles',()=>{
  const recorder=new DiagnosticRecorder('test','worker',2);recorder.setMetadata({clockDomain:'source-session',url:'https://private.invalid/?token=secret'});
  for(let i=0;i<3;i++)recorder.frame({sessionId:'s',frameId:i,targetId:null,cpuSubmitTimeUs:null,gpuCompleteTimeUs:null,resultAvailableTimeUs:null,renderSubmitTimeUs:null,visibleTimeUs:null,imageHandle:{}});
  const exported=recorder.export();assert.equal(exported.frames.length,2);assert.equal(exported.frames[0].frameId,1);assert.equal(exported.eventLogComplete,false);assert.equal(exported.droppedRecords,1);assert.equal(exported.frames[0].visibleTimeUs,null);assert.ok(!JSON.stringify(exported).includes('secret'));assert.ok(!JSON.stringify(exported).includes('imageHandle'));
});
test('pipeline announces a WASM size fallback once through onCapability before the result resolves, and surfaces only safe size reasons',async t=>{
  const caps=[],order=[],pipeline=createWorkerPipeline({options:{backendPreference:'wasm'},prepareFrame:(f,s)=>prepareWorkerFrame(f,null,s),onCapability:c=>{caps.push(c);order.push('capability');},workerFactory:()=>new Endpoint()});
  await pipeline.loadTargets([await compileGrayTarget(texture(),{targetId:'cap'})]);await pipeline.reset('s');
  if(caps.at(-1).fallbackReason==='WASM_INIT_FAILED'){await pipeline.dispose();return t.skip('WASM unavailable');}
  const frame=(i,w,h,kind='rgba8',scale=4)=>({...mockFrame('s',i),width:w,height:h,pixelFormat:kind,mappedObservationTimeUs:i*33333,imageIdentity:`cap-${i}`,imageHandle:{kind,data:new Uint8Array(w*h*scale).fill(90),released:false,release(){}}});
  const baseline=caps.length,seen=[];
  for(const [i,w,h] of [[1,1024,1024],[2,1024,1024],[3,1025,1024],[4,1025,1024],[5,1024,1024]]){await pipeline.process(frame(i,w,h),new AbortController().signal);order.push(`result-${i}`);seen.push(caps.length-baseline);}
  assert.deepEqual(seen,[0,0,1,1,1],'announced on the first large frame only, never per frame');
  assert.deepEqual(order.slice(order.indexOf('result-2')+1,order.indexOf('result-3')+1),['capability','result-3'],'observer runs before the result is delivered');
  assert.equal(caps.at(-1).fallbackReason,'WASM_PIXEL_LIMIT_CPU_FALLBACK');
  await assert.rejects(pipeline.process(frame(6,4097,1,'gray8',1),new AbortController().signal),e=>e.code==='UNSUPPORTED'&&/Standard image exceeds processing limit/.test(e.reason));
  await pipeline.dispose();
});
