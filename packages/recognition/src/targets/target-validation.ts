/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// What the recognizer accepts as a compiled target: the algorithm identity, the preprocessing record, bounds, and a
// pyramid and hash that recompute from the bundle's own base level.

import {
  EngineError,
  validateTargetBundle,
  type TargetBundle,
  type TargetDiagnostic,
} from '@livemira/contracts';

import { ANMS_SELECTION_ID } from '../features/anms.ts';
import type { LocalFeature } from '../features/extract.ts';
import { buildPyramid } from '../features/pyramid.ts';
import { RECOGNITION_LIMITS } from '../image/gray-image.ts';
import { hamming } from '../matching/packed-matcher.ts';
import { hullArea } from '../geometry/homography.ts';

/** Harris corners, ANMS spatial selection, upright BRIEF-256. */
export const ALGORITHM_VERSION = 'm0-harris-anms-brief256-v1';
export const COMPILER_VERSION = 'webar-gray8-cpu/0.3.0';

/** Feature budget and pyramid levels of a compiled target (live frames use 512 features and 3 levels). */
export const TARGET_MAX_FEATURES = 384;
export const TARGET_LEVELS = 3;

/** Algorithms of earlier releases whose targets must be recompiled. */
const RETIRED_ALGORITHMS: readonly string[] = ['m0-harris-brief256-v1', 'c-oriented-brief256-v2'];

/** The preprocessing record stored in every bundle; key order is part of the serialized form. */
export function preprocessingRecord(
  levels: number,
  maxFeatures: number,
): Readonly<Record<string, string | number>> {
  return {
    pixelFormat: 'gray8',
    levels,
    maxFeatures,
    downsample: 'box2-center',
    smoothing: 'box3',
    orientation: 'upright-only',
    selection: ANMS_SELECTION_ID,
  };
}

const invalid = (message: string): never => {
  throw new EngineError('INVALID_TARGET', message, { isRecoverable: false });
};

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Quality problems that make a compiled target unusable (severity 'error'). */
export function diagnoseFeatures(
  features: readonly LocalFeature[],
  widthPx: number,
  heightPx: number,
): TargetDiagnostic[] {
  const diagnostics: TargetDiagnostic[] = [];
  const add = (code: string, message: string): void => {
    diagnostics.push({ code, message, severity: 'error' });
  };
  if (features.length < 24)
    add('LOW_TEXTURE', `Only ${features.length} features; require at least 24 for this baseline.`);
  if (hullArea(features.map((f) => [f.x, f.y])) / (widthPx * heightPx) < 0.15) {
    add('LOW_COVERAGE', 'Features cover less than 15 percent of target area.');
  }
  const repeated = features.filter((f, i) =>
    features.some((g, j) => i !== j && hamming(f.descriptor, g.descriptor) <= 16),
  ).length;
  if (features.length && repeated / features.length > 0.35) {
    add('REPETITIVE_TEXTURE', 'More than 35 percent of descriptors have a near duplicate.');
  }
  return diagnostics;
}

/** Bundle features as local features of the base level (level 0, score 1). */
export function featuresFromTarget(target: TargetBundle): LocalFeature[] {
  return target.features.points.map(([x, y], i) => ({
    x,
    y,
    level: 0,
    score: 1,
    descriptor: target.features.descriptors.slice(i * 32, (i + 1) * 32),
  }));
}

/** Synchronous checks, with the recognizer's smaller allocation and work bounds applied before the general validator. */
export function preflightTarget(value: unknown): asserts value is TargetBundle {
  const candidate = value as Partial<TargetBundle> | null;
  if (
    !candidate ||
    !Array.isArray(candidate.features?.points) ||
    candidate.features.points.length > RECOGNITION_LIMITS.features ||
    !Array.isArray(candidate.features?.descriptors) ||
    candidate.features.descriptors.length > RECOGNITION_LIMITS.features * 32 ||
    !Array.isArray(candidate.pyramid) ||
    candidate.pyramid.length > 8 ||
    candidate.pyramid.some(
      (l) => !Array.isArray(l?.pixels) || l.pixels.length > RECOGNITION_LIMITS.pixels,
    )
  ) {
    invalid('Target exceeds CPU baseline bounds');
  }
  validateTargetBundle(value);
  const t = value;
  if (RETIRED_ALGORITHMS.includes(t.algorithmVersion)) {
    invalid(
      `Target was compiled with ${t.algorithmVersion}; recompile it with ${ALGORITHM_VERSION}`,
    );
  }
  if (
    t.algorithmVersion !== ALGORITHM_VERSION ||
    t.compilerVersion !== COMPILER_VERSION ||
    t.features.descriptorType !== t.algorithmVersion ||
    t.features.descriptorLength !== 32 ||
    t.imageHashDomain !== 'canonical-gray8' ||
    t.widthPx < 32 ||
    t.heightPx < 32 ||
    t.widthPx > RECOGNITION_LIMITS.dimension ||
    t.heightPx > RECOGNITION_LIMITS.dimension ||
    t.widthPx * t.heightPx > RECOGNITION_LIMITS.pixels ||
    t.features.points.length > RECOGNITION_LIMITS.features ||
    t.pyramid.length < 1 ||
    t.pyramid.length > RECOGNITION_LIMITS.levels ||
    !t.features.descriptors.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) ||
    !t.features.points.every(([x, y]) => x >= 0 && y >= 0 && x < t.widthPx && y < t.heightPx)
  ) {
    invalid('Unsupported algorithm, dimensions or feature data');
  }
}

/** Full validation: preflight, preprocessing record, a pyramid recomputed from the base level, and the image hash. */
export async function validateTarget(value: unknown): Promise<TargetBundle> {
  preflightTarget(value);
  const t = value;
  const p = t.preprocessing;
  if (
    p.pixelFormat !== 'gray8' ||
    p.downsample !== 'box2-center' ||
    p.smoothing !== 'box3' ||
    p.orientation !== 'upright-only' ||
    typeof p.levels !== 'number' ||
    !Number.isInteger(p.levels) ||
    p.levels < 1 ||
    p.levels > RECOGNITION_LIMITS.levels ||
    typeof p.maxFeatures !== 'number' ||
    !Number.isInteger(p.maxFeatures) ||
    p.maxFeatures < 16 ||
    p.maxFeatures > RECOGNITION_LIMITS.features ||
    t.features.points.length > p.maxFeatures ||
    p.selection !== ANMS_SELECTION_ID
  ) {
    invalid('Unsupported preprocessing');
  }
  const base = t.pyramid[0]!;
  if (base.width !== t.widthPx || base.height !== t.heightPx || base.scale !== 1)
    invalid('Invalid pyramid base');
  const expected = buildPyramid(
    { widthPx: base.width, heightPx: base.height, data: new Uint8Array(base.pixels) },
    p.levels as number,
  );
  if (
    expected.length !== t.pyramid.length ||
    expected.some((l, i) => {
      const level = t.pyramid[i]!;
      return (
        l.widthPx !== level.width ||
        l.heightPx !== level.height ||
        l.scale !== level.scale ||
        !l.data.every((v, j) => v === level.pixels[j])
      );
    })
  ) {
    invalid('Inconsistent pyramid');
  }
  if ((await sha256Hex(new Uint8Array(base.pixels))) !== t.imageHash)
    invalid('Canonical gray8 hash mismatch');
  return t;
}
