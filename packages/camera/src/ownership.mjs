/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Own one native resource. Borrowers must finish GPU work before returning. */
export function ownImage(value, close = () => value.close?.(), kind = 'video-frame') {
  let released = false;
  return {
    kind,
    get data() {
      if (released) throw new Error('Image has been released');
      return value;
    },
    get value() {
      if (released) throw new Error('Image has been released');
      return value;
    },
    get released() { return released; },
    release() {
      if (released) return;
      released = true;
      close();
    },
  };
}

/** stop releases candidates immediately, but never an asynchronously borrowed image. */
export class LatestFrameQueue {
  constructor(consume, onError = () => {}) {
    this.consume = consume;
    this.onError = onError;
    this.sessionId = null;
    this.pending = null;
    this.active = null;
    this.stats = { accepted: 0, replaced: 0, stale: 0, completed: 0, failed: 0 };
  }
  start(sessionId) { this.stop(); this.sessionId = sessionId; }
  offer(packet, imageHandle = packet.imageHandle) {
    if (packet.sessionId !== this.sessionId || this.sessionId === null) {
      this.stats.stale++;
      imageHandle.release();
      return false;
    }
    this.stats.accepted++;
    if (this.pending) { this.pending.imageHandle.release(); this.stats.replaced++; }
    this.pending = { packet, imageHandle };
    this.pump();
    return true;
  }
  pump() {
    if (this.active || !this.pending) return;
    const entry = this.pending;
    this.pending = null;
    this.active = Promise.resolve().then(() => {
      if (entry.packet.sessionId === this.sessionId) return this.consume(entry.packet);
    }).catch(error => {
      this.stats.failed++;
      try { this.onError(error); } catch { /* Observers cannot break cleanup. */ }
    }).finally(() => {
      try { entry.imageHandle.release(); }
      catch (error) { try { this.onError(error); } catch { /* Preserve queue progress. */ } }
      this.stats.completed++;
      this.active = null;
      this.pump();
    });
  }
  discardCandidate() {
    if (this.pending) { this.pending.imageHandle.release(); this.pending = null; this.stats.replaced++; }
  }
  stop() {
    this.sessionId = null;
    this.pending?.imageHandle.release();
    this.pending = null;
  }
  async drain() { while (this.active) await this.active; }
}
