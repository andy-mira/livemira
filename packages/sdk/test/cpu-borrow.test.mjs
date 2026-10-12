import test from 'node:test';
import assert from 'node:assert/strict';
import {createCpuPipeline} from '../../../dist/sdk/src/cpu.js';
import {mockFrame} from '../../../dist/sdk/src/mock.js';
import {compileGrayTarget} from '../../target-compiler/index.mjs';
import {texture} from '../../../tests/recognition/fixtures.mjs';

// The copying path (buildPyramid) reads one row at a time with subarray; the borrowing path never does. Counting those calls
// on the exact array handed to the pipeline separates "copied" from "borrowed" without touching pipeline internals.
class SpyBytes extends Uint8Array {
  static subarrays=0;
  subarray(...args){SpyBytes.subarrays++;return super.subarray(...args);}
}
const image=texture(),signal=()=>new AbortController().signal;
const gray=(id,data=new SpyBytes(image.data),extra={})=>({...mockFrame('s',id),width:image.width,height:image.height,pixelFormat:'gray8',mappedObservationTimeUs:id*33333,imageIdentity:`image-${id}`,imageHandle:{kind:'gray8',data,released:false,release(){throw new Error('Pipeline must not release the frame');}},...extra});
async function ready(options){const pipeline=createCpuPipeline(options);await pipeline.loadTargets([await compileGrayTarget(image,{targetId:'borrow'})]);await pipeline.reset('s');return pipeline;}
async function run(options,make=gray){
  const pipeline=await ready(options);let result;SpyBytes.subarrays=0;
  for(let i=1;i<=3;i++)result=await pipeline.process(make(i),signal());
  await pipeline.dispose();return {result,subarrays:SpyBytes.subarrays};
}

test('default pipeline always copies, even when a frame claims to be private Worker output',async()=>{
  const plain=await run({}),spoofed=await run({},id=>gray(id,undefined,{isPrivateWorkerStandardFrame:true}));
  assert.ok(plain.subarrays>=image.height*3,'one row copy per frame');
  assert.equal(spoofed.subarrays,plain.subarrays);assert.equal(spoofed.result.state,'TRACKING');
  const flagged=await run({borrowPreparedGray:false},id=>gray(id,undefined,{isPrivateWorkerStandardFrame:true}));assert.equal(flagged.subarrays,plain.subarrays);
});

test('borrowPreparedGray skips the redundant copy, leaves the bytes alone and returns the same recognition result',async()=>{
  const copied=await run({}),borrowed=await run({borrowPreparedGray:true});
  assert.ok(borrowed.subarrays<image.height,'no per-row copy');
  assert.equal(borrowed.result.state,'TRACKING');assert.equal(borrowed.result.targetId,'borrow');
  assert.deepEqual(borrowed.result.cornersPx,copied.result.cornersPx);assert.deepEqual(borrowed.result.H_imageFromTarget,copied.result.H_imageFromTarget);
  const data=new SpyBytes(image.data),before=data.slice(),pipeline=await ready({borrowPreparedGray:true});
  await pipeline.process(gray(1,data),signal());assert.deepEqual(data,before);assert.equal(data.buffer.byteLength,before.length);assert.equal(data.length,before.length);
  await pipeline.dispose();
});

test('borrowing keeps strict checks: abort, release, identity, orientation, format, byte layout and recognizer cap',async()=>{
  const pipeline=await ready({borrowPreparedGray:true}),bad=(frame,check,s=signal())=>assert.rejects(pipeline.process(frame,s),check);
  const aborted=new AbortController();aborted.abort();
  await bad(gray(1),e=>e.name==='AbortError',aborted.signal);
  // Abort raised while canonicalizing, after the first check passed.
  const late=new AbortController(),aborting=await ready({borrowPreparedGray:true,canonicalize:async frame=>{late.abort();return frame;}});
  await assert.rejects(aborting.process(gray(1),late.signal),e=>e.name==='AbortError');await aborting.dispose();
  await bad(gray(2,undefined,{imageHandle:{kind:'gray8',data:new SpyBytes(image.data),released:true,release(){}}}),e=>e instanceof RangeError&&/released/.test(e.message));
  await bad(gray(3,undefined,{sessionId:''}),e=>e instanceof RangeError&&/identity/.test(e.message));
  await bad(gray(4,undefined,{frameId:-1}),e=>e instanceof RangeError&&/identity/.test(e.message));
  await bad(gray(5,undefined,{frameId:1.5}),e=>e instanceof RangeError&&/identity/.test(e.message));
  await bad(gray(6,undefined,{rotation:90}),e=>e instanceof RangeError&&/orientation/.test(e.message));
  await bad(gray(7,undefined,{mirrored:true}),e=>e instanceof RangeError&&/orientation/.test(e.message));
  // Canonicalization may not swap in another frame's identity.
  const swapped=await ready({borrowPreparedGray:true,canonicalize:async frame=>({...frame,frameId:frame.frameId+1})});
  await assert.rejects(swapped.process(gray(8),signal()),e=>e instanceof RangeError&&/identity/.test(e.message));await swapped.dispose();
  // Anything that is not a packed gray8 Uint8Array of exact length goes to the validating copy path, which rejects it.
  await bad(gray(9,undefined,{imageHandle:{kind:'rgba8',data:new SpyBytes(image.data),released:false,release(){}}}),e=>e instanceof RangeError&&/format/.test(e.message));
  await bad(gray(10,new Uint8ClampedArray(image.data)),e=>e instanceof RangeError);
  await bad(gray(11,new SpyBytes(image.data.subarray(0,image.data.length-1))),e=>e instanceof RangeError);
  // Recognizer cap: 4096 per edge and 4,194,304 pixels, reported explicitly instead of silently resized.
  await bad(gray(12,new SpyBytes(4097),{width:4097,height:1}),e=>e.code==='UNSUPPORTED');
  await bad(gray(13,new SpyBytes(2049*2049),{width:2049,height:2049}),e=>e.code==='UNSUPPORTED');
  await bad(gray(14,new SpyBytes(0),{width:0,height:5}),e=>e.code==='UNSUPPORTED');
  await pipeline.dispose();
});
