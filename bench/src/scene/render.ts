// SPDX-License-Identifier: Apache-2.0
// Renders camera frames of the target lying on a cluttered table: trilinear (mip) sampling, motion blur integrated
// over the exposure, photometric changes, screen-space occluders and sensor noise. This renderer is the ground-truth
// generator and shares no code with the product kernels.

import { normal } from '../rng.ts';
import { invert3, type CameraModel } from './camera.ts';
import { sampleMip, type MipTexture } from './textures.ts';

export interface Photometry {
  readonly gain: number;
  readonly offset: number;
  readonly gamma: number;
  /** Corner darkening 0..1. */
  readonly vignette: number;
  /** Additive highlight in screen space, gray levels at the centre; saturates the picture where strong. */
  readonly specular?: { readonly x: number; readonly y: number; readonly radiusPx: number; readonly intensity: number };
}

export const NEUTRAL_LIGHT: Photometry = { gain: 1, offset: 0, gamma: 1, vignette: 0.15 };

export interface Occluder {
  readonly kind: 'ellipse' | 'rect';
  readonly cx: number;
  readonly cy: number;
  readonly rx: number;
  readonly ry: number;
  readonly value: number;
}

export interface SensorNoise {
  /** Read noise standard deviation in gray levels. */
  readonly readSigma: number;
  /** Shot noise: sigma = shot · 3 · sqrt(value / 255) gray levels (≈3 at white for shot = 1, a denoised phone camera). */
  readonly shot: number;
}

export const DEFAULT_NOISE: SensorNoise = { readSigma: 1.5, shot: 1 };

export interface FrameScene {
  readonly camera: CameraModel;
  /** Image-from-plane homographies sampled over the exposure (one entry: no motion blur). */
  readonly exposure: readonly Float64Array[];
  readonly target: {
    readonly mip: MipTexture;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly widthM: number;
  } | null;
  readonly table: { readonly mip: MipTexture; readonly metersPerTexel: number };
  readonly light: Photometry;
  readonly occluders: readonly Occluder[];
  readonly noise: SensorNoise;
  readonly seed: number;
}

/** Renders one gray8 frame of `scene.camera` size. */
export function renderFrame(scene: FrameScene): Uint8Array {
  const { width, height } = scene.camera;
  const acc = new Float32Array(width * height);
  const target = scene.target;
  const s = target ? target.widthM / target.widthPx : 1;
  const tw = target?.widthPx ?? 0;
  const th = target?.heightPx ?? 0;
  const tableSize = scene.table.mip.levels[0]!.width;
  const tableHalfM = (tableSize * scene.table.metersPerTexel) / 2;
  for (const H of scene.exposure) {
    const g = invert3(H);
    for (let y = 0; y < height; y++) {
      const py = y + 0.5;
      for (let x = 0; x < width; x++) {
        const px = x + 0.5;
        const W = g[6]! * px + g[7]! * py + g[8]!;
        let value: number;
        if (W <= 1e-9) value = 170 + (40 * y) / height;
        else {
          const X = (g[0]! * px + g[1]! * py + g[2]!) / W;
          const Y = (g[3]! * px + g[4]! * py + g[5]!) / W;
          // Footprint of one output pixel on the plane (metres), from the homography's local Jacobian.
          const dxX = (g[0]! - X * g[6]!) / W;
          const dxY = (g[3]! - Y * g[6]!) / W;
          const dyX = (g[1]! - X * g[7]!) / W;
          const dyY = (g[4]! - Y * g[7]!) / W;
          const footprintM = Math.max(Math.hypot(dxX, dxY), Math.hypot(dyX, dyY));
          const u = X / s + tw / 2;
          const v = Y / s + th / 2;
          if (target && u >= 0 && v >= 0 && u < tw && v < th) value = sampleMip(target.mip, u, v, footprintM / s);
          else if (Math.abs(X) < tableHalfM && Math.abs(Y) < tableHalfM) {
            const k = scene.table.metersPerTexel;
            value = sampleMip(scene.table.mip, (X + tableHalfM) / k, (Y + tableHalfM) / k, footprintM / k);
          } else value = 100;
        }
        acc[y * width + x]! += value;
      }
    }
  }
  const n = scene.exposure.length;
  for (let i = 0; i < acc.length; i++) acc[i]! /= n;
  for (const o of scene.occluders) {
    for (let y = Math.max(0, Math.floor(o.cy - o.ry)); y < Math.min(height, Math.ceil(o.cy + o.ry)); y++)
      for (let x = Math.max(0, Math.floor(o.cx - o.rx)); x < Math.min(width, Math.ceil(o.cx + o.rx)); x++) {
        const dx = (x + 0.5 - o.cx) / o.rx;
        const dy = (y + 0.5 - o.cy) / o.ry;
        if (o.kind === 'rect' || dx * dx + dy * dy <= 1) acc[y * width + x] = o.value + 12 * dy;
      }
  }
  const { gain, offset, gamma, vignette, specular } = scene.light;
  const rmax = Math.hypot(width / 2, height / 2);
  const random = normal(scene.seed);
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let v = acc[i]! * gain + offset;
      const r = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2) / rmax;
      v *= 1 - vignette * r * r;
      if (specular) {
        const d2 = ((x - specular.x) ** 2 + (y - specular.y) ** 2) / (specular.radiusPx * specular.radiusPx);
        v += specular.intensity * Math.exp(-1.5 * d2);
      }
      v = Math.max(0, Math.min(255, v));
      if (gamma !== 1) v = 255 * (v / 255) ** gamma;
      const sigma = Math.hypot(scene.noise.readSigma, scene.noise.shot * 3 * Math.sqrt(v / 255));
      v += sigma * random();
      out[i] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  return out;
}

/** Fraction of the target area that is inside the frame and not covered by an occluder (8×8 sample grid). */
export function visibleFraction(
  camera: CameraModel,
  H_imageFromTarget: ArrayLike<number>,
  widthPx: number,
  heightPx: number,
  occluders: readonly Occluder[],
): number {
  let visible = 0;
  const N = 8;
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const u = ((i + 0.5) / N) * widthPx;
      const v = ((j + 0.5) / N) * heightPx;
      const h = H_imageFromTarget;
      const w = h[6]! * u + h[7]! * v + h[8]!;
      if (w <= 0) continue;
      const x = (h[0]! * u + h[1]! * v + h[2]!) / w;
      const y = (h[3]! * u + h[4]! * v + h[5]!) / w;
      if (x < 0 || y < 0 || x >= camera.width || y >= camera.height) continue;
      const covered = occluders.some((o) => {
        const dx = (x - o.cx) / o.rx;
        const dy = (y - o.cy) / o.ry;
        return o.kind === 'rect' ? Math.abs(dx) <= 1 && Math.abs(dy) <= 1 : dx * dx + dy * dy <= 1;
      });
      if (!covered) visible++;
    }
  return visible / (N * N);
}
