/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { MediaClock } from './clock.mjs';
import { ownImage, LatestFrameQueue } from './ownership.mjs';
import { createFramePacket } from './packet.mjs';
import { bindFrameGeometry } from './preview.mjs';

/** Pull/step replay of caller-decoded frames; never fabricates an image or exposure. */
export class ReplaySource {
  constructor({ consume, makePacket = createFramePacket, onError, nowUs, newSessionId = () => crypto.randomUUID(), transferOwnership = false }) {
    if (typeof makePacket !== 'function') throw new TypeError('Canonical packet factory is required');
    this.queue = new LatestFrameQueue(consume, onError);
    this.makePacket = makePacket;
    this.nowUs = nowUs;
    this.newSessionId = newSessionId;
    this.sessionId = null;
    this.consume = consume;
    this.transferOwnership = transferOwnership;
  }
  start(sessionId = this.newSessionId()) {
    this.stop();
    this.sessionId = sessionId;
    this.frameId = 0;
    this.clock = new MediaClock(this.nowUs);
    this.queue.start(this.sessionId);
    return this.sessionId;
  }
  /** Ownership transfers even on rejection. Pass the session captured before async decoding. */
  push(sessionId, { image, close, sourceTimestampUs, width, height, pixelFormat = 'rgba8',
    rotation = 0, mirrored = false, calibrationId = null, geometry, imageIdentity }) {
    const handle = ownImage(image, close, pixelFormat);
    try {
      if (!this.sessionId || sessionId !== this.sessionId) { handle.release(); return false; }
      if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384)) throw new RangeError('Valid integer dimensions required');
      if (!['rgba8', 'bgra8', 'gray8', 'video-frame', 'image-bitmap'].includes(pixelFormat)
        || ![0, 90, 180, 270].includes(rotation)) throw new RangeError('Unsupported frame format or rotation');
      const channels = pixelFormat === 'gray8' ? 1 : ['rgba8', 'bgra8'].includes(pixelFormat) ? 4 : null;
      if (channels && (!(image instanceof Uint8Array || image instanceof Uint8ClampedArray)
        || image.byteLength !== width * height * channels)) throw new RangeError('CPU replay requires tightly packed pixel bytes');
      const timing = this.clock.observe(sourceTimestampUs);
      if (!timing) { handle.release(); return false; }
      const packet = this.makePacket({ sessionId, frameId: this.frameId++, ...timing,
        timestampSource: 'replay', width, height, pixelFormat, rotation, mirrored,
        calibrationId, imageHandle: handle, geometry, imageIdentity });
      if (geometry) bindFrameGeometry(packet, geometry);
      if (this.transferOwnership) { this.consume(packet); return true; }
      return this.queue.offer(packet, handle);
    } catch (error) { handle.release(); throw error; }
  }
  stop() { this.sessionId = null; this.queue.stop(); }
  async dispose() { this.stop(); await this.queue.drain(); }
}

/** SDK-compatible manually stepped replay. Caller supplies decoded frames and pacing. */
export class ReplayFrameSource {
  constructor(options = {}) { this.options = options; this.disposed = false; this.lifecycleGeneration = 0; }
  async start(sessionId, onFrame, signal) {
    if (this.disposed) throw new Error('DISPOSED');
    const generation = this.lifecycleGeneration + 1;
    await this.stop();
    if (generation !== this.lifecycleGeneration || this.disposed) throw new DOMException('Replay start superseded', 'AbortError');
    if (signal.aborted) throw new DOMException('Replay start aborted', 'AbortError');
    this.source = new ReplaySource({ ...this.options, consume: onFrame, transferOwnership: true });
    this.source.start(sessionId);
    const source = this.source;
    const abort = () => source.stop();
    signal.addEventListener('abort', abort, { once: true });
    this.abortCleanup = () => signal.removeEventListener('abort', abort);
  }
  push(sessionId, sample) {
    if (!this.source) { ownImage(sample.image, sample.close, sample.pixelFormat).release(); return false; }
    return this.source.push(sessionId, sample);
  }
  async stop() {
    this.lifecycleGeneration++;
    this.abortCleanup?.(); this.abortCleanup = null;
    const source = this.source; this.source = null;
    await source?.dispose();
  }
  nowSessionUs() { return this.source?.sessionId ? this.source.clock.arrival() : null; }
  async dispose() { this.disposed = true; await this.stop(); }
}
