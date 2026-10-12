import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../index.mjs';
import { MockSource, MockPipeline, MockRenderer, mockFrame, mockObservation } from '../../../dist/sdk/src/mock.js';
const tick = () => new Promise(resolve=>setImmediate(resolve));
const setup = (pipeline = new MockPipeline(), extra={}) => {
  const source = new MockSource(), renderer = new MockRenderer();
  const engine=createEngine({source,pipeline,renderer,...extra});
  return {source,renderer,engine};
};
test('ready/found/update/lost edges; duplicate frames; repeated lifecycle; unsubscribe', async()=>{
  const {source,renderer,engine}=setup(); const events=[];
  for (const type of ['ready','targetFound','targetUpdated','targetLost']) engine.on(type,()=>events.push(type));
  const off=engine.on('ready',()=>{throw new Error('listener isolation');});
  await Promise.all([engine.start(),engine.start()]); off();
  let released=0;
  source.push(mockFrame(source.sessionId,1,()=>released++)); await tick();
  source.push(mockFrame(source.sessionId,1,()=>released++)); await tick();
  source.push(mockFrame(source.sessionId,2,()=>released++)); await tick();
  await engine.stop(); await engine.stop();
  assert.deepEqual(events,['ready','targetFound','targetUpdated','targetUpdated','targetLost']);
  assert.equal(released,3); assert.equal(renderer.visible,false);
  await engine.start(); assert.equal(source.sessionId,'session-2'); await engine.dispose(); await engine.dispose();
  assert.throws(()=>engine.start(),/disposed/);
});
test('one processing plus latest candidate; stop waits borrowed frame and rejects stale result', async()=>{
  let finish; const pipeline=new MockPipeline(); pipeline.process=frame=>new Promise(resolve=>{finish=()=>resolve(mockObservation(frame));});
  const {source,renderer,engine}=setup(pipeline); await engine.start();
  const a=mockFrame(source.sessionId,1),b=mockFrame(source.sessionId,2),c=mockFrame(source.sessionId,3);
  source.push(a); source.push(b); source.push(c);
  assert.equal(a.imageHandle.released,false); assert.equal(b.imageHandle.released,true); assert.equal(c.imageHandle.released,false);
  const stopped=engine.stop(); await tick();
  assert.equal(a.imageHandle.released,false); assert.equal(c.imageHandle.released,true);
  finish(); await stopped; assert.equal(a.imageHandle.released,true); assert.equal(renderer.updates.length,0);
  await engine.start(); const stale=mockFrame('session-1',100); source.push(stale); assert.equal(stale.imageHandle.released,true); await engine.dispose();
});
test('prediction overlay expires without incoming frames and lost is emitted once',async()=>{
  const {source,renderer,engine}=setup(undefined,{maxPredictionMs:10}); let lost=0; engine.on('targetLost',()=>lost++);
  await engine.start(); source.push(mockFrame(source.sessionId,1)); await tick(); assert.equal(renderer.visible,true);
  await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(renderer.visible,false); assert.equal(lost,1);
  await engine.dispose(); assert.equal(lost,1);
});
test('processing failure releases image and emits recoverable error',async()=>{
  const pipeline=new MockPipeline(); pipeline.process=async()=>{throw new Error('compute rejected');};
  const {source,engine}=setup(pipeline); const errors=[];engine.on('error',e=>errors.push(e.error));await engine.start();
  const frame=mockFrame(source.sessionId,1);source.push(frame);await tick();
  assert.equal(frame.imageHandle.released,true);assert.equal(errors[0].code,'FRAME_FAILED');await engine.dispose();
});
test('partial startup failure is cleaned and retry creates new session',async()=>{
  const {source,engine,renderer}=setup();let stops=0;
  renderer.stop=async()=>{stops++;};const original=source.start.bind(source);
  source.start=async()=>{throw new Error('permission denied');};
  await assert.rejects(engine.start(),e=>e.code==='START_FAILED');assert.equal(stops,1);
  source.start=original;await engine.start();assert.equal(source.sessionId,'session-2');await engine.dispose();
});
test('start and immediate stop quiesce the source',async()=>{
  const {source,engine}=setup();await Promise.all([engine.start(),engine.stop()]);assert.equal(source.callback,null);await engine.dispose();
});
test('stale measured computation does not acquire and duplicate identity is not a new observation',async()=>{
  let now=0, finish;const pipeline=new MockPipeline();pipeline.process=frame=>new Promise(resolve=>{finish=()=>resolve(mockObservation(frame));});
  const {source,renderer,engine}=setup(pipeline,{nowUs:()=>now});await engine.start();
  const first=mockFrame(source.sessionId,1);first.imageIdentity='same';source.push(first);
  const duplicate=mockFrame(source.sessionId,2);duplicate.imageIdentity='same';source.push(duplicate);assert.equal(duplicate.imageHandle.released,true);
  now=100001;finish();await tick();assert.equal(renderer.updates.length,0);await engine.dispose();
});
test('all disposers run even with synchronous failure and public errors exclude adapter payloads',async()=>{
  const {source,engine,renderer}=setup();const events=[];engine.on('error',e=>events.push(e));
  source.start=async()=>{throw new Error('https://example.invalid/?token=PRIVATE_SYNTHETIC');};
  await assert.rejects(engine.start(),e=>!e.message.includes('PRIVATE_SYNTHETIC'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SYNTHETIC'));
  let rendererDisposed=false;source.dispose=()=>{throw new Error('PRIVATE_SYNTHETIC');};renderer.dispose=async()=>{rendererDisposed=true;};
  await assert.rejects(engine.dispose(),e=>!e.message.includes('PRIVATE_SYNTHETIC'));assert.equal(rendererDisposed,true);await engine.dispose();
});
test('diagnostics and events share source session clock and never invent GPU or visible completion',async()=>{
  let now=500000;const records=[];const pipeline=new MockPipeline();pipeline.process=async frame=>{now+=2000;return mockObservation(frame);};
  const {source,renderer,engine}=setup(pipeline,{nowUs:()=>now,onDiagnostics:d=>records.push(d)});source.nowSessionUs=()=>now-500000;
  renderer.update=async()=>{now+=5000;};let updated;
  engine.on('targetUpdated',e=>updated=e);await engine.start();source.push(mockFrame(source.sessionId,1));await tick();
  assert.equal(records[0].cpuSubmitTimeUs,0);assert.equal(records[0].resultAvailableTimeUs,2000);assert.equal(records[0].renderSubmitTimeUs,2000);
  assert.equal(records[0].gpuCompleteTimeUs,null);assert.equal(records[0].visibleTimeUs,null);assert.equal(updated.timestampUs,7000);
  assert.equal('imageHandle' in records[0],false);await engine.dispose();
});
test('queue wait is measured on the SDK clock for processed frames, unknown for dropped candidates, without touching frame timestamps or releases', async()=>{
  let now=0,finish;const records=[],released=[];
  const pipeline=new MockPipeline();const finishers=[];pipeline.process=frame=>new Promise(resolve=>finishers.push(()=>resolve(mockObservation(frame))));
  const {source,engine}=setup(pipeline,{nowUs:()=>now,onDiagnostics:d=>records.push(d)});await engine.start();
  const frame=id=>{const f=mockFrame(source.sessionId,id,()=>released.push(id));f.arrivalTimeUs=900000+id;f.sourceTimestampUs=id*33333;return f;};
  const a=frame(1),b=frame(2),c=frame(3),stamps=[a,b,c].map(f=>[f.arrivalTimeUs,f.sourceTimestampUs,f.captureTimeUs]);
  source.push(a);now=10000;source.push(b);now=20000;source.push(c);        // A busy, B pending then replaced by latest C
  await tick();assert.deepEqual(released,[2],'replaced candidate released once');
  assert.equal(records.length,1);assert.equal(records[0].frameId,2);assert.equal(records[0].dropReason,'candidate-replaced');assert.equal(records[0].queueWaitDurationUs,null);
  now=60000;finishers[0]();await tick();await tick();
  now=75000;finishers[1]();await tick();await tick();
  const processed=records.filter(r=>r.dropReason===null);
  assert.deepEqual(processed.map(r=>[r.frameId,r.queueWaitDurationUs]),[[1,0],[3,40000]],'waits are SDK-clock receipt-to-hand-off, not exposure or arrival');
  assert.deepEqual(processed.map(r=>r.arrivalTimeUs),[900001,900003]);
  assert.deepEqual([a,b,c].map(f=>[f.arrivalTimeUs,f.sourceTimestampUs,f.captureTimeUs]),stamps,'original timestamps untouched');
  assert.deepEqual([...released].sort(),[1,2,3]);await engine.dispose();
  const {DiagnosticRecorder}=await import('../../../dist/sdk/src/diagnostics.js'),recorder=new DiagnosticRecorder('q');recorder.frame(processed[1]);recorder.frame(records[0]);
  assert.deepEqual(recorder.export().frames.map(f=>f.queueWaitDurationUs),[40000,null]);
});

test('engine.stop() from targetFound listener does not emit targetUpdated and does not arm expiry', async () => {
  const { source, renderer, engine } = setup();
  const events = [];
  let stopped;
  engine.on('targetFound', () => {
    events.push('found');
    stopped = engine.stop();
    events.push('stop-requested');
  });
  engine.on('targetUpdated', () => events.push('updated'));
  engine.on('targetLost', () => events.push('lost'));
  await engine.start();
  source.push(mockFrame(source.sessionId, 1));
  await tick();
  await stopped;
  assert.deepEqual(events, ['found', 'stop-requested', 'lost']);
  assert.equal(renderer.visible, false);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(events, ['found', 'stop-requested', 'lost']);
  await engine.start();
  assert.equal(source.sessionId, 'session-2');
  await engine.dispose();
});

test('engine.stop() from targetUpdated listener prevents expiry timer and allows clean restart', async () => {
  const { source, renderer, engine } = setup(undefined, { maxPredictionMs: 30 });
  const events = [];
  let stopped;
  engine.on('targetFound', () => events.push('found'));
  engine.on('targetUpdated', () => {
    events.push('updated');
    stopped = engine.stop();
    events.push('stop-requested');
  });
  engine.on('targetLost', () => events.push('lost'));
  await engine.start();
  source.push(mockFrame(source.sessionId, 1));
  await tick();
  await stopped;
  assert.deepEqual(events, ['found', 'updated', 'stop-requested', 'lost']);
  assert.equal(renderer.visible, false);
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(events, ['found', 'updated', 'stop-requested', 'lost']);
  await engine.start();
  assert.equal(source.sessionId, 'session-2');
  await engine.dispose();
});

test('engine.dispose() from targetFound listener settles without targetUpdated', async () => {
  const { source, renderer, engine } = setup();
  const events = [];
  let disposed;
  engine.on('targetFound', () => {
    events.push('found');
    disposed = engine.dispose();
    events.push('dispose-requested');
  });
  engine.on('targetUpdated', () => events.push('updated'));
  await engine.start();
  source.push(mockFrame(source.sessionId, 1));
  await tick();
  await disposed;
  assert.deepEqual(events, ['found', 'dispose-requested']);
  assert.equal(renderer.visible, false);
});

const twoTargetPipeline = () => {
  const pipeline = new MockPipeline();
  pipeline.process = async frame => mockObservation(frame, frame.frameId === 1 ? 'one' : 'two');
  return pipeline;
};

test('engine.stop() from targetLost on target switch submits no render for the new target; restart works', async () => {
  const { source, renderer, engine } = setup(twoTargetPipeline());
  const events = [];
  let stopping;
  engine.on('targetLost', e => { events.push(`lost:${e.reason}`); stopping = engine.stop(); });
  engine.on('targetFound', e => events.push(`found:${e.result.targetId}`));
  engine.on('targetUpdated', e => events.push(`updated:${e.result.targetId}`));
  try {
    await engine.start();
    source.push(mockFrame(source.sessionId, 1)); await tick();
    source.push(mockFrame(source.sessionId, 2)); await tick();
    await stopping;
    assert.deepEqual(renderer.updates.map(r => r.targetId), ['one']);
    assert.deepEqual(events, ['found:one', 'updated:one', 'lost:target-changed']);
    assert.equal(renderer.visible, false);
    await engine.start();
    assert.equal(source.sessionId, 'session-2');
  } finally {
    await engine.dispose();
  }
});

test('measured target switch without cancellation still loses one and finds two', async () => {
  const { source, renderer, engine } = setup(twoTargetPipeline());
  const events = [];
  engine.on('targetLost', e => events.push(`lost:${e.reason}`));
  engine.on('targetFound', e => events.push(`found:${e.result.targetId}`));
  try {
    await engine.start();
    source.push(mockFrame(source.sessionId, 1)); await tick();
    source.push(mockFrame(source.sessionId, 2)); await tick();
    assert.deepEqual(renderer.updates.map(r => r.targetId), ['one', 'two']);
    assert.deepEqual(events, ['found:one', 'lost:target-changed', 'found:two']);
  } finally {
    await engine.dispose();
  }
});

test('engine.stop() from capabilityChanged or sessionConfigUpdated never announces ready; restart succeeds', async () => {
  for (const name of ['capabilityChanged', 'sessionConfigUpdated']) {
    const { source, engine } = setup();
    const events = [];
    let stopping, armed = true;
    engine.on(name, () => { if (armed) { armed = false; stopping = engine.stop(); } });
    engine.on('ready', () => events.push('ready'));
    engine.on('sessionEnded', e => events.push(`ended:${e.reason}`));
    try {
      await engine.start();
      await stopping;
      assert.ok(stopping, `${name} observer ran`);
      assert.deepEqual(events.filter(e => e === 'ready'), [], `${name}: no ready after cancellation`);
      assert.equal(source.callback, null, `${name}: source quiesced`);
      await engine.start();
      assert.equal(source.sessionId, 'session-2');
      assert.deepEqual(events.filter(e => e === 'ready'), ['ready'], `${name}: restart announces ready once`);
    } finally {
      await engine.dispose();
    }
  }
});
