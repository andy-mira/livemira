/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { ReplaySource } from '../src/index.mjs';
let consumed = 0, released = 0;
const source = new ReplaySource({ consume(frame) {
  const pixels = frame.imageHandle.data;
  console.log(JSON.stringify({ sessionId: frame.sessionId, frameId: frame.frameId,
    pixelFormat: frame.pixelFormat, checksum: pixels.reduce((sum, value) => sum + value, 0),
    captureTimeUs: frame.captureTimeUs, mappedObservationTimeUs: frame.mappedObservationTimeUs }));
  consumed++;
} });
const sessionId = source.start();
source.push(sessionId, { image: new Uint8Array([0, 64, 128, 255]), width: 2, height: 2,
  pixelFormat: 'gray8', sourceTimestampUs: 0, imageIdentity: 'example-checker-0', close: () => released++ });
await source.queue.drain();
await source.dispose();
if (consumed !== 1 || released !== 1) throw new Error('Replay lifecycle invariant failed');
console.log(JSON.stringify({ consumed, released, fixture: 'synthetic 2x2 pixels; not recognition or camera evidence' }));
