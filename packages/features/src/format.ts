// SPDX-License-Identifier: Apache-2.0
// Binary target asset (`livemira-target/2`, the bytes of the engine's target bundles). Little-endian:
//   'LMT2' u16 version u16 flags (low byte: BRIEF pattern version) | u16 idBytes, id (UTF-8) | u16 width u16 height f32 physicalWidthMeters (NaN: none)
//   u32 points u32 descriptors | f32 points[2n] | u8 repeatability[n] | u32 descriptorPoint[d] | u8 descriptors[32d]
//   u16 templateWidth u16 templateHeight | u8 template[w·h] | 32-byte SHA-256 of everything before it.
// The template may be stored below the target's resolution; decoding resamples it back to the target size. Transport
// compression (gzip/brotli) is left to the server.

import type { GrayImage } from '@livemira-next/contracts';

import type { CompiledTarget } from './compile.ts';
import { PATTERN_VERSION } from './orb.ts';

const MAGIC = 0x32544d4c; // 'LMT2'

export interface TargetAsset {
  readonly compiled: CompiledTarget;
  /** Template at the target's own resolution (resampled up when stored smaller). */
  readonly template: GrayImage;
}

function resample(src: GrayImage, width: number, height: number): GrayImage {
  if (src.width === width && src.height === height) return src;
  const out = new Uint8Array(width * height);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const v = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
    const j = Math.floor(v);
    const fy = v - j;
    for (let x = 0; x < width; x++) {
      const u = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
      const i = Math.floor(u);
      const fx = u - i;
      const o = j * src.stride + i;
      const d = src.data;
      const top = d[o]! + fx * (d[o + 1]! - d[o]!);
      const bottom = d[o + src.stride]! + fx * (d[o + src.stride + 1]! - d[o + src.stride]!);
      out[y * width + x] = Math.round(top + fy * (bottom - top));
    }
  }
  return { width, height, stride: width, data: out };
}

/** Area-average downscale so the long edge is at most `maxEdge`. */
function shrink(src: GrayImage, maxEdge: number): GrayImage {
  const k = Math.max(src.width, src.height) / maxEdge;
  if (k <= 1) return src;
  const w = Math.round(src.width / k);
  const h = Math.round(src.height / k);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * k);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
      const y0 = Math.floor(y * k);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src.data[yy * src.stride + xx]!;
      out[y * w + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
    }
  return { width: w, height: h, stride: w, data: out };
}

export async function encodeTarget(
  compiled: CompiledTarget,
  template: GrayImage,
  options: { readonly templateMaxEdge?: number } = {},
): Promise<Uint8Array> {
  const t = shrink(template, options.templateMaxEdge ?? 480);
  const id = new TextEncoder().encode(compiled.info.id);
  const n = compiled.points.length / 2;
  const d = compiled.descriptorPoint.length;
  const size = 8 + 2 + id.length + 8 + 8 + 8 * n + n + 4 * d + 32 * d + 4 + t.width * t.height;
  const bytes = new Uint8Array(size + 32);
  const view = new DataView(bytes.buffer);
  let o = 0;
  view.setUint32(o, MAGIC, true);
  view.setUint16(o + 4, 2, true);
  view.setUint16(o + 6, PATTERN_VERSION, true);
  o += 8;
  view.setUint16(o, id.length, true);
  bytes.set(id, o + 2);
  o += 2 + id.length;
  view.setUint16(o, compiled.info.width, true);
  view.setUint16(o + 2, compiled.info.height, true);
  view.setFloat32(o + 4, compiled.info.physicalWidthMeters ?? NaN, true);
  o += 8;
  view.setUint32(o, n, true);
  view.setUint32(o + 4, d, true);
  o += 8;
  for (let i = 0; i < 2 * n; i++, o += 4) view.setFloat32(o, compiled.points[i]!, true);
  bytes.set(compiled.repeatability, o);
  o += n;
  for (let i = 0; i < d; i++, o += 4) view.setUint32(o, compiled.descriptorPoint[i]!, true);
  bytes.set(compiled.descriptors, o);
  o += 32 * d;
  view.setUint16(o, t.width, true);
  view.setUint16(o + 2, t.height, true);
  o += 4;
  for (let y = 0; y < t.height; y++) bytes.set(t.data.subarray(y * t.stride, y * t.stride + t.width), o + y * t.width);
  o += t.width * t.height;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.subarray(0, o)));
  bytes.set(digest, o);
  return bytes;
}

export async function decodeTarget(bytes: Uint8Array): Promise<TargetAsset> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (why: string): never => {
    throw new Error(`Invalid target asset: ${why}`);
  };
  if (bytes.length < 64 || view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 2) fail('header');
  const pattern = view.getUint16(6, true) & 0xff;
  if (pattern !== PATTERN_VERSION)
    fail(`descriptor pattern v${pattern}, this engine uses v${PATTERN_VERSION}; recompile the target`);
  const body = bytes.subarray(0, bytes.length - 32);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(body)));
  if (!digest.every((v, i) => v === bytes[bytes.length - 32 + i])) fail('checksum');
  let o = 8;
  const idLength = view.getUint16(o, true);
  const id = new TextDecoder().decode(bytes.subarray(o + 2, o + 2 + idLength));
  o += 2 + idLength;
  const width = view.getUint16(o, true);
  const height = view.getUint16(o + 2, true);
  const physical = view.getFloat32(o + 4, true);
  o += 8;
  const n = view.getUint32(o, true);
  const d = view.getUint32(o + 4, true);
  o += 8;
  const points = new Float32Array(2 * n);
  for (let i = 0; i < 2 * n; i++, o += 4) points[i] = view.getFloat32(o, true);
  const repeatability = bytes.slice(o, o + n);
  o += n;
  const descriptorPoint = new Uint32Array(d);
  for (let i = 0; i < d; i++, o += 4) descriptorPoint[i] = view.getUint32(o, true);
  const descriptors = bytes.slice(o, o + 32 * d);
  o += 32 * d;
  const tw = view.getUint16(o, true);
  const th = view.getUint16(o + 2, true);
  o += 4;
  const stored: GrayImage = { width: tw, height: th, stride: tw, data: bytes.slice(o, o + tw * th) };
  return {
    compiled: {
      info: { id, width, height, physicalWidthMeters: Number.isNaN(physical) ? null : physical },
      points,
      repeatability,
      descriptors,
      descriptorPoint,
    },
    template: resample(stored, width, height),
  };
}
