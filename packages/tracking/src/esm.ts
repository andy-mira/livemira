// SPDX-License-Identifier: Apache-2.0
// ESM template alignment (Benhimane & Malis, IROS 2004) of the whole target template against a frame, coarse to
// fine. The homography is updated on SL(3) by right-composition with exp(Σ x_i A_i); the Jacobian uses the mean of
// the template and warped-image gradients (second-order convergence). A gain/bias pair absorbs global lighting
// changes and Huber weights limit occluders and highlights. Deterministic: fixed iteration order and schedule.

import type { ImagePyramid } from '@livemira-next/contracts';
import { multiply3 } from '@livemira-next/geometry';
import { inside, sample, sampleField, sampleGradient, type Gradients } from '@livemira-next/imaging';
import { solveInPlace } from '@livemira-next/geometry';

import type { EsmLevel, TargetModel } from './target-model.ts';

export interface EsmOptions {
  /** Iterations per image level, finest last; levels beyond the pyramid are skipped. */
  readonly iterations?: readonly number[];
  /** The coarsest level used keeps at least this target diagonal, px. */
  readonly minDiagonalPx?: number;
  /**
   * 'sampled' (default): Scharr gradients evaluated at the warped template pixels only (`sampleGradient`);
   * 'field': Scharr gradient images of the whole level, computed per frame. Both give the same values; 'field'
   * costs a full-level pass for ~3000 sampled pixels.
   */
  readonly gradients?: 'sampled' | 'field';
}

export interface EsmResult {
  readonly H: Float64Array;
  /** Normalised cross-correlation of warped image and template over the valid pixels of the final level. */
  readonly ncc: number;
  /** Share of template pixels that landed inside the image at the final level. */
  readonly validRatio: number;
  /** Weighted RMS photometric residual, gray levels. */
  readonly rms: number;
  readonly valid: number;
  readonly gain: number;
  readonly bias: number;
  readonly iterations: number;
}

/** exp(A) of a small 3×3 matrix, Taylor series to the fourth order. */
function expm(a: Float64Array): Float64Array {
  const out = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  let term = Float64Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let k = 1; k <= 4; k++) {
    term = multiply3(term, a).map((v) => v / k);
    for (let i = 0; i < 9; i++) out[i]! += term[i]!;
  }
  return out;
}

/** Σ x_i A_i for the generators used in target-model.ts. */
function generator(x: ArrayLike<number>): Float64Array {
  return Float64Array.from([x[4]!, x[2]!, x[0]!, x[3]!, -x[4]! - x[5]!, x[1]!, x[6]!, x[7]!, x[5]!]);
}

const scaleMat = (s: number): number[] => [s, 0, 0, 0, s, 0, 0, 0, 1];

/** Image px per target px at the target centre (square root of the local affine determinant). */
export function imageScale(H: ArrayLike<number>, width: number, height: number): number {
  const x = width / 2;
  const y = height / 2;
  const w = H[6]! * x + H[7]! * y + H[8]!;
  const u = (H[0]! * x + H[1]! * y + H[2]!) / w;
  const v = (H[3]! * x + H[4]! * y + H[5]!) / w;
  const a = (H[0]! - u * H[6]!) / w;
  const b = (H[1]! - u * H[7]!) / w;
  const c = (H[3]! - v * H[6]!) / w;
  const d = (H[4]! - v * H[7]!) / w;
  return Math.sqrt(Math.abs(a * d - b * c));
}

const A = new Float64Array(100);
const B = new Float64Array(10);
const J = new Float64Array(10);
const S = new Float64Array(3);
/**
 * Aligns `model`'s template to the frame pyramid starting from `Hinit` (image level-0 edge coordinates from target
 * edge coordinates). `gradients(l)` returns the Scharr gradients of image level l.
 */
export function esmAlign(
  model: TargetModel,
  pyramid: ImagePyramid,
  gradients: (level: number) => Gradients,
  Hinit: Float64Array,
  options: EsmOptions = {},
): EsmResult | null {
  const schedule = options.iterations ?? [8, 6, 5];
  const minDiag = options.minDiagonalPx ?? 56;
  const { width: tw, height: th } = model.info;
  const scale0 = imageScale(Hinit, tw, th);
  const diag0 = scale0 * Math.hypot(tw, th);
  let start = Math.min(schedule.length - 1, pyramid.levels.length - 1);
  while (start > 0 && diag0 / 2 ** start < minDiag) start--;
  let H: Float64Array = new Float64Array(Hinit);
  let gain = 1;
  let bias = 0;
  let iterations = 0;
  let last: { ncc: number; validRatio: number; rms: number; valid: number } | null = null;
  for (let l = start; l >= 0; l--) {
    const image = pyramid.levels[l]!;
    const grad = options.gradients === 'field' ? gradients(l) : null;
    const sl = scale0 / 2 ** l;
    const lt = Math.max(0, Math.min(model.esm.length - 1, Math.round(Math.log2(1 / Math.max(sl, 1e-6)))));
    const t: EsmLevel = model.esm[lt]!;
    if (t.count < 30) continue;
    // M maps normalised template coordinates to image level-l edge coordinates.
    const Ninv = [t.s, 0, t.cx, 0, t.s, t.cy, 0, 0, 1];
    const N = [1 / t.s, 0, -t.cx / t.s, 0, 1 / t.s, -t.cy / t.s, 0, 0, 1];
    let M = multiply3(multiply3(multiply3(scaleMat(2 ** -l), H), scaleMat(2 ** lt)), Ninv);
    let sigma = 12;
    const iters = schedule[schedule.length - 1 - l] ?? schedule.at(-1)!;
    for (let it = 0; it < iters; it++) {
      iterations++;
      A.fill(0);
      B.fill(0);
      let valid = 0;
      let absSum = 0;
      let sumI = 0;
      let sumT = 0;
      let sumII = 0;
      let sumTT = 0;
      let sumIT = 0;
      let sse = 0;
      const k = 1.5 * sigma;
      for (let p = 0; p < t.count; p++) {
        const u = t.pn[2 * p]!;
        const v = t.pn[2 * p + 1]!;
        const w = M[6]! * u + M[7]! * v + M[8]!;
        if (!(w > 1e-9)) continue;
        const x = (M[0]! * u + M[1]! * v + M[2]!) / w;
        const y = (M[3]! * u + M[4]! * v + M[5]!) / w;
        if (!inside(image.width, image.height, x, y, 1.5)) continue;
        let I: number, Ix: number, Iy: number;
        if (grad) {
          I = sample(image, x, y);
          Ix = sampleField(grad.gx, grad.width, x, y);
          Iy = sampleField(grad.gy, grad.width, x, y);
        } else {
          sampleGradient(image, x, y, S);
          I = S[0]!;
          Ix = S[1]!;
          Iy = S[2]!;
        }
        const a = (M[0]! - x * M[6]!) / w;
        const b = (M[1]! - x * M[7]!) / w;
        const c = (M[3]! - y * M[6]!) / w;
        const d = (M[4]! - y * M[7]!) / w;
        const T = t.value[p]!;
        const gu = 0.5 * (Ix * a + Iy * c + gain * t.gu[p]!);
        const gv = 0.5 * (Ix * b + Iy * d + gain * t.gv[p]!);
        const o = 16 * p;
        for (let i = 0; i < 8; i++) J[i] = gu * t.jwjg[o + i]! + gv * t.jwjg[o + 8 + i]!;
        J[8] = -T;
        J[9] = -1;
        const e = I - (gain * T + bias);
        const r = Math.abs(e);
        const wt = r <= k ? 1 : k / r;
        for (let i = 0; i < 10; i++) {
          const wi = wt * J[i]!;
          B[i]! += wi * e;
          for (let j = i; j < 10; j++) A[i * 10 + j]! += wi * J[j]!;
        }
        valid++;
        absSum += r;
        sse += wt * e * e;
        sumI += I;
        sumT += T;
        sumII += I * I;
        sumTT += T * T;
        sumIT += I * T;
      }
      if (valid < 24) return null;
      for (let i = 0; i < 10; i++) for (let j = 0; j < i; j++) A[i * 10 + j] = A[j * 10 + i]!;
      for (let i = 0; i < 10; i++) A[i * 11]! *= 1 + 1e-6;
      const x = Float64Array.from(B, (v) => -v);
      if (!solveInPlace(A, x, 10)) return null;
      M = multiply3(M, expm(generator(x)));
      gain = Math.min(4, Math.max(0.15, gain + x[8]!));
      bias += x[9]!;
      sigma = Math.max(4, (1.25 * absSum) / valid);
      const varI = sumII - (sumI * sumI) / valid;
      const varT = sumTT - (sumT * sumT) / valid;
      const cov = sumIT - (sumI * sumT) / valid;
      last = {
        ncc: varI > 0 && varT > 0 ? cov / Math.sqrt(varI * varT) : 0,
        validRatio: valid / t.count,
        rms: Math.sqrt(sse / valid),
        valid,
      };
      let step = 0;
      for (let i = 0; i < 8; i++) step = Math.max(step, Math.abs(x[i]!));
      if (step < 2e-5) break;
    }
    H = multiply3(multiply3(multiply3(scaleMat(2 ** l), M), N), scaleMat(2 ** -lt));
    const k8 = H[8]!;
    if (!(Math.abs(k8) > 1e-12)) return null;
    H = H.map((v) => v / k8);
  }
  if (!last || !H.every(Number.isFinite)) return null;
  return { H, ...last, gain, bias, iterations };
}
