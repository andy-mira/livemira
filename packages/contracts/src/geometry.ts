/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mat3 } from './math.ts';

export interface RectPx {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How one captured frame maps to the standard (processing) image and to the viewport.
 * Input: the camera picture's intrinsic pixels. Standard: the cropped, rotated, mirrored and scaled processing image
 * in which recognition, tracking and `cornersPx` work. Viewport: CSS pixels of the preview container.
 */
export interface FrameGeometry {
  readonly H_standardFromInput: Mat3;
  readonly H_viewportFromStandard: Mat3;
  /** Region of the input used for processing, in input pixels. */
  readonly crop: RectPx;
  readonly rotationDeg: 0 | 90 | 180 | 270;
  readonly isMirrored: boolean;
  readonly fit: 'contain' | 'cover';
  readonly standardWidthPx: number;
  readonly standardHeightPx: number;
  readonly viewportWidthCss: number;
  readonly viewportHeightCss: number;
  readonly devicePixelRatio: number;
}
