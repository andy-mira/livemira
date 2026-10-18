/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared test fixtures: synthetic images, frames and an in-process vision Worker endpoint.

import { createGeometry, createOwnedImage } from '@livemira/camera';
import type { Frame, FrameImage } from '@livemira/contracts';
import type { GrayImage } from '@livemira/recognition';

import type { VisionRequest, VisionResponse } from '../src/worker/protocol.ts';
import type { WorkerEndpoint } from '../src/worker/vision-client.ts';
import { createVisionRuntime } from '../src/worker/vision-runtime.ts';

/** Random filled rectangles over a flat background. */
export function texture(seed = 1234, widthPx = 320, heightPx = 240): GrayImage {
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const data = new Uint8Array(widthPx * heightPx).fill(80);
  for (let i = 0; i < 900; i++) {
    const x = random() % widthPx;
    const y = random() % heightPx;
    const w = 3 + (random() % 20);
    const h = 3 + (random() % 20);
    const color = random() % 256;
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = color;
    }
  }
  return { widthPx, heightPx, data };
}

export interface FrameOptions {
  readonly pictureKey?: string;
  readonly timeUs?: number;
  readonly image?: FrameImage;
  readonly widthPx?: number;
  readonly heightPx?: number;
}

/** A frame whose picture is `gray` (standard orientation); its owner refuses to be released by a borrower. */
export function grayFrame(
  sessionId: string,
  frameId: number,
  gray: GrayImage,
  options: FrameOptions = {},
): Frame {
  const timeUs = options.timeUs ?? frameId * 33333;
  const widthPx = options.widthPx ?? gray.widthPx;
  const heightPx = options.heightPx ?? gray.heightPx;
  return {
    sessionId,
    frameId,
    pictureKey: options.pictureKey ?? `image-${frameId}`,
    timing: {
      sourceTimestampUs: timeUs,
      timestampSource: 'replay',
      arrivalTimeUs: timeUs,
      observationTimeUs: timeUs,
    },
    widthPx,
    heightPx,
    geometry: createGeometry({ widthPx, heightPx, longEdge: 'native' }),
    image:
      options.image ??
      createOwnedImage('gray8', gray.data, () => {
        throw new Error('A borrower released the original picture');
      }),
  };
}

type Listener = (event: MessageEvent) => void;

/** A Worker endpoint running the real vision runtime in this thread, with structured cloning and transfer. */
export class InProcessWorker implements WorkerEndpoint {
  readonly posted: VisionRequest[] = [];
  isTerminated = false;
  /** When true, frame requests are swallowed (a hung Worker). */
  hangsOnFrames = false;
  /** Rewrites each response before the client sees it (an untrusted Worker). */
  tamper: ((response: VisionResponse) => VisionResponse) | null = null;
  private readonly listeners = new Map<string, Listener>();
  private readonly runtime = createVisionRuntime((data) =>
    queueMicrotask(() =>
      this.emit('message', {
        data: this.tamper ? this.tamper(structuredClone(data)) : data,
      } as MessageEvent),
    ),
  );

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }

  emit(type: string, event: MessageEvent): void {
    this.listeners.get(type)?.(event);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const clone = structuredClone(message, { transfer }) as VisionRequest;
    this.posted.push(clone);
    if (this.hangsOnFrames && clone.type === 'frame') return;
    queueMicrotask(() => void this.runtime(clone));
  }

  terminate(): void {
    this.isTerminated = true;
  }
}
