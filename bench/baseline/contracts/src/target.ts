/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from './errors.ts';
import type { Point2 } from './math.ts';

export interface TargetPyramidLevel {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  /** Gray8 pixels, row-major. */
  readonly pixels: readonly number[];
}

export interface TargetFeatures {
  /** Feature positions in target pixels. */
  readonly points: readonly Point2[];
  readonly descriptorType: string;
  /** Bytes per descriptor. */
  readonly descriptorLength: number;
  /** All descriptors concatenated, `points.length * descriptorLength` bytes. */
  readonly descriptors: readonly number[];
}

export interface TargetDiagnostic {
  readonly code: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
}

/**
 * A compiled target image, schema version 1. The format is unchanged from earlier releases so existing compiled
 * targets of the same algorithm keep loading. Algorithm-specific checks live in the recognition package.
 */
export interface TargetBundle {
  readonly schemaVersion: 1;
  readonly compilerVersion: string;
  readonly algorithmVersion: string;
  readonly targetId: string;
  /** SHA-256 (hex) of the image the bundle was compiled from; see `imageHashDomain`. */
  readonly imageHash: string;
  readonly imageHashDomain?: 'encoded-image' | 'canonical-gray8';
  readonly widthPx: number;
  readonly heightPx: number;
  readonly physicalWidthMeters: number | null;
  readonly orientation: 'top-left';
  readonly pyramid: readonly TargetPyramidLevel[];
  readonly features: TargetFeatures;
  readonly preprocessing: Readonly<Record<string, string | number | boolean>>;
  readonly diagnostics: readonly TargetDiagnostic[];
}

/** Structural validation shared by every consumer; throws `INVALID_TARGET` for malformed, incompatible or oversized bundles. */
export function validateTargetBundle(value: unknown): asserts value is TargetBundle {
  const t = value as TargetBundle;
  const fail = (): never => {
    throw new EngineError('INVALID_TARGET', 'Malformed, incompatible or oversized target bundle', {
      isRecoverable: false,
    });
  };
  if (
    !t ||
    t.schemaVersion !== 1 ||
    !t.targetId ||
    typeof t.targetId !== 'string' ||
    t.targetId.length > 256 ||
    !t.compilerVersion ||
    !t.algorithmVersion ||
    !/^[a-f0-9]{64}$/i.test(t.imageHash ?? '') ||
    t.orientation !== 'top-left'
  ) {
    fail();
  }
  if (
    ![t.widthPx, t.heightPx].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) ||
    (t.physicalWidthMeters !== null &&
      !(Number.isFinite(t.physicalWidthMeters) && t.physicalWidthMeters > 0))
  ) {
    fail();
  }
  const f = t.features;
  if (
    !f ||
    !Array.isArray(f.points) ||
    f.points.length > 100000 ||
    !Number.isInteger(f.descriptorLength) ||
    f.descriptorLength < 1 ||
    f.descriptorLength > 512 ||
    !f.descriptorType ||
    !Array.isArray(f.descriptors) ||
    f.descriptors.length !== f.points.length * f.descriptorLength ||
    !f.descriptors.every(Number.isFinite)
  ) {
    fail();
  }
  if (!f.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
    fail();
  if (
    !Array.isArray(t.pyramid) ||
    t.pyramid.length > 16 ||
    !t.preprocessing ||
    !Array.isArray(t.diagnostics)
  )
    fail();
  let bytes = 0;
  for (const level of t.pyramid) {
    if (
      ![level.width, level.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) ||
      !Number.isFinite(level.scale) ||
      level.scale <= 0 ||
      !Array.isArray(level.pixels) ||
      level.pixels.length !== level.width * level.height
    ) {
      fail();
    }
    bytes += level.pixels.length;
    if (bytes > 16777216 || !level.pixels.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      fail();
  }
}
