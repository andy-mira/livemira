// SPDX-License-Identifier: Apache-2.0
// Test helpers: a synthetic target, an independent bilinear renderer and frame/pose builders.

import { cornersOf, type FrameHandle, type GrayImage, type PoseEstimate } from '@livemira-next/contracts';

export function texture(width: number, height: number, seed: number): GrayImage {
  let s = seed;
  const r = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const data = new Uint8Array(width * height).fill(90);
  for (let i = 0; i < (width * height) / 200; i++) {
    const x = r() % width;
    const y = r() % height;
    const w = 4 + (r() % 30);
    const h = 4 + (r() % 30);
    const v = r() % 256;
    for (let yy = y; yy < Math.min(height, y + h); yy++)
      for (let xx = x; xx < Math.min(width, x + w); xx++) data[yy * width + xx] = v;
  }
  // Soften edges a little, like a camera.
  const out = new Uint8Array(data);
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++)
      out[y * width + x] = Math.round(
        (4 * data[y * width + x]! +
          data[y * width + x - 1]! +
          data[y * width + x + 1]! +
          data[(y - 1) * width + x]! +
          data[(y + 1) * width + x]!) /
          8,
      );
  return { width, height, stride: width, data: out };
}

export function invert(m: ArrayLike<number>): number[] {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m) as number[];
  const cof = [
    e! * i! - f! * h!,
    c! * h! - b! * i!,
    b! * f! - c! * e!,
    f! * g! - d! * i!,
    a! * i! - c! * g!,
    c! * d! - a! * f!,
    d! * h! - e! * g!,
    b! * g! - a! * h!,
    a! * e! - b! * d!,
  ];
  const det = a! * cof[0]! + b! * cof[3]! + c! * cof[6]!;
  return cof.map((v) => v / det);
}

/** Frame (640×360) showing `target` through H (pixel-edge coordinates), on a flat gray background. */
export function render(target: GrayImage, H: ArrayLike<number>, gain = 1, bias = 0): GrayImage {
  const g = invert(H);
  const data = new Uint8Array(640 * 360).fill(100);
  for (let y = 0; y < 360; y++)
    for (let x = 0; x < 640; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w = g[6]! * px + g[7]! * py + g[8]!;
      const u = (g[0]! * px + g[1]! * py + g[2]!) / w - 0.5;
      const v = (g[3]! * px + g[4]! * py + g[5]!) / w - 0.5;
      const i = Math.floor(u);
      const j = Math.floor(v);
      if (i < 0 || j < 0 || i + 1 >= target.width || j + 1 >= target.height) continue;
      const fx = u - i;
      const fy = v - j;
      const o = j * target.width + i;
      const d = target.data;
      const value =
        (1 - fy) * ((1 - fx) * d[o]! + fx * d[o + 1]!) +
        fy * ((1 - fx) * d[o + target.width]! + fx * d[o + target.width + 1]!);
      data[y * 640 + x] = Math.max(0, Math.min(255, Math.round(gain * value + bias)));
    }
  return { width: 640, height: 360, stride: 640, data };
}

export const TARGET = texture(400, 300, 77);
export const INFO = { id: 't', width: 400, height: 300, physicalWidthMeters: null };
export const H_TRUE = Float64Array.from([0.62, 0.12, 170, -0.08, 0.55, 70, 0.0002, -0.00015, 1]);

export function frame(id: number, image: GrayImage): FrameHandle {
  return {
    sessionId: 's',
    frameId: id,
    time: { captureUs: id * 33_333, receiveUs: id * 33_333, source: 'replay' },
    image: { kind: 'cpu-gray', image },
  };
}

export function poseOf(H: Float64Array, id: number): PoseEstimate {
  return {
    targetId: 't',
    frameId: id,
    timeUs: id * 33_333,
    H_imageFromTarget: H,
    corners: cornersOf(H, 400, 300),
    covariance: null,
    quality: { support: 0, ratio: 0, residual: 0, residualKind: 'px', coverage: 0 },
    origin: 'predicted',
  };
}

export function cornerError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const ca = cornersOf(a, 400, 300);
  const cb = cornersOf(b, 400, 300);
  return ca.reduce((s, p, i) => s + Math.hypot(p[0] - cb[i]![0], p[1] - cb[i]![1]), 0) / 4;
}
