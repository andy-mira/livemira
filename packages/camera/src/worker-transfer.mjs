/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { createFramePacket } from './packet.mjs';
import { getFrameGeometry } from './preview.mjs';

const abortError = () => new DOMException('Frame preparation aborted', 'AbortError');

/**
 * Copy-only boundary: the SDK's original handle remains borrowed and untouched.
 * @param {import('@livemira/contracts').FramePacket} frame
 * @param {import('@livemira/contracts').FrameGeometry | null} geometry
 * @param {AbortSignal} signal
 * @returns {Promise<import('@livemira/contracts').WorkerFrameLease>}
 */
export async function prepareWorkerFrame(frame, geometry = getFrameGeometry(frame), signal = new AbortController().signal) {
  const started = performance.now();
  if (signal.aborted) throw abortError();
  const { width, height, pixelFormat } = frame;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 16384)
    || width * height > 16777216) throw new RangeError('Worker frame dimensions exceed limit');
  if (frame.imageHandle.released) throw new Error('Frame already released');
  const source = frame.imageHandle.data;
  let image, copiedBytes = null, copy;
  try {
    if (pixelFormat === 'video-frame' || pixelFormat === 'image-bitmap') {
      if (!geometry) throw new Error('Native Worker frame requires captured geometry');
      if ((source.displayWidth ?? source.width) !== width || (source.displayHeight ?? source.height) !== height) {
        throw new Error('Native Worker image dimensions do not match frame metadata');
      }
      copy = pixelFormat === 'video-frame' ? source.clone() : await createImageBitmap(source);
      image = { kind: pixelFormat, image: copy };
    } else {
      if (!['gray8', 'rgba8', 'bgra8'].includes(pixelFormat)) throw new Error('Unsupported Worker image format');
      const channels = pixelFormat === 'gray8' ? 1 : 4;
      const payload = ArrayBuffer.isView(source) ? { data: source, byteOffset: 0, byteLength: source.byteLength,
        strideBytes: width * channels, coordinateSpace: geometry ? 'input' : 'standard' } : source;
      if (!payload || !(payload.data instanceof Uint8Array || payload.data instanceof Uint8ClampedArray)) throw new TypeError('Worker CPU frame requires byte pixels');
      if (payload.alphaPremultiplied === true || payload.colorEncoding === 'linear') throw new Error('Worker pixels require straight alpha and srgb or gray encoding');
      if (!geometry && (frame.rotation !== 0 || frame.mirrored || payload.coordinateSpace !== 'standard')) throw new Error('Input-space CPU pixels require geometry');
      const rowBytes = width * channels, stride = payload.strideBytes, offset = payload.byteOffset, length = payload.byteLength;
      if (![stride, offset, length].every(Number.isSafeInteger) || stride < rowBytes || offset < 0 || length < 0
        || offset + length > payload.data.byteLength || (height - 1) * stride + rowBytes > length) throw new RangeError('Invalid CPU image layout');
      const pixels = new Uint8Array(rowBytes * height);
      for (let y = 0; y < height; y++) pixels.set(payload.data.subarray(offset + y * stride, offset + y * stride + rowBytes), y * rowBytes);
      if (pixelFormat === 'bgra8') for (let i = 0; i < pixels.length; i += 4) {
        const b = pixels[i]; pixels[i] = pixels[i + 2]; pixels[i + 2] = b;
      }
      copiedBytes = pixels.byteLength;
      image = { kind: channels === 1 ? 'gray8' : 'rgba8', buffer: pixels.buffer, width, height, strideBytes: rowBytes };
    }
    if (signal.aborted) throw abortError();
    // Deep copy small geometry so later viewport edits cannot mutate an in-flight request.
    const boundGeometry = geometry ? { ...geometry, crop: { ...geometry.crop },
      H_standardFromInput: [...geometry.H_standardFromInput], H_viewportFromStandard: [...geometry.H_viewportFromStandard] } : null;
    const { imageHandle: _handle, ...metadata } = createFramePacket(frame);
    metadata.pixelFormat = image.kind;
    let state = 'owned';
    return { frame: { metadata, image, geometry: boundGeometry }, transfer: [copy ?? image.buffer], copiedBytes,
      preparationDurationUs: (performance.now() - started) * 1000,
      markTransferred() {
        if (state === 'released') throw new Error('Frame copy already released');
        state = 'transferred';
      },
      release() {
        if (state !== 'owned') return;
        state = 'released';
        copy?.close();
      } };
  } catch (error) { copy?.close(); throw error; }
}
