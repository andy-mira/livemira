/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The camera as a frame source: one camera run per session. After delivery, the receiver owns each frame and its
// picture. Viewport transitions are forwarded only from the current run.

import { EngineError, type Frame, type ViewportTransition } from '@livemira/contracts';

import type {
  CameraEnvironment,
  CameraEvent,
  CameraRecovery,
  CameraRequest,
  GeometryOptions,
} from './camera-types.ts';
import { CameraRuntime } from './capture/camera-runtime.ts';
import type { SnapshotStrategy } from './capture/snapshot.ts';
import type { PreviewSurfaceFactory } from './preview/preview-surface.ts';
import type { ViewportStabilization } from './viewport/viewport-gate.ts';

export interface CameraSourceOptions {
  /** The element the camera preview is mounted in; null for capture without a preview. */
  readonly previewContainer: HTMLElement | null;
  readonly camera?: CameraRequest;
  readonly geometry?: GeometryOptions;
  /** Default on; false captures without the viewport gate (no masking during view changes). */
  readonly viewportStabilization?: Partial<ViewportStabilization> | false;
  readonly previewSurface?: PreviewSurfaceFactory;
  readonly snapshotStrategies?: Readonly<Record<'auto' | 'canvas', readonly SnapshotStrategy[]>>;
  readonly env?: CameraEnvironment;
  readonly nowUs?: () => number;
}

const aborted = (message: string): EngineError =>
  new EngineError('ABORTED', message, { isRecoverable: true });

export class CameraSource {
  private camera: CameraRequest;
  private geometry: GeometryOptions;
  private runtime: CameraRuntime | null = null;
  private isDisposed = false;
  private lifecycleGeneration = 0;
  private cancelStart: (() => void) | null = null;
  private abortCleanup: (() => void) | null = null;
  private lastDiagnostics: Record<string, unknown> | null = null;
  private lastRecovery: { detail: string; nextCamera: CameraRecovery } | null = null;
  private readonly transitionListeners = new Set<(transition: ViewportTransition) => void>();
  private readonly eventListeners = new Set<(event: CameraEvent) => void>();
  private readonly options: CameraSourceOptions;
  private readonly env: CameraEnvironment;

  constructor(options: CameraSourceOptions) {
    this.options = options;
    this.camera = { ...options.camera };
    this.geometry = { ...options.geometry };
    this.env = options.env ?? (globalThis as unknown as CameraEnvironment);
  }

  private assertUsable(): void {
    if (this.isDisposed)
      throw new EngineError('DISPOSED', 'Camera source disposed', { isRecoverable: false });
  }

  /** Begin and end of each viewport transition of the current camera run; between them no frames are delivered. */
  onViewportTransition(listener: (transition: ViewportTransition) => void): () => void {
    this.assertUsable();
    if (typeof listener !== 'function')
      throw new EngineError('INVALID_CONFIG', 'Transition listener must be a function', {
        isRecoverable: false,
      });
    this.transitionListeners.add(listener);
    return () => void this.transitionListeners.delete(listener);
  }

  onEvent(listener: (event: CameraEvent) => void): () => void {
    this.assertUsable();
    this.eventListeners.add(listener);
    return () => void this.eventListeners.delete(listener);
  }

  private forward(event: CameraEvent): void {
    if (
      event.type === 'failure' &&
      event.error.code === 'CAMERA_FRAME_STALLED' &&
      event.recommended
    ) {
      this.camera = { ...this.camera, ...event.recommended };
      this.lastRecovery = { detail: event.detail, nextCamera: event.recommended };
    }
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        // Observer isolation.
      }
    }
  }

  /** Starts a camera run for `sessionId`, delivering frames to `onFrame`. Aborting `signal` stops it. */
  async start(
    sessionId: string,
    onFrame: (frame: Frame) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.assertUsable();
    const generation = this.lifecycleGeneration + 1;
    await this.stop();
    if (generation !== this.lifecycleGeneration || this.isDisposed)
      throw aborted('Camera start superseded');
    if (signal.aborted) throw aborted('Camera start aborted');
    const runtime: CameraRuntime = new CameraRuntime({
      env: this.env,
      consume: onFrame,
      previewContainer: this.options.previewContainer,
      geometry: this.geometry,
      viewportStabilization: this.options.viewportStabilization ?? {},
      ...(this.options.previewSurface ? { previewSurface: this.options.previewSurface } : {}),
      ...(this.options.snapshotStrategies
        ? { snapshotStrategies: this.options.snapshotStrategies }
        : {}),
      ...(this.options.nowUs ? { nowUs: this.options.nowUs } : {}),
      onEvent: (event) => this.forward(event),
      onTransition: (event) => {
        if (this.runtime !== runtime) return;
        for (const listener of [...this.transitionListeners]) {
          try {
            listener(event);
          } catch {
            // Observer isolation.
          }
        }
      },
    });
    this.runtime = runtime;
    let rejectAbort: (error: EngineError) => void = () => {};
    const abortion = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = (): void => {
      runtime.stop();
      rejectAbort(aborted('Camera start aborted'));
    };
    this.cancelStart = abort;
    signal.addEventListener('abort', abort, { once: true });
    this.abortCleanup = () => signal.removeEventListener('abort', abort);
    try {
      await Promise.race([runtime.start(sessionId, this.camera), abortion]);
      if (runtime.state !== 'running')
        throw new EngineError('CAMERA_SUSPENDED', 'CAMERA_SUSPENDED', { isRecoverable: true });
    } catch (error) {
      if (this.runtime === runtime) await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
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

  /** Changes the camera (only while stopped) and the geometry options (a live change masks and settles again). */
  configure(change: {
    readonly camera?: CameraRequest;
    readonly geometry?: GeometryOptions;
  }): void {
    this.assertUsable();
    if (change.camera) {
      if (this.runtime)
        throw new EngineError('INVALID_CONFIG', 'Stop the engine before configuring its camera', {
          isRecoverable: true,
        });
      this.camera = { ...this.camera, ...change.camera };
    }
    if (change.geometry) {
      this.geometry = { ...this.geometry, ...change.geometry };
      this.runtime?.updateGeometry(change.geometry);
    }
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      ...(this.runtime?.getDiagnostics() ??
        this.lastDiagnostics ?? { state: 'stopped', sessionId: null }),
      recovery: this.lastRecovery,
    };
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = (await this.env.navigator?.mediaDevices?.enumerateDevices?.()) ?? [];
    return devices.filter((device) => device.kind === 'videoinput');
  }

  /** The current camera run's session clock, or null while not running. */
  nowSessionUs(): number | null {
    return this.runtime?.state === 'running' ? this.runtime.clock!.arrival() : null;
  }

  async dispose(): Promise<void> {
    this.isDisposed = true;
    try {
      await this.stop();
    } finally {
      this.transitionListeners.clear();
      this.eventListeners.clear();
    }
  }
}
