/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Standard image drawing with integer transforms (rotation, mirroring, crop, no scaling) must equal a per-pixel CPU
// remapping exactly, for CPU pixels, ImageBitmap and VideoFrame inputs.

import { createGeometry } from '@livemira/camera';
import {
  rgbaToGray,
  standardize,
  StandardImageWorkspace,
  type TransferredImage,
} from '@livemira/compute';
import type { FrameGeometry } from '@livemira/contracts';

export interface StandardizeCaseReport {
  readonly name: string;
  readonly kind: string;
  readonly mismatches: number;
  readonly size: readonly [number, number];
  readonly error?: string;
}

function randomOpaqueRgba(
  width: number,
  height: number,
  seed: number,
): Uint8ClampedArray<ArrayBuffer> {
  let s = seed;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      data[i + c] = (s >>> 0) & 255;
    }
    data[i + 3] = 255;
  }
  return data;
}

/** Expected gray: each standard pixel centre mapped back to its input pixel (exact for integer transforms). */
function expected(gray: Uint8Array, width: number, geometry: FrameGeometry): Uint8Array {
  const h = geometry.H_standardFromInput;
  const det = h[0] * h[4] - h[1] * h[3];
  const out = new Uint8Array(geometry.standardWidthPx * geometry.standardHeightPx);
  for (let y = 0; y < geometry.standardHeightPx; y++) {
    for (let x = 0; x < geometry.standardWidthPx; x++) {
      const u = x + 0.5 - h[2];
      const v = y + 0.5 - h[5];
      const ix = Math.floor((h[4] * u - h[1] * v) / det);
      const iy = Math.floor((-h[3] * u + h[0] * v) / det);
      out[y * geometry.standardWidthPx + x] = gray[iy * width + ix]!;
    }
  }
  return out;
}

async function inputOf(
  kind: string,
  rgba: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<TransferredImage> {
  if (kind === 'rgba8')
    return { kind: 'rgba8', buffer: rgba.slice().buffer, width, height, strideBytes: width * 4 };
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(rgba, width, height), 0, 0);
  if (kind === 'image-bitmap')
    return { kind: 'image-bitmap', image: await createImageBitmap(canvas) };
  return { kind: 'video-frame', image: new VideoFrame(canvas, { timestamp: 0 }) };
}

async function run(): Promise<StandardizeCaseReport[]> {
  const width = 64;
  const height = 48;
  const rgba = randomOpaqueRgba(width, height, 0x1234567);
  const gray = rgbaToGray(new Uint8Array(rgba.buffer), width, height).data;
  const workspace = new StandardImageWorkspace();
  const reports: StandardizeCaseReport[] = [];
  const cases = [
    { name: 'identity', params: {} },
    { name: 'rotate-90', params: { rotationDeg: 90 as const } },
    { name: 'rotate-180', params: { rotationDeg: 180 as const } },
    { name: 'rotate-270', params: { rotationDeg: 270 as const } },
    { name: 'mirror', params: { isMirrored: true } },
    { name: 'mirror-rotate-90', params: { isMirrored: true, rotationDeg: 90 as const } },
    {
      name: 'crop-rotate-270',
      params: { crop: { x: 5, y: 3, width: 40, height: 30 }, rotationDeg: 270 as const },
    },
  ];
  for (const kind of ['rgba8', 'image-bitmap', 'video-frame']) {
    for (const { name, params } of cases) {
      const geometry = createGeometry({
        widthPx: width,
        heightPx: height,
        longEdge: 'native',
        ...params,
      });
      try {
        const image = await inputOf(kind, rgba, width, height);
        const result = standardize({ image, geometry }, workspace);
        if ('image' in image) image.image.close();
        const want = expected(gray, width, geometry);
        let mismatches = 0;
        for (let i = 0; i < want.length; i++) if (want[i] !== result.data[i]) mismatches++;
        reports.push({ name, kind, mismatches, size: [result.widthPx, result.heightPx] });
      } catch (error) {
        reports.push({ name, kind, mismatches: -1, size: [0, 0], error: String(error) });
      }
    }
  }
  workspace.dispose();
  return reports;
}

Object.defineProperty(window, '__probe', { value: run() });
