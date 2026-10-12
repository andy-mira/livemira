import test from 'node:test';
import assert from 'node:assert/strict';
import {captureTargetFrame,describeTargetFrame} from '../../../dist/sdk/src/target-extent.js';
import {createEngine} from '../../../dist/sdk/src/index.js';
import {DiagnosticRecorder} from '../../../dist/sdk/src/diagnostics.js';
import {MockSource,MockPipeline,MockRenderer,mockFrame,mockObservation} from '../../../dist/sdk/src/mock.js';
import {createGeometry,transformPoint} from '../../../dist/camera/src/geometry.mjs';
import {toFrameGeometry} from '../../../dist/camera/src/packet.mjs';
const corners=[[30,80],[120,80],[120,130],[30,130]];
const geometry=(width=720,height=1280)=>toFrameGeometry(createGeometry({width,height,longEdge:320}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-8,`${actual} != ${expected}`);
function frame(session,id,width=720,height=1280){return {...mockFrame(session,id),width,height,arrivalTimeUs:id*1000,imageIdentity:`${session}:${id}`};}
function result(f,state='TRACKING'){
  const value={...mockObservation(f,'bird-01'),state,cornersPx:corners.map(p=>[...p])};
  if(state==='LIMITED'){value.quality={...value.quality,measured:false};value.predictionAgeUs=33000;}
  if(state==='LOST'||state==='SEARCHING'){value.targetId=null;value.cornersPx=null;value.H_imageFromTarget=null;value.quality={...value.quality,measured:false};value.reason='no-valid-original-match';}
  return value;
}
function setup(t,extra={}){
  t.mock.timers.enable({apis:['setTimeout']});
  const source=new MockSource(),pipeline=new MockPipeline(),renderer=new MockRenderer(),recorder=new DiagnosticRecorder('extent-fixture');
  const geo=new Map(),states=new Map();let now=0;
  pipeline.process=async f=>result(f,states.get(f.frameId)??'TRACKING');
  const engine=createEngine({source,pipeline,renderer,nowUs:()=>now,getFrameGeometry:f=>geo.get(f.frameId)??null,...extra});
  engine.on('targetLost',event=>recorder.event('targetLost',event));
  const push=async(id,state='TRACKING',width=720,height=1280)=>{now+=1000;states.set(id,state);geo.set(id,geometry(width,height));source.push(frame(source.sessionId,id,width,height));await tick();};
  t.after(()=>engine.dispose());
  return {engine,source,pipeline,recorder,geo,push,setNow:n=>{now=n;}};
}

test('portrait extent converts processing corners to actual camera pixels, independent of CSS letterboxing',()=>{
  const f=frame('s',1),g=geometry();g.cssWidth=392;g.cssHeight=407;
  const extent=describeTargetFrame(captureTargetFrame(f,result(f),g));
  assert.deepEqual([extent.inputWidth,extent.inputHeight],[720,1280]);
  assert.deepEqual([extent.geometry.standardWidth,extent.geometry.standardHeight],[180,320]);
  assert.deepEqual(extent.boundingBoxInputPx,{x:120,y:320,width:360,height:200});
  assert.deepEqual(extent.cornersInputPx,[[120,320],[480,320],[480,520],[120,520]]);
  assert.equal(extent.widthFraction,.5);assert.equal(extent.edgeWidthInputPx,360);assert.equal(extent.edgeHeightInputPx,200);
  close(extent.areaFraction,360*200/(720*1280));assert.equal(extent.fullyInsideInput,true);
});

test('camera-space extent handles crop, every rotation and mirroring using the inverse frame transform',()=>{
  const input=[[120,90],[360,90],[360,210],[120,210]];
  for(const rotation of [0,90,180,270])for(const mirrored of [false,true]){
    const g=toFrameGeometry(createGeometry({width:1000,height:800,crop:{x:100,y:50,width:600,height:500},rotation,mirrored,longEdge:320}));
    const f=frame('s',1,1000,800),r=result(f);r.cornersPx=input.map(p=>transformPoint(g.H_standardFromInput,...p));
    const e=describeTargetFrame(captureTargetFrame(f,r,g));
    e.cornersInputPx.forEach((p,i)=>p.forEach((v,k)=>close(v,input[i][k])));
    close(e.boundingBoxInputPx.width,240);close(e.boundingBoxInputPx.height,120);
    close(e.widthFraction,.24);close(e.edgeWidthInputPx,240);close(e.edgeHeightInputPx,120);
  }
});

test('missing/singular geometry stays unknown and targets outside the image are not clipped',()=>{
  const f=frame('s',1),r=result(f),g=geometry();
  const missing=describeTargetFrame(captureTargetFrame(f,r,null));
  assert.equal(missing.inputWidth,720);assert.equal(missing.cornersInputPx,null);assert.equal(missing.widthFraction,null);assert.equal(missing.unavailableReason,'frame-geometry-unavailable');
  g.H_standardFromInput=Array(9).fill(0);
  assert.equal(describeTargetFrame(captureTargetFrame(f,r,g)).unavailableReason,'invalid-frame-geometry');
  const outside=result(f);outside.cornersPx=[[-20,80],[200,80],[200,130],[-20,130]];
  const e=describeTargetFrame(captureTargetFrame(f,outside,geometry()));
  close(e.boundingBoxInputPx.width,880);close(e.widthFraction,880/720);assert.equal(e.fullyInsideInput,false);
  assert.equal(describeTargetFrame(captureTargetFrame(f,result(f,'LOST'),geometry())).unavailableReason,'no-target-corners');
});

test('loss retains adjacent predicted frame and earlier reliable frame with their own camera geometry',async t=>{
  const {engine,source,recorder,geo,push}=setup(t);let event;engine.on('targetLost',e=>{event=e;});await engine.start();
  await push(10);geo.get(10).H_standardFromInput[0]=999;
  await push(11,'LIMITED',1440,2560);await push(12,'LOST',1440,2560);
  const loss=recorder.export().events[0].lossContext;
  assert.equal(loss.precedingInputFrameRecorded,true);assert.equal(loss.triggerFrame.frameId,12);assert.equal(loss.triggerFrame.cornersInputPx,null);
  assert.equal(loss.precedingFrame.frameId,11);assert.equal(loss.precedingFrame.measured,false);assert.equal(loss.precedingFrame.predictionAgeUs,33000);
  assert.equal(loss.lastReliableFrame.frameId,10);assert.equal(loss.lastReliableFrame.measured,true);
  assert.deepEqual([loss.lastReliableFrame.inputWidth,loss.precedingFrame.inputWidth,loss.triggerFrame.inputWidth],[720,1440,1440]);
  assert.equal(loss.lastReliableFrame.widthFraction,.5);assert.equal(loss.precedingFrame.widthFraction,.5);
  assert.equal(loss.lastReliableFrame.boundingBoxInputPx.width,360);assert.equal(loss.precedingFrame.boundingBoxInputPx.width,720);
  assert.equal(loss.lastReliableFrame.sourceObservationId,`${source.sessionId}:10`);
  assert.equal(loss.lastReliableFrame.geometry.H_standardFromInput[0],.25);
  assert.equal(JSON.stringify(recorder.export()).includes('imageHandle'),false);
  event.lossContext.lastReliableFrame.boundingBoxInputPx.width=999;
  assert.equal(recorder.export().events[0].lossContext.lastReliableFrame.boundingBoxInputPx.width,360);
});

test('timer loss has no trigger frame, while skipped input IDs are explicitly reported',async t=>{
  const {engine,recorder,push,setNow}=setup(t);await engine.start();await push(1);
  setNow(101000);t.mock.timers.tick(100);
  const timed=recorder.export().events[0].lossContext;
  assert.equal(timed.triggerFrame,null);assert.equal(timed.precedingInputFrameRecorded,null);assert.equal(timed.precedingFrame.frameId,1);
  await push(10);await push(12,'LOST');
  const skipped=recorder.export().events[1].lossContext;
  assert.equal(skipped.precedingInputFrameRecorded,false);assert.equal(skipped.precedingFrame.frameId,10);
});

test('new sessions and changed targets never inherit the earlier target reliable measurement',async t=>{
  const {engine,source,pipeline,recorder,push}=setup(t);await engine.start();await push(1);await engine.stop();
  await engine.start();await push(1,'SEARCHING');await push(2);await push(3,'LOST');
  const second=recorder.export().events[1].lossContext;
  assert.equal(second.lastReliableFrame.sessionId,source.sessionId);assert.equal(second.lastReliableFrame.frameId,2);
  await push(4);
  pipeline.process=async f=>({...result(f),targetId:'bird-03'});await push(5);
  const changed=recorder.export().events[2];
  assert.equal(changed.reason,'target-changed');assert.equal(changed.targetId,'bird-01');
  assert.equal(changed.lossContext.lastReliableFrame.targetId,'bird-01');assert.equal(changed.lossContext.triggerFrame.targetId,'bird-03');
});

test('unavailable adapter geometry does not break recognition or guess a camera-space target size',async t=>{
  const {engine,recorder,push}=setup(t,{getFrameGeometry:()=>{throw new Error('unavailable');}});
  await engine.start();await push(1);await push(2,'LOST');
  const reliable=recorder.export().events[0].lossContext.lastReliableFrame;
  assert.equal(reliable.inputWidth,720);assert.equal(reliable.unavailableReason,'frame-geometry-unavailable');assert.equal(reliable.widthFraction,null);
});
