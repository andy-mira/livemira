/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Node has no OffscreenCanvas. This stand-in keeps real RGBA pixels and maps them with the supplied affine transform
// (nearest neighbour), so tests check the Worker's caching, clearing, stride and limit logic, not browser resampling.

export interface CanvasLog {
  readonly canvases: FakeCanvas[];
  contexts: number;
  resizes: number;
  clears: number;
  draws: number;
  imageData: number;
  readonly contextOptions: unknown[];
  readonly flags: { noContext: boolean; ctorThrows: boolean };
}

export interface PixelSource {
  readonly width?: number;
  readonly height?: number;
  readonly displayWidth?: number;
  readonly displayHeight?: number;
  readonly pixels: Uint8ClampedArray | Uint8Array;
}

let log: CanvasLog | null = null;

class FakeImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4)
      throw new RangeError('ImageData size');
    this.data = data;
    this.width = width;
    this.height = height;
    log!.imageData++;
  }
}

class FakeContext {
  private t = [1, 0, 0, 1, 0, 0];
  readonly canvas: FakeCanvas;
  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.t = [a, b, c, d, e, f];
  }
  resetTransform(): void {
    this.t = [1, 0, 0, 1, 0, 0];
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    log!.clears++;
    const c = this.canvas;
    for (let j = y; j < y + h; j++)
      c.pixels.fill(0, (j * c.width + x) * 4, (j * c.width + x + w) * 4);
  }
  putImageData(image: FakeImageData, x: number, y: number): void {
    const c = this.canvas;
    for (let j = 0; j < image.height; j++)
      c.pixels.set(
        image.data.subarray(j * image.width * 4, (j + 1) * image.width * 4),
        ((y + j) * c.width + x) * 4,
      );
  }
  getImageData(x: number, y: number, w: number, h: number): FakeImageData {
    const c = this.canvas;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let j = 0; j < h; j++)
      data.set(
        c.pixels.subarray(((y + j) * c.width + x) * 4, ((y + j) * c.width + x + w) * 4),
        j * w * 4,
      );
    return new FakeImageData(data, w, h);
  }
  drawImage(source: PixelSource): void {
    log!.draws++;
    const c = this.canvas;
    const [a, b, cc, d, e, f] = this.t as [number, number, number, number, number, number];
    const det = a * d - b * cc;
    const sw = source.displayWidth ?? source.width!;
    const sh = source.displayHeight ?? source.height!;
    if (!det) return;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const X = x + 0.5 - e;
        const Y = y + 0.5 - f;
        const sx = Math.floor((d * X - cc * Y) / det);
        const sy = Math.floor((-b * X + a * Y) / det);
        if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) {
          const s = (sy * sw + sx) * 4;
          const t = (y * c.width + x) * 4;
          for (let k = 0; k < 4; k++) c.pixels[t + k] = source.pixels[s + k]!;
        }
      }
    }
  }
}

export class FakeCanvas {
  #w: number;
  #h: number;
  pixels: Uint8ClampedArray;
  context: FakeContext | undefined;
  constructor(w: number, h: number) {
    if (log!.flags.ctorThrows) throw new Error('canvas allocation failed');
    this.#w = w;
    this.#h = h;
    this.pixels = new Uint8ClampedArray(w * h * 4);
    log!.canvases.push(this);
  }
  // `resizes` counts effective size changes; assigning the same value is a no-op here (a real canvas would clear).
  get width(): number {
    return this.#w;
  }
  set width(v: number) {
    if (v !== this.#w) log!.resizes++;
    this.#w = v;
    this.pixels = new Uint8ClampedArray(v * this.#h * 4);
  }
  get height(): number {
    return this.#h;
  }
  set height(v: number) {
    if (v !== this.#h) log!.resizes++;
    this.#h = v;
    this.pixels = new Uint8ClampedArray(this.#w * v * 4);
  }
  getContext(_type: string, options?: unknown): FakeContext | null {
    log!.contexts++;
    log!.contextOptions.push(options);
    if (log!.flags.noContext) return null;
    return (this.context ??= new FakeContext(this));
  }
}

const globals = globalThis as { OffscreenCanvas?: unknown; ImageData?: unknown };

/** Installs the fake canvas for the duration of `run`. */
export async function withCanvas<T>(
  flags: Partial<CanvasLog['flags']>,
  run: (log: CanvasLog) => T | Promise<T>,
): Promise<T> {
  log = {
    canvases: [],
    contexts: 0,
    resizes: 0,
    clears: 0,
    draws: 0,
    imageData: 0,
    contextOptions: [],
    flags: { noContext: false, ctorThrows: false, ...flags },
  };
  globals.OffscreenCanvas = FakeCanvas;
  globals.ImageData = FakeImageData;
  try {
    return await run(log);
  } finally {
    delete globals.OffscreenCanvas;
    delete globals.ImageData;
    log = null;
  }
}
