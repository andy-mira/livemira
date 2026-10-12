/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FramePacket, CpuImagePayload } from '@livemira/contracts';
import { rgbaToGray, buildPyramid, algorithmVersion } from './reference.mjs';

/** CPU input bridge; does not implement the provisional ComputeBackend. */
export function copyCanonicalFrame(frame: FramePacket, signal?: AbortSignal, kernels = { rgbaToGray, buildPyramid }) {
  signal?.throwIfAborted();
  if (frame.imageHandle.released) throw new RangeError('Frame handle is released');
  if (!frame.sessionId || !Number.isSafeInteger(frame.frameId) || frame.frameId < 0) throw new RangeError('Invalid frame identity');
  if (frame.rotation !== 0 || frame.mirrored) throw new RangeError('Canonical orientation required');
  if (frame.imageHandle.kind !== frame.pixelFormat) throw new RangeError('Pixel format mismatch');
  const payload = frame.imageHandle.data;
  let data: Uint8Array, stride: number | undefined;
  if (payload instanceof Uint8Array) data = payload;
  else {
    const p = payload as CpuImagePayload;
    if (!p || !(p.data instanceof Uint8Array) || !Number.isSafeInteger(p.byteOffset) || !Number.isSafeInteger(p.byteLength) ||
        p.byteOffset < 0 || p.byteLength < 0 || p.byteOffset + p.byteLength > p.data.length ||
        p.coordinateSpace !== 'standard' || p.alphaPremultiplied !== false ||
        p.colorEncoding !== (frame.pixelFormat === 'gray8' ? 'gray' : 'srgb') || !Number.isSafeInteger(p.strideBytes)) {
      throw new RangeError('Unsupported or invalid CPU payload');
    }
    data = p.data.subarray(p.byteOffset, p.byteOffset + p.byteLength); stride = p.strideBytes;
  }
  let image;
  if (frame.pixelFormat === 'rgba8') image = kernels.rgbaToGray(data, frame.width, frame.height, stride);
  else if (frame.pixelFormat === 'gray8') image = kernels.buildPyramid({ data, width: frame.width, height: frame.height, stride }, 1)[0];
  else throw new RangeError('Only canonical gray8 and unpremultiplied RGBA8 supported');
  signal?.throwIfAborted();
  return { sessionId: frame.sessionId, frameId: frame.frameId, algorithmVersion, image };
}
