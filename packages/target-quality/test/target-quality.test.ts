/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import {
  analyzeGrayTarget,
  assessGrayTarget,
  drawTemplateFeatures,
  normalizedSize,
  REPLACE_BELOW,
  scoreMetrics,
} from '@livemira/target-quality';

function texture(
  widthPx: number,
  heightPx: number,
): { widthPx: number; heightPx: number; data: Uint8Array } {
  const data = new Uint8Array(widthPx * heightPx);
  let seed = 99;
  for (let i = 0; i < data.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    data[i] = ((seed >>> 0) % 7 === 0 ? 255 : 0) | ((i * 37) & 63);
  }
  return { widthPx, heightPx, data };
}

test('a detailed picture scores at least the replacement threshold; a flat one is replaced', () => {
  const good = assessGrayTarget(texture(400, 300));
  assert.ok(good.score >= REPLACE_BELOW, `score ${good.score}`);
  assert.equal(good.shouldReplace, false);
  assert.equal(good.algorithm.version, 'm0-harris-anms-brief256-v1');
  const flat = assessGrayTarget({
    widthPx: 200,
    heightPx: 150,
    data: new Uint8Array(200 * 150).fill(128),
  });
  assert.equal(flat.shouldReplace, true);
  assert.ok(flat.score <= 2);
  assert.ok(flat.reasons.some((r) => r.code === 'LOW_FEATURE_COUNT' && r.severity === 'blocker'));
});

test('large pictures are reduced to a 640 long edge before scoring', () => {
  assert.deepEqual(normalizedSize(1280, 960), { widthPx: 640, heightPx: 480, scale: 0.5 });
  const { result, features } = analyzeGrayTarget(texture(1280, 720));
  assert.equal(result.normalization.resampling, 'box-area');
  assert.deepEqual([features.widthPx, features.heightPx], [640, 360]);
});

test('the scoring step is pure and validates its input', () => {
  const metrics = {
    featureCount: 200,
    featuresPerLevel: [150, 40, 10],
    hullCoverage: 0.7,
    occupiedCells: 16,
    effectiveCells: 14,
    nearDuplicateRatio: 0.01,
    ambiguousRatio: 0.05,
    medianNearestDistance: 90,
    contrastRange: 180,
    dispersion: 0.8,
    isotropy: 0.9,
  };
  assert.equal(scoreMetrics({ metrics, blockers: 0 }).score, 5);
  assert.equal(scoreMetrics({ metrics, blockers: 1 }).score, 2);
  assert.throws(
    () => scoreMetrics({ metrics: { ...metrics, dispersion: 2 }, blockers: 0 }),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
});

test('template features are drawn as rings scaled to the box', () => {
  const { features } = analyzeGrayTarget(texture(400, 300));
  const arcs: number[][] = [];
  const context = {
    save() {},
    restore() {},
    beginPath() {},
    stroke() {},
    clearRect() {},
    arc: (x: number, y: number, r: number) => void arcs.push([x, y, r]),
    lineWidth: 0,
    strokeStyle: '',
  };
  const drawn = drawTemplateFeatures(
    context,
    features,
    { widthPx: 200, heightPx: 150 },
    { maxPoints: 3 },
  );
  assert.equal(drawn, 3);
  assert.equal(arcs.length, 3);
  assert.ok(arcs.every(([x, y]) => x! >= 0 && x! <= 200 && y! >= 0 && y! <= 150));
});
