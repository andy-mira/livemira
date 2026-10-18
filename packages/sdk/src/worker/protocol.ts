/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Messages between the engine and its vision Worker. Every message carries the protocol version, a request id and the
// Worker generation, so a response to an older request or an older Worker is ignored.

import {
  SOURCE_TOO_LARGE,
  STANDARD_TOO_LARGE,
  type PrepareStages,
  type TransferredImage,
} from '@livemira/compute';
import type { ErrorCode, FrameGeometry, TargetBundle, TrackingResult } from '@livemira/contracts';
import type { RecognitionTrace } from '@livemira/recognition';

export const WORKER_PROTOCOL_VERSION = 1;

/** What the Worker needs to know about a frame besides its picture. */
export interface WorkerFrameMetadata {
  readonly sessionId: string;
  readonly frameId: number;
  readonly pictureKey: string;
  readonly observationTimeUs: number;
}

export interface WorkerFrame {
  readonly metadata: WorkerFrameMetadata;
  readonly image: TransferredImage;
  /** Null only for CPU pixels already in standard orientation and size. */
  readonly geometry: FrameGeometry | null;
}

/** Options fixed for the lifetime of one Worker. */
export interface VisionOptions {
  /** Attach the inlier image points to measured TRACKING results. Default false. */
  readonly collectMatchedPoints: boolean;
  /** Send a bounded recognition trace and preparation stages with every result. Default false. */
  readonly observeRecognition: boolean;
  /** 'wasm' (default) selects the WebAssembly matcher with JavaScript fallback; 'js' keeps the JavaScript matcher. */
  readonly exactMatching: 'wasm' | 'js';
  /** Retry a global miss at a half-octave scale. Default true; false only for diagnostic comparisons. */
  readonly scaleRetry: boolean;
}

export const DEFAULT_VISION_OPTIONS: VisionOptions = Object.freeze({
  collectMatchedPoints: false,
  observeRecognition: false,
  exactMatching: 'wasm',
  scaleRetry: true,
});

/** What actually runs in the Worker. */
export interface VisionCapability {
  readonly execution: 'worker' | 'thread';
  readonly generation: number;
  readonly algorithmVersion: string;
  /** The exact matcher really used. */
  readonly matching: 'wasm-simd' | 'wasm-scalar' | 'cpu';
  /** Every attempted WebAssembly variant and its outcome, e.g. 'simd:selected'; 'none' without WebAssembly matching. */
  readonly matchingSelection: string;
  /** Why the JavaScript matcher runs, or 'none'. */
  readonly matchingFallback: string;
  readonly fallbackReason: string | null;
}

export interface WorkerTiming {
  readonly prepareDurationUs: number;
  readonly computeDurationUs: number;
  readonly totalDurationUs: number;
  /** Present only when recognition is observed. */
  readonly prepareStages?: PrepareStages;
  /** Main-thread copy of the frame before transfer. */
  readonly inputPreparationDurationUs?: number;
  readonly inputCopiedBytes?: number | null;
}

interface Envelope {
  readonly protocol: typeof WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
}

export type VisionRequestBody =
  | { readonly type: 'init'; readonly options: VisionOptions }
  | { readonly type: 'load-targets'; readonly targets: readonly TargetBundle[] }
  | { readonly type: 'reset'; readonly sessionId: string }
  | { readonly type: 'frame'; readonly frame: WorkerFrame }
  | {
      readonly type: 'compile';
      readonly encodedImage: ArrayBuffer;
      readonly targetId: string;
      readonly maxEdgePx: number;
    }
  | { readonly type: 'dispose' };

export type VisionRequest = Envelope & VisionRequestBody;

export type VisionResponse = Envelope &
  (
    | { readonly type: 'ready'; readonly capability: VisionCapability }
    | { readonly type: 'ack' }
    | {
        readonly type: 'result';
        readonly result: TrackingResult;
        readonly timing: WorkerTiming;
        readonly capability?: VisionCapability;
        readonly trace?: RecognitionTrace;
      }
    | { readonly type: 'compiled'; readonly target: TargetBundle }
    | {
        readonly type: 'error';
        readonly code: ErrorCode;
        readonly isRecoverable: boolean;
        readonly reason: string;
      }
  );

/** Fixed, input-independent messages that may leave the Worker; anything else is reported generically. */
export const WORKER_SAFE_REASONS: readonly string[] = Object.freeze([
  SOURCE_TOO_LARGE,
  STANDARD_TOO_LARGE,
]);
export const WORKER_GENERIC_REASON = 'Worker operation failed';

export function safeWorkerReason(reason: unknown): string {
  return typeof reason === 'string' && WORKER_SAFE_REASONS.includes(reason)
    ? reason
    : WORKER_GENERIC_REASON;
}
