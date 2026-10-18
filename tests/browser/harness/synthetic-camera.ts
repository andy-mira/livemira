/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// A synthetic camera for desktop probes: getUserMedia returns the captureStream of a canvas that draws numbered
// frames. Each frame encodes its number in a row of 16 black or white cells along the top edge, so a probe can tell
// from pixels exactly which frame (and which size) is on screen. Changing the size emulates a camera that swaps its
// intrinsic dimensions after a rotation.

import type { Page } from 'playwright-core';

export interface SyntheticCameraOptions {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly frameRate: number;
}

/** Page-side control, available as window.__syntheticCamera. */
export interface SyntheticCameraControl {
  /** Number of the last drawn frame (starts at 1). */
  readonly frameNumber: number;
  setSize(widthPx: number, heightPx: number): void;
  /** Draws `image` into every frame at the centre, `fraction` of the frame height tall; null removes it. */
  setImage(image: CanvasImageSource | null, fraction?: number): void;
}

export const CELL_COUNT = 16;

/** Runs in the page before any page script. Must stay self-contained: it is serialized into the page. */
function installSyntheticCamera(options: SyntheticCameraOptions): void {
  const canvas = document.createElement('canvas');
  canvas.width = options.widthPx;
  canvas.height = options.heightPx;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Synthetic camera needs a 2D canvas');
  let frameNumber = 0;
  let picture: { image: CanvasImageSource; fraction: number } | null = null;
  const draw = (): void => {
    frameNumber++;
    const { width, height } = canvas;
    context.fillStyle = picture ? '#777' : `hsl(${(frameNumber * 37) % 360} 60% 45%)`;
    context.fillRect(0, 0, width, height);
    if (picture) {
      const source = picture.image as { width: number; height: number };
      const h = height * picture.fraction;
      const w = (h * source.width) / source.height;
      context.drawImage(picture.image, (width - w) / 2, (height - h) / 2, w, h);
    }
    const cell = width / 16;
    for (let bit = 0; bit < 16; bit++) {
      context.fillStyle = (frameNumber >> bit) & 1 ? '#fff' : '#000';
      context.fillRect(bit * cell, 0, cell, cell);
    }
    if (!picture) {
      context.fillStyle = '#fff';
      context.font = `${Math.round(height / 6)}px sans-serif`;
      context.fillText(String(frameNumber), width / 10, height / 2);
    }
  };
  draw();
  setInterval(draw, 1000 / options.frameRate);
  const stream = canvas.captureStream(options.frameRate);
  const control = {
    get frameNumber() {
      return frameNumber;
    },
    setSize(widthPx: number, heightPx: number) {
      canvas.width = widthPx;
      canvas.height = heightPx;
      draw();
    },
    setImage(image: CanvasImageSource | null, fraction = 0.6) {
      picture = image ? { image, fraction } : null;
      draw();
    },
  };
  Object.defineProperty(window, '__syntheticCamera', { value: control });
  const devices = {
    getUserMedia: async (constraints?: MediaStreamConstraints): Promise<MediaStream> => {
      if (!constraints?.video)
        throw new DOMException('Synthetic camera has video only', 'NotFoundError');
      return new MediaStream(stream.getVideoTracks().map((track) => track.clone()));
    },
    enumerateDevices: async (): Promise<MediaDeviceInfo[]> => [
      {
        deviceId: 'synthetic',
        groupId: 'synthetic',
        kind: 'videoinput',
        label: 'Synthetic camera',
        toJSON() {
          return this;
        },
      },
    ],
  };
  Object.defineProperty(navigator, 'mediaDevices', { value: devices, configurable: true });
}

export async function useSyntheticCamera(
  page: Page,
  options: SyntheticCameraOptions,
): Promise<void> {
  await page.addInitScript(installSyntheticCamera, options);
}
