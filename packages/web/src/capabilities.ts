// SPDX-License-Identifier: Apache-2.0
// Runtime capability probing (never from the user agent). Worker-only APIs are probed inside a Worker.

import type { Capability } from '@livemira-next/contracts';

/** Capabilities visible on the main thread. */
export function probeMainThread(scope: typeof globalThis = globalThis): Set<Capability> {
  const caps = new Set<Capability>(['dom']);
  const g = scope as unknown as Record<string, unknown>;
  if (typeof g.MediaStreamTrackProcessor === 'function') caps.add('mstp-window');
  if (typeof g.VideoFrame === 'function') {
    caps.add('videoframe');
    if (typeof (g.VideoFrame as { prototype?: { copyTo?: unknown } }).prototype?.copyTo === 'function')
      caps.add('videoframe-copyto');
  }
  if (typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype)
    caps.add('rvfc');
  if (typeof g.OffscreenCanvas === 'function') caps.add('offscreen-2d');
  if (g.crossOriginIsolated === true) caps.add('cross-origin-isolated');
  if (typeof g.DeviceMotionEvent === 'function') caps.add('device-motion');
  if (typeof g.Gyroscope === 'function') caps.add('generic-sensor');
  if ((navigator as unknown as { gpu?: unknown }).gpu) caps.add('webgpu');
  try {
    const canvas = document.createElement('canvas');
    if (canvas.getContext('webgl2')) caps.add('webgl2');
  } catch {
    // No WebGL2.
  }
  try {
    const simd = Uint8Array.from([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
    ]);
    if (WebAssembly.validate(simd)) caps.add('wasm-simd');
  } catch {
    // No WebAssembly.
  }
  return caps;
}

/** Whether a dedicated Worker exposes MediaStreamTrackProcessor (WebKit exposes it only there). */
export function probeWorkerTrackProcessor(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const source = "postMessage(typeof MediaStreamTrackProcessor === 'function')";
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const worker = new Worker(url);
      const done = (value: boolean): void => {
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(value);
      };
      worker.onmessage = (event) => done(event.data === true);
      worker.onerror = () => done(false);
      setTimeout(() => done(false), 2000);
    } catch {
      resolve(false);
    }
  });
}
