// SPDX-License-Identifier: Apache-2.0

/**
 * 3×3 homography, row-major, acting on column vectors p' = H·p with p = (x, y, 1)ᵀ. Named H_<to>From<from>;
 * H_imageFromTarget maps target pixels (pixel edges, origin top-left) to standard-image pixels.
 */
export type Mat3 = Float64Array;

export type Point2 = readonly [number, number];

/** Corners top-left, top-right, bottom-right, bottom-left. */
export type Corners = readonly [Point2, Point2, Point2, Point2];

export interface RectPx {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Pinhole intrinsics in standard-image pixels (no distortion). */
export interface Intrinsics {
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
}

export function mat3(values: ArrayLike<number>): Mat3 {
  if (values.length !== 9) throw new RangeError('Mat3 needs nine values');
  return Float64Array.from(values);
}

export const identity3 = (): Mat3 => mat3([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Projects (x, y); NaN at the horizon. */
export function project(h: ArrayLike<number>, x: number, y: number): Point2 {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  if (Math.abs(w) < 1e-12) return [NaN, NaN];
  return [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
}

/** The target rectangle's pixel-edge corners through `h`. */
export function cornersOf(h: ArrayLike<number>, widthPx: number, heightPx: number): Corners {
  return [project(h, 0, 0), project(h, widthPx, 0), project(h, widthPx, heightPx), project(h, 0, heightPx)];
}
