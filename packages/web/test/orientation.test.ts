// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resampleOriented } from '../src/luma.ts';
import { cornerUvs, displaySize, rawFromDisplay, type Orientation } from '../src/orientation.ts';

/** A raw 8×4 picture, white 2×2 marker at the top-left (the case measured in Chromium's drawImage). */
const RAW = Uint8Array.from({ length: 32 }, (_, i) => (i % 8 < 2 && i < 16 ? 255 : 0));

function shown(o: Orientation): { width: number; height: number; bright: string[] } {
  const [width, height] = displaySize(8, 4, o);
  const out = new Uint8Array(width * height);
  resampleOriented(RAW, 8, 4, 8, width, height, out, o);
  const bright: string[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (out[y * width + x]! > 128) bright.push(`${x},${y}`);
  return { width, height, bright };
}

test('rotations match what Chromium draws for rotated VideoFrames (clockwise, planes stay raw)', () => {
  assert.deepEqual(shown({ rotation: 0, flip: false }), { width: 8, height: 4, bright: ['0,0', '1,0', '0,1', '1,1'] });
  // Measured: rotation 90 → marker at (2..3, 0..1) of 4×8; rotation 270 → (0..1, 6..7).
  assert.deepEqual(shown({ rotation: 90, flip: false }), { width: 4, height: 8, bright: ['2,0', '3,0', '2,1', '3,1'] });
  assert.deepEqual(shown({ rotation: 270, flip: false }), {
    width: 4,
    height: 8,
    bright: ['0,6', '1,6', '0,7', '1,7'],
  });
  assert.deepEqual(shown({ rotation: 180, flip: false }).bright, ['6,2', '7,2', '6,3', '7,3']);
  // Mirror first, then rotate: the marker moves to the top-right of the raw picture.
  assert.deepEqual(shown({ rotation: 0, flip: true }).bright, ['6,0', '7,0', '6,1', '7,1']);
});

test('texture corners agree with the display-to-raw map', () => {
  for (const rotation of [0, 90, 180, 270] as const)
    for (const flip of [false, true]) {
      const o = { rotation, flip };
      const [a, b, c, d, e, f] = rawFromDisplay(1, 1, o);
      const uv = cornerUvs(o);
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ].forEach(([x, y], i) => {
        assert.equal(uv[2 * i], a * x! + b * y! + c);
        assert.equal(uv[2 * i + 1], d * x! + e * y! + f);
      });
    }
  // Upright: the identity; rotated 90° clockwise: the shown top-left is the raw bottom-left.
  assert.deepEqual(cornerUvs({ rotation: 0, flip: false }), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(cornerUvs({ rotation: 90, flip: false }).slice(0, 2), [0, 1]);
});

test('the integer resample (full, half, quarter size) is the box average of the shown picture, in every orientation', () => {
  const sw = 16;
  const sh = 8;
  const raw = Uint8Array.from({ length: sw * sh }, (_, i) => (i * 97 + 13) % 251);
  for (const rotation of [0, 90, 180, 270] as const)
    for (const flip of [false, true]) {
      const o = { rotation, flip };
      const [dw, dh] = displaySize(sw, sh, o);
      // Reference: each shown pixel from its raw pixel, then n × n averages.
      const [a, b, c, d, e, f] = rawFromDisplay(sw, sh, o);
      const shownPicture = new Uint8Array(dw * dh);
      for (let y = 0; y < dh; y++)
        for (let x = 0; x < dw; x++) {
          const u = Math.floor(a * (x + 0.5) + b * (y + 0.5) + c);
          const v = Math.floor(d * (x + 0.5) + e * (y + 0.5) + f);
          shownPicture[y * dw + x] = raw[v * sw + u]!;
        }
      for (const n of [1, 2, 4]) {
        const width = dw / n;
        const height = dh / n;
        const out = new Uint8Array(width * height);
        resampleOriented(raw, sw, sh, sw, width, height, out, o);
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            let sum = 0;
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) sum += shownPicture[(y * n + j) * dw + x * n + i]!;
            assert.equal(
              out[y * width + x],
              (sum + ((n * n) >> 1)) >> Math.log2(n * n),
              `${rotation}${flip ? 'f' : ''} n=${n}`,
            );
          }
      }
    }
});
