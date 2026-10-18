/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Taking a picture of the current video frame. Strategies are tried in order; one that fails is disabled for the
// rest of the camera run. Canvas readback is always the last resort.

import type { FrameGeometry } from '@livemira/contracts';

/** The parts of a window snapshots use. */
export interface SnapshotEnvironment {
  readonly VideoFrame?: new (source: CanvasImageSource, init: { timestamp: number }) => VideoFrame;
  createImageBitmap?(source: CanvasImageSource): Promise<ImageBitmap>;
}

export interface SnapshotStrategy {
  readonly format: 'video-frame' | 'image-bitmap';
  isAvailable(env: SnapshotEnvironment): boolean;
  /** A synchronous strategy returns the picture directly, so taking it adds no asynchronous step. */
  take(
    env: SnapshotEnvironment,
    video: HTMLVideoElement,
    sourceTimestampUs: number,
  ): VideoFrame | ImageBitmap | Promise<ImageBitmap>;
  /** True when a failure should disable this strategy only if the camera run is still current. */
  readonly disablesOnlyWhenCurrent: boolean;
}

/** `new VideoFrame(video)`: no copy on the main thread where the browser supports it. */
export const videoFrameSnapshot: SnapshotStrategy = {
  format: 'video-frame',
  isAvailable: (env) => typeof env.VideoFrame === 'function',
  take: (env, video, sourceTimestampUs) =>
    new env.VideoFrame!(video, { timestamp: Math.round(sourceTimestampUs) }),
  disablesOnlyWhenCurrent: false,
};

/** `createImageBitmap(video)`. */
export const imageBitmapSnapshot: SnapshotStrategy = {
  format: 'image-bitmap',
  isAvailable: (env) => typeof env.createImageBitmap === 'function',
  take: (env, video) => env.createImageBitmap!(video),
  disablesOnlyWhenCurrent: true,
};

/** Strategies of the capture modes: 'auto' tries native pictures first, 'canvas' reads pixels back only. */
export const SNAPSHOT_STRATEGIES: Readonly<Record<'auto' | 'canvas', readonly SnapshotStrategy[]>> =
  Object.freeze({
    auto: Object.freeze([videoFrameSnapshot, imageBitmapSnapshot]),
    canvas: Object.freeze([]),
  });

export interface SnapshotStats {
  snapshots: number;
  bitmapCopies: number;
  snapshotFailures: number;
  nativeSnapshotFailures: number;
  bitmapSnapshotFailures: number;
  cpuReadbackBytes: number;
}

export interface NativeSnapshot {
  readonly picture: NativePicture;
  readonly format: SnapshotStrategy['format'];
}

export type NativePicture = (VideoFrame | ImageBitmap) & {
  readonly displayWidth?: number;
  readonly displayHeight?: number;
};

/** Per-run state of the snapshot strategies and the cached readback canvas. */
export class Snapshotter {
  private readonly disabled = new Set<SnapshotStrategy>();
  private standardCanvas: HTMLCanvasElement | null = null;
  private standardContext: CanvasRenderingContext2D | null = null;
  private readonly strategies: readonly SnapshotStrategy[];
  private readonly env: SnapshotEnvironment;
  private readonly stats: SnapshotStats;

  constructor(
    env: SnapshotEnvironment,
    strategies: readonly SnapshotStrategy[],
    stats: SnapshotStats,
  ) {
    this.env = env;
    this.strategies = strategies;
    this.stats = stats;
  }

  /**
   * The first native picture any enabled strategy produces, or null. A synchronous strategy (VideoFrame) answers
   * synchronously, so no asynchronous step is added; an asynchronous one (ImageBitmap) answers through a promise.
   * `isCurrent` tells whether the camera run that asked is still current when an asynchronous strategy fails.
   */
  takeNative(
    video: HTMLVideoElement,
    sourceTimestampUs: number,
    isCurrent: () => boolean,
  ): NativeSnapshot | null | Promise<NativeSnapshot | null> {
    return this.tryFrom(0, video, sourceTimestampUs, isCurrent);
  }

  private tryFrom(
    index: number,
    video: HTMLVideoElement,
    sourceTimestampUs: number,
    isCurrent: () => boolean,
  ): NativeSnapshot | null | Promise<NativeSnapshot | null> {
    for (let i = index; i < this.strategies.length; i++) {
      const strategy = this.strategies[i]!;
      if (this.disabled.has(strategy) || !strategy.isAvailable(this.env)) continue;
      let picture: VideoFrame | ImageBitmap | Promise<ImageBitmap>;
      try {
        picture = strategy.take(this.env, video, sourceTimestampUs);
      } catch {
        this.fail(strategy, isCurrent);
        continue;
      }
      if (!(picture instanceof Promise)) return this.succeed(strategy, picture);
      return picture.then(
        (settled) => this.succeed(strategy, settled),
        () => {
          this.fail(strategy, isCurrent);
          return this.tryFrom(i + 1, video, sourceTimestampUs, isCurrent);
        },
      );
    }
    return null;
  }

  private succeed(strategy: SnapshotStrategy, picture: VideoFrame | ImageBitmap): NativeSnapshot {
    if (strategy.format === 'image-bitmap') this.stats.bitmapCopies++;
    return { picture: picture as NativePicture, format: strategy.format };
  }

  private fail(strategy: SnapshotStrategy, isCurrent: () => boolean): void {
    if (strategy.format === 'video-frame') this.stats.nativeSnapshotFailures++;
    else this.stats.bitmapSnapshotFailures++;
    if (!strategy.disablesOnlyWhenCurrent || isCurrent()) this.disabled.add(strategy);
  }

  /**
   * Canvas readback: draws the frame straight into its standard image with the geometry's transform (the canvas is
   * cached, its context requested once per size) and reads that back. The Worker then only converts it to gray.
   */
  readback(doc: Document, video: HTMLVideoElement, geometry: FrameGeometry): Uint8Array {
    const widthPx = geometry.standardWidthPx;
    const heightPx = geometry.standardHeightPx;
    this.standardCanvas ??= doc.createElement('canvas');
    if (this.standardCanvas.width !== widthPx || this.standardCanvas.height !== heightPx) {
      this.standardCanvas.width = widthPx;
      this.standardCanvas.height = heightPx;
      this.standardContext = null;
    }
    this.standardContext ??= this.standardCanvas.getContext('2d', { willReadFrequently: true });
    const context = this.standardContext;
    if (!context) throw new Error('IMAGE_SNAPSHOT_UNAVAILABLE');
    const h = geometry.H_standardFromInput;
    try {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, widthPx, heightPx);
      context.setTransform(h[0], h[3], h[1], h[4], h[2], h[5]);
      context.drawImage(video, 0, 0);
    } finally {
      context.setTransform(1, 0, 0, 1, 0, 0);
    }
    const rgba = context.getImageData(0, 0, widthPx, heightPx);
    const pixels = new Uint8Array(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength);
    this.stats.cpuReadbackBytes += pixels.byteLength;
    return pixels;
  }

  dispose(): void {
    this.standardContext = null;
    if (this.standardCanvas) this.standardCanvas.width = this.standardCanvas.height = 0;
    this.standardCanvas = null;
  }
}
