// SPDX-License-Identifier: Apache-2.0
// The vision Worker while suspended (a hidden page): the track it owns is off, incoming frames are released unprocessed
// on every path, and a stop ends the track. Driven through a fake Worker scope; no pipeline is loaded.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FromWorker, ToWorker } from '../src/protocol.ts';
import { startVisionWorker, type VisionScope } from '../src/vision-worker.ts';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

class FakeFrame {
  closed = false;
  timestamp = 0;
  close(): void {
    this.closed = true;
  }
}

function setup() {
  let handler: ((event: MessageEvent<ToWorker>) => void) | null = null;
  const posted: FromWorker[] = [];
  const scope: VisionScope = {
    postMessage: (m) => void posted.push(m),
    addEventListener: (_type, listener) => void (handler = listener),
  };
  startVisionWorker(scope);
  const send = (message: unknown): void => handler!({ data: message } as MessageEvent<ToWorker>);
  return { send, posted };
}

test('suspend switches the owned track off, releases frames on every path, and resume switches it on', async () => {
  const track = { enabled: true, stopped: false, stop: () => void (track.stopped = true) };
  const streams: { push(frame: FakeFrame): void }[] = [];
  Object.assign(globalThis, {
    MediaStreamTrackProcessor: class {
      readable: ReadableStream<FakeFrame>;
      constructor() {
        let controller!: ReadableStreamDefaultController<FakeFrame>;
        this.readable = new ReadableStream<FakeFrame>({ start: (c) => void (controller = c) });
        streams.push({ push: (f) => controller.enqueue(f) });
      }
    },
  });
  const { send } = setup();
  send({ type: 'track', track });
  await tick();
  assert.equal(track.enabled, true);

  send({ type: 'suspend', isSuspended: true });
  assert.equal(track.enabled, false, 'the Worker-owned track is off');
  const streamed = new FakeFrame();
  streams[0]!.push(streamed);
  await tick();
  assert.equal(streamed.closed, true, 'a streamed frame is released at once');
  const single = new FakeFrame();
  send({ type: 'frame', frame: single, captureUs: 1 });
  assert.equal(single.closed, true, 'a frame from the main thread is released at once');

  send({ type: 'suspend', isSuspended: true });
  assert.equal(track.enabled, false, 'idempotent');
  send({ type: 'suspend', isSuspended: false });
  assert.equal(track.enabled, true);

  send({ type: 'stop' });
  assert.equal(track.stopped, true, 'a stop ends the track');
});

test('a track that arrives while suspended starts off', async () => {
  const track = { enabled: true, stop() {} };
  const { send } = setup();
  send({ type: 'suspend', isSuspended: true });
  send({ type: 'track', track });
  await tick();
  assert.equal(track.enabled, false);
  send({ type: 'suspend', isSuspended: false });
  assert.equal(track.enabled, true);
});
