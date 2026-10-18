/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Corners,
  CoreEvents,
  EngineError,
  ErrorCode,
  EventContext,
  Frame,
  FrameGeometry,
  RectPx,
  TargetBundle,
  TrackingResult,
  TrackingState,
  ViewportTransition,
} from '@livemira/contracts';
import type { MediaConfig, MediaSnapshot, MediaState } from '@livemira/media';
import type {
  MediaOptions,
  RendererEvent,
  TargetMediaSource,
  TargetSize,
} from '@livemira/renderer';

/** A target's media: a URL or a file, with its playback policy. */
export type TargetMedia = ({ readonly url: string } | { readonly file: Blob }) &
  Omit<MediaConfig, 'url'>;

/** Configuration of a session, captured at its start and when camera or capability facts change. */
export interface SessionConfig {
  readonly targets: readonly {
    readonly targetId: string;
    readonly imageHash: string;
    readonly algorithmVersion: string;
    readonly compilerVersion: string;
    readonly widthPx: number;
    readonly heightPx: number;
  }[];
  readonly media: readonly {
    readonly targetId: string;
    /** SHA-256 of the URL or of the file bytes; never the URL itself. */
    readonly identityHash: string | null;
    readonly identityKind: 'url-sha256' | 'file-sha256' | null;
    readonly fit: 'contain' | 'cover';
  }[];
  readonly maxPredictionMs: number;
  readonly lossDisplayGraceMs: number;
  readonly requestedLongEdge: 480 | 640 | 960 | 'native' | null;
  readonly processingLongEdge: number | null;
  readonly inputWidthPx: number | null;
  readonly inputHeightPx: number | null;
  readonly previewWidthCss: number | null;
  readonly previewHeightCss: number | null;
  readonly previewSurface: 'canvas' | 'video' | null;
  readonly devicePixelRatio: number | null;
  readonly geometry: FrameGeometry | null;
  readonly cameraSettings: Readonly<Record<string, string | number | boolean>>;
  readonly capture: 'auto' | 'canvas' | null;
  readonly timestampSource: 'media-time' | 'callback' | null;
  readonly cameraClockMapping: { readonly sourceToSessionOffsetUs: number } | null;
  readonly clockDomain: 'source-session' | null;
}

/** What actually runs: engine build, preview surface, frame detection and the matching operator in the Worker. */
export interface EngineCapability {
  readonly engine: {
    readonly version: string;
    readonly buildId: string | null;
    readonly format: string;
    readonly variant: string | null;
  };
  readonly previewSurface: 'canvas' | 'video' | null;
  readonly capturePath: 'video-frame-callback' | 'decoded-frame-count' | null;
  readonly capture: 'auto' | 'canvas' | null;
  readonly execution: 'worker' | null;
  readonly workerGeneration: number | null;
  readonly algorithmVersion: string | null;
  readonly matching: string | null;
  readonly matchingSelection: string | null;
  readonly matchingFallback: string | null;
  readonly fallbackReason: string | null;
}

/** Engine estimates of where a target was in one camera frame, in captured-input pixels; never image truth. */
export interface TargetFrameExtent {
  readonly sessionId: string;
  readonly frameId: number;
  readonly pictureKey: string | null;
  readonly observationTimeUs: number;
  readonly arrivalTimeUs: number;
  readonly targetId: string | null;
  readonly state: TrackingState;
  readonly isMeasured: boolean;
  readonly predictionAgeUs: number;
  readonly inputWidthPx: number;
  readonly inputHeightPx: number;
  readonly geometry: FrameGeometry | null;
  readonly cornersStandardPx: Corners | null;
  readonly cornersInputPx: Corners | null;
  readonly boundingBoxInputPx: RectPx | null;
  readonly edgeWidthInputPx: number | null;
  readonly edgeHeightInputPx: number | null;
  readonly widthFraction: number | null;
  readonly heightFraction: number | null;
  readonly areaFraction: number | null;
  readonly isFullyInsideInput: boolean | null;
  readonly unavailableReason:
    'no-target-corners' | 'frame-geometry-unavailable' | 'invalid-frame-geometry' | null;
}

export interface TargetLossContext {
  readonly triggerFrame: TargetFrameExtent | null;
  readonly precedingFrame: TargetFrameExtent | null;
  readonly lastReliableFrame: TargetFrameExtent | null;
  /** Null for a timer or lifecycle loss; false when an input frame before the trigger was skipped. */
  readonly isPrecedingInputFrameRecorded: boolean | null;
}

export type StartupStage = 'pipeline-init' | 'renderer-init' | 'camera-init';

export interface EngineEvents extends Omit<CoreEvents, 'targetLost' | 'viewportTransition'> {
  sessionConfig: EventContext & { readonly config: SessionConfig };
  sessionConfigUpdated: EventContext & { readonly config: SessionConfig };
  stageTiming: EventContext & {
    readonly stage: StartupStage;
    readonly durationUs: number;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly attemptTimeUs: number;
  };
  cameraPermission: EventContext & {
    readonly phase: 'request' | 'result';
    readonly permission: 'pending' | 'granted' | 'denied' | 'failed';
  };
  /** The camera stopped: its error code and the original fine-grained reason. */
  cameraStatus: EventContext & { readonly code: ErrorCode; readonly detail: string };
  /** The camera picture's size, announced while it is still hidden or masked; a host may relayout now. */
  cameraSize: EventContext & { readonly widthPx: number; readonly heightPx: number };
  pageVisibility: EventContext & {
    readonly visibility: 'hidden' | 'visible' | 'pagehide' | 'pageshow';
  };
  viewportTransition: EventContext &
    ViewportTransition & {
      readonly sizes: {
        readonly viewportWidthCss: number | null;
        readonly viewportHeightCss: number | null;
        readonly cameraWidthPx: number | null;
        readonly cameraHeightPx: number | null;
      };
    };
  capabilityChanged: EventContext & { readonly capability: EngineCapability };
  targetLost: EventContext & { readonly reason: string; readonly lossContext: TargetLossContext };
  mediaState: EventContext & { readonly state: MediaState; readonly media: MediaSnapshot };
  /** Playback needs a user gesture: call `engine.media.retry()` from one. */
  playbackBlocked: EventContext;
}

// ---- Internal seams (not public) ----

/** A frame source; implemented by camera.CameraSource. */
export interface FrameSource {
  start(sessionId: string, onFrame: (frame: Frame) => void, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  nowSessionUs?(): number | null;
  onViewportTransition?(listener: (transition: ViewportTransition) => void): () => void;
}

/** A vision pipeline; implemented by the Worker client. */
export interface VisionPipeline {
  loadTargets(targets: readonly TargetBundle[]): Promise<void>;
  reset(sessionId: string): Promise<void>;
  process(frame: Frame, signal: AbortSignal): Promise<TrackingResult>;
  dispose(): Promise<void>;
}

/** The overlay; implemented by renderer.OverlayRenderer. */
export interface OverlaySink {
  start(container: HTMLElement, sessionId: string): Promise<void>;
  update(result: TrackingResult, geometry: FrameGeometry): Promise<void>;
  hide(): void;
  holdAfterLoss?(graceMs: number): boolean;
  setTargets?(targets: readonly TargetSize[]): void;
  setTargetMedia?(targetId: string, source: TargetMediaSource, options?: MediaOptions): void;
  clearTargetMedia?(targetId: string): void;
  onEvent?(listener: (event: RendererEvent) => void): () => void;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export type EngineErrorEvent = EventContext & { readonly error: EngineError };
