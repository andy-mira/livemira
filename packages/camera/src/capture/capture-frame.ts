/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// One capture: from a new-frame callback to a delivered Frame. Every asynchronous step re-checks that the camera run
// (generation) and the viewport epoch are still the ones the capture began under; anything stale is released.

import { EngineError, type Frame, type FrameGeometry, type FrameImage } from '@livemira/contracts';

import type { CameraEvent } from '../camera-types.ts';
import { createGeometry, type GeometryParams } from '../geometry/frame-geometry.ts';
import { createOwnedImage } from '../owned-image.ts';
import type { PreviewLayer } from '../preview/preview-layer.ts';
import type { GateToken, ViewportGate } from '../viewport/viewport-gate.ts';
import type { FrameClock, FrameClockReading } from './frame-clock.ts';
import type { NativePicture, NativeSnapshot, Snapshotter, SnapshotStats } from './snapshot.ts';

export interface CaptureStats extends SnapshotStats {
  duplicateCallbacks: number;
  busyDrops: number;
  staleDrops: number;
  missedPresented: number;
  snapshotDimensionMismatches: number;
  dimensionChangeDrops: number;
  transitionDrops: number;
}

export interface LastFrameDiagnostic {
  readonly frameId: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly format: FrameImage['format'];
  readonly sourceTimestampUs: number;
  readonly reportedMediaTimeUs: number;
  readonly timestampSource: 'media-time' | 'callback';
  readonly arrivalTimeUs: number;
  readonly observationTimeUs: number;
  readonly snapshotCompleteTimeUs: number;
}

/** What a capture needs from the camera run that owns it. */
export interface CaptureContext {
  readonly generation: number;
  readonly isRunning: boolean;
  readonly sessionId: string;
  readonly video: HTMLVideoElement;
  readonly track: MediaStreamTrack;
  readonly document: Document;
  readonly gate: ViewportGate | null;
  readonly preview: PreviewLayer | null;
  readonly clock: FrameClock;
  readonly snapshotter: Snapshotter;
  readonly stats: CaptureStats;
  readonly timestamps: 'media-time' | 'callback';
  /** Switches the run to callback timestamps (its media time does not advance). */
  useCallbackTimestamps(): void;
  geometryOptions(): Omit<GeometryParams, 'widthPx' | 'heightPx'>;
  emit(event: CameraEvent): void;
  deliver(frame: Frame): void;
  progressed(): void;
}

/**
 * New pictures in a row that repeat the previous media time before the run gives up on the media clock. Some browsers
 * never advance a camera stream's media time; one repeat can be a browser quirk, three (about 0.1 s) are not.
 */
const FROZEN_MEDIA_TIME_PICTURES = 3;

/** Per-run capture state. */
export class FrameCapture {
  frameId = 0;
  lastPresented = -1;
  lastCallbackUs: number | null = null;
  latestGeometry: FrameGeometry | null = null;
  lastFrameDiagnostic: LastFrameDiagnostic | null = null;
  lastNativeDimensions: Record<string, number | null> | null = null;
  private isSnapshotBusy = false;
  private repeatedMediaTimes = 0;
  private geometryKey: string | null = null;
  private layoutKey: string | null = null;
  private readonly context: () => CaptureContext;
  private readonly nowUs: () => number;
  /** The run's current generation; readable after the camera stopped, when no context can be built any more. */
  private readonly generation: () => number;

  constructor(context: () => CaptureContext, nowUs: () => number, generation: () => number) {
    this.context = context;
    this.nowUs = nowUs;
    this.generation = generation;
  }

  /** Handles one new-frame callback. Errors end the camera run through `onFailure`. */
  async capture(
    generation: number,
    sourceTimestampUs: number,
    presentedFrames: number,
    onFailure: (error: unknown) => void,
  ): Promise<void> {
    const run = this.context();
    if (generation !== run.generation || !run.isRunning) return;
    this.lastCallbackUs = this.nowUs();
    if (!Number.isSafeInteger(presentedFrames) || presentedFrames <= 0) return;
    if (presentedFrames <= this.lastPresented) {
      run.stats.duplicateCallbacks++;
      return;
    }
    if (this.lastPresented >= 0)
      run.stats.missedPresented += Math.max(0, presentedFrames - this.lastPresented - 1);
    this.lastPresented = presentedFrames;
    if (this.isSnapshotBusy) {
      run.stats.busyDrops++;
      return;
    }
    const geometryOptions = run.geometryOptions();
    const settings = run.track.getSettings();
    const gate = run.gate;
    const gateToken = gate?.begin() ?? null;
    const video = run.video;
    if (!video.videoWidth || !video.videoHeight) return;
    const inputWidth = video.videoWidth;
    const inputHeight = video.videoHeight;
    let handle: FrameImage | null = null;
    this.isSnapshotBusy = true;
    try {
      const reportedMediaTimeUs = sourceTimestampUs;
      const arrivalTimeUs = run.clock.arrival();
      if (run.timestamps === 'callback') sourceTimestampUs = arrivalTimeUs;
      const timing = run.clock.observe(sourceTimestampUs, arrivalTimeUs);
      if (!timing) {
        run.stats.duplicateCallbacks++;
        // The presented count advanced, so this is a new picture with the previous media time.
        if (
          run.timestamps === 'media-time' &&
          ++this.repeatedMediaTimes >= FROZEN_MEDIA_TIME_PICTURES
        )
          run.useCallbackTimestamps();
        return;
      }
      this.repeatedMediaTimes = 0;
      // Canvas readback draws the standard image with the very geometry the frame is delivered with.
      const standardGeometry = createGeometry({
        ...geometryOptions,
        widthPx: inputWidth,
        heightPx: inputHeight,
      });
      // Only an asynchronous strategy adds an asynchronous step; otherwise the frame is delivered synchronously within
      // the new-frame callback, before the next callback is requested.
      const isCurrent = (): boolean => generation === this.generation();
      const native = run.snapshotter.takeNative(run.video, sourceTimestampUs, isCurrent);
      handle = this.snapshot(
        run,
        generation,
        gateToken,
        inputWidth,
        inputHeight,
        native instanceof Promise ? await native : native,
        standardGeometry,
      );
      if (!handle) return;
      run.stats.snapshots++;
      if (generation !== this.generation()) {
        run.stats.staleDrops++;
        handle.release();
        handle = null;
        return;
      }
      const delivered = this.admitAndDeliver(run, generation, gateToken, handle, {
        inputWidth,
        inputHeight,
        settings,
        geometryOptions,
        timing,
        reportedMediaTimeUs,
        presentedFrames,
        standardGeometry,
      });
      if (delivered) handle = null;
    } catch (error) {
      handle?.release();
      run.stats.snapshotFailures++;
      if (generation === this.generation()) onFailure(error);
    } finally {
      this.isSnapshotBusy = false;
    }
  }

  /** Owns the native picture, or reads the frame back when there is none usable. Null when stale. */
  private snapshot(
    run: CaptureContext,
    generation: number,
    gateToken: GateToken | null,
    inputWidth: number,
    inputHeight: number,
    native: NativeSnapshot | null,
    standardGeometry: FrameGeometry,
  ): FrameImage | null {
    let value: NativePicture | null = native?.picture ?? null;
    if (generation !== this.generation()) {
      value?.close?.();
      run.stats.staleDrops++;
      return null;
    }
    if (run.gate && gateToken && run.gate.epoch !== gateToken.epoch) {
      value?.close?.();
      run.stats.transitionDrops++;
      return null;
    }
    if (value && (run.video.videoWidth !== inputWidth || run.video.videoHeight !== inputHeight)) {
      value.close?.();
      run.stats.dimensionChangeDrops++;
      return null;
    }
    if (value) {
      const displayWidth = value.displayWidth ?? (value as ImageBitmap).width;
      const displayHeight = value.displayHeight ?? (value as ImageBitmap).height;
      const frame = value as VideoFrame;
      this.lastNativeDimensions = {
        videoWidth: inputWidth,
        videoHeight: inputHeight,
        displayWidth,
        displayHeight,
        codedWidth: frame.codedWidth ?? null,
        codedHeight: frame.codedHeight ?? null,
      };
      if (displayWidth !== inputWidth || displayHeight !== inputHeight) {
        // Never stretch the live video to guessed decoder or display dimensions.
        value.close?.();
        value = null;
        run.stats.snapshotDimensionMismatches++;
      }
    }
    if (value) {
      return native!.format === 'video-frame'
        ? createOwnedImage('video-frame', value as VideoFrame)
        : createOwnedImage('image-bitmap', value as ImageBitmap);
    }
    if (generation !== this.generation()) return null;
    // Drawn straight into the standard image: a quarter of the full picture at the default 640 long edge, and the
    // Worker only converts it to gray.
    return createOwnedImage(
      'standard-rgba8',
      run.snapshotter.readback(run.document, run.video, standardGeometry),
      () => {},
    );
  }

  private admitAndDeliver(
    run: CaptureContext,
    generation: number,
    gateToken: GateToken | null,
    handle: FrameImage,
    capture: {
      inputWidth: number;
      inputHeight: number;
      settings: MediaTrackSettings;
      geometryOptions: Omit<GeometryParams, 'widthPx' | 'heightPx'>;
      timing: FrameClockReading;
      reportedMediaTimeUs: number;
      presentedFrames: number;
      standardGeometry: FrameGeometry;
    },
  ): boolean {
    const { inputWidth, inputHeight, settings, geometryOptions } = capture;
    const gate = run.gate;
    // The frame's own geometry. During a transition the gate prepares it under the mask first and applies it again
    // (with the published geometry) immediately before it unmasks, so no notification or picture can precede it.
    let geometry: FrameGeometry | null = capture.standardGeometry;
    let isCommitted = false;
    const build = (): FrameGeometry =>
      (geometry ??= createGeometry({
        ...geometryOptions,
        widthPx: inputWidth,
        heightPx: inputHeight,
      }));
    // Host layout hook: the capture's intrinsic size, announced once per size and only while a preview is mounted behind a
    // gate. The host may relayout synchronously; the gate then sees a changed view, re-arms, and the new layout settles
    // under the mask. It is never announced from a visible, unmasked picture.
    const announce = (): void => {
      const layoutKey = `${inputWidth}x${inputHeight}`;
      if (!gate || !run.preview || this.layoutKey === layoutKey) return;
      this.layoutKey = layoutKey;
      run.emit({ type: 'pictureSize', widthPx: inputWidth, heightPx: inputHeight });
    };
    const prepare = (): void => {
      announce();
      if (generation !== this.generation()) return;
      run.preview?.update(build(), inputWidth, inputHeight);
    };
    const commit = (): void => {
      isCommitted = true;
      this.latestGeometry = build();
      run.preview?.update(this.latestGeometry, inputWidth, inputHeight);
    };
    if (gate) {
      // The very first frame finds the gate open and no geometry applied: announce before it, while the video is hidden.
      if (!gate.isGated && this.layoutKey === null) {
        announce();
        if (generation !== this.generation()) return this.drop(run, handle, 'staleDrops');
      }
      const sig = JSON.stringify([
        inputWidth,
        inputHeight,
        settings.deviceId,
        (settings as { zoom?: number }).zoom,
        geometryOptions,
      ]);
      if (!gate.admit(gateToken!, sig, `${inputWidth}x${inputHeight}`, { prepare, commit })) {
        // A dropped transition frame is still fresh evidence that the camera is alive.
        handle.release();
        run.stats.transitionDrops++;
        run.progressed();
        return true;
      }
      if (generation !== this.generation()) return this.drop(run, handle, 'staleDrops');
    }
    if (!isCommitted) commit();
    const frameGeometry = build();
    const key = JSON.stringify([
      inputWidth,
      inputHeight,
      settings.deviceId,
      (settings as { zoom?: number }).zoom,
      frameGeometry,
    ]);
    if (key !== this.geometryKey) {
      this.geometryKey = key;
      run.emit({ type: 'geometryChanged', geometry: frameGeometry });
      if (generation !== this.generation() || (gate && gate.epoch !== gateToken!.epoch))
        return this.drop(run, handle);
    }
    return this.deliver(run, generation, gateToken, handle, capture);
  }

  private deliver(
    run: CaptureContext,
    generation: number,
    gateToken: GateToken | null,
    handle: FrameImage,
    capture: {
      inputWidth: number;
      inputHeight: number;
      timing: FrameClockReading;
      reportedMediaTimeUs: number;
      presentedFrames: number;
    },
  ): boolean {
    const { inputWidth, inputHeight, timing } = capture;
    const latest = this.latestGeometry!;
    const frame: Frame = {
      sessionId: run.sessionId,
      frameId: this.frameId++,
      pictureKey: `${run.sessionId}:${capture.presentedFrames}`,
      timing: {
        sourceTimestampUs: timing.sourceTimestampUs,
        timestampSource: run.timestamps,
        arrivalTimeUs: timing.arrivalTimeUs,
        observationTimeUs: timing.observationTimeUs,
      },
      widthPx: inputWidth,
      heightPx: inputHeight,
      geometry: Object.freeze({
        ...latest,
        crop: Object.freeze({ ...latest.crop }),
        H_standardFromInput: Object.freeze([
          ...latest.H_standardFromInput,
        ]) as unknown as FrameGeometry['H_standardFromInput'],
        H_viewportFromStandard: Object.freeze([
          ...latest.H_viewportFromStandard,
        ]) as unknown as FrameGeometry['H_viewportFromStandard'],
      }),
      image: handle,
    };
    run.emit({ type: 'clockMapping', sourceToSessionOffsetUs: timing.sourceToSessionOffsetUs });
    if (generation !== this.generation() || (run.gate && run.gate.epoch !== gateToken!.epoch))
      return this.drop(run, handle);
    this.lastFrameDiagnostic = {
      frameId: frame.frameId,
      widthPx: inputWidth,
      heightPx: inputHeight,
      format: handle.format,
      sourceTimestampUs: timing.sourceTimestampUs,
      reportedMediaTimeUs: capture.reportedMediaTimeUs,
      timestampSource: run.timestamps,
      arrivalTimeUs: timing.arrivalTimeUs,
      observationTimeUs: timing.observationTimeUs,
      snapshotCompleteTimeUs: run.clock.arrival(),
    };
    run.deliver(frame);
    run.progressed();
    return true;
  }

  private drop(run: CaptureContext, handle: FrameImage, counter?: 'staleDrops'): true {
    if (counter) run.stats[counter]++;
    handle.release();
    return true;
  }
}

/** The failure event of a capture error. */
export function captureFailure(error: unknown): EngineError {
  return error instanceof EngineError && error.code === 'CAMERA_CLOCK_RESET'
    ? error
    : new EngineError('CAMERA_CAPTURE_FAILED', 'FRAME_CAPTURE_FAILED', {
        isRecoverable: true,
        cause: error,
      });
}
