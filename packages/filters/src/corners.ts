// SPDX-License-Identifier: Apache-2.0

import type { Corners, PoseEstimate, TargetInfo } from '@livemira-next/contracts';
import { solve4 } from '@livemira-next/geometry';

/** The homography putting the target rectangle's pixel-edge corners on `corners`; null when degenerate. */
export function homographyFromCorners(
  info: Pick<TargetInfo, 'width' | 'height'>,
  corners: ArrayLike<number>,
): Float64Array | null {
  const target = Float64Array.from([0, 0, info.width, 0, info.width, info.height, 0, info.height]);
  return solve4(target, Float64Array.from(corners), [0, 1, 2, 3]);
}

export function flatCorners(c: Corners): Float64Array {
  return Float64Array.from([c[0][0], c[0][1], c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]]);
}

export function cornersFromFlat(v: ArrayLike<number>): Corners {
  return [
    [v[0]!, v[1]!],
    [v[2]!, v[3]!],
    [v[4]!, v[5]!],
    [v[6]!, v[7]!],
  ];
}

/** A pose with new corners (and the homography through them), keeping everything else of `base`. */
export function withCorners(
  base: PoseEstimate,
  info: Pick<TargetInfo, 'width' | 'height'>,
  corners: ArrayLike<number>,
  timeUs: number,
  origin: PoseEstimate['origin'],
): PoseEstimate | null {
  const H = homographyFromCorners(info, corners);
  if (!H) return null;
  return { ...base, H_imageFromTarget: H, corners: cornersFromFlat(corners), timeUs, origin };
}
