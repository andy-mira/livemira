/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import {
  BRIEF_PATTERN,
  buildPyramid,
  extractFeatures,
  intermediateScaleImage,
  INTERMEDIATE_SCALE,
} from '@livemira/recognition';

import { natural, rects, tiled } from './images.ts';

const isInvalidConfig = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'INVALID_CONFIG';

test('extraction honours the budget and per-level quotas, has no duplicates and is deterministic', () => {
  for (const [budget, image] of [
    [384, rects(101)],
    [512, rects(101)],
    [384, natural(11)],
    [512, tiled(7, 32)],
  ] as const) {
    const result = extractFeatures(image, { maxFeatures: budget, levels: 3 });
    assert.deepEqual(
      result,
      extractFeatures(image, { maxFeatures: budget, levels: 3 }),
      'deterministic',
    );
    assert.ok(result.features.length <= budget && result.features.length > 0);
    for (let level = 0; level < 3; level++) {
      const quota = Math.floor(budget / 3) + (level < budget % 3 ? 1 : 0);
      assert.ok(result.features.filter((f) => f.level === level).length <= quota);
    }
    assert.equal(
      new Set(result.features.map((f) => `${f.level}:${f.x}:${f.y}`)).size,
      result.features.length,
    );
    for (const f of result.features) assert.ok(f.descriptor.length === 32 && f.score > 0);
    assert.deepEqual(
      result.pyramid.map((l) => l.scale),
      [1, 2, 4],
    );
  }
});

test('a dense 640×480 frame fills the live budget in bounded time, with features at every level', () => {
  const dense = rects(5, 640, 480, 6000);
  const started = performance.now();
  const result = extractFeatures(dense, { maxFeatures: 512, levels: 3 });
  assert.equal(result.features.length, 512);
  assert.ok(performance.now() - started < 5000);
  for (const level of [0, 1, 2]) assert.ok(result.features.some((f) => f.level === level));
});

test('feature positions map level pixels back to base pixel centres', () => {
  for (const f of extractFeatures(rects(3), { maxFeatures: 384, levels: 3 }).features) {
    const scale = 2 ** f.level;
    const levelX = (f.x + 0.5) / scale - 0.5;
    const levelY = (f.y + 0.5) / scale - 0.5;
    assert.ok(Number.isInteger(levelX) && Number.isInteger(levelY));
  }
});

test('extraction does not modify the input image', () => {
  const image = natural(4);
  const before = Uint8Array.from(image.data);
  extractFeatures(image, { maxFeatures: 512, levels: 3 });
  assert.deepEqual(image.data, before);
});

test('a region of interest keeps base-image coordinates and only selects inside it', () => {
  const image = rects(9);
  const roi = { x: 40, y: 30, width: 240, height: 180 };
  const { features } = extractFeatures(image, { maxFeatures: 384, levels: 3, roi });
  assert.ok(features.length > 0);
  for (const f of features) {
    assert.ok(
      f.x >= roi.x && f.x < roi.x + roi.width && f.y >= roi.y && f.y < roi.y + roi.height,
      `${f.x},${f.y}`,
    );
  }
});

test('invalid images, budgets, levels and regions are rejected', () => {
  const image = rects(1);
  assert.throws(
    () =>
      extractFeatures(
        { widthPx: 100000, heightPx: 100000, data: new Uint8Array() },
        { maxFeatures: 384, levels: 3 },
      ),
    isInvalidConfig,
  );
  assert.throws(
    () =>
      extractFeatures(
        { widthPx: 31, heightPx: 40, data: new Uint8Array(31 * 40) },
        { maxFeatures: 384, levels: 3 },
      ),
    isInvalidConfig,
  );
  for (const maxFeatures of [15, 513, 100.5])
    assert.throws(() => extractFeatures(image, { maxFeatures, levels: 3 }), isInvalidConfig);
  for (const levels of [0, 5, 1.5])
    assert.throws(() => extractFeatures(image, { maxFeatures: 384, levels }), isInvalidConfig);
  for (const roi of [
    { x: -1, y: 0, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 2 },
    { x: 0, y: 0, width: 600, height: 2 },
    { x: NaN, y: 0, width: 2, height: 2 },
  ]) {
    assert.throws(
      () => extractFeatures(image, { maxFeatures: 384, levels: 3, roi }),
      isInvalidConfig,
    );
  }
});

test('the pyramid halves with rounding and stops before a level shorter than 32 pixels', () => {
  const image = {
    widthPx: 70,
    heightPx: 140,
    data: Uint8Array.from({ length: 70 * 140 }, (_, i) => i % 251),
  };
  const levels = buildPyramid(image, 4);
  assert.deepEqual(
    levels.map((l) => [l.widthPx, l.heightPx, l.scale]),
    [
      [70, 140, 1],
      [35, 70, 2],
    ],
  );
  const d = image.data;
  assert.equal(levels[1]!.data[0], Math.round((d[0]! + d[1]! + d[70]! + d[71]!) / 4));
});

test('the BRIEF pattern has 256 pairs with offsets in [-8, 8]', () => {
  assert.equal(BRIEF_PATTERN.length, 256);
  for (const pair of BRIEF_PATTERN)
    for (const offset of pair) assert.ok(Number.isInteger(offset) && offset >= -8 && offset <= 8);
});

test('the half-octave image is resampled bilinearly and is null when it would be too small', () => {
  const image = natural(2, 320, 240);
  const scaled = intermediateScaleImage(image)!;
  assert.equal(scaled.widthPx, Math.floor(320 * INTERMEDIATE_SCALE));
  assert.equal(scaled.heightPx, Math.floor(240 * INTERMEDIATE_SCALE));
  assert.equal(
    intermediateScaleImage({ widthPx: 40, heightPx: 40, data: new Uint8Array(1600) }),
    null,
  );
});
