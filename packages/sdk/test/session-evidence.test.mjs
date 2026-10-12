import test from 'node:test';
import assert from 'node:assert/strict';
import {createEngine} from '../../../dist/sdk/src/index.js';
import {DiagnosticRecorder} from '../../../dist/sdk/src/diagnostics.js';
import {MockSource,MockPipeline,MockRenderer} from '../../../dist/sdk/src/mock.js';
const target=id=>({schemaVersion:1,compilerVersion:'synthetic',algorithmVersion:'synthetic',targetId:id,imageHash:'0'.repeat(64),widthPx:320,heightPx:240,physicalWidthMeters:null,orientation:'top-left',pyramid:[],features:{points:[],descriptorType:'synthetic',descriptorLength:1,descriptors:[]},preprocessing:{},diagnostics:[]});
function setup(extra={}){const source=new MockSource(),pipeline=new MockPipeline(),renderer=new MockRenderer(),recorder=new DiagnosticRecorder('fixture');const engine=createEngine({source,pipeline,renderer,...extra});for(const name of ['attemptStart','sessionConfig','sessionConfigUpdated','stageTiming','sessionStartFailed','sessionEnded'])engine.on(name,e=>recorder.event(name,e));return {engine,source,pipeline,recorder};}
test('session snapshots retain each target/configuration, copy values and hash full media identity',async()=>{
  const adapter={backendActual:'cpu',geometry:null};const {engine,recorder}=setup({getSessionConfig:()=>adapter,sessionIdPrefix:'instance-'});
  engine.setTrackingMode('absolute');const first=target('one');await engine.loadTargets([first]);
  engine.setTargetMedia('one',{url:'https://example.invalid/private-path?token=SYNTHETIC_SECRET'});
  await engine.start();adapter.backendActual='wasm';first.targetId='mutated';
  await engine.stop('switch');await engine.loadTargets([target('two')]);await engine.start();await engine.stop();await engine.dispose();
  const events=recorder.export().events,snapshots=events.filter(e=>e.type==='sessionConfig');
  assert.deepEqual(snapshots.map(e=>e.config.targets[0].targetId),['one','two']);assert.equal(snapshots[0].config.backendActual,'cpu');
  assert.equal(snapshots[0].config.media[0].identityKind,'url-sha256');assert.match(snapshots[0].config.media[0].identityHash,/^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(recorder.export()).includes('SYNTHETIC_SECRET'),false);assert.equal(JSON.stringify(recorder.export()).includes('private-path'),false);
  assert.deepEqual(events.filter(e=>e.type==='sessionEnded').map(e=>e.sessionId),['instance-session-1','instance-session-2']);
});
test('snapshot records the real display-grace and prediction policy; adapter values cannot override them',async()=>{
  for(const [extra,grace] of [[{lossDisplayGraceMs:500},500],[{},0]]){
    const {engine,recorder}=setup({...extra,getSessionConfig:()=>({maxPredictionMs:900,lossDisplayGraceMs:900})});
    await engine.start();engine.refreshSessionConfig();await engine.stop();await engine.dispose();
    for(const type of ['sessionConfig','sessionConfigUpdated']){const config=recorder.export().events.find(e=>e.type===type).config;assert.equal(config.lossDisplayGraceMs,grace,type);assert.equal(config.maxPredictionMs,100,type);}
  }
});
test('lossDisplayGraceMs accepts only undefined or a finite number in range; null, strings and out-of-range values are rejected',()=>{
  const base={source:new MockSource(),pipeline:new MockPipeline(),renderer:new MockRenderer()};
  for(const bad of [null,'500','0',{},[],true,-1,NaN,Infinity,1001])assert.throws(()=>createEngine({...base,lossDisplayGraceMs:bad}),e=>e.code==='INVALID_CONFIG',String(bad));
  for(const ok of [undefined,0,500,1000])assert.doesNotThrow(()=>createEngine({...base,lossDisplayGraceMs:ok}));
});
test('recorder metadata keeps structured display-grace and prediction values',()=>{
  const recorder=new DiagnosticRecorder('m');recorder.setMetadata({lossDisplayGraceMs:500,maxPredictionMs:100,notes:'text only'});
  const metadata=recorder.export().metadata;assert.equal(metadata.lossDisplayGraceMs,500);assert.equal(metadata.maxPredictionMs,100);
});
test('failed permission attempt retains snapshot, failed stage, error and one end without frames',async()=>{
  let now=1000;const {engine,source,recorder}=setup({nowUs:()=>now});await engine.loadTargets([target('one')]);
  source.start=async()=>{now+=500000;throw new Error('denied');};await assert.rejects(engine.start(),e=>e.code==='START_FAILED');await engine.stop();await engine.dispose();
  const data=recorder.export();assert.equal(data.frames.length,0);assert.equal(data.events.filter(e=>e.type==='sessionEnded').length,1);
  assert.equal(data.events.find(e=>e.type==='sessionConfig').config.inputWidth,null);
  assert.deepEqual(data.events.find(e=>e.type==='sessionStartFailed').attemptTimeUs,500000);
  const stage=data.events.find(e=>e.type==='stageTiming'&&e.stage==='camera-init');assert.equal(stage.durationUs,500000);assert.equal(stage.status,'failed');assert.equal(stage.timestampDomain,'attempt');
});
test('source clock begins after initialization and stage duration uses attempt clock',async()=>{
  let now=0,origin=null;const {engine,source,recorder}=setup({nowUs:()=>now});source.nowSessionUs=()=>origin==null?null:now-origin;
  const start=source.start.bind(source);source.start=async(...args)=>{now+=800000;origin=now;await start(...args);};source.stop=async()=>{origin=null;};
  await engine.start();now+=10000;engine.refreshSessionConfig();await engine.stop();
  const events=recorder.export().events;assert.equal(events.find(e=>e.type==='sessionConfig').timestampDomain,'attempt');assert.equal(events.find(e=>e.type==='stageTiming'&&e.stage==='camera-init').durationUs,800000);
  assert.equal(events.find(e=>e.type==='sessionConfigUpdated').timestampUs,0);assert.equal(events.find(e=>e.type==='sessionConfigUpdated').timestampDomain,'source-session');assert.equal(events.find(e=>e.type==='sessionEnded').timestampUs,10000);
  await engine.dispose();
});
