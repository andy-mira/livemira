/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EngineError,
  normalizeHomography,
  type FrameIdentity,
  type Point2,
  type TargetBundle,
  type TargetDiagnostic,
} from '@livemira/contracts';

import { extractFeatures, type LocalFeature } from './features/extract.ts';
import type { Roi } from './features/harris.ts';
import { hullArea, validateHomography } from './geometry/homography.ts';
import { verifyGeometry } from './geometry/ransac.ts';
import { RECOGNITION_LIMITS, type GrayImage } from './image/gray-image.ts';
import { matchPacked, packDescriptors, type PointPair } from './matching/packed-matcher.ts';
import type {
  ExactMatcher,
  RecognitionBatch,
  RecognitionFacts,
  RecognitionObservation,
  RecognitionPassFacts,
  TargetRejection,
} from './recognition-types.ts';
import { INTERMEDIATE_SCALE, intermediateScaleImage } from './scale/intermediate-scale.ts';
import {
  diagnoseFeatures,
  featuresFromTarget,
  preflightTarget,
  validateTarget,
} from './targets/target-validation.ts';

/** Feature budget and pyramid levels of a live frame. */
const FRAME_MAX_FEATURES = 512;
const FRAME_LEVELS = 3;

export interface RecognizerOptions {
  /** Exact matcher for the descriptors (WebAssembly); without it, or when it resolves null, the built-in matcher runs. */
  readonly exactMatcher?: ExactMatcher;
  /** Default true: retry a global miss once at a half-octave scale. False only for diagnostic comparisons. */
  readonly scaleRetry?: boolean;
  /** Default false: when true, `facts.passes` carries one bounded record per recognition pass. */
  readonly capturePasses?: boolean;
}

export interface RecognizeOptions {
  readonly roi?: Roi | null;
  readonly signal?: AbortSignal;
}

interface CachedTarget {
  readonly features: LocalFeature[];
  readonly packed: Uint32Array;
  readonly bytes: Uint8Array;
  readonly diagnostics: TargetDiagnostic[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new EngineError('ABORTED', 'Recognition cancelled', { isRecoverable: true });
}

function passFacts(
  batch: RecognitionBatch,
  scale: number,
  prepareMs: number,
): RecognitionPassFacts {
  const d = batch.facts;
  return {
    scale,
    prepareMs,
    featureMs: d.featureMs,
    retrievalMs: d.retrievalMs,
    matchMs: d.matchMs,
    geometryMs: d.geometryMs,
    totalMs: d.totalMs,
    featureCount: d.featureCount,
    candidateCount: d.candidateCount,
    observationCount: batch.observations.length,
    isAmbiguous: batch.isAmbiguous,
    isBudgetExhausted: d.isBudgetExhausted,
    rejected: batch.rejected.map((r) => ({ targetId: r.targetId, reason: r.reason })),
  };
}

const inlierCount = (o: RecognitionObservation): number => o.inliers.filter(Boolean).length;

/** Recognizes up to ten loaded targets in standard gray images. One recognition at a time. */
export class Recognizer {
  #targets: TargetBundle[] = [];
  #disposed = false;
  #generation = 0;
  #cache: CachedTarget[] = [];
  #isPending = false;
  readonly #exactMatcher: ExactMatcher | undefined;
  readonly #scaleRetry: boolean;
  readonly #capturePasses: boolean;

  constructor(options: RecognizerOptions = {}) {
    if (options.scaleRetry !== undefined && typeof options.scaleRetry !== 'boolean') {
      throw new EngineError('INVALID_CONFIG', 'scaleRetry must be a boolean', {
        isRecoverable: false,
      });
    }
    if (options.capturePasses !== undefined && typeof options.capturePasses !== 'boolean') {
      throw new EngineError('INVALID_CONFIG', 'capturePasses must be a boolean', {
        isRecoverable: false,
      });
    }
    this.#exactMatcher = options.exactMatcher;
    this.#scaleRetry = options.scaleRetry ?? true;
    this.#capturePasses = options.capturePasses === true;
  }

  /** Validates and snapshots the targets (1..10, unique ids), then replaces the loaded set. */
  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.#alive();
    if (this.#isPending) {
      throw new EngineError('INVALID_CONFIG', 'Cannot replace targets during recognition', {
        isRecoverable: true,
      });
    }
    if (
      !targets.length ||
      targets.length > RECOGNITION_LIMITS.targets ||
      new Set(targets.map((t) => t.targetId)).size !== targets.length
    ) {
      throw new EngineError('INVALID_TARGET', 'Require 1 to 10 unique targets', {
        isRecoverable: false,
      });
    }
    const generation = ++this.#generation;
    const next: TargetBundle[] = [];
    targets.forEach(preflightTarget);
    // Snapshot all targets together before any asynchronous digest work.
    for (const copy of structuredClone(targets)) {
      await validateTarget(copy);
      next.push(copy);
    }
    this.#alive();
    if (generation !== this.#generation) {
      throw new EngineError('ABORTED', 'Target load superseded', { isRecoverable: true });
    }
    this.#targets = next;
    this.#cache = next.map((t) => {
      const features = featuresFromTarget(t);
      return {
        features,
        packed: packDescriptors(features),
        bytes: new Uint8Array(t.features.descriptors),
        diagnostics: diagnoseFeatures(features, t.widthPx, t.heightPx),
      };
    });
  }

  #alive(): void {
    if (this.#disposed)
      throw new EngineError('DISPOSED', 'Recognizer disposed', { isRecoverable: false });
  }

  /** Recognizes the loaded targets in one standard gray image; retries a global miss once at a half-octave scale. */
  async recognize(
    image: GrayImage,
    identity: FrameIdentity,
    options: RecognizeOptions = {},
  ): Promise<RecognitionBatch> {
    this.#alive();
    throwIfAborted(options.signal);
    if (this.#isPending) {
      throw new EngineError('INVALID_CONFIG', 'Only one recognition job may be in flight', {
        isRecoverable: true,
      });
    }
    this.#isPending = true;
    try {
      const start = performance.now();
      const primary = await this.#recognizeOnce(image, identity, options);
      // Snapshot the first pass before anything is accumulated into a later batch; without capturePasses nothing is stored.
      const first = this.#capturePasses ? passFacts(primary, 1, 0) : null;
      if (first) primary.facts.passes = [first];
      // Retry only a global miss; never an ambiguous result.
      if (!this.#scaleRetry || options.roi || primary.observations.length || primary.isAmbiguous)
        return primary;
      throwIfAborted(options.signal);
      this.#alive();
      const resampleStart = performance.now();
      const scaled = intermediateScaleImage(image);
      if (!scaled) return primary;
      const resampleMs = performance.now() - resampleStart;
      const secondary = await this.#recognizeOnce(scaled, identity, options, INTERMEDIATE_SCALE);
      const second = first ? passFacts(secondary, INTERMEDIATE_SCALE, resampleMs) : null;
      for (const key of [
        'featureMs',
        'retrievalMs',
        'matchMs',
        'geometryMs',
        'fineComparisons',
      ] as const) {
        secondary.facts[key] += primary.facts[key];
      }
      secondary.facts.featureMs += resampleMs;
      secondary.facts.totalMs = performance.now() - start;
      secondary.facts.scalePasses = 2;
      if (first && second) secondary.facts.passes = [first, second];
      return secondary;
    } finally {
      this.#isPending = false;
    }
  }

  async #recognizeOnce(
    image: GrayImage,
    identity: FrameIdentity,
    options: RecognizeOptions,
    featureImageScale = 1,
  ): Promise<RecognitionBatch> {
    if (!this.#targets.length)
      throw new EngineError('INVALID_TARGET', 'No targets loaded', { isRecoverable: false });
    if (!identity.sessionId || !Number.isSafeInteger(identity.frameId) || identity.frameId < 0) {
      throw new EngineError('FRAME_FAILED', 'Invalid frame identity', { isRecoverable: false });
    }
    const start = performance.now();
    const algorithmVersion = this.#targets[0]!.algorithmVersion;
    const { features } = extractFeatures(image, {
      maxFeatures: FRAME_MAX_FEATURES,
      levels: FRAME_LEVELS,
      roi: options.roi ?? null,
    });
    // Restore points before matching and geometric validation: the threshold stays 3 original pixels.
    if (featureImageScale !== 1) {
      for (const f of features) {
        f.x = (f.x + 0.5) / featureImageScale - 0.5;
        f.y = (f.y + 0.5) / featureImageScale - 0.5;
      }
    }
    const featureMs = performance.now() - start;
    const retrievalStart = performance.now();
    const indices = this.#targets.map((_, i) => i);
    const packed = packDescriptors(features);
    const facts: RecognitionFacts = {
      algorithmVersion,
      matchingBackend: 'cpu',
      scalePasses: 1,
      featureMs,
      retrievalMs: performance.now() - retrievalStart,
      matchMs: 0,
      geometryMs: 0,
      totalMs: 0,
      featureCount: features.length,
      candidateCount: indices.length,
      isBudgetExhausted: false,
      fineComparisons: 0,
    };
    const accelerated = await this.#matchExactly(indices, features, facts, options.signal);
    const observations: RecognitionObservation[] = [];
    const rejected: TargetRejection[] = [];
    for (const index of indices) {
      throwIfAborted(options.signal);
      const outcome = this.#verifyTarget(index, features, packed, accelerated, identity, facts);
      if ('reason' in outcome) rejected.push(outcome);
      else observations.push(outcome);
    }
    observations.sort(
      (a, b) => inlierCount(b) - inlierCount(a) || a.reprojectionErrorPx - b.reprojectionErrorPx,
    );
    const isAmbiguous =
      observations.length > 1 &&
      inlierCount(observations[1]!) >= inlierCount(observations[0]!) * 0.85;
    throwIfAborted(options.signal);
    // Suppress ambiguous candidates here so the tracker can never pick one of them.
    if (isAmbiguous)
      for (const o of observations)
        rejected.push({ targetId: o.targetId, reason: 'AMBIGUOUS_TARGETS' });
    facts.totalMs = performance.now() - start;
    return { observations: isAmbiguous ? [] : observations, isAmbiguous, rejected, facts };
  }

  /** Exact matching by the injected matcher for every usable target, or null when the built-in matcher must run. */
  async #matchExactly(
    indices: readonly number[],
    features: readonly LocalFeature[],
    facts: RecognitionFacts,
    signal?: AbortSignal,
  ): Promise<Map<
    string,
    readonly { targetIndex: number; frameIndex: number; distance: number }[]
  > | null> {
    const matcher = this.#exactMatcher;
    if (!matcher || !indices.length) return null;
    const requested = indices
      .filter((i) => !this.#cache[i]!.diagnostics.length)
      .map((i) => ({ targetId: this.#targets[i]!.targetId, descriptors: this.#cache[i]!.bytes }));
    if (!requested.length) return null;
    const matchStart = performance.now();
    const generation = this.#generation;
    const output = await matcher(
      requested,
      new Uint8Array(features.flatMap((f) => f.descriptor)),
      signal,
    );
    throwIfAborted(signal);
    this.#alive();
    if (generation !== this.#generation) {
      throw new EngineError('ABORTED', 'Recognition generation changed', { isRecoverable: true });
    }
    if (output === null) return null;
    if (
      !['cpu', 'wasm'].includes(output.backend) ||
      output.matches.length !== requested.length ||
      new Set(output.matches.map((m) => m.targetId)).size !== requested.length ||
      output.matches.some((m) => !requested.some((r) => r.targetId === m.targetId))
    ) {
      throw new EngineError('FRAME_FAILED', 'Invalid exact matching batch', {
        isRecoverable: false,
      });
    }
    facts.matchingBackend = output.backend as 'cpu' | 'wasm';
    facts.matchMs = performance.now() - matchStart;
    return new Map(output.matches.map((m) => [m.targetId, m.pairs]));
  }

  /** Matches and verifies one target; returns its observation or its rejection. */
  #verifyTarget(
    index: number,
    features: readonly LocalFeature[],
    packed: Uint32Array,
    accelerated: Map<
      string,
      readonly { targetIndex: number; frameIndex: number; distance: number }[]
    > | null,
    identity: FrameIdentity,
    facts: RecognitionFacts,
  ): RecognitionObservation | TargetRejection {
    const target = this.#targets[index]!;
    const cached = this.#cache[index]!;
    const targetFeatures = cached.features;
    if (cached.diagnostics.length) {
      return { targetId: target.targetId, reason: cached.diagnostics.map((d) => d.code).join(',') };
    }
    const matchStart = performance.now();
    const external = accelerated?.get(target.targetId);
    if (
      external &&
      (!Array.isArray(external) ||
        external.length > Math.min(targetFeatures.length, features.length) ||
        new Set(external.map((p) => p.targetIndex)).size !== external.length ||
        new Set(external.map((p) => p.frameIndex)).size !== external.length ||
        external.some(
          (p) =>
            !Number.isInteger(p.targetIndex) ||
            p.targetIndex < 0 ||
            p.targetIndex >= targetFeatures.length ||
            !Number.isInteger(p.frameIndex) ||
            p.frameIndex < 0 ||
            p.frameIndex >= features.length ||
            !Number.isInteger(p.distance) ||
            p.distance < 0 ||
            p.distance > 64,
        ))
    ) {
      throw new EngineError('FRAME_FAILED', 'Invalid exact match indices', {
        isRecoverable: false,
      });
    }
    const pairs: PointPair[] = external
      ? external.map((p) => ({
          target: [targetFeatures[p.targetIndex]!.x, targetFeatures[p.targetIndex]!.y] as Point2,
          image: [features[p.frameIndex]!.x, features[p.frameIndex]!.y] as Point2,
          distance: p.distance,
        }))
      : matchPacked(targetFeatures, features, cached.packed, packed);
    facts.matchMs += performance.now() - matchStart;
    facts.fineComparisons += targetFeatures.length * features.length;
    const geometryStart = performance.now();
    const result = verifyGeometry(pairs, target.widthPx, target.heightPx);
    facts.geometryMs += performance.now() - geometryStart;
    // Corners are pixel edges, so the outer width/height boundary must also be valid.
    if (
      !result.accepted ||
      !validateHomography(result.H, target.widthPx + 1, target.heightPx + 1)
    ) {
      return {
        targetId: target.targetId,
        reason: result.accepted ? 'INVALID_BOUNDARY' : result.reason,
      };
    }
    return {
      sessionId: identity.sessionId,
      frameId: identity.frameId,
      targetId: target.targetId,
      algorithmVersion: target.algorithmVersion,
      H_imageFromTarget: normalizeHomography(result.H),
      targetPoints: pairs.map((p) => p.target),
      imagePoints: pairs.map((p) => p.image),
      inliers: result.inlierMask,
      reprojectionErrorPx: result.rmsErrorPx,
      spatialCoverage:
        hullArea(pairs.filter((_, i) => result.inlierMask[i]).map((p) => p.target)) /
        (target.widthPx * target.heightPx),
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#generation++;
    this.#targets = [];
    this.#cache = [];
  }
}
