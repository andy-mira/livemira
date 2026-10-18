/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Frame geometry: how a captured picture maps to the standard (processing) image and to the viewport. Coordinates
// refer to pixel edges. Every size comes from the real picture, crop and container; nothing is device-specific.

import {
  EngineError,
  type FrameGeometry,
  type Mat3,
  type Point2,
  type RectPx,
} from '@livemira/contracts';

/** Processing long edge: 480, 640 (default) or 960 pixels, or the picture's own size. */
export type LongEdge = number | 'native';

export interface GeometryParams {
  /** Intrinsic size of the captured picture. */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Clockwise rotation from the picture to the standard image. Default 0. */
  readonly rotationDeg?: 0 | 90 | 180 | 270;
  /** Mirror the picture horizontally before rotating. Default false. */
  readonly isMirrored?: boolean;
  /** Region of the picture used; default the whole picture. */
  readonly crop?: RectPx;
  /** Default 640; the standard image is never enlarged. */
  readonly longEdge?: LongEdge;
  /** Viewport size in CSS pixels; default the picture size. */
  readonly viewportWidthCss?: number;
  readonly viewportHeightCss?: number;
  /** Default 1. */
  readonly devicePixelRatio?: number;
  /** How the standard image fills the viewport. Default 'cover'. */
  readonly fit?: 'contain' | 'cover';
  /** Mirror the viewport mapping horizontally. Default false. */
  readonly isViewportMirrored?: boolean;
}

/** Product of two row-major 3×3 matrices. */
export function multiply3(a: readonly number[], b: readonly number[]): number[] {
  return Array.from({ length: 9 }, (_, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    return a[row * 3]! * b[col]! + a[row * 3 + 1]! * b[col + 3]! + a[row * 3 + 2]! * b[col + 6]!;
  });
}

/** Applies a homography to a point. */
export function transformPoint(m: readonly number[], x: number, y: number): Point2 {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  return [(m[0]! * x + m[1]! * y + m[2]!) / w, (m[3]! * x + m[4]! * y + m[5]!) / w];
}

const ROTATIONS = (w: number, h: number): Record<0 | 90 | 180 | 270, number[]> => ({
  0: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  90: [0, -1, h, 1, 0, 0, 0, 0, 1],
  180: [-1, 0, w, 0, -1, h, 0, 0, 1],
  270: [0, 1, 0, -1, 0, w, 0, 0, 1],
});

/** Geometry of one capture. Throws `INVALID_CONFIG` for non-positive sizes, a crop outside the picture or unknown modes. */
export function createGeometry(params: GeometryParams): FrameGeometry {
  const {
    widthPx: width,
    heightPx: height,
    rotationDeg: rotation = 0,
    isMirrored: mirrored = false,
    crop = { x: 0, y: 0, width, height },
    longEdge = 640,
    viewportWidthCss: cssWidth = width,
    viewportHeightCss: cssHeight = height,
    devicePixelRatio: dpr = 1,
    fit = 'cover',
    isViewportMirrored: viewportMirrored = false,
  } = params;
  if (
    ![width, height, crop.width, crop.height, cssWidth, cssHeight, dpr].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    (longEdge !== 'native' && !(Number.isFinite(longEdge) && longEdge > 0)) ||
    ![crop.x, crop.y].every((v) => Number.isFinite(v) && v >= 0) ||
    crop.x + crop.width > width ||
    crop.y + crop.height > height ||
    ![0, 90, 180, 270].includes(rotation) ||
    !['contain', 'cover'].includes(fit)
  ) {
    throw new EngineError('INVALID_CONFIG', 'Invalid frame geometry', { isRecoverable: false });
  }
  const w = crop.width;
  const h = crop.height;
  const unmirror = mirrored ? [-1, 0, w, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rw = rotation % 180 ? h : w;
  const rh = rotation % 180 ? w : h;
  const targetEdge = longEdge === 'native' ? Math.max(rw, rh) : longEdge;
  const scale = Math.min(1, targetEdge / Math.max(rw, rh));
  const standardWidthPx = Math.max(1, Math.round(rw * scale));
  const standardHeightPx = Math.max(1, Math.round(rh * scale));
  const H_standardFromInput = multiply3(
    [standardWidthPx / rw, 0, 0, 0, standardHeightPx / rh, 0, 0, 0, 1],
    multiply3(
      ROTATIONS(w, h)[rotation],
      multiply3(unmirror, [1, 0, -crop.x, 0, 1, -crop.y, 0, 0, 1]),
    ),
  );
  const viewportScale = Math[fit === 'cover' ? 'max' : 'min'](
    cssWidth / standardWidthPx,
    cssHeight / standardHeightPx,
  );
  let H_viewportFromStandard = [
    viewportScale,
    0,
    (cssWidth - standardWidthPx * viewportScale) / 2,
    0,
    viewportScale,
    (cssHeight - standardHeightPx * viewportScale) / 2,
    0,
    0,
    1,
  ];
  if (viewportMirrored)
    H_viewportFromStandard = multiply3([-1, 0, cssWidth, 0, 1, 0, 0, 0, 1], H_viewportFromStandard);
  return {
    H_standardFromInput: H_standardFromInput as unknown as Mat3,
    H_viewportFromStandard: H_viewportFromStandard as unknown as Mat3,
    crop: { ...crop },
    rotationDeg: rotation,
    isMirrored: mirrored,
    fit,
    standardWidthPx,
    standardHeightPx,
    viewportWidthCss: cssWidth,
    viewportHeightCss: cssHeight,
    devicePixelRatio: dpr,
  };
}
