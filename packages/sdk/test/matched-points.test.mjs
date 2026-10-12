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
  listeners=new Map();terminated=false;posted=[];
  constructor(tamper){this.runtime=createVisionWorkerRuntime(data=>queueMicrotask(()=>this.emit('message',{data:tamper&&data.type==='result'?tamper(structuredClone(data)):data})));}
  addEventListener(type,fn){this.listeners.set(type,fn);}removeEventListener(type){this.listeners.delete(type);}
  emit(type,event){this.listeners.get(type)?.(event);}
  postMessage(message,transfer=[]){const clone=structuredClone(message,{transfer});this.posted.push(clone);queueMicrotask(()=>this.runtime(clone));}
  terminate(){this.terminated=true;}
}
async function track(options,tamper){
  const image=texture(),endpoints=[],pipeline=createWorkerPipeline({options,prepareFrame:(f,s)=>prepareWorkerFrame(f,null,s),workerFactory:()=>{const e=new Endpoint(tamper);endpoints.push(e);return e;}});
  await pipeline.loadTargets([await compileGrayTarget(image,{targetId:'worker'})]);await pipeline.reset('s');let result;
  for(let i=0;i<3;i++){const frame={...mockFrame('s',i+1),width:image.width,height:image.height,mappedObservationTimeUs:i*33333,imageIdentity:`image-${i}`,imageHandle:{kind:'gray8',data:image.data,released:false,release(){}}};result=await pipeline.process(frame,new AbortController().signal);}
  await pipeline.dispose();return {result,endpoints};
}
test('worker default: no matchedPoints crosses the boundary; option true: current inlier points arrive for the same frame',async()=>{
  const off=await track({});assert.equal(off.result.state,'TRACKING');assert.equal('matchedPoints' in off.result,false);
  assert.equal(off.endpoints[0].posted.find(p=>p.type==='init').options.collectMatchedPoints,undefined);
  const on=await track({collectMatchedPoints:true});
  assert.equal(on.endpoints[0].posted.find(p=>p.type==='init').options.collectMatchedPoints,true);
  const m=on.result.matchedPoints;assert.ok(m);assert.equal(m.frameId,on.result.frameId);assert.equal(m.sessionId,'s');assert.equal(m.targetId,'worker');assert.equal(m.pointsPx.length,on.result.quality.inlierCount);
});
test('main side never trusts the Worker: points are stripped when not requested or when they describe another frame/target',async()=>{
  const forged=data=>{data.result.matchedPoints={sessionId:'s',frameId:data.result.frameId,targetId:'worker',origin:'original-target',pointsPx:[[1,1]]};return data;};
  assert.equal('matchedPoints' in (await track({},forged)).result,false);
  const wrongFrame=data=>{data.result.matchedPoints={sessionId:'s',frameId:data.result.frameId+1,targetId:'worker',origin:'original-target',pointsPx:[[1,1]]};return data;};
  assert.equal('matchedPoints' in (await track({collectMatchedPoints:true},wrongFrame)).result,false);
  const nonFinite=data=>{if(data.result.matchedPoints)data.result.matchedPoints.pointsPx[0]=[Infinity,1];return data;};
  assert.equal('matchedPoints' in (await track({collectMatchedPoints:true},nonFinite)).result,false);
});
test('invalid collectMatchedPoints is rejected before a Worker exists and by the Worker runtime',async()=>{
  for(const bad of ['yes',1,null])assert.throws(()=>createWorkerPipeline({options:{collectMatchedPoints:bad},prepareFrame:()=>{},workerFactory:()=>{throw new Error('no worker');}}),e=>e.code==='INVALID_CONFIG');
  const out=[];const run=createVisionWorkerRuntime(m=>out.push(m));
  await run({protocol:1,requestId:1,generation:1,type:'init',options:{trackingMode:'absolute',backendPreference:'cpu',collectMatchedPoints:'yes'}});
  assert.equal(out[0].type,'error');assert.equal(out[0].code,'INVALID_CONFIG');
});
test('DiagnosticRecorder never retains the points: per-frame numeric logs stay bounded',()=>{
  const recorder=new DiagnosticRecorder('t','worker',4);
  const result={sessionId:'s',frameId:1,observationTimeUs:1,targetId:'a',state:'TRACKING',H_imageFromTarget:null,cornersPx:null,T_cameraFromTarget:null,poseMetricValid:false,quality:{inlierCount:2,inlierRatio:1,reprojectionErrorPx:0,spatialCoverage:1,degenerate:false,measured:true},predictionAgeUs:0,reason:'r',matchedPoints:{sessionId:'s',frameId:1,targetId:'a',origin:'original-target',pointsPx:Array.from({length:512},(_,i)=>[i,i])}};
  recorder.result(result);
  assert.ok(result.matchedPoints,'caller object is not mutated');
  const exported=recorder.export();assert.equal(exported.results.length,1);assert.equal('matchedPoints' in exported.results[0],false);
  assert.ok(!JSON.stringify(exported).includes('pointsPx'));assert.equal(exported.results[0].quality.inlierCount,2);
});
