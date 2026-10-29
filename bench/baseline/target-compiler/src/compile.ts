/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EngineError,
  validateTargetBundle,
  type Point2,
  type TargetBundle,
} from '@livemira/contracts';
import {
  ALGORITHM_VERSION,
  buildPyramid,
  COMPILER_VERSION,
  diagnoseFeatures,
  extractFeatures,
  preprocessingRecord,
  sha256Hex,
  TARGET_LEVELS,
  TARGET_MAX_FEATURES,
  validateGray,
  type GrayImage,
} from '@livemira/recognition';

export interface CompileOptions {
  /** 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
  readonly targetId: string;
  /** Printed width in metres, when known; stored in the bundle only. */
  readonly physicalWidthMeters?: number | null;
}

const invalid = (message: string): never => {
  throw new EngineError('INVALID_TARGET', message, { isRecoverable: false });
};

/**
 * Compiles a canonical gray8 image (32..4096 pixels per edge) into a target bundle: the base image and two pyramid
 * levels, at most 384 ANMS features with BRIEF-256 descriptors, the SHA-256 of the base image and quality diagnostics.
 * The input is copied before the first await, so later changes by the caller cannot affect the result.
 */
export async function compileGrayTarget(
  image: GrayImage,
  options: CompileOptions,
): Promise<TargetBundle> {
  validateGray(image);
  const snapshot = { ...image, data: new Uint8Array(image.data) };
  const { targetId, physicalWidthMeters = null } = options;
  const maxFeatures = TARGET_MAX_FEATURES;
  const levels = TARGET_LEVELS;
  if (
    !/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) ||
    (physicalWidthMeters !== null &&
      (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0))
  ) {
    invalid('Invalid target identity or physical width');
  }
  const { features } = extractFeatures(snapshot, { maxFeatures, levels });
  // Field order is part of the serialized form.
  const result: TargetBundle = {
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    targetId,
    imageHash: await sha256Hex(snapshot.data),
    imageHashDomain: 'canonical-gray8',
    widthPx: snapshot.widthPx,
    heightPx: snapshot.heightPx,
    physicalWidthMeters,
    orientation: 'top-left',
    pyramid: buildPyramid(snapshot, levels).map((l) => ({
      width: l.widthPx,
      height: l.heightPx,
      scale: l.scale,
      pixels: Array.from(l.data),
    })),
    features: {
      points: features.map((f) => [f.x, f.y] as Point2),
      descriptorType: ALGORITHM_VERSION,
      descriptorLength: 32,
      descriptors: features.flatMap((f) => f.descriptor),
    },
    preprocessing: preprocessingRecord(levels, maxFeatures),
    diagnostics: diagnoseFeatures(features, snapshot.widthPx, snapshot.heightPx),
  };
  validateTargetBundle(result);
  return result;
}
