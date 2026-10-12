import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../index.mjs';
import {createCpuPipeline} from '../../../dist/sdk/src/cpu.js';
import {ReplayFrameSource} from '../../camera/src/index.mjs';
import {compileGrayTarget} from '../../target-compiler/index.mjs';
import {texture,warp} from '../../../tests/recognition/fixtures.mjs';

test('SDK composes real replay, grayscale, compilation, recognition and tracking with final resource release',async()=>{
  let clock=0,releases=0,session;const results=[],events=[];
  const source=new ReplayFrameSource({nowUs:()=>clock});
  const pipeline=createCpuPipeline();let finish;
  const process=pipeline.process;pipeline.process=async(...args)=>{try{return await process(...args);}finally{finish();}};
  const renderer={async start(){},setTargets(ts){assert.equal(ts.length,1);},setTargetMedia(){},async update(r){results.push(r);},hide(){},async stop(){},async dispose(){}};
  const engine=createEngine({source,pipeline,renderer,nowUs:()=>clock});
  engine.on('ready',e=>session=e.sessionId);for(const name of ['targetFound','targetLost','error'])engine.on(name,()=>events.push(name));
  const image=texture(),target=await compileGrayTarget(image,{targetId:'integrated'});await engine.loadTargets([target]);await engine.start();
  for(let i=0;i<5;i++){
    clock=i*33333;const pixels=warp(image,[1,0,10,0,1,6,0,0,1]);const done=new Promise(resolve=>finish=resolve);
    source.push(session,{image:pixels.data,width:pixels.width,height:pixels.height,pixelFormat:'gray8',sourceTimestampUs:clock,imageIdentity:`frame-${i}`,close:()=>releases++});
    await done;await new Promise(resolve=>setImmediate(resolve));
  }
  assert.ok(results.length>=1);assert.equal(results[0].targetId,'integrated');assert.equal(results[0].poseMetricValid,false);
  assert.ok(Math.abs(results[0].cornersPx[0][0]-10)<3);assert.ok(Math.abs(results[0].cornersPx[0][1]-6)<3);
  await engine.dispose();assert.equal(releases,5);assert.deepEqual(events,['targetFound','targetLost']);
});
