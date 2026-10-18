/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The camera's standard readback against the earlier path, on one still camera picture: the earlier path read the
// full picture back and drew the standard image from it in the Worker; the camera now draws the standard image straight
// from the video. The report holds per-geometry gray differences, so any change of the recognition input is known.

import { createGeometry } from '@livemira/camera';
import { rgbaToGray, standardize, StandardImageWorkspace } from '@livemira/compute';

import { Snapshotter, type SnapshotStats } from '../../../packages/camera/src/capture/snapshot.ts';

export interface StandardReadbackCase {
  readonly name: string;
  readonly size: readonly [number, number];
  readonly meanAbsDiff: number;
  readonly maxDiff: number;
  /** Share of pixels that differ by more than 2 gray levels. */
  readonly over2: number;
  readonly defaultBytes: number;
  readonly experimentBytes: number;
  readonly error?: string;
}

/** A camera-like picture: smooth gradients, edges and fine texture, from a fixed seed. */
function picture(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const gradient = g.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2b4a6f');
  gradient.addColorStop(0.5, '#d9c48a');
  gradient.addColorStop(1, '#3d6b3a');
  g.fillStyle = gradient;
  g.fillRect(0, 0, width, height);
  let seed = 987654;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  for (let i = 0; i < 900; i++) {
    const v = Math.floor(random() * 256);
    g.fillStyle = `rgba(${v},${(v * 7) & 255},${(v * 13) & 255},${0.3 + random() * 0.7})`;
    const x = random() * width;
    const y = random() * height;
    if (random() < 0.5) g.fillRect(x, y, 2 + random() * 60, 2 + random() * 60);
    else {
      g.beginPath();
      g.arc(x, y, 1 + random() * 30, 0, Math.PI * 2);
      g.fill();
    }
  }
  return canvas;
}

async function stillVideo(source: HTMLCanvasElement): Promise<HTMLVideoElement> {
  // A canvas stream only delivers frames when the canvas is painted: repaint the same picture until the video holds it.
  const copy = document.createElement('canvas');
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext('2d')!.drawImage(source, 0, 0);
  const g = source.getContext('2d')!;
  let isPainting = true;
  const paint = (): void => {
    if (!isPainting) return;
    g.drawImage(copy, 0, 0);
    requestAnimationFrame(paint);
  };
  paint();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source.captureStream();
  await video.play();
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if (video.videoWidth === source.width && video.videoHeight === source.height) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
  for (let i = 0; i < 10; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  video.pause();
  isPainting = false;
  return video;
}

/** The earlier canvas readback: the full picture, as the Worker used to receive it. */
function fullReadback(video: HTMLVideoElement, width: number, height: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(video, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height);
  return new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
}

async function run(): Promise<StandardReadbackCase[]> {
  const width = 720;
  const height = 1280;
  const video = await stillVideo(picture(width, height));
  const stats = { cpuReadbackBytes: 0 } as SnapshotStats;
  const snapshotter = new Snapshotter({}, [], stats);
  const workspace = new StandardImageWorkspace();
  const viewport = { viewportWidthCss: 390, viewportHeightCss: 844, devicePixelRatio: 3 };
  const cases = [
    { name: 'long-edge-640-cover', params: { longEdge: 640 as const, fit: 'cover' as const } },
    { name: 'long-edge-480-cover', params: { longEdge: 480 as const, fit: 'cover' as const } },
    { name: 'long-edge-960-contain', params: { longEdge: 960 as const, fit: 'contain' as const } },
    { name: 'native', params: { longEdge: 'native' as const } },
    {
      name: 'long-edge-640-rotate-90-mirrored',
      params: { longEdge: 640 as const, rotationDeg: 90 as const, isMirrored: true },
    },
  ];
  const reports: StandardReadbackCase[] = [];
  for (const { name, params } of cases) {
    try {
      const geometry = createGeometry({ widthPx: width, heightPx: height, ...viewport, ...params });
      const full = fullReadback(video, width, height);
      const before = standardize(
        {
          image: {
            kind: 'rgba8',
            buffer: full.slice().buffer,
            width,
            height,
            strideBytes: width * 4,
          },
          geometry,
        },
        workspace,
      ).data.slice();
      const standard = snapshotter.readback(document, video, geometry);
      const after = rgbaToGray(standard, geometry.standardWidthPx, geometry.standardHeightPx).data;
      let sum = 0;
      let maxDiff = 0;
      let over2 = 0;
      for (let i = 0; i < before.length; i++) {
        const d = Math.abs(before[i]! - after[i]!);
        sum += d;
        if (d > maxDiff) maxDiff = d;
        if (d > 2) over2++;
      }
      reports.push({
        name,
        size: [geometry.standardWidthPx, geometry.standardHeightPx],
        meanAbsDiff: sum / before.length,
        maxDiff,
        over2: over2 / before.length,
        defaultBytes: full.byteLength,
        experimentBytes: standard.byteLength,
      });
    } catch (error) {
      reports.push({
        name,
        size: [0, 0],
        meanAbsDiff: -1,
        maxDiff: -1,
        over2: -1,
        defaultBytes: 0,
        experimentBytes: 0,
        error: String(error),
      });
    }
  }
  workspace.dispose();
  snapshotter.dispose();
  return reports;
}

Object.defineProperty(window, '__probe', { value: run() });
