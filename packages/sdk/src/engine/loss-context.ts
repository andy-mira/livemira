/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Where the target was when it was lost: a bounded numeric cache of the last processed and the last reliable frame,
// described in captured-input pixels only at the loss boundary, from each frame's own transform. No image handles,
// pixels or per-frame serialization.

import type { Corners, Frame, FrameGeometry, Mat3, TrackingResult } from '@livemira/contracts';

import type { TargetFrameExtent, TargetLossContext } from './engine-types.ts';

export type CapturedTargetFrame = Pick<
  TargetFrameExtent,
  | 'sessionId'
  | 'frameId'
  | 'pictureKey'
  | 'observationTimeUs'
  | 'arrivalTimeUs'
  | 'targetId'
  | 'state'
  | 'isMeasured'
  | 'predictionAgeUs'
  | 'inputWidthPx'
  | 'inputHeightPx'
  | 'geometry'
  | 'cornersStandardPx'
>;

const copyCorners = (corners: Corners | null): Corners | null =>
  corners ? (corners.map((p) => [p[0], p[1]]) as unknown as Corners) : null;

function copyGeometry(g: FrameGeometry | null): FrameGeometry | null {
  return g
    ? {
        ...g,
        H_standardFromInput: [...g.H_standardFromInput] as unknown as Mat3,
        H_viewportFromStandard: [...g.H_viewportFromStandard] as unknown as Mat3,
        crop: { x: g.crop.x, y: g.crop.y, width: g.crop.width, height: g.crop.height },
      }
    : null;
}

export function captureTargetFrame(frame: Frame, result: TrackingResult): CapturedTargetFrame {
  return {
    sessionId: result.sessionId,
    frameId: result.frameId,
    pictureKey: frame.pictureKey ?? null,
    observationTimeUs: result.observationTimeUs,
    arrivalTimeUs: frame.timing.arrivalTimeUs,
    targetId: result.targetId,
    state: result.state,
    isMeasured: result.quality.isMeasured && !result.quality.isDegenerate,
    predictionAgeUs: result.prediction.ageUs,
    inputWidthPx: frame.widthPx,
    inputHeightPx: frame.heightPx,
    geometry: copyGeometry(frame.geometry),
    cornersStandardPx: copyCorners(result.cornersPx),
  };
}

function inverse(m: Mat3): Mat3 | null {
  if (m.length !== 9 || !m.every(Number.isFinite)) return null;
  const [a, b, c, d, e, f, g, h, i] = m;
  const adj = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const det = a * adj[0]! + b * adj[3]! + c * adj[6]!;
  const magnitude = Math.max(...adj.map(Math.abs));
  if (!Number.isFinite(det) || !magnitude || Math.abs(det) < 1e-12 * magnitude) return null;
  return adj.map((v) => v / det) as unknown as Mat3;
}

/** Calculated only at the loss boundary, from that captured frame's own transform. */
export function describeTargetFrame(sample: CapturedTargetFrame | null): TargetFrameExtent | null {
  if (!sample) return null;
  const value: { -readonly [K in keyof TargetFrameExtent]: TargetFrameExtent[K] } = {
    ...sample,
    geometry: copyGeometry(sample.geometry),
    cornersStandardPx: copyCorners(sample.cornersStandardPx),
    cornersInputPx: null,
    boundingBoxInputPx: null,
    edgeWidthInputPx: null,
    edgeHeightInputPx: null,
    widthFraction: null,
    heightFraction: null,
    areaFraction: null,
    isFullyInsideInput: null,
    unavailableReason: null,
  };
  if (!sample.cornersStandardPx) {
    value.unavailableReason = 'no-target-corners';
    return value;
  }
  if (!sample.geometry) {
    value.unavailableReason = 'frame-geometry-unavailable';
    return value;
  }
  const m = inverse(sample.geometry.H_standardFromInput);
  if (
    !m ||
    !Number.isFinite(sample.inputWidthPx) ||
    !Number.isFinite(sample.inputHeightPx) ||
    sample.inputWidthPx <= 0 ||
    sample.inputHeightPx <= 0
  ) {
    value.unavailableReason = 'invalid-frame-geometry';
    return value;
  }
  const corners = sample.cornersStandardPx.map(([x, y]) => {
    const w = m[6] * x + m[7] * y + m[8];
    return Math.abs(w) > 1e-12
      ? [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]
      : [NaN, NaN];
  }) as [number, number][];
  if (!corners.flat().every(Number.isFinite)) {
    value.unavailableReason = 'invalid-frame-geometry';
    return value;
  }
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  const width = Math.max(...xs) - x;
  const height = Math.max(...ys) - y;
  const edge = (a: number, b: number): number =>
    Math.hypot(corners[a]![0] - corners[b]![0], corners[a]![1] - corners[b]![1]);
  const area =
    Math.abs(
      corners.reduce((sum, p, k) => {
        const next = corners[(k + 1) % 4]!;
        return sum + p[0] * next[1] - p[1] * next[0];
      }, 0),
    ) / 2;
  value.cornersInputPx = corners as unknown as Corners;
  value.boundingBoxInputPx = { x, y, width, height };
  value.edgeWidthInputPx = (edge(0, 1) + edge(2, 3)) / 2;
  value.edgeHeightInputPx = (edge(1, 2) + edge(3, 0)) / 2;
  value.widthFraction = width / sample.inputWidthPx;
  value.heightFraction = height / sample.inputHeightPx;
  value.areaFraction = area / (sample.inputWidthPx * sample.inputHeightPx);
  // Unclipped target bounds: fractions may exceed 1 for a target crossing the frame edges.
  value.isFullyInsideInput = corners.every(
    ([cx, cy]) => cx >= 0 && cy >= 0 && cx <= sample.inputWidthPx && cy <= sample.inputHeightPx,
  );
  return value;
}

/** The last processed and last reliable frame of the current session. */
export class LossContextTracker {
  private lastProcessed: CapturedTargetFrame | null = null;
  private lastReliable: CapturedTargetFrame | null = null;

  reset(): void {
    this.lastProcessed = null;
    this.lastReliable = null;
  }

  processed(sample: CapturedTargetFrame): void {
    this.lastProcessed = sample;
  }

  reliable(sample: CapturedTargetFrame): void {
    this.lastReliable = sample;
  }

  forgetReliable(): void {
    this.lastReliable = null;
  }

  describe(
    sessionId: string | null,
    targetId: string | null,
    trigger: CapturedTargetFrame | null,
  ): TargetLossContext {
    const preceding = this.lastProcessed?.sessionId === sessionId ? this.lastProcessed : null;
    const reliable =
      this.lastReliable?.sessionId === sessionId && this.lastReliable.targetId === targetId
        ? this.lastReliable
        : null;
    return {
      triggerFrame: describeTargetFrame(trigger),
      precedingFrame: describeTargetFrame(preceding),
      lastReliableFrame: describeTargetFrame(reliable),
      isPrecedingInputFrameRecorded: trigger
        ? Boolean(preceding && preceding.frameId === trigger.frameId - 1)
        : null,
    };
  }
}
