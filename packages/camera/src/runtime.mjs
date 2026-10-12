/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { ownImage, LatestFrameQueue } from './ownership.mjs';
import { MediaClock } from './clock.mjs';
import { createGeometry } from './geometry.mjs';
import { createFramePacket, toFrameGeometry } from './packet.mjs';
import { ViewportGate } from './viewport-gate.mjs';
import { mountCameraPreview, bindFrameGeometry } from './preview.mjs';

/** Internal source adapter. makePacket must return the canonical FramePacket. */
export class CameraRuntime {
  constructor({ consume, makePacket = createFramePacket, onEvent = () => {}, env = globalThis, nowUs,
    geometry = {}, calibration = null, transferOwnership = false, visibilityPolicy = 'restart', previewContainer = null, viewportStabilization = true, onTransition = () => {} }) {
    if (typeof makePacket !== 'function') throw new TypeError('Canonical packet factory is required');
    this.env = env;
    this.makePacket = makePacket;
    this.onEvent = onEvent;
    this.nowUs = nowUs ?? (() => env.performance.now() * 1000);
    this.geometryOptions = geometry;
    this.calibration = calibration;
    this.consume = consume;
    this.transferOwnership = transferOwnership;
    this.visibilityPolicy = visibilityPolicy;
    this.previewContainer = previewContainer;
    this.viewportStabilization = viewportStabilization;
    this.onTransition = onTransition;
    this.gate = null;
    this.queue = new LatestFrameQueue(consume, error => this.emit('error', { code: 'CONSUMER_FAILED', error }));
    this.generation = 0;
    this.state = 'stopped';
    this.disposed = false;
    this.suspendedConfig = null;
    this.stats = { snapshots: 0, bitmapCopies: 0, snapshotFailures: 0, duplicateCallbacks: 0, busyDrops: 0,
      cpuReadbackBytes: 0, nativeSnapshotFailures: 0, bitmapSnapshotFailures: 0, staleDrops: 0, missedPresented: 0,
      snapshotDimensionMismatches: 0, dimensionChangeDrops: 0, transitionDrops: 0 };
    this.visibilityListener = () => {
      if (env.document.hidden && ['running', 'starting'].includes(this.state)) {
        this.suspendedConfig = this.visibilityPolicy === 'restart' ? this.config : null;
        this.stopInternal('suspended');
        this.emit('suspended', { requiresRestart: this.visibilityPolicy !== 'restart' });
      } else if (!env.document.hidden && this.suspendedConfig) {
        const config = this.suspendedConfig;
        this.suspendedConfig = null;
        void this.start(config).catch(() => {});
      }
    };
    env.document?.addEventListener('visibilitychange', this.visibilityListener);
  }
  emit(type, detail = {}) {
    try { this.onEvent({ type, sessionId: this.sessionId ?? null, ...detail }); } catch { /* Observer isolation. */ }
  }
  async listCameras() {
    const devices = await this.env.navigator.mediaDevices.enumerateDevices();
    return devices.filter(device => device.kind === 'videoinput');
  }
  async start(config = {}) {
    if (this.disposed) throw new Error('DISPOSED');
    this.stop();
    this.config = { ...config };
    if (config.snapshotPreference !== undefined && !['auto', 'cpu'].includes(config.snapshotPreference)) throw new RangeError('Unsupported snapshot preference');
    if (config.timestampPreference !== undefined && !['media','callback'].includes(config.timestampPreference)) throw new RangeError('Unsupported timestamp preference');
    if (this.env.document?.hidden) { this.suspendedConfig = this.config; this.state = 'suspended'; return; }
    const generation = this.generation;
    this.state = 'starting';
    let stream;
    try {
      // Observe orientation even while camera permission/play is pending; stopInternal owns cleanup.
      if (this.viewportStabilization !== false && typeof this.env.addEventListener === 'function') {
        this.gate = new ViewportGate({ env: this.env, container: this.previewContainer, nowUs: () => this.nowUs(),
          options: this.viewportStabilization === true ? {} : this.viewportStabilization,
          setMask: on => { this.gateMasked = on; this.preview?.mask(on); },
          onTransition: event => {
            if (generation !== this.generation) return;
            if (event.phase === 'begin') this.queue.discardCandidate();
            this.emit('viewportTransition', event);
            // A camera observer can stop/restart or trigger another transition synchronously.
            if (generation !== this.generation || this.gate?.epoch !== event.epoch) return;
            try { this.onTransition(event); } catch { /* Observer isolation. */ }
          } });
      }
      if (!this.env.isSecureContext || !this.env.navigator?.mediaDevices?.getUserMedia) throw new Error('CAMERA_UNAVAILABLE');
      this.emit('permissionRequest');
      if (generation !== this.generation) return;
      stream = await this.env.navigator.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: config.width ?? 1280 }, height: { ideal: config.height ?? 720 },
        ...(config.deviceId ? { deviceId: { exact: config.deviceId } } : { facingMode: { ideal: config.facingMode ?? 'environment' } }),
      } });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      this.emit('permissionResult',{permission:'granted'});
      if (generation !== this.generation) return;
      const video = this.env.document.createElement('video');
      this.video = video;
      if (this.previewContainer) { this.preview = mountCameraPreview(video, this.previewContainer); if (this.gateMasked) this.preview.mask(true); }
      this.gate?.attachVideo(video);
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('NO_VIDEO_TRACK');
      this.track = track;
      this.endedListener = () => {
        if (generation !== this.generation) return;
        this.emit('error', { code: 'TRACK_ENDED', recoverable: true });
        this.stop();
      };
      track.addEventListener('ended', this.endedListener);
      await video.play();
      if (generation !== this.generation) { video.pause(); video.srcObject = null; return; }
      if (typeof video.requestVideoFrameCallback !== 'function' && typeof video.getVideoPlaybackQuality !== 'function') {
        throw new Error('NEW_FRAME_DETECTION_UNAVAILABLE');
      }
      this.sessionId = config.sessionId ?? this.env.crypto.randomUUID();
      this.clock = new MediaClock(this.nowUs);
      this.frameId = 0;
      this.lastPresented = -1;
      this.nativeSnapshotDisabled = false;
      this.bitmapSnapshotDisabled = false;
      this.snapshotPath = 'unverified';
      this.videoCallbackDisabled = false;
      this.geometryKey = null;
      this.latestGeometry = null;
      this.lastFrameDiagnostic = null;
      this.lastNativeDimensions = null;
      this.queue.start(this.sessionId);
      this.state = 'running';
      this.lastProgressUs = this.nowUs();
      this.lastCallbackUs = null;
      this.watchdog = (this.env.setInterval ?? globalThis.setInterval)(() => this.checkStall(generation), 250);
      this.schedule(generation);
      if (this.state !== 'running') throw new Error('NEW_FRAME_DETECTION_UNAVAILABLE');
      this.emit('ready', { settings: track.getSettings(), capturePath: this.callbackKind === 'video' ? 'video-frame-callback' : 'decoded-frame-count' });
    } catch (error) {
      if (generation !== this.generation) return;
      if(!stream){
        this.emit('permissionResult',{permission:error.name==='NotAllowedError'?'denied':'failed'});
        // An observer may have stopped or restarted the camera; this failed operation then owns nothing.
        if (generation !== this.generation) return;
      }
      this.stop();
      this.emit('error', { code: error.name === 'NotAllowedError' ? 'CAMERA_PERMISSION_DENIED' : 'CAMERA_START_FAILED', recoverable: true, error });
      throw error;
    }
  }
  schedule(generation) {
    if (generation !== this.generation || this.state !== 'running') return;
    if (!this.videoCallbackDisabled && typeof this.video.requestVideoFrameCallback === 'function') {
      this.callbackKind = 'video';
      try { this.callbackId = this.video.requestVideoFrameCallback((_now, metadata) => {
        if (generation !== this.generation || this.state !== 'running') return;
        this.callbackId = null;
        void this.capture(generation, metadata.mediaTime * 1e6, metadata.presentedFrames);
        this.schedule(generation);
      }); } catch {
        this.videoCallbackDisabled = true;
        if (typeof this.video.getVideoPlaybackQuality !== 'function' || typeof this.env.requestAnimationFrame !== 'function') {
          this.emit('error', { code: 'NEW_FRAME_DETECTION_UNAVAILABLE', recoverable: false }); this.stop(); return;
        }
        this.emit('capabilityChanged', { capturePath: 'decoded-frame-count', reason: 'VIDEO_CALLBACK_FAILED' });
        this.schedule(generation);
      }
    } else {
      this.callbackKind = 'animation';
      this.callbackId = this.env.requestAnimationFrame(() => {
        if (generation !== this.generation || this.state !== 'running') return;
        this.callbackId = null;
        const quality = this.video.getVideoPlaybackQuality();
        const presented = quality.totalVideoFrames - quality.droppedVideoFrames;
        if (Number.isSafeInteger(presented) && presented > 0) void this.capture(generation, this.video.currentTime * 1e6, presented);
        this.schedule(generation);
      });
    }
  }
  async capture(generation, sourceTimestampUs, presentedFrames) {
    if (generation !== this.generation || this.state !== 'running') return;
    this.lastCallbackUs = this.nowUs();
    if (!Number.isSafeInteger(presentedFrames) || presentedFrames <= 0) return;
    if (presentedFrames <= this.lastPresented) { this.stats.duplicateCallbacks++; return; }
    if (this.lastPresented >= 0) this.stats.missedPresented += Math.max(0, presentedFrames - this.lastPresented - 1);
    this.lastPresented = presentedFrames;
    if (this.snapshotBusy) { this.stats.busyDrops++; return; }
    const video = this.video, sessionId = this.sessionId;
    const geometryOptions = { ...this.geometryOptions, ...(this.gate?.viewportGeometry() ?? {}), ...(this.geometryOptions.crop ? { crop: { ...this.geometryOptions.crop } } : {}) };
    const settings = this.track.getSettings();
    const gate = this.gate, gateToken = gate?.begin();
    if (!video.videoWidth || !video.videoHeight) return;
    const inputWidth = video.videoWidth, inputHeight = video.videoHeight;
    let handle;
    this.snapshotBusy = true;
    try {
      const reportedMediaTimeUs = sourceTimestampUs;
      const arrivalTimeUs = this.clock.arrival();
      if (this.config.timestampPreference === 'callback') sourceTimestampUs = arrivalTimeUs;
      const timing = this.clock.observe(sourceTimestampUs, arrivalTimeUs);
      if (!timing) { this.stats.duplicateCallbacks++; return; }
      // Reserve the sole candidate slot before starting an asynchronous copy.
      if (!this.transferOwnership) this.queue.discardCandidate();
      let value, pixelFormat = 'video-frame';
      if (this.config.snapshotPreference !== 'cpu' && !this.nativeSnapshotDisabled && typeof this.env.VideoFrame === 'function') {
        try { value = new this.env.VideoFrame(video, { timestamp: Math.round(sourceTimestampUs) }); }
        catch { this.stats.nativeSnapshotFailures++; this.nativeSnapshotDisabled = true; }
      }
      if (!value) {
        if (this.config.snapshotPreference !== 'cpu' && !this.bitmapSnapshotDisabled && typeof this.env.createImageBitmap === 'function') {
          try {
            value = await this.env.createImageBitmap(video);
            pixelFormat = 'image-bitmap';
            this.stats.bitmapCopies++;
          } catch { this.stats.bitmapSnapshotFailures++; if (generation === this.generation) this.bitmapSnapshotDisabled = true; }
        }
      }
      if (generation !== this.generation) { value?.close?.(); this.stats.staleDrops++; return; }
      if (gate && gate.epoch !== gateToken.epoch) { value?.close?.(); this.stats.transitionDrops++; return; }
      if (value && (video.videoWidth !== inputWidth || video.videoHeight !== inputHeight)) {
        value.close?.(); this.stats.dimensionChangeDrops++; return;
      }
      if (value) {
        this.lastNativeDimensions = { videoWidth: inputWidth, videoHeight: inputHeight,
          displayWidth: value.displayWidth ?? value.width, displayHeight: value.displayHeight ?? value.height,
          codedWidth: value.codedWidth ?? null, codedHeight: value.codedHeight ?? null,
          rotation: value.rotation ?? null, flip: value.flip ?? null };
        if ((value.displayWidth ?? value.width) !== inputWidth || (value.displayHeight ?? value.height) !== inputHeight) {
          // Never stretch the live video to guessed decoder/display dimensions.
          value.close?.(); value = null; this.stats.snapshotDimensionMismatches++;
        }
      }
      if (!value) {
        if (generation !== this.generation) return;
        this.readbackCanvas ??= this.env.document.createElement('canvas');
        if (this.readbackCanvas.width !== inputWidth || this.readbackCanvas.height !== inputHeight) {
          this.readbackCanvas.width = inputWidth;
          this.readbackCanvas.height = inputHeight;
          this.readbackContext = null;
        }
        // The context belongs to the cached canvas; it is requested once per canvas size, not once per frame.
        this.readbackContext ??= this.readbackCanvas.getContext('2d', { willReadFrequently: true });
        const context = this.readbackContext;
        if (!context) throw new Error('IMAGE_SNAPSHOT_UNAVAILABLE');
        context.drawImage(video, 0, 0, inputWidth, inputHeight);
        const rgba = context.getImageData(0, 0, inputWidth, inputHeight);
        value = new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
        pixelFormat = 'rgba8';
        this.stats.cpuReadbackBytes += value.byteLength;
      }
      handle = ownImage(value, undefined, pixelFormat);
      this.stats.snapshots++;
      if (generation !== this.generation) { this.stats.staleDrops++; handle.release(); return; }
      if (gate) {
        const sig = JSON.stringify([inputWidth, inputHeight, settings.deviceId, settings.zoom, geometryOptions]);
        if (!gate.admit(gateToken, sig, `${inputWidth}x${inputHeight}`)) {
          // A dropped transition frame is still fresh evidence that the camera is alive.
          handle.release(); handle = null; this.stats.transitionDrops++; this.lastProgressUs = this.nowUs(); return;
        }
        if (generation !== this.generation) { this.stats.staleDrops++; handle.release(); return; }
      }
      this.snapshotPath = pixelFormat;
      const width = inputWidth;
      const height = inputHeight;
      const geometry = createGeometry({ ...geometryOptions, width, height });
      this.latestGeometry = toFrameGeometry(geometry);
      this.preview?.update(this.latestGeometry, width, height);
      const key = JSON.stringify([width, height, settings.deviceId, settings.zoom, geometry]);
      if (key !== this.geometryKey) {
        this.geometryKey = key;
        // Calibration providers must explicitly match dimensions, crop, device and zoom.
        this.calibrationId = this.calibration?.({ settings, geometry, width, height }) ?? null;
        this.emit('geometryChanged', { geometry: toFrameGeometry(geometry), calibrationId: this.calibrationId });
        if (generation !== this.generation || (gate && gate.epoch !== gateToken.epoch)) { handle.release(); return; }
      }
      const packet = this.makePacket({ sessionId, frameId: this.frameId++, ...timing, imageIdentity: `${sessionId}:${presentedFrames}`,
        timestampSource: this.config.timestampPreference === 'callback' ? 'callback' : 'media-time', width, height, pixelFormat,
        rotation: geometry.rotation, mirrored: geometry.mirrored,
        calibrationId: this.calibrationId, imageHandle: handle, geometry });
      bindFrameGeometry(packet, this.latestGeometry);
      this.emit('clockMapping', { ...timing.clockMapping });
      if (generation !== this.generation || (gate && gate.epoch !== gateToken.epoch)) { handle.release(); return; }
      this.lastFrameDiagnostic = { frameId: packet.frameId, width, height, pixelFormat,
        sourceTimestampUs, reportedMediaTimeUs, timestampSource: packet.timestampSource,
        arrivalTimeUs: timing.arrivalTimeUs, mappedObservationTimeUs: timing.mappedObservationTimeUs,
        snapshotCompleteTimeUs: this.clock.arrival(), captureTimeUs: null, captureTimeUncertaintyUs: null };
      if (this.transferOwnership) this.consume(packet);
      else this.queue.offer(packet, handle);
      this.lastProgressUs = this.nowUs();
      handle = null;
    } catch (error) {
      handle?.release();
      this.stats.snapshotFailures++;
      if (generation === this.generation) {
        this.emit('error', { code: error.message === 'SOURCE_CLOCK_RESET' ? 'SOURCE_CLOCK_RESET' : 'FRAME_CAPTURE_FAILED', error, recoverable: true });
        this.stop();
      }
    } finally { this.snapshotBusy = false; }
  }
  updateGeometry(options) {
    const next = { ...this.geometryOptions, ...options };
    const changed = JSON.stringify(next) !== JSON.stringify(this.geometryOptions);
    this.geometryOptions = next;
    // A geometry change on a live stream is a viewport-class change: mask first, then wait for fresh frames under it.
    if (changed && this.gate && this.state !== 'stopped') this.gate.trigger('geometry', false);
  }
  checkStall(generation = this.generation) {
    if (generation !== this.generation || this.state !== 'running' || this.nowUs() - this.lastProgressUs < 2000000) return;
    const canFallback = this.config.snapshotPreference !== 'cpu' || this.config.timestampPreference !== 'callback';
    this.emit('error', { code: 'CAMERA_FRAME_STALLED', recoverable: canFallback, requiresRestart: true,
      recommendedCamera: canFallback ? { snapshotPreference: 'cpu', timestampPreference: 'callback' } : null,
      reason: this.lastCallbackUs !== null && this.nowUs() - this.lastCallbackUs < 1000000 ? 'CALLBACK_WITHOUT_NEW_PACKET' : 'NO_VIDEO_CALLBACK' });
    this.stop();
  }
  getDiagnostics() {
    const settings = this.track?.getSettings() ?? {};
    const rect = this.video?.getBoundingClientRect?.();
    return { state: this.state, sessionId: this.sessionId ?? null, generation: this.generation,
      snapshotPath: this.snapshotPath ?? 'unverified', callbackPath: this.callbackKind ?? null,
      timestampPreference: this.config?.timestampPreference ?? 'media', snapshotPreference: this.config?.snapshotPreference ?? 'auto',
      lastPresented: this.lastPresented ?? null, sinceLastPacketUs: this.lastProgressUs === undefined ? null : this.nowUs() - this.lastProgressUs,
      sinceLastCallbackUs: this.lastCallbackUs == null ? null : this.nowUs() - this.lastCallbackUs,
      settings: Object.fromEntries(['width','height','frameRate','facingMode','resizeMode','zoom'].filter(k => settings[k] !== undefined).map(k => [k, settings[k]])),
      geometry: this.latestGeometry ?? null, lastFrame: this.lastFrameDiagnostic ?? null,
      nativeDimensions: this.lastNativeDimensions ?? null,
      previewDimensions: this.video ? { intrinsicWidth: this.video.videoWidth, intrinsicHeight: this.video.videoHeight,
        cssWidth: this.video.style?.width ?? null, cssHeight: this.video.style?.height ?? null,
        renderedWidth: rect?.width ?? null, renderedHeight: rect?.height ?? null } : null,
      viewportGate: this.gate?.getDiagnostics() ?? null, stats: { ...this.stats }, queue: { ...this.queue.stats }, nativeCopyBytes: null };
  }
  async switchCamera(deviceId) { return this.start({ ...this.config, deviceId }); }
  stopInternal(state = 'stopped') {
    this.generation++;
    if (this.watchdog != null) (this.env.clearInterval ?? globalThis.clearInterval)(this.watchdog);
    this.watchdog = null;
    if (this.callbackId != null) {
      if (this.callbackKind === 'video') this.video?.cancelVideoFrameCallback(this.callbackId);
      else this.env.cancelAnimationFrame(this.callbackId);
    }
    this.callbackId = null;
    if (this.track && this.endedListener) this.track.removeEventListener('ended', this.endedListener);
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.video) { this.video.pause(); this.video.srcObject = null; }
    this.gate?.dispose(); this.gate = null; this.gateMasked = false;
    this.preview?.remove(); this.preview = null;
    this.stream = this.video = this.track = null;
    this.readbackContext = null;
    if (this.readbackCanvas) { this.readbackCanvas.width = this.readbackCanvas.height = 0; this.readbackCanvas = null; }
    this.queue.stop();
    this.state = state;
  }
  stop() { this.suspendedConfig = null; this.stopInternal(); }
  async dispose() {
    this.disposed = true;
    this.stop();
    this.env.document?.removeEventListener('visibilitychange', this.visibilityListener);
    await this.queue.drain();
  }
}
