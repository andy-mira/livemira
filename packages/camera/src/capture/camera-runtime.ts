/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// One camera: opening the stream, detecting new frames, capturing them through the viewport gate, the stall
// watchdog and the page-visibility stop. Every camera run has a generation; anything begun under an older one is
// ignored or released.

import { EngineError, type Frame, type ViewportTransition } from '@livemira/contracts';

import {
  DEFAULT_CAPTURE,
  DEFAULT_TIMESTAMPS,
  type CameraEnvironment,
  type CameraEvent,
  type CameraRequest,
  type GeometryOptions,
} from '../camera-types.ts';
import { mountPreviewLayer, type PreviewLayer } from '../preview/preview-layer.ts';
import type { PreviewSurfaceFactory } from '../preview/preview-surface.ts';
import { ViewportGate, type ViewportStabilization } from '../viewport/viewport-gate.ts';
import {
  captureFailure,
  FrameCapture,
  type CaptureContext,
  type CaptureStats,
} from './capture-frame.ts';
import { FrameClock } from './frame-clock.ts';
import { Snapshotter, SNAPSHOT_STRATEGIES, type SnapshotStrategy } from './snapshot.ts';

const STALL_LIMIT_US = 2_000_000;
const WATCHDOG_INTERVAL_MS = 250;

export interface CameraRuntimeOptions {
  readonly env: CameraEnvironment;
  readonly consume: (frame: Frame) => void;
  readonly onEvent: (event: CameraEvent) => void;
  readonly onTransition: (transition: ViewportTransition) => void;
  readonly previewContainer: HTMLElement | null;
  readonly geometry: GeometryOptions;
  readonly viewportStabilization: Partial<ViewportStabilization> | false;
  readonly previewSurface?: PreviewSurfaceFactory;
  readonly snapshotStrategies?: Readonly<Record<'auto' | 'canvas', readonly SnapshotStrategy[]>>;
  readonly nowUs?: () => number;
}

export type CameraRuntimeState = 'stopped' | 'starting' | 'running' | 'suspended';

interface RunningCamera {
  readonly stream: MediaStream;
  readonly video: HTMLVideoElement;
  readonly track: MediaStreamTrack;
  readonly endedListener: () => void;
}

function newStats(): CaptureStats {
  return {
    snapshots: 0,
    bitmapCopies: 0,
    snapshotFailures: 0,
    duplicateCallbacks: 0,
    busyDrops: 0,
    cpuReadbackBytes: 0,
    nativeSnapshotFailures: 0,
    bitmapSnapshotFailures: 0,
    staleDrops: 0,
    missedPresented: 0,
    snapshotDimensionMismatches: 0,
    dimensionChangeDrops: 0,
    transitionDrops: 0,
  };
}

export class CameraRuntime {
  state: CameraRuntimeState = 'stopped';
  generation = 0;
  sessionId: string | null = null;
  clock: FrameClock | null = null;
  private isDisposed = false;
  private request: CameraRequest = {};
  private geometryOptions: GeometryOptions;
  private gate: ViewportGate | null = null;
  private isGateMasked = false;
  private preview: PreviewLayer | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private camera: RunningCamera | null = null;
  private capture: FrameCapture | null = null;
  private snapshotter: Snapshotter | null = null;
  private callbackId: number | null = null;
  private callbackKind: 'video' | 'animation' | null = null;
  private isVideoCallbackDisabled = false;
  private watchdog: number | null = null;
  private lastProgressUs: number | null = null;
  /** Timestamps the current run uses: the requested ones, or callback ones after a frozen media time. */
  private timestamps: 'media-time' | 'callback' = DEFAULT_TIMESTAMPS;
  private timestampFallback: 'MEDIA_TIME_FROZEN' | null = null;
  private readonly stats: CaptureStats = newStats();
  private readonly options: CameraRuntimeOptions;
  private readonly env: CameraEnvironment;
  private readonly nowUs: () => number;
  private readonly visibilityListener: () => void;

  constructor(options: CameraRuntimeOptions) {
    this.options = options;
    this.env = options.env;
    const clock = options.env.performance ?? performance;
    this.nowUs = options.nowUs ?? (() => clock.now() * 1000);
    this.geometryOptions = options.geometry;
    this.visibilityListener = () => {
      if (this.env.document?.hidden && (this.state === 'running' || this.state === 'starting')) {
        this.stopInternal('suspended');
        this.emit({ type: 'suspended' });
      }
    };
    this.env.document?.addEventListener('visibilitychange', this.visibilityListener);
  }

  private emit(event: CameraEvent): void {
    try {
      this.options.onEvent(event);
    } catch {
      // Observer isolation.
    }
  }

  private fail(
    code: EngineError['code'],
    detail: string,
    isRecoverable: boolean,
    extra: {
      cause?: unknown;
      recommended?: null | { capture: 'canvas'; timestamps: 'callback' };
    } = {},
  ): void {
    this.emit({
      type: 'failure',
      error: new EngineError(code, detail, {
        isRecoverable,
        ...(extra.cause !== undefined ? { cause: extra.cause } : {}),
      }),
      detail,
      ...(extra.recommended !== undefined ? { recommended: extra.recommended } : {}),
    });
  }

  /** Opens the camera. Throws (after reporting a failure event) when it cannot start. */
  async start(sessionId: string, request: CameraRequest): Promise<void> {
    if (this.isDisposed)
      throw new EngineError('DISPOSED', 'Camera disposed', { isRecoverable: false });
    this.stop();
    this.request = { ...request };
    if (
      request.capture !== undefined &&
      request.capture !== 'auto' &&
      request.capture !== 'canvas'
    ) {
      throw new EngineError('INVALID_CONFIG', 'Unsupported capture mode', { isRecoverable: false });
    }
    if (
      request.timestamps !== undefined &&
      request.timestamps !== 'media-time' &&
      request.timestamps !== 'callback'
    ) {
      throw new EngineError('INVALID_CONFIG', 'Unsupported timestamp mode', {
        isRecoverable: false,
      });
    }
    if (this.env.document?.hidden) {
      this.state = 'suspended';
      return;
    }
    const generation = this.generation;
    this.state = 'starting';
    let stream: MediaStream | undefined;
    try {
      this.createGate(generation);
      const devices = this.env.navigator?.mediaDevices;
      const getUserMedia = devices?.getUserMedia;
      if (!this.env.isSecureContext || typeof getUserMedia !== 'function')
        throw new Error('CAMERA_UNAVAILABLE');
      // Announced before any await: an observer that stops the camera here ends this start synchronously.
      this.emit({ type: 'permission', phase: 'request', permission: 'pending' });
      if (generation !== this.generation) return;
      stream = await this.openStream(generation, (constraints) =>
        getUserMedia.call(devices, constraints),
      );
      if (!stream) return;
      if (!(await this.attachVideo(generation, stream))) return;
      this.beginRun(generation, sessionId);
    } catch (error) {
      if (generation !== this.generation) return;
      if (!stream) {
        const isDenied = (error as { name?: string })?.name === 'NotAllowedError';
        this.emit({
          type: 'permission',
          phase: 'result',
          permission: isDenied ? 'denied' : 'failed',
        });
        // An observer may have stopped or restarted the camera; this failed operation then owns nothing.
        if (generation !== this.generation) return;
      }
      this.stop();
      const isDenied = (error as { name?: string })?.name === 'NotAllowedError';
      const detail = isDenied
        ? 'CAMERA_PERMISSION_DENIED'
        : error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : 'CAMERA_START_FAILED';
      const code = isDenied
        ? 'CAMERA_PERMISSION_DENIED'
        : detail === 'CAMERA_UNAVAILABLE'
          ? 'CAMERA_UNAVAILABLE'
          : 'CAMERA_START_FAILED';
      this.fail(code, detail, true, { cause: error });
      throw new EngineError(code, detail, { isRecoverable: true, cause: error });
    }
  }

  /** Observes the view even while permission or playback is pending; stopInternal owns cleanup. */
  private createGate(generation: number): void {
    const stabilization = this.options.viewportStabilization;
    if (stabilization === false || typeof this.env.addEventListener !== 'function') return;
    this.gate = new ViewportGate({
      env: this.env,
      container: this.options.previewContainer,
      nowUs: () => this.nowUs(),
      stabilization,
      setMask: (on) => {
        this.isGateMasked = on;
        this.preview?.mask(on);
      },
      onTransition: (event) => {
        if (generation !== this.generation) return;
        // A camera observer can stop, restart or trigger another transition synchronously.
        if (this.gate?.epoch !== event.epoch) return;
        try {
          this.options.onTransition(event);
        } catch {
          // Observer isolation.
        }
      },
    });
  }

  private async openStream(
    generation: number,
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  ): Promise<MediaStream | undefined> {
    const request = this.request;
    const stream = await getUserMedia({
      audio: false,
      video: {
        width: { ideal: request.idealWidthPx ?? 1280 },
        height: { ideal: request.idealHeightPx ?? 720 },
        ...(request.deviceId
          ? { deviceId: { exact: request.deviceId } }
          : { facingMode: { ideal: request.facingMode ?? 'environment' } }),
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return undefined;
    }
    this.stream = stream;
    this.emit({ type: 'permission', phase: 'result', permission: 'granted' });
    if (generation !== this.generation) return undefined;
    return stream;
  }

  private async attachVideo(generation: number, stream: MediaStream): Promise<boolean> {
    const video = this.env.document!.createElement('video');
    this.video = video;
    if (this.options.previewContainer) {
      this.preview = mountPreviewLayer(
        video as never,
        this.options.previewContainer as never,
        this.options.previewSurface,
      );
      if (this.isGateMasked) this.preview.mask(true);
    }
    this.gate?.attachVideo(video);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('NO_VIDEO_TRACK');
    const endedListener = (): void => {
      if (generation !== this.generation) return;
      this.fail('CAMERA_TRACK_ENDED', 'TRACK_ENDED', true);
      this.stop();
    };
    track.addEventListener('ended', endedListener);
    this.camera = { stream, video, track, endedListener };
    await video.play();
    if (generation !== this.generation) {
      video.pause();
      video.srcObject = null;
      return false;
    }
    const hasFrameCallback =
      typeof (video as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback ===
      'function';
    if (!hasFrameCallback && typeof video.getVideoPlaybackQuality !== 'function')
      throw new Error('NEW_FRAME_DETECTION_UNAVAILABLE');
    return true;
  }

  private beginRun(generation: number, sessionId: string): void {
    this.sessionId = sessionId;
    this.clock = new FrameClock(this.nowUs);
    this.snapshotter = new Snapshotter(
      this.env,
      (this.options.snapshotStrategies ?? SNAPSHOT_STRATEGIES)[
        this.request.capture ?? DEFAULT_CAPTURE
      ],
      this.stats,
    );
    this.capture = new FrameCapture(
      () => this.captureContext(),
      this.nowUs,
      () => this.generation,
    );
    this.isVideoCallbackDisabled = false;
    this.timestamps = this.request.timestamps ?? DEFAULT_TIMESTAMPS;
    this.timestampFallback = null;
    this.state = 'running';
    this.lastProgressUs = this.nowUs();
    const setIntervalFn =
      this.env.setInterval?.bind(this.env) ??
      ((fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number);
    this.watchdog = setIntervalFn(() => this.checkStall(generation), WATCHDOG_INTERVAL_MS);
    this.schedule(generation);
    if (this.state !== 'running') throw new Error('NEW_FRAME_DETECTION_UNAVAILABLE');
    const settings = this.camera!.track.getSettings() as Record<
      string,
      string | number | boolean | undefined
    >;
    this.emit({
      type: 'ready',
      settings,
      capturePath: this.callbackKind === 'video' ? 'video-frame-callback' : 'decoded-frame-count',
    });
  }

  private captureContext(): CaptureContext {
    const camera = this.camera!;
    const generation = (): number => this.generation;
    const isRunning = (): boolean => this.state === 'running';
    return {
      get generation() {
        return generation();
      },
      get isRunning() {
        return isRunning();
      },
      sessionId: this.sessionId!,
      video: camera.video,
      track: camera.track,
      document: this.env.document!,
      gate: this.gate,
      preview: this.preview,
      clock: this.clock!,
      snapshotter: this.snapshotter!,
      stats: this.stats,
      timestamps: this.timestamps,
      useCallbackTimestamps: () => {
        if (this.timestamps === 'callback') return;
        this.timestamps = 'callback';
        this.timestampFallback = 'MEDIA_TIME_FROZEN';
        this.clock!.restartSource();
        this.emit({
          type: 'timestampsChanged',
          timestamps: 'callback',
          reason: 'MEDIA_TIME_FROZEN',
        });
      },
      geometryOptions: () => ({
        ...this.geometryOptions,
        ...(this.gate?.viewportGeometry() ?? {}),
        ...(this.geometryOptions.crop ? { crop: { ...this.geometryOptions.crop } } : {}),
      }),
      emit: (event) => this.emit(event),
      deliver: (frame) => this.options.consume(frame),
      progressed: () => {
        this.lastProgressUs = this.nowUs();
      },
    };
  }

  /** New-frame detection: requestVideoFrameCallback, or animation frames plus decoded-frame counts as the fallback. */
  private schedule(generation: number): void {
    if (generation !== this.generation || this.state !== 'running') return;
    const video = this.camera!.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
      ) => number;
    };
    if (!this.isVideoCallbackDisabled && typeof video.requestVideoFrameCallback === 'function') {
      this.callbackKind = 'video';
      try {
        this.callbackId = video.requestVideoFrameCallback((_now, metadata) => {
          if (generation !== this.generation || this.state !== 'running') return;
          this.callbackId = null;
          void this.capture!.capture(
            generation,
            metadata.mediaTime * 1e6,
            metadata.presentedFrames,
            (error) => this.captureFailed(error),
          );
          this.schedule(generation);
        });
      } catch {
        this.isVideoCallbackDisabled = true;
        if (
          typeof video.getVideoPlaybackQuality !== 'function' ||
          typeof this.env.requestAnimationFrame !== 'function'
        ) {
          this.fail('CAMERA_START_FAILED', 'NEW_FRAME_DETECTION_UNAVAILABLE', false);
          this.stop();
          return;
        }
        this.emit({
          type: 'capturePathChanged',
          capturePath: 'decoded-frame-count',
          reason: 'VIDEO_CALLBACK_FAILED',
        });
        this.schedule(generation);
      }
      return;
    }
    this.callbackKind = 'animation';
    this.callbackId = this.env.requestAnimationFrame!(() => {
      if (generation !== this.generation || this.state !== 'running') return;
      this.callbackId = null;
      const quality = video.getVideoPlaybackQuality();
      const presented = quality.totalVideoFrames - quality.droppedVideoFrames;
      if (Number.isSafeInteger(presented) && presented > 0) {
        void this.capture!.capture(generation, video.currentTime * 1e6, presented, (error) =>
          this.captureFailed(error),
        );
      }
      this.schedule(generation);
    });
  }

  private captureFailed(error: unknown): void {
    const failure = captureFailure(error);
    this.emit({
      type: 'failure',
      error: failure,
      detail: failure.code === 'CAMERA_CLOCK_RESET' ? 'SOURCE_CLOCK_RESET' : 'FRAME_CAPTURE_FAILED',
    });
    this.stop();
  }

  /** Changes geometry options; on a live stream this is a viewport-class change that masks and settles again. */
  updateGeometry(options: GeometryOptions): void {
    const next = { ...this.geometryOptions, ...options };
    const isChanged = JSON.stringify(next) !== JSON.stringify(this.geometryOptions);
    this.geometryOptions = next;
    if (isChanged && this.gate && this.state !== 'stopped') this.gate.trigger('geometry', false);
  }

  /** Two seconds without a delivered or gated frame: report a stall with a recommended fallback, and stop. */
  checkStall(generation = this.generation): void {
    if (
      generation !== this.generation ||
      this.state !== 'running' ||
      this.nowUs() - this.lastProgressUs! < STALL_LIMIT_US
    )
      return;
    const canFallback = this.request.capture !== 'canvas' || this.timestamps !== 'callback';
    const lastCallbackUs = this.capture?.lastCallbackUs ?? null;
    const detail =
      lastCallbackUs !== null && this.nowUs() - lastCallbackUs < 1_000_000
        ? 'CALLBACK_WITHOUT_NEW_PACKET'
        : 'NO_VIDEO_CALLBACK';
    this.fail('CAMERA_FRAME_STALLED', detail, canFallback, {
      recommended: canFallback ? { capture: 'canvas', timestamps: 'callback' } : null,
    });
    this.stop();
  }

  getDiagnostics(): Record<string, unknown> {
    const settings = (this.camera?.track.getSettings() ?? {}) as Record<string, unknown>;
    const video = this.camera?.video;
    const rect = video?.getBoundingClientRect?.();
    const capture = this.capture;
    return {
      state: this.state,
      sessionId: this.sessionId,
      generation: this.generation,
      callbackPath: this.callbackKind,
      capture: this.request.capture ?? DEFAULT_CAPTURE,
      timestamps: this.timestampFallback
        ? 'callback'
        : (this.request.timestamps ?? DEFAULT_TIMESTAMPS),
      timestampFallback: this.timestampFallback,
      lastPresented: capture?.lastPresented ?? null,
      sinceLastPacketUs: this.lastProgressUs === null ? null : this.nowUs() - this.lastProgressUs,
      sinceLastCallbackUs:
        capture?.lastCallbackUs == null ? null : this.nowUs() - capture.lastCallbackUs,
      settings: Object.fromEntries(
        ['width', 'height', 'frameRate', 'facingMode', 'resizeMode', 'zoom']
          .filter((k) => settings[k] !== undefined)
          .map((k) => [k, settings[k]]),
      ),
      geometry: capture?.latestGeometry ?? null,
      lastFrame: capture?.lastFrameDiagnostic ?? null,
      nativeDimensions: capture?.lastNativeDimensions ?? null,
      preview: video
        ? {
            intrinsicWidth: video.videoWidth,
            intrinsicHeight: video.videoHeight,
            renderedWidth: rect?.width ?? null,
            renderedHeight: rect?.height ?? null,
            surface: this.preview?.surface ?? null,
          }
        : null,
      viewportGate: this.gate?.getDiagnostics() ?? null,
      stats: { ...this.stats },
    };
  }

  private stopInternal(state: CameraRuntimeState): void {
    this.generation++;
    if (this.watchdog != null)
      (this.env.clearInterval?.bind(this.env) ?? clearInterval)(this.watchdog);
    this.watchdog = null;
    const camera = this.camera;
    if (this.callbackId != null) {
      if (this.callbackKind === 'video') {
        (
          camera?.video as { cancelVideoFrameCallback?: (id: number) => void } | undefined
        )?.cancelVideoFrameCallback?.(this.callbackId);
      } else this.env.cancelAnimationFrame?.(this.callbackId);
    }
    this.callbackId = null;
    if (camera) camera.track.removeEventListener('ended', camera.endedListener);
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }
    this.gate?.dispose();
    this.gate = null;
    this.isGateMasked = false;
    this.preview?.remove();
    this.preview = null;
    this.stream = null;
    this.video = null;
    this.camera = null;
    this.snapshotter?.dispose();
    this.snapshotter = null;
    this.state = state;
  }

  stop(): void {
    this.stopInternal('stopped');
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    this.stop();
    this.env.document?.removeEventListener('visibilitychange', this.visibilityListener);
  }
}
