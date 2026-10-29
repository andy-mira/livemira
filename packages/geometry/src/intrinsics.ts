// SPDX-License-Identifier: Apache-2.0
// Focal length from plane homographies, and the camera pose of a plane from its homography (for 6-DoF content; the
// engine's video planes need only the homography).
//
// With the principal point known (image centre) and square pixels, each homography of the plane gives two linear
// constraints on a = 1/f² (Zhang 2000: h1ᵀωh2 = 0 and h1ᵀωh1 = h2ᵀωh2 with ω = K⁻ᵀK⁻¹). Frontal views carry no
// information (their projective terms vanish), so constraints are weighted by how much they constrain a.

import { multiply3 } from './homography.ts';

export interface FocalEstimate {
  /** Focal length, standard-image px; null until the views constrain it. */
  readonly focalPx: number | null;
  /** Relative standard error of the focal length estimate, or null. */
  readonly relativeError: number | null;
  readonly views: number;
}

export class FocalEstimator {
  private sumAA = 0;
  private sumAB = 0;
  private sumBB = 0;
  private views = 0;
  private readonly cx: number;
  private readonly cy: number;

  constructor(principalX: number, principalY: number) {
    this.cx = principalX;
    this.cy = principalY;
  }

  /** Adds the constraints of one homography (image px from target px). */
  add(H: ArrayLike<number>): void {
    const h = multiply3([1, 0, -this.cx, 0, 1, -this.cy, 0, 0, 1], H);
    const [h11, h12, , h21, h22, , h31, h32] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    // Each constraint: A·a = B, normalised so different frames weigh by their geometry, not their scale.
    const n = h11 * h11 + h21 * h21 + h12 * h12 + h22 * h22;
    if (!(n > 0)) return;
    const pairs: [number, number][] = [
      [(h11 * h12 + h21 * h22) / n, (-h31 * h32) / n],
      [(h11 * h11 + h21 * h21 - h12 * h12 - h22 * h22) / n, -(h31 * h31 - h32 * h32) / n],
    ];
    for (const [A, B] of pairs) {
      this.sumAA += A * A;
      this.sumAB += A * B;
      this.sumBB += B * B;
    }
    this.views++;
  }

  estimate(): FocalEstimate {
    if (this.views < 3 || this.sumAA <= 0) return { focalPx: null, relativeError: null, views: this.views };
    const a = this.sumAB / this.sumAA;
    if (!(a > 0)) return { focalPx: null, relativeError: null, views: this.views };
    const residual = Math.max(0, this.sumBB - 2 * a * this.sumAB + a * a * this.sumAA);
    const dof = Math.max(1, 2 * this.views - 1);
    const sigmaA = Math.sqrt(residual / dof / this.sumAA);
    // f = a^(−1/2): relative error of f is half the relative error of a.
    return { focalPx: 1 / Math.sqrt(a), relativeError: sigmaA / a / 2, views: this.views };
  }
}

export interface PlanePose {
  /** Camera-from-plane rotation, row-major 3×3. */
  readonly R: Float64Array;
  /** Camera-from-plane translation, in the units of `metersPerTargetPx` (metres when physical size is known). */
  readonly t: Float64Array;
}

/**
 * Camera pose of the target plane (plane origin at the target's top-left corner, X right, Y down, Z into the
 * picture) from its homography, the focal length and principal point, and the target pixel size.
 */
export function poseFromHomography(
  H: ArrayLike<number>,
  focalPx: number,
  cx: number,
  cy: number,
  metersPerTargetPx: number,
): PlanePose | null {
  const Kinv = [1 / focalPx, 0, -cx / focalPx, 0, 1 / focalPx, -cy / focalPx, 0, 0, 1];
  const S = [1 / metersPerTargetPx, 0, 0, 0, 1 / metersPerTargetPx, 0, 0, 0, 1];
  const M = multiply3(multiply3(Kinv, H), S);
  const c1 = [M[0]!, M[3]!, M[6]!];
  const c2 = [M[1]!, M[4]!, M[7]!];
  const c3 = [M[2]!, M[5]!, M[8]!];
  const n1 = Math.hypot(...c1);
  const n2 = Math.hypot(...c2);
  if (!(n1 > 0 && n2 > 0)) return null;
  let lambda = 2 / (n1 + n2);
  if (c3[2]! * lambda < 0) lambda = -lambda;
  const r1 = c1.map((v) => v * lambda);
  const r2 = c2.map((v) => v * lambda);
  // Orthonormalise the first two columns symmetrically, then complete the frame.
  const x = normalize(r1);
  let y = normalize(r2);
  const d = x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const xo = normalize(x.map((v, i) => v - (d / 2) * y[i]!));
  y = normalize(y.map((v, i) => v - (d / 2) * x[i]!));
  const z = [xo[1]! * y[2]! - xo[2]! * y[1]!, xo[2]! * y[0]! - xo[0]! * y[2]!, xo[0]! * y[1]! - xo[1]! * y[0]!];
  const R = Float64Array.from([xo[0]!, y[0]!, z[0]!, xo[1]!, y[1]!, z[1]!, xo[2]!, y[2]!, z[2]!]);
  return { R, t: Float64Array.from(c3.map((v) => v * lambda)) };
}

function normalize(v: readonly number[]): number[] {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}
