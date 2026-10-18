/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FrameClock, hasLayoutTurned, ViewportGate, type GateToken } from '@livemira/camera';
import { EngineError } from '@livemira/contracts';

type Listener = () => void;

/** A minimal scripted window: orientation, resize, a container, video resize events and animation frames. */
class FakeWindow {
  innerWidth = 390;
  innerHeight = 844;
  devicePixelRatio = 3;
  nowUs = 1_000_000;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly orientationListeners = new Set<Listener>();
  readonly videoListeners = new Set<Listener>();
  readonly frames = new Map<number, Listener>();
  private nextFrame = 1;
  readonly container = {
    width: 390,
    height: 844,
    getBoundingClientRect: () => ({ width: this.container.width, height: this.container.height }),
  };
  readonly screen = {
    orientation: {
      angle: 0,
      addEventListener: (_: string, l: Listener) => void this.orientationListeners.add(l),
      removeEventListener: (_: string, l: Listener) => void this.orientationListeners.delete(l),
    },
  };
  readonly video = {
    addEventListener: (_: string, l: Listener) => void this.videoListeners.add(l),
    removeEventListener: (_: string, l: Listener) => void this.videoListeners.delete(l),
  };
  addEventListener(type: string, l: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(l);
  }
  removeEventListener(type: string, l: Listener): void {
    this.listeners.get(type)?.delete(l);
  }
  requestAnimationFrame(callback: Listener): number {
    const id = this.nextFrame++;
    this.frames.set(id, callback);
    return id;
  }
  cancelAnimationFrame(id: number): void {
    this.frames.delete(id);
  }
  flushFrames(): void {
    const queued = [...this.frames.values()];
    this.frames.clear();
    for (const callback of queued) callback();
  }
  rotate(): void {
    [this.innerWidth, this.innerHeight] = [this.innerHeight, this.innerWidth];
    [this.container.width, this.container.height] = [this.container.height, this.container.width];
    this.screen.orientation.angle = this.screen.orientation.angle ? 0 : 90;
    for (const l of [...this.orientationListeners]) l();
  }
  attached(): number {
    let n = this.orientationListeners.size + this.videoListeners.size;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function setup() {
  const win = new FakeWindow();
  const log: string[] = [];
  const gate = new ViewportGate({
    env: win,
    container: win.container,
    nowUs: () => win.nowUs,
    setMask: (on) => log.push(on ? 'mask' : 'unmask'),
    onTransition: (t) => log.push(`${t.phase}:${t.reason}`),
  });
  gate.attachVideo(win.video);
  const frame = (width: number, height: number, token: GateToken = gate.begin()): boolean => {
    win.nowUs += 34000;
    return gate.admit(token, `${width}x${height}`, `${width}x${height}`, {
      prepare: () => log.push('prepare'),
      commit: () => log.push('commit'),
    });
  };
  return { win, log, gate, frame };
}

test('steady state delivers every fresh frame without masking', () => {
  const { log, frame } = setup();
  for (let i = 0; i < 5; i++) assert.equal(frame(1280, 720), true);
  assert.deepEqual(log, []);
});

test('a rotation masks at once and reopens only after settling, painting and a confirming frame, in that order', () => {
  const { win, log, gate, frame } = setup();
  frame(1280, 720);
  win.rotate();
  assert.deepEqual(log, ['mask', 'begin:orientation']);
  // The camera has not swapped yet: frames of the old size wait (up to 400 ms) and are never delivered.
  assert.equal(frame(1280, 720), false);
  for (const l of [...win.videoListeners]) l();
  for (let i = 0; i < 4; i++) assert.equal(frame(720, 1280), false);
  assert.ok(log.includes('prepare'), 'the settled geometry is prepared under the mask');
  assert.equal(gate.isGated, true);
  win.flushFrames();
  win.flushFrames();
  const opened = frame(720, 1280);
  assert.equal(opened, true);
  const tail = log.slice(log.indexOf('commit'));
  assert.deepEqual(tail, ['commit', 'unmask', 'end:intrinsic'], 'the end reports the last trigger');
  assert.equal(gate.isGated, false);
});

test('a capture that began under an older epoch is dropped', () => {
  const { win, gate, frame } = setup();
  frame(1280, 720);
  const token = gate.begin();
  win.rotate();
  assert.equal(frame(1280, 720, token), false);
  assert.equal(gate.stats.staleEpochDrops, 1);
});

test('dispose removes every listener, cancels the paint wait and unmasks', () => {
  const { win, log, gate, frame } = setup();
  frame(1280, 720);
  win.rotate();
  for (const l of [...win.videoListeners]) l();
  for (let i = 0; i < 4; i++) frame(720, 1280);
  assert.equal(win.frames.size, 1, 'waiting for paint');
  gate.dispose();
  assert.equal(win.attached(), 0);
  assert.equal(win.frames.size, 0);
  assert.equal(log.at(-1), 'unmask');
  assert.equal(frame(720, 1280), false);
});

test('invalid stabilization options are rejected', () => {
  for (const stabilization of [
    { stableFrames: 0 },
    { quietMs: -1 },
    { orientationIntrinsicWaitMs: NaN },
  ]) {
    assert.throws(
      () => new ViewportGate({ env: new FakeWindow(), nowUs: () => 0, stabilization }),
      (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
    );
  }
});

test('only a swap of both axes with a flipped orientation class counts as a turn', () => {
  assert.equal(hasLayoutTurned([390, 844], [844, 390]), true);
  assert.equal(hasLayoutTurned([390, 844], [390, 500]), false, 'keyboard');
  assert.equal(hasLayoutTurned([390, 844], [390, 760]), false, 'address bar');
  assert.equal(hasLayoutTurned(null, [844, 390]), false);
});

test('the frame clock maps source time onto the session clock and rejects repeats and resets', () => {
  let now = 100000;
  const clock = new FrameClock(() => now);
  now += 2000;
  const first = clock.observe(5000000)!;
  assert.equal(first.arrivalTimeUs, 2000);
  assert.equal(first.sourceToSessionOffsetUs, -4998000);
  assert.equal(first.observationTimeUs, 2000);
  assert.equal(clock.observe(5000000), null);
  assert.throws(
    () => clock.observe(0),
    (e) => e instanceof EngineError && e.code === 'CAMERA_CLOCK_RESET',
  );
  assert.equal(new FrameClock(() => now).observe(0)!.arrivalTimeUs, 0);
});
