/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { CameraRuntime } from './runtime.mjs';

/** Implements the SDK FrameSource contract: the SDK becomes the sole queue/resource owner after delivery. */
export class CameraFrameSource {
  constructor(options = {}) {
    this.options = options;
    this.runtime = null;
    this.abortCleanup = null;
    this.disposed = false;
    this.lifecycleGeneration = 0;
    this.transitionListeners = new Set();
  }
  /** Optional FrameSource hook: begin/end of an orientation/viewport transition. Synchronous; returns unsubscribe. */
  onViewportTransition(listener) {
    if (this.disposed) throw new Error('DISPOSED');
    if (typeof listener !== 'function') throw new TypeError('Transition listener must be a function');
    this.transitionListeners.add(listener);
    return () => { this.transitionListeners.delete(listener); };
  }
  async start(sessionId, onFrame, signal) {
    if (this.disposed) throw new Error('DISPOSED');
    const generation = this.lifecycleGeneration + 1;
    await this.stop();
    if (generation !== this.lifecycleGeneration || this.disposed) throw new DOMException('Camera start superseded', 'AbortError');
    if (signal.aborted) throw new DOMException('Camera start aborted', 'AbortError');
    const runtime = new CameraRuntime({ ...this.options, consume: onFrame,
      onEvent: event => {
        if (event.code === 'CAMERA_FRAME_STALLED' && event.recommendedCamera) {
          this.options = { ...this.options, camera: { ...this.options.camera, ...event.recommendedCamera } };
          this.lastRecovery = { code: event.code, reason: event.reason, nextCamera: event.recommendedCamera };
        }
        this.options.onEvent?.(event);
      },
      onTransition: event => { if (this.runtime === runtime) for (const listener of [...this.transitionListeners]) { try { listener(event); } catch { /* Observer isolation. */ } } },
      transferOwnership: true, visibilityPolicy: 'stop' });
    this.runtime = runtime;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      runtime.stop();
      rejectAbort(new DOMException('Camera start aborted', 'AbortError'));
    };
    this.cancelStart = abort;
    signal.addEventListener('abort', abort, { once: true });
    this.abortCleanup = () => signal.removeEventListener('abort', abort);
    try {
      await Promise.race([runtime.start({ ...this.options.camera, sessionId }), aborted]);
      if (runtime.state !== 'running') throw new Error('CAMERA_SUSPENDED');
    } catch (error) {
      if (this.runtime === runtime) await this.stop();
      throw error;
    }
  }
  async stop() {
    this.lifecycleGeneration++;
    this.cancelStart?.();
    this.cancelStart = null;
    this.abortCleanup?.();
    this.abortCleanup = null;
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.dispose();
    if (runtime) this.lastDiagnostics = runtime.getDiagnostics();
  }
  configureCamera(camera) {
    if (this.disposed) throw new Error('DISPOSED');
    if (this.runtime) throw new Error('Stop the engine before configuring its camera');
    this.options = { ...this.options, camera: { ...this.options.camera, ...camera } };
  }
  updateGeometry(geometry) {
    this.options = { ...this.options, geometry: { ...this.options.geometry, ...geometry } };
    this.runtime?.updateGeometry(geometry);
  }
  getDiagnostics() { return { ...(this.runtime?.getDiagnostics() ?? this.lastDiagnostics ?? { state: 'stopped', sessionId: null }), recovery: this.lastRecovery ?? null }; }
  async listCameras() {
    const devices = await (this.options.env ?? globalThis).navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'videoinput');
  }
  nowSessionUs() {
    return this.runtime?.state === 'running' ? this.runtime.clock.arrival() : null;
  }
  async dispose() { this.disposed = true; try { await this.stop(); } finally { this.transitionListeners.clear(); } }
}
