/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameGeometry } from '@livemira/contracts';

import { multiply3 } from '../geometry/frame-geometry.ts';

/** CSS properties that place a picture of the camera's intrinsic size exactly where the frame's geometry maps it. */
export type PreviewStyle = Readonly<Record<string, string>>;

/**
 * Composes the same input → standard → viewport mapping used for recognition and overlays into one CSS transform of
 * a box with the picture's intrinsic size, clipped to the crop.
 */
export function previewStyle(
  geometry: FrameGeometry,
  widthPx: number,
  heightPx: number,
): PreviewStyle {
  const h = multiply3(geometry.H_viewportFromStandard, geometry.H_standardFromInput);
  const crop = geometry.crop;
  return {
    position: 'absolute',
    left: '0px',
    top: '0px',
    width: `${widthPx}px`,
    height: `${heightPx}px`,
    minWidth: '0px',
    minHeight: '0px',
    maxWidth: 'none',
    maxHeight: 'none',
    padding: '0px',
    border: '0px',
    boxSizing: 'content-box',
    aspectRatio: 'auto',
    objectFit: 'contain',
    objectPosition: '0 0',
    transformOrigin: '0 0',
    transform: `matrix(${h[0]},${h[3]},${h[1]},${h[4]},${h[2]},${h[5]})`,
    clipPath: `inset(${crop.y}px ${widthPx - crop.x - crop.width}px ${heightPx - crop.y - crop.height}px ${crop.x}px)`,
  };
}
