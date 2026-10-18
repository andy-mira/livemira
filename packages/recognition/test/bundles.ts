/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Test bundles assembled from the recognition primitives, as the target compiler builds them.

import type { TargetBundle } from '@livemira/contracts';
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
  type GrayImage,
} from '@livemira/recognition';

/** A bundle as the target compiler builds it, assembled from the recognition primitives (tests only). */
export async function bundleFor(image: GrayImage, targetId: string): Promise<TargetBundle> {
  const { features } = extractFeatures(image, {
    maxFeatures: TARGET_MAX_FEATURES,
    levels: TARGET_LEVELS,
  });
  return {
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    targetId,
    imageHash: await sha256Hex(image.data),
    imageHashDomain: 'canonical-gray8',
    widthPx: image.widthPx,
    heightPx: image.heightPx,
    physicalWidthMeters: null,
    orientation: 'top-left',
    pyramid: buildPyramid(image, TARGET_LEVELS).map((l) => ({
      width: l.widthPx,
      height: l.heightPx,
      scale: l.scale,
      pixels: Array.from(l.data),
    })),
    features: {
      points: features.map((f) => [f.x, f.y] as const),
      descriptorType: ALGORITHM_VERSION,
      descriptorLength: 32,
      descriptors: features.flatMap((f) => f.descriptor),
    },
    preprocessing: preprocessingRecord(TARGET_LEVELS, TARGET_MAX_FEATURES),
    diagnostics: diagnoseFeatures(features, image.widthPx, image.heightPx),
  };
}
