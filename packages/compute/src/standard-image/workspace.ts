/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

export interface Surface {
  readonly canvas: OffscreenCanvas;
  readonly context: OffscreenCanvasRenderingContext2D;
}

/** Creates a canvas surface; injectable for tests. */
export type SurfaceFactory = (
  widthPx: number,
  heightPx: number,
  willReadFrequently: boolean,
) => Surface;

/** Scratch buffers above this size are allocated per frame instead of kept. */
const SCRATCH_CACHE_MAX_BYTES = 16 * 1048576;

const offscreenSurface: SurfaceFactory = (widthPx, heightPx, willReadFrequently) => {
  let canvas: OffscreenCanvas | null = null;
  try {
    canvas = new OffscreenCanvas(widthPx, heightPx);
    const context = canvas.getContext(
      '2d',
      willReadFrequently ? { willReadFrequently: true } : undefined,
    );
    if (context) return { canvas, context };
  } catch {
    // Reported below.
  }
  if (canvas) canvas.width = canvas.height = 0;
  throw new EngineError('UNSUPPORTED', 'No worker canvas', { isRecoverable: true });
};

/** Canvases and scratch bytes owned by one Worker runtime: resized only when dimensions change, released by dispose(). */
export class StandardImageWorkspace {
  private input: Surface | null = null;
  private output: Surface | null = null;
  private scratch: ArrayBuffer | null = null;
  private readonly createSurface: SurfaceFactory;

  constructor(createSurface: SurfaceFactory = offscreenSurface) {
    this.createSurface = createSurface;
  }

  inputSurface(widthPx: number, heightPx: number): Surface {
    return (this.input = this.fit(this.input, widthPx, heightPx, false));
  }

  outputSurface(widthPx: number, heightPx: number): Surface {
    return (this.output = this.fit(this.output, widthPx, heightPx, true));
  }

  private fit(
    surface: Surface | null,
    widthPx: number,
    heightPx: number,
    willReadFrequently: boolean,
  ): Surface {
    if (!surface) return this.createSurface(widthPx, heightPx, willReadFrequently);
    if (surface.canvas.width !== widthPx || surface.canvas.height !== heightPx) {
      surface.canvas.width = widthPx;
      surface.canvas.height = heightPx;
    }
    return surface;
  }

  /** Contents are undefined; callers overwrite every byte. Small buffers are reused across frames. */
  bytes(length: number): Uint8ClampedArray<ArrayBuffer> {
    if (length > SCRATCH_CACHE_MAX_BYTES) return new Uint8ClampedArray(length);
    if (!this.scratch || this.scratch.byteLength < length) this.scratch = new ArrayBuffer(length);
    return new Uint8ClampedArray(this.scratch, 0, length);
  }

  dispose(): void {
    for (const surface of [this.input, this.output])
      if (surface) surface.canvas.width = surface.canvas.height = 0;
    this.input = this.output = null;
    this.scratch = null;
  }
}
