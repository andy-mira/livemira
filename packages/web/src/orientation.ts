// SPDX-License-Identifier: Apache-2.0
// Camera frame orientation. A VideoFrame's planes (copyTo) hold the sensor picture; the picture shown to the user is
// that picture mirrored (when `flip`) and then rotated clockwise by `rotation` (WebCodecs; measured in Chromium:
// drawImage applies both, copyTo and WebGL uploads do not). WebKit applies the camera rotation when drawing and in
// WebGL uploads but does not expose it, so it is detected from a drawn thumbnail (luma.ts). The engine works in the
// shown orientation: the standard image, the poses and the overlay all use display coordinates.

export type Rotation = 0 | 90 | 180 | 270;

export interface Orientation {
  readonly rotation: Rotation;
  readonly flip: boolean;
}

export const UPRIGHT: Orientation = { rotation: 0, flip: false };

/** The frame's own orientation metadata, when the browser exposes it (null: unknown). */
export function frameOrientation(frame: VideoFrame): Orientation | null {
  const meta = frame as VideoFrame & { rotation?: number; flip?: boolean };
  if (typeof meta.rotation !== 'number') return null;
  const r = ((Math.round(meta.rotation / 90) % 4) + 4) % 4;
  return { rotation: (r * 90) as Rotation, flip: meta.flip === true };
}

/** Size of the shown picture of a raw `width` × `height` picture. */
export function displaySize(width: number, height: number, o: Orientation): [number, number] {
  return o.rotation % 180 ? [height, width] : [width, height];
}

/**
 * Affine map from display edge coordinates (dx, dy) to raw edge coordinates of a raw `width` × `height` picture:
 * u = a·dx + b·dy + c, v = d·dx + e·dy + f, returned as [a, b, c, d, e, f].
 */
export function rawFromDisplay(
  width: number,
  height: number,
  o: Orientation,
): [number, number, number, number, number, number] {
  let m: [number, number, number, number, number, number];
  switch (o.rotation) {
    case 90:
      m = [0, 1, 0, -1, 0, height];
      break;
    case 180:
      m = [-1, 0, width, 0, -1, height];
      break;
    case 270:
      m = [0, -1, width, 1, 0, 0];
      break;
    default:
      m = [1, 0, 0, 0, 1, 0];
  }
  // The mirror is applied to the raw picture before the rotation: u_raw = width − u.
  if (o.flip) m = [-m[0], -m[1], width - m[2], m[3], m[4], m[5]];
  return m;
}

/** Texture coordinates of the display corners (top-left, top-right, bottom-right, bottom-left) of a raw texture. */
export function cornerUvs(o: Orientation): number[] {
  const [a, b, c, d, e, f] = rawFromDisplay(1, 1, o);
  return [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ].flatMap(([x, y]) => [a * x! + b * y! + c, d * x! + e * y! + f]);
}

export function orientationName(o: Orientation): string {
  return `${o.flip ? 'flip+' : ''}r${o.rotation}`;
}
