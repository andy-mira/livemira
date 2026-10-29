// SPDX-License-Identifier: Apache-2.0

/** Viewport (device px) from standard-image px: uniform scale and offset. */
export interface FitTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function viewportFromStandard(
  sw: number,
  sh: number,
  vw: number,
  vh: number,
  fit: 'cover' | 'contain',
): FitTransform {
  const scale = (fit === 'cover' ? Math.max : Math.min)(vw / sw, vh / sh);
  return { scale, offsetX: (vw - sw * scale) / 2, offsetY: (vh - sh * scale) / 2 };
}
