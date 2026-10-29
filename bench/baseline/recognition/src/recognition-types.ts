/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mat3, Point2 } from '@livemira/contracts';

/** A target recognized in one frame: the accepted homography and every putative correspondence with its inlier flag. */
export interface RecognitionObservation {
  readonly sessionId: string;
  readonly frameId: number;
  readonly targetId: string;
  readonly algorithmVersion: string;
  /** Standard-image pixels from target pixels, normalized so the last element is 1. */
  readonly H_imageFromTarget: Mat3;
  readonly targetPoints: readonly Point2[];
  readonly imagePoints: readonly Point2[];
  readonly inliers: readonly boolean[];
  /** Root mean square reprojection error of the inliers. */
  readonly reprojectionErrorPx: number;
  /** Convex hull of the inlier target points divided by the target area. */
  readonly spatialCoverage: number;
}

export interface TargetRejection {
  readonly targetId: string;
  /** Diagnostic code(s), e.g. 'NO_ROBUST_MODEL' or 'AMBIGUOUS_TARGETS'. */
  readonly reason: string;
}

/** Facts of one recognition pass, snapshotted before any accumulation. `prepareMs` is the resampling of that pass. */
export interface RecognitionPassFacts {
  readonly scale: number;
  readonly prepareMs: number;
  readonly featureMs: number;
  readonly retrievalMs: number;
  readonly matchMs: number;
  readonly geometryMs: number;
  readonly totalMs: number;
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly observationCount: number;
  readonly isAmbiguous: boolean;
  readonly isBudgetExhausted: boolean;
  readonly rejected: readonly TargetRejection[];
}

/** What one recognition computed besides its result; times are milliseconds measured with performance.now(). */
export interface RecognitionFacts {
  readonly algorithmVersion: string;
  matchingBackend: 'cpu' | 'wasm';
  /** 1, or 2 after the half-octave scale retry. */
  scalePasses: number;
  featureMs: number;
  retrievalMs: number;
  matchMs: number;
  geometryMs: number;
  totalMs: number;
  readonly featureCount: number;
  readonly candidateCount: number;
  readonly isBudgetExhausted: boolean;
  fineComparisons: number;
  /** Present only when the recognizer captures passes: one entry, or two after a scale retry. */
  passes?: RecognitionPassFacts[];
}

export interface RecognitionBatch {
  /** Accepted targets, most inliers first; empty when the result is ambiguous. */
  readonly observations: RecognitionObservation[];
  readonly isAmbiguous: boolean;
  readonly rejected: TargetRejection[];
  readonly facts: RecognitionFacts;
}

export interface ExactMatchRequest {
  readonly targetId: string;
  readonly descriptors: Uint8Array;
}

/**
 * Exact descriptor matching supplied by the assembler (the WebAssembly matcher). It must follow the built-in matcher's
 * contract; resolving null means "match this frame with the built-in matcher".
 */
export type ExactMatcher = (
  targets: readonly ExactMatchRequest[],
  frameDescriptors: Uint8Array,
  signal?: AbortSignal,
) => Promise<{
  readonly backend: string;
  readonly matches: readonly {
    readonly targetId: string;
    readonly pairs: readonly {
      readonly targetIndex: number;
      readonly frameIndex: number;
      readonly distance: number;
    }[];
  }[];
} | null>;
