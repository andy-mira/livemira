/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Presence and exercised capability are deliberately reported separately. No permission prompt. */
export async function probeCapabilities(env = globalThis) {
  const result = {
    secureContext: env.isSecureContext === true,
    getUserMedia: typeof env.navigator?.mediaDevices?.getUserMedia === 'function',
    requestVideoFrameCallback: typeof env.HTMLVideoElement?.prototype?.requestVideoFrameCallback === 'function',
    videoFrame: typeof env.VideoFrame === 'function', imageBitmap: typeof env.createImageBitmap === 'function',
    offscreenCanvas: typeof env.OffscreenCanvas === 'function',
    webgpuPresent: !!env.navigator?.gpu, webgpuAdapter: 'unavailable',
    crossOriginIsolated: env.crossOriginIsolated === true,
    sharedArrayBuffer: typeof env.SharedArrayBuffer === 'function', wasmSimd: false,
    capturePath: 'unverified', videoFrameConstruction: 'unavailable', imageBitmapConstruction: 'unavailable',
    videoFrameTransfer: 'unavailable', imageBitmapTransfer: 'unavailable', cpuBufferTransfer: 'unavailable',
    canvasReadback: 'unavailable', workerPresent: typeof env.Worker === 'function',
  };
  // Minimal valid module returning v128.const. Validation does not instantiate application code.
  const simd = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,...Array(16).fill(0),11]);
  result.wasmSimd = env.WebAssembly?.validate(simd) ?? false;
  if (typeof env.structuredClone === 'function') {
    try {
      const buffer = new ArrayBuffer(4), received = env.structuredClone(buffer, { transfer: [buffer] });
      result.cpuBufferTransfer = buffer.byteLength === 0 && received.byteLength === 4 ? 'passed' : 'failed';
    } catch { result.cpuBufferTransfer = 'failed'; }
  }
  if (env.navigator?.gpu) {
    try { result.webgpuAdapter = await env.navigator.gpu.requestAdapter() ? 'available' : 'unavailable'; }
    catch { result.webgpuAdapter = 'failed'; }
  }
  const canvas = env.document?.createElement('canvas') ?? (result.offscreenCanvas ? new env.OffscreenCanvas(2, 2) : null);
  if (canvas) {
    canvas.width = canvas.height = 2;
    try {
      const context = canvas.getContext('2d'); context?.fillRect(0, 0, 2, 2);
      result.canvasReadback = context?.getImageData(0, 0, 2, 2).data.length === 16 ? 'passed' : 'failed';
    } catch { result.canvasReadback = 'failed'; }
    if (result.videoFrame) {
      try {
        const frame = new env.VideoFrame(canvas, { timestamp: 0 }); result.videoFrameConstruction = 'passed';
        try {
          if (env.structuredClone) { const received = env.structuredClone(frame, { transfer: [frame] }); received.close(); result.videoFrameTransfer = 'passed'; }
        } catch { result.videoFrameTransfer = 'failed'; }
        finally { frame.close(); }
      }
      catch { result.videoFrameConstruction = 'failed'; }
    }
    if (result.imageBitmap) {
      try {
        const bitmap = await env.createImageBitmap(canvas); result.imageBitmapConstruction = 'passed';
        try {
          if (env.structuredClone) { const received = env.structuredClone(bitmap, { transfer: [bitmap] }); received.close(); result.imageBitmapTransfer = 'passed'; }
        } catch { result.imageBitmapTransfer = 'failed'; }
        finally { bitmap.close(); }
      }
      catch { result.imageBitmapConstruction = 'failed'; }
    }
  }
  result.wasmThreadsPrerequisites = result.crossOriginIsolated && result.sharedArrayBuffer;
  return result;
}
