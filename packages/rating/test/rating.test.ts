// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GrayImage } from '@livemira-next/contracts';
import { compileTarget, encodeTarget } from '@livemira-next/features';

import { rateCompiledTarget } from '../src/rating.ts';

/** Random flat rectangles: detail all over the picture. */
function texture(width: number, height: number, seed: number): GrayImage {
  let s = seed;
  const r = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const data = new Uint8Array(width * height).fill(90);
  for (let i = 0; i < (width * height) / 150; i++) {
    const x = r() % width;
    const y = r() % height;
    const w = 4 + (r() % 26);
    const h = 4 + (r() % 26);
    const v = r() % 256;
    for (let yy = y; yy < Math.min(height, y + h); yy++)
      for (let xx = x; xx < Math.min(width, x + w); xx++) data[yy * width + xx] = v;
  }
  return { width, height, stride: width, data };
}

test('rating: rich detail all over rates high; the same detail in one corner or a repeating tile rates low', async () => {
  const rate = async (image: GrayImage): Promise<Awaited<ReturnType<typeof rateCompiledTarget>>> => {
    const compiled = compileTarget({
      info: { id: 't', width: image.width, height: image.height, physicalWidthMeters: null },
      image,
    });
    return rateCompiledTarget(await encodeTarget(compiled, image));
  };
  const rich = texture(480, 360, 33);
  // Only the top-left quarter keeps its detail; the rest is flat.
  const corner: GrayImage = {
    ...rich,
    data: Uint8Array.from(rich.data, (v, i) => (i % 480 < 240 && i < 480 * 180 ? v : 110)),
  };
  // One 60 px tile repeated over the picture.
  const tile = texture(60, 60, 5);
  const repeated: GrayImage = {
    width: 480,
    height: 360,
    stride: 480,
    data: Uint8Array.from(
      { length: 480 * 360 },
      (_, i) => tile.data[(Math.floor(i / 480) % 60) * 60 + ((i % 480) % 60)]!,
    ),
  };
  const [a, b, c] = [await rate(rich), await rate(corner), await rate(repeated)];
  assert.ok(a.stars >= 4, `rich: ${a.stars} ${JSON.stringify(a.factors)}`);
  assert.ok(b.stars <= 2, `one corner: ${b.stars} ${JSON.stringify(b.factors)}`);
  assert.ok(b.advice.includes('CONCENTRATED') && b.advice.includes('WEAK_QUARTER'), b.advice.join());
  assert.ok(c.stars <= 2, `repeating tile: ${c.stars} ${JSON.stringify(c.factors)}`);
  assert.ok(c.advice.includes('REPETITIVE') || c.advice.includes('HARD_TO_FIND'), c.advice.join());
  assert.equal(a.points.length, 2 * a.metrics.robustPoints);
});
