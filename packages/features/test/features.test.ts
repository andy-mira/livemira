// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GrayImage } from '@livemira-next/contracts';

import {
  compileTarget,
  decodeTarget,
  encodeTarget,
  extractOrb,
  fastScorer,
  HammingMatcher,
  nearest2GroupedReference,
  nearest2Reference,
  OrbDetector,
} from '../src/index.ts';

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

/** The image rotated by `deg` about its centre (bilinear, edge coordinates). */
function rotate(src: GrayImage, deg: number): GrayImage {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out = new Uint8Array(src.width * src.height).fill(90);
  const cx = src.width / 2;
  const cy = src.height / 2;
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const u = c * dx + s * dy + cx - 0.5;
      const v = -s * dx + c * dy + cy - 0.5;
      const i = Math.floor(u);
      const j = Math.floor(v);
      if (i < 0 || j < 0 || i + 1 >= src.width || j + 1 >= src.height) continue;
      const fx = u - i;
      const fy = v - j;
      const o = j * src.width + i;
      const d = src.data;
      out[y * src.width + x] = Math.round(
        (1 - fy) * ((1 - fx) * d[o]! + fx * d[o + 1]!) +
          fy * ((1 - fx) * d[o + src.width]! + fx * d[o + src.width + 1]!),
      );
    }
  return { width: src.width, height: src.height, stride: src.width, data: out };
}

test('the WASM SIMD matcher agrees with the JavaScript reference', () => {
  const matcher = HammingMatcher.create();
  assert.equal(matcher.backend, 'wasm-simd');
  const a = extractOrb(texture(320, 240, 3)).descriptors;
  const b = extractOrb(texture(320, 240, 4)).descriptors;
  assert.deepEqual([...matcher.nearest2(a, b)], [...nearest2Reference(a, b)]);
  const groups = Uint32Array.from({ length: b.length / 32 }, (_, i) => Math.floor(i / 3));
  assert.deepEqual([...matcher.nearest2Grouped(a, b, groups)], [...nearest2GroupedReference(a, b, groups)]);
});

test('the WASM SIMD FAST kernel gives the same features as the JavaScript reference', () => {
  assert.equal(fastScorer().backend, 'wasm-simd');
  const image = texture(333, 251, 11);
  // A dim, low-contrast band exercises the fallback threshold.
  for (let i = 0; i < image.data.length; i++) if (i % 333 > 250) image.data[i] = 40 + (image.data[i]! >> 4);
  for (const options of [{}, { roi: { x: 40, y: 30, width: 200, height: 150 } }]) {
    const a = extractOrb(image, { ...options, wasm: true });
    const b = extractOrb(image, { ...options, wasm: false });
    assert.ok(a.count > 100);
    assert.deepEqual([...a.x], [...b.x]);
    assert.deepEqual([...a.y], [...b.y]);
    assert.deepEqual([...a.score], [...b.score]);
    assert.deepEqual([...a.descriptors], [...b.descriptors]);
  }
});

test('oriented descriptors match across a 90° rotation', () => {
  const image = texture(320, 320, 9);
  const k0 = extractOrb(image, { budget: 400 });
  const k1 = extractOrb(rotate(image, 90), { budget: 400 });
  const nn = nearest2Reference(k1.descriptors, k0.descriptors);
  let good = 0;
  let total = 0;
  for (let q = 0; q < k1.count; q++) {
    if (nn[3 * q + 1]! >= 0.8 * nn[3 * q + 2]!) continue;
    total++;
    const r = nn[3 * q]!;
    // A 90° turn about the centre maps (x, y) to (cx − (y − cy), cy + (x − cx)).
    const ex = 160 - (k0.y[r]! - 160);
    const ey = 160 + (k0.x[r]! - 160);
    if (Math.hypot(k1.x[q]! - ex, k1.y[q]! - ey) < 4) good++;
  }
  assert.ok(total > 40 && good / total > 0.7, `${good}/${total}`);
});

test('compiled targets survive the G2 round trip', async () => {
  const image = texture(320, 240, 11);
  const compiled = compileTarget({ info: { id: 'x', width: 320, height: 240, physicalWidthMeters: 0.1 }, image });
  assert.ok(compiled.points.length / 2 > 100);
  assert.ok(compiled.descriptorPoint.length >= compiled.points.length / 2);
  const bytes = await encodeTarget(compiled, image, { templateMaxEdge: 240 });
  const asset = await decodeTarget(bytes);
  assert.equal(asset.compiled.info.id, 'x');
  assert.ok(Math.abs(asset.compiled.info.physicalWidthMeters! - 0.1) < 1e-6);
  assert.deepEqual([...asset.compiled.descriptors], [...compiled.descriptors]);
  assert.deepEqual([...asset.compiled.points], [...compiled.points]);
  assert.equal(asset.template.width, 320);
  const otherPattern = bytes.slice();
  otherPattern[6] = otherPattern[6]! ^ 0x7f;
  await assert.rejects(decodeTarget(otherPattern), /descriptor pattern/);
  bytes[20] = bytes[20]! ^ 1;
  await assert.rejects(decodeTarget(bytes));
});

/** `target` shrunk by `scale` (area-averaged, as a camera sees a far picture) at (x0, y0) of a 640×360 frame. */
function farAway(target: GrayImage, scale: number, x0: number, y0: number): GrayImage {
  const data = new Uint8Array(640 * 360).fill(110);
  const w = Math.round(target.width * scale);
  const h = Math.round(target.height * scale);
  const n = Math.ceil(1 / scale);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++)
          sum +=
            target.data[
              Math.min(target.height - 1, Math.floor((y + (j + 0.5) / n) / scale)) * target.width +
                Math.min(target.width - 1, Math.floor((x + (i + 0.5) / n) / scale))
            ]!;
      data[(y0 + y) * 640 + x0 + x] = Math.round(sum / (n * n));
    }
  return { width: 640, height: 360, stride: 640, data };
}

test('a target small on screen is found in an enlarged region, at the right place', async () => {
  const target = texture(400, 300, 21);
  const detector = new OrbDetector();
  await detector.load([{ info: { id: 't', width: 400, height: 300, physicalWidthMeters: null }, image: target }]);
  // 100 × 75 px at (260, 150): its corners in frame pixels.
  const truth = [
    [260, 150],
    [360, 150],
    [360, 225],
    [260, 225],
  ];
  const handle = {
    sessionId: 's',
    frameId: 1,
    time: { captureUs: 0, receiveUs: 0, source: 'replay' as const },
    image: { kind: 'cpu-gray' as const, image: farAway(target, 0.25, 260, 150) },
  };
  const roi = { x: 225, y: 124, width: 170, height: 128 };
  const error = (corners: readonly (readonly number[])[]): number =>
    corners.reduce((s, c, i) => s + Math.hypot(c[0]! - 0.5 - truth[i]![0]!, c[1]! - 0.5 - truth[i]![1]!), 0) / 4;
  const own = await detector.detect(handle, { roi });
  const enlarged = await detector.detect(handle, { roi, upscale: 2.4 });
  assert.ok(!own.some((d) => error(d.corners) < 3), 'not found at its own size');
  assert.equal(enlarged.length, 1, 'found once enlarged');
  assert.ok(
    error(enlarged[0]!.corners) < 2,
    `corners mapped back to the frame (${error(enlarged[0]!.corners).toFixed(2)} px)`,
  );
});
