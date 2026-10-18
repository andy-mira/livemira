/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The public engine: one container in, everything else assembled inside it (camera, vision Worker, overlay renderer,
// extensions, diagnostics). The container gets three equal layers: the camera picture, the overlay video plane and
// the extension drawings, all letting pointer events through.

import {
  CameraSource,
  DEFAULT_CAPTURE,
  DEFAULT_TIMESTAMPS,
  type CameraEvent,
  type PreviewSurfaceFactory,
  type SnapshotStrategy,
} from '@livemira/camera';
import { EngineError, type EventContext, type TargetBundle } from '@livemira/contracts';
import type { TelemetrySink } from '@livemira/diagnostics';
import type { PlaybackRecovery } from '@livemira/media';
import { OverlayRenderer, MAX_LOSS_DISPLAY_GRACE_MS, type RevealOptions } from '@livemira/renderer';

import { engineBuildInfo } from '../build-info.ts';
import { defaultWorkerFactory } from '../worker/embedded-worker.ts';
import type { VisionCapability } from '../worker/protocol.ts';
import { VisionClient, type WorkerEndpoint } from '../worker/vision-client.ts';
import { EngineCore, type EngineState } from './engine-core.ts';
import type { EngineCapability, EngineEvents, SessionConfig, TargetMedia } from './engine-types.ts';
import { selectedExperiments } from './experiments.ts';
import { HostedOverlay, type EngineExtension, type ExtensionHandle } from './extension-host.ts';
import type { SessionFacts } from './session-config.ts';

export type ProcessingLongEdge = 480 | 640 | 960 | 'native';

export interface EngineOptions {
  /** Positioned element with a non-zero size. The engine adds its own layers inside it. */
  readonly container: HTMLElement;
  readonly camera?: {
    /** Default 'environment'. */
    readonly facingMode?: 'environment' | 'user';
    /** Overrides facingMode. */
    readonly deviceId?: string;
    /** Default 1280. */
    readonly idealWidthPx?: number;
    /** Default 720. */
    readonly idealHeightPx?: number;
    /** Default 640. */
    readonly processingLongEdge?: ProcessingLongEdge;
    /** How the camera picture fills the container; default 'cover'. */
    readonly fit?: 'contain' | 'cover';
    /** Default 'canvas'. */
    readonly capture?: 'auto' | 'canvas';
    /** Default 'callback'. */
    readonly timestamps?: 'media-time' | 'callback';
  };
  readonly tracking?: {
    /** 0..100, default 100. */
    readonly maxPredictionMs?: number;
    /** Visual hold after a loss, 0..1000, default 200. */
    readonly lossDisplayGraceMs?: number;
  };
  /** Loading mask and reveal on the video plane; false: the video simply appears. */
  readonly presentation?: RevealOptions | false;
  readonly adapters?: {
    readonly previewSurface?: PreviewSurfaceFactory;
    readonly snapshot?: readonly SnapshotStrategy[];
    readonly playbackRecoveries?: readonly PlaybackRecovery[];
    readonly workerFactory?: () => Worker | WorkerEndpoint;
  };
  readonly extensions?: readonly EngineExtension[];
  readonly diagnostics?: TelemetrySink;
}

export type CameraChange = Pick<
  NonNullable<EngineOptions['camera']>,
  'facingMode' | 'deviceId' | 'processingLongEdge' | 'fit'
>;

export interface Engine {
  readonly state: EngineState;
  /** Replaces all targets (1..10, unique ids) and their media. Only while idle. */
  setTargets(entries: readonly { target: TargetBundle; media?: TargetMedia }[]): Promise<void>;
  /** Sets, replaces or (null) clears one target's media; while running, the active media is released. */
  setTargetMedia(targetId: string, media: TargetMedia | null): void;
  /** Starts a session. Call from a user gesture so the camera prompt and playback can proceed. */
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  dispose(): Promise<void>;
  on<K extends keyof EngineEvents>(type: K, listener: (event: EngineEvents[K]) => void): () => void;
  readonly media: {
    /** From a user gesture. Resolves true when playback continued with the new muted state. */
    setMuted(isMuted: boolean): Promise<boolean>;
    /** From a user gesture after `playbackBlocked` or a media error. */
    retry(): Promise<boolean>;
  };
  readonly camera: {
    list(): Promise<readonly { deviceId: string; label: string }[]>;
    /** Only while idle; applies to the next start. */
    configure(change: CameraChange): void;
  };
  /** Current event context (same clock and domain as events). */
  getEventContext(): EventContext;
  getDiagnostics(): Record<string, unknown>;
}

const invalid = (message: string): EngineError =>
  new EngineError('INVALID_CONFIG', message, { isRecoverable: false });

/** The camera diagnostics fields the engine reads. */
interface CameraDiagnosticsView {
  readonly state?: string;
  readonly sessionId?: string | null;
  readonly geometry?: SessionConfig['geometry'];
  readonly settings?: Readonly<Record<string, string | number | boolean>>;
  readonly lastFrame?: {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly timestampSource: 'media-time' | 'callback';
  } | null;
  readonly preview?: {
    readonly intrinsicWidth: number;
    readonly intrinsicHeight: number;
    readonly renderedWidth: number | null;
    readonly renderedHeight: number | null;
    readonly surface: 'canvas' | 'video' | null;
  } | null;
}

const LONG_EDGES: readonly unknown[] = [480, 640, 960, 'native'];
const DEFAULT_LOSS_DISPLAY_GRACE_MS = 200;

function oneOf<T>(value: unknown, allowed: readonly T[], name: string): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) throw invalid(`Invalid ${name}`);
  return value as T;
}

function validateCamera(camera: EngineOptions['camera'] = {}): void {
  oneOf(camera.facingMode, ['environment', 'user'], 'camera.facingMode');
  oneOf(camera.processingLongEdge, LONG_EDGES, 'camera.processingLongEdge');
  oneOf(camera.fit, ['contain', 'cover'], 'camera.fit');
  oneOf(camera.capture, ['auto', 'canvas'], 'camera.capture');
  oneOf(camera.timestamps, ['media-time', 'callback'], 'camera.timestamps');
  if (camera.deviceId !== undefined && (typeof camera.deviceId !== 'string' || !camera.deviceId))
    throw invalid('Invalid camera.deviceId');
  for (const key of ['idealWidthPx', 'idealHeightPx'] as const) {
    const value = camera[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 8192))
      throw invalid(`Invalid camera.${key}`);
  }
}

function layer(doc: Document, name: string, zIndex: number): HTMLElement {
  const element = doc.createElement('div');
  Object.assign(element.style, {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    zIndex: String(zIndex),
  });
  element.setAttribute('data-livemira-layer', name);
  return element;
}

/** Creates an engine in `options.container`. Throws INVALID_CONFIG for invalid options. */
export function createEngine(options: EngineOptions): Engine {
  if (!options || typeof options !== 'object') throw invalid('Engine options required');
  const container = options.container;
  if (!container || typeof container !== 'object' || !container.ownerDocument)
    throw invalid('A container element is required');
  validateCamera(options.camera);
  const camera = { ...options.camera };
  const tracking = { ...options.tracking };
  // Only an absent value means the default; null is invalid like any other non-number. The default 200 ms bridges the
  // brief losses right after a target is found, which otherwise make the overlay flash.
  const grace =
    tracking.lossDisplayGraceMs === undefined
      ? DEFAULT_LOSS_DISPLAY_GRACE_MS
      : tracking.lossDisplayGraceMs;
  if (
    typeof grace !== 'number' ||
    !Number.isFinite(grace) ||
    grace < 0 ||
    grace > MAX_LOSS_DISPLAY_GRACE_MS
  )
    throw invalid('tracking.lossDisplayGraceMs must be in [0,1000] ms');
  const extensions = [...(options.extensions ?? [])];
  for (const extension of extensions) {
    if (!extension || typeof extension.attach !== 'function' || typeof extension.name !== 'string')
      throw invalid('Invalid extension');
  }
  const needs = {
    matchedPoints: extensions.some((e) => e.needs?.matchedPoints === true),
    recognitionTrace: extensions.some((e) => e.needs?.recognitionTrace === true),
  };
  const adapters = { ...options.adapters };
  const telemetry = options.diagnostics;
  const experiments = selectedExperiments();

  const doc = container.ownerDocument;
  const cameraLayer = layer(doc, 'camera', 0);
  const overlayLayer = layer(doc, 'overlay', 1);
  const extensionLayer = layer(doc, 'extensions', 2);

  const cameraSource = new CameraSource({
    previewContainer: cameraLayer,
    camera: {
      facingMode: camera.facingMode ?? 'environment',
      ...(camera.deviceId !== undefined ? { deviceId: camera.deviceId } : {}),
      ...(camera.idealWidthPx !== undefined ? { idealWidthPx: camera.idealWidthPx } : {}),
      ...(camera.idealHeightPx !== undefined ? { idealHeightPx: camera.idealHeightPx } : {}),
      ...(camera.capture !== undefined ? { capture: camera.capture } : {}),
      ...(camera.timestamps !== undefined ? { timestamps: camera.timestamps } : {}),
    },
    geometry: { longEdge: camera.processingLongEdge ?? 640, fit: camera.fit ?? 'cover' },
    ...(adapters.previewSurface ? { previewSurface: adapters.previewSurface } : {}),
    ...(adapters.snapshot ? { snapshotStrategies: { auto: adapters.snapshot, canvas: [] } } : {}),
  });

  let core: EngineCore | null = null;
  let workerCapability: VisionCapability | null = null;
  let capturePath: EngineCapability['capturePath'] = null;
  let clockOffsetUs: number | null = null;
  /** Callback timestamps the camera switched to on its own (its media time did not advance), for this run. */
  let timestampFallback: 'callback' | null = null;

  const renderer = new OverlayRenderer({
    ...(options.presentation !== undefined ? { presentation: options.presentation } : {}),
    ...(adapters.playbackRecoveries ? { recoveries: adapters.playbackRecoveries } : {}),
  });
  const hosted = new HostedOverlay(renderer, extensionLayer);

  const vision = new VisionClient({
    workerFactory:
      (adapters.workerFactory as (() => WorkerEndpoint) | undefined) ?? defaultWorkerFactory(),
    options: {
      collectMatchedPoints: needs.matchedPoints,
      observeRecognition: needs.recognitionTrace,
    },
    onCapability: (capability) => {
      workerCapability = capability;
      core?.refreshCapability();
      core?.refreshSessionConfig();
    },
    onTiming: (frame, generation, timing) => {
      if (!telemetry?.wantsFrameDetail) return;
      try {
        telemetry.workerTiming?.({
          sessionId: frame.sessionId,
          frameId: frame.frameId,
          generation,
          timing: { ...timing } as never,
        });
      } catch {
        // Diagnostics cannot interrupt the engine.
      }
    },
    onFailure: (error) => {
      if (!core || core.state !== 'running') return;
      core.emit('error', { ...core.context(), error });
      void core.stop('worker-failure').catch(() => {});
    },
    onResult: (result) => {
      if (telemetry?.wantsFrameDetail) {
        try {
          telemetry.result?.(result);
        } catch {
          // Diagnostics cannot interrupt the engine.
        }
      }
      hosted.result(result);
    },
    onRecognitionTrace: (trace) => hosted.trace(trace),
  });

  const capability = (): EngineCapability => {
    const diagnostics = cameraSource.getDiagnostics() as {
      preview?: { surface?: 'canvas' | 'video' } | null;
    };
    return {
      engine: {
        version: engineBuildInfo.version,
        buildId: engineBuildInfo.buildId,
        format: engineBuildInfo.format,
        variant: engineBuildInfo.variant,
      },
      previewSurface: diagnostics.preview?.surface ?? null,
      capturePath,
      capture: camera.capture ?? DEFAULT_CAPTURE,
      execution: workerCapability ? 'worker' : null,
      workerGeneration: workerCapability?.generation ?? null,
      algorithmVersion: workerCapability?.algorithmVersion ?? null,
      matching: workerCapability?.matching ?? null,
      matchingSelection: workerCapability?.matchingSelection ?? null,
      matchingFallback: workerCapability?.matchingFallback ?? null,
      fallbackReason: workerCapability?.fallbackReason ?? null,
    };
  };

  const sessionFacts = (): SessionFacts => {
    const d = cameraSource.getDiagnostics() as CameraDiagnosticsView;
    const isCurrent = core !== null && d.sessionId === core.sessionId && d.state === 'running';
    const geometry = isCurrent ? (d.geometry as SessionConfig['geometry']) : null;
    const lastFrame = isCurrent ? d.lastFrame : null;
    return {
      requestedLongEdge: camera.processingLongEdge ?? 640,
      processingLongEdge: geometry
        ? Math.max(geometry.standardWidthPx, geometry.standardHeightPx)
        : null,
      inputWidthPx: lastFrame?.widthPx ?? null,
      inputHeightPx: lastFrame?.heightPx ?? null,
      previewWidthCss: isCurrent ? (d.preview?.renderedWidth ?? null) : null,
      previewHeightCss: isCurrent ? (d.preview?.renderedHeight ?? null) : null,
      previewSurface: isCurrent ? (d.preview?.surface ?? null) : null,
      devicePixelRatio: geometry?.devicePixelRatio ?? null,
      geometry,
      cameraSettings: isCurrent ? (d.settings ?? {}) : {},
      capture: camera.capture ?? DEFAULT_CAPTURE,
      timestampSource: isCurrent
        ? (timestampFallback ??
          lastFrame?.timestampSource ??
          camera.timestamps ??
          DEFAULT_TIMESTAMPS)
        : null,
      cameraClockMapping:
        clockOffsetUs === null ? null : { sourceToSessionOffsetUs: clockOffsetUs },
      clockDomain: isCurrent ? 'source-session' : null,
    };
  };

  core = new EngineCore({
    source: cameraSource,
    pipeline: vision,
    overlay: hosted,
    ...(tracking.maxPredictionMs !== undefined
      ? { maxPredictionMs: tracking.maxPredictionMs }
      : {}),
    lossDisplayGraceMs: grace,
    presentationModes: {
      isMotionAdaptive: experiments.motionAdaptiveHold,
      // Hold a target measured only once for at most 100 ms to limit acquisition flashes.
      unknownMotionHoldMs: 100,
      isReconfirmAfterHide: experiments.reconfirmAfterHide,
    },
    ...(telemetry ? { telemetry } : {}),
    sessionFacts,
    capability,
    sessionIdPrefix: `${crypto.randomUUID().slice(0, 8)}-`,
  });
  const engineCore = core;
  // Each session maps its own camera clock: the previous session's offset is forgotten when a new attempt begins.
  engineCore.on('attemptStart', () => {
    clockOffsetUs = null;
  });

  // Camera events become engine events; a camera that stops ends the session (design 04 §5, Q6).
  const onCameraEvent = (event: CameraEvent): void => {
    const context = engineCore.context();
    switch (event.type) {
      case 'permission':
        engineCore.emit('cameraPermission', {
          ...context,
          phase: event.phase,
          permission: event.permission,
        });
        break;
      case 'ready':
        capturePath = event.capturePath;
        timestampFallback = null;
        break;
      case 'timestampsChanged':
        // A new source clock: the next frame maps it again.
        timestampFallback = event.timestamps;
        clockOffsetUs = null;
        engineCore.refreshSessionConfig();
        break;
      case 'capturePathChanged':
        capturePath = event.capturePath;
        engineCore.refreshCapability();
        break;
      case 'pictureSize':
        engineCore.emit('cameraSize', {
          ...context,
          widthPx: event.widthPx,
          heightPx: event.heightPx,
        });
        break;
      case 'geometryChanged':
        engineCore.refreshSessionConfig();
        break;
      case 'clockMapping':
        if (clockOffsetUs === null) {
          clockOffsetUs = event.sourceToSessionOffsetUs;
          engineCore.refreshSessionConfig();
        }
        break;
      case 'failure':
        engineCore.emit('cameraStatus', {
          ...context,
          code: event.error.code,
          detail: event.detail,
        });
        if (engineCore.state === 'running') void engineCore.stop('camera-error').catch(() => {});
        break;
      case 'suspended':
        engineCore.emit('cameraStatus', {
          ...context,
          code: 'CAMERA_SUSPENDED',
          detail: 'suspended',
        });
        if (engineCore.state === 'running')
          void engineCore.stop('camera-suspended').catch(() => {});
        break;
    }
  };
  const unsubscribeCamera = cameraSource.onEvent(onCameraEvent);
  // Registered before any session subscription, so the event precedes the engine's own handling.
  const unsubscribeTransition = cameraSource.onViewportTransition((transition) => {
    const d = cameraSource.getDiagnostics() as CameraDiagnosticsView;
    const rect = cameraLayer.getBoundingClientRect?.();
    engineCore.emit('viewportTransition', {
      ...engineCore.context(),
      phase: transition.phase,
      epoch: transition.epoch,
      reason: transition.reason,
      sizes: {
        viewportWidthCss: rect ? rect.width : null,
        viewportHeightCss: rect ? rect.height : null,
        cameraWidthPx: d.preview?.intrinsicWidth ?? null,
        cameraHeightPx: d.preview?.intrinsicHeight ?? null,
      },
    });
  });

  const view = doc.defaultView;
  const pageEvent = (visibility: 'hidden' | 'visible' | 'pagehide' | 'pageshow') => (): void =>
    engineCore.emit('pageVisibility', { ...engineCore.context(), visibility });
  const onVisibility = (): void => pageEvent(doc.hidden ? 'hidden' : 'visible')();
  const onPageHide = pageEvent('pagehide');
  const onPageShow = pageEvent('pageshow');
  doc.addEventListener('visibilitychange', onVisibility);
  view?.addEventListener('pagehide', onPageHide);
  view?.addEventListener('pageshow', onPageShow);

  container.append(cameraLayer, overlayLayer, extensionLayer);
  const handles: ExtensionHandle[] = [];
  for (const extension of extensions) {
    try {
      handles.push(extension.attach(hosted));
    } catch (cause) {
      for (const handle of handles) handle.detach();
      throw new EngineError('INVALID_CONFIG', `Extension ${extension.name} failed to attach`, {
        isRecoverable: false,
        cause,
      });
    }
  }

  let isTornDown = false;
  const teardown = (): void => {
    if (isTornDown) return;
    isTornDown = true;
    for (const handle of handles) {
      try {
        handle.detach();
      } catch {
        // An extension cannot block disposal.
      }
    }
    unsubscribeCamera();
    unsubscribeTransition();
    doc.removeEventListener('visibilitychange', onVisibility);
    view?.removeEventListener('pagehide', onPageHide);
    view?.removeEventListener('pageshow', onPageShow);
    cameraLayer.remove();
    overlayLayer.remove();
    extensionLayer.remove();
  };

  return {
    get state() {
      return engineCore.state;
    },
    async setTargets(entries) {
      if (!Array.isArray(entries))
        throw new EngineError('INVALID_TARGET', 'Targets required', { isRecoverable: false });
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || !entry.target)
          throw new EngineError('INVALID_TARGET', 'Each entry needs a target', {
            isRecoverable: false,
          });
      }
      await engineCore.setTargets(entries.map((e) => e.target));
      for (const entry of entries)
        engineCore.setTargetMedia(entry.target.targetId, entry.media ?? null);
    },
    setTargetMedia: (targetId, media) => engineCore.setTargetMedia(targetId, media),
    start: () => engineCore.start(overlayLayer),
    stop: (reason) => engineCore.stop(reason),
    async dispose() {
      try {
        await engineCore.dispose();
      } finally {
        teardown();
      }
    },
    on: (type, listener) => engineCore.on(type, listener),
    media: {
      setMuted: (isMuted) => renderer.setMutedFromGesture(isMuted),
      retry: () =>
        renderer.getDiagnostics().isFailed
          ? renderer.retryFromGesture()
          : renderer.resumeBlockedFromGesture(),
    },
    camera: {
      async list() {
        const devices = await cameraSource.listCameras();
        return devices.map((d) => ({ deviceId: d.deviceId, label: d.label }));
      },
      configure(change) {
        if (engineCore.state !== 'idle')
          throw new EngineError('INVALID_CONFIG', 'Configure the camera while the engine is idle', {
            isRecoverable: true,
          });
        validateCamera(change);
        Object.assign(camera, change);
        cameraSource.configure({
          ...(change.facingMode !== undefined || change.deviceId !== undefined
            ? {
                camera: {
                  ...(change.facingMode !== undefined ? { facingMode: change.facingMode } : {}),
                  ...(change.deviceId !== undefined ? { deviceId: change.deviceId } : {}),
                },
              }
            : {}),
          ...(change.processingLongEdge !== undefined || change.fit !== undefined
            ? {
                geometry: {
                  ...(change.processingLongEdge !== undefined
                    ? { longEdge: change.processingLongEdge }
                    : {}),
                  ...(change.fit !== undefined ? { fit: change.fit } : {}),
                },
              }
            : {}),
        });
      },
    },
    getEventContext: () => engineCore.context(),
    getDiagnostics: () => ({
      state: engineCore.state,
      sessionId: engineCore.sessionId,
      capability: capability(),
      camera: cameraSource.getDiagnostics(),
      renderer: renderer.getDiagnostics(),
      build: engineBuildInfo,
      experiments,
    }),
  };
}
