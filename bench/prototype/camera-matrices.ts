// SPDX-License-Identifier: Apache-2.0
// F3: matrices for 3D content (three.js / Babylon.js / own WebGL), column-major like WebGL. The projection reproduces
// the pinhole camera of the standard image (focal length, principal point) inside the viewport's cover fit, so a
// model placed with the view matrix lines up with the camera picture the compositor draws.

import type { FitTransform } from '@livemira-next/web';

/** OpenGL-style projection (column-major 4×4) of a pinhole camera in standard-image px, for a `vw` × `vh` viewport. */
export function projectionMatrix(
  focalPx: number,
  cx: number,
  cy: number,
  fit: FitTransform,
  vw: number,
  vh: number,
  near = 0.01,
  far = 100,
): Float32Array {
  // Standard px → viewport px: x_v = s·x + ox. In NDC: x_n = 2 x_v / vw − 1, y_n = 1 − 2 y_v / vh.
  const fx = (2 * fit.scale * focalPx) / vw;
  const fy = (2 * fit.scale * focalPx) / vh;
  const px = (2 * (fit.scale * cx + fit.offsetX)) / vw - 1;
  const py = 1 - (2 * (fit.scale * cy + fit.offsetY)) / vh;
  // Camera looks down −Z in GL; the vision camera looks down +Z with Y down: flip Y and Z through the view matrix.
  return Float32Array.from([
    fx,
    0,
    0,
    0,
    0,
    fy,
    0,
    0,
    -px,
    -py,
    -(far + near) / (far - near),
    -1,
    0,
    0,
    (-2 * far * near) / (far - near),
    0,
  ]);
}

/** GL view matrix (column-major) from the vision pose (camera-from-plane R, t; X right, Y down, Z forward). */
export function viewMatrix(R: ArrayLike<number>, t: ArrayLike<number>): Float32Array {
  // Convert the vision camera (Y down, Z forward) to GL (Y up, Z backward): diag(1, −1, −1) · [R | t].
  const m = new Float32Array(16);
  for (let r = 0; r < 3; r++) {
    const sign = r === 0 ? 1 : -1;
    for (let c = 0; c < 3; c++) m[c * 4 + r] = sign * R[r * 3 + c]!;
    m[12 + r] = sign * t[r]!;
  }
  m[15] = 1;
  return m;
}
