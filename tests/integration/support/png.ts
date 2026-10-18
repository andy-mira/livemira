/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// A minimal PNG decoder for test pictures: 8-bit gray, gray+alpha, RGB or RGBA, non-interlaced. Returns the gray8
// image with the engine's integer luma (77R + 150G + 29B + 128) >> 8.

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import type { GrayImage } from '@livemira/recognition';

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function readPngGray(file: string | URL): GrayImage {
  const bytes = readFileSync(file);
  if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let widthPx = 0;
  let heightPx = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      widthPx = body.readUInt32BE(0);
      heightPx = body.readUInt32BE(4);
      const [depth, color, , , interlace] = [body[8], body[9], body[10], body[11], body[12]];
      channels = CHANNELS[color!] ?? 0;
      if (depth !== 8 || !channels || interlace !== 0) throw new Error('unsupported PNG layout');
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = widthPx * channels;
  const pixels = new Uint8Array(heightPx * stride);
  for (let y = 0; y < heightPx; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels]! : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels]! : 0;
      const v = line[x]!;
      pixels[y * stride + x] =
        (filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c)) & 255;
    }
  }
  const data = new Uint8Array(widthPx * heightPx);
  for (let i = 0; i < data.length; i++) {
    const p = i * channels;
    data[i] =
      channels < 3
        ? pixels[p]!
        : (77 * pixels[p]! + 150 * pixels[p + 1]! + 29 * pixels[p + 2]! + 128) >> 8;
  }
  return { widthPx, heightPx, data };
}
