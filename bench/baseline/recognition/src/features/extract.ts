/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Feature extraction of the recognition algorithm m0-harris-anms-brief256-v1: box-2 pyramid, 3×3 box smoothing,
// Harris corners with 5×5 non-maximum suppression, ANMS spatial selection per level, upright BRIEF-256.

import { EngineError } from '@livemira/contracts';

import { RECOGNITION_LIMITS, validateGray, type GrayImage } from '../image/gray-image.ts';
import { selectAnms } from './anms.ts';
import { briefOffsetTable, describe } from './brief.ts';
import { createTensorRows, detectCorners, type Roi } from './harris.ts';
import { buildPyramid, smoothBox3 } from './pyramid.ts';

export interface LocalFeature {
  /** Position in base-image pixels (pixel centres at integer + 0.5 − 0.5). */
  x: number;
  y: number;
  readonly level: number;
  readonly score: number;
  /** 32 bytes. */
  readonly descriptor: number[];
}

export interface FeatureExtraction {
  readonly features: LocalFeature[];
  readonly pyramid: readonly {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly scale: number;
  }[];
}

export interface ExtractOptions {
  /** 16..512; the budget is split over the levels (the first levels get the remainder). */
  readonly maxFeatures: number;
  /** 1..4 */
  readonly levels: number;
  readonly roi?: Roi | null;
}

function checkOptions(image: GrayImage, maxFeatures: number, roi: Roi | null): void {
  const invalid = (message: string): EngineError =>
    new EngineError('INVALID_CONFIG', message, { isRecoverable: false });
  if (
    !Number.isInteger(maxFeatures) ||
    maxFeatures < 16 ||
    maxFeatures > RECOGNITION_LIMITS.features
  ) {
    throw invalid('INVALID_FEATURE_LIMIT');
  }
  if (
    roi &&
    (!(['x', 'y', 'width', 'height'] as const).every((k) => Number.isFinite(roi[k])) ||
      roi.width <= 0 ||
      roi.height <= 0 ||
      roi.x < 0 ||
      roi.y < 0 ||
      roi.x + roi.width > image.widthPx ||
      roi.y + roi.height > image.heightPx)
  ) {
    throw invalid('INVALID_ROI');
  }
}

export function extractFeatures(image: GrayImage, options: ExtractOptions): FeatureExtraction {
  const { maxFeatures, levels } = options;
  const roi = options.roi ?? null;
  validateGray(image);
  checkOptions(image, maxFeatures, roi);
  const layers = buildPyramid(image, levels);
  const features: LocalFeature[] = [];
  const rows = createTensorRows(image.widthPx);
  for (let level = 0; level < layers.length; level++) {
    const layer = layers[level]!;
    const { widthPx: w, heightPx: h, scale } = layer;
    const data = smoothBox3(layer);
    const candidates = detectCorners(data, w, h, scale, roi, rows);
    const quota =
      Math.floor(maxFeatures / layers.length) + (level < maxFeatures % layers.length ? 1 : 0);
    const table = briefOffsetTable(w);
    let selectedCount = 0;
    for (const point of selectAnms(candidates, quota)) {
      const descriptor = describe(data, point.y * w + point.x, table);
      selectedCount++;
      features.push({
        x: (point.x + 0.5) * scale - 0.5,
        y: (point.y + 0.5) * scale - 0.5,
        level,
        score: point.score,
        descriptor,
      });
      if (selectedCount >= quota) break;
    }
  }
  return {
    features,
    pyramid: layers.map(({ widthPx, heightPx, scale }) => ({ widthPx, heightPx, scale })),
  };
}
