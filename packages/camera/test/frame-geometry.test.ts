/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGeometry, multiply3, transformPoint } from '@livemira/camera';
import { EngineError } from '@livemira/contracts';

const isInvalid = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'INVALID_CONFIG';

test('corner markers map correctly for each rotation and input mirroring', () => {
  const expected = {
    0: [
      [0, 0],
      [400, 0],
      [400, 200],
      [0, 200],
    ],
    90: [
      [200, 0],
      [200, 400],
      [0, 400],
      [0, 0],
    ],
    180: [
      [400, 200],
      [0, 200],
      [0, 0],
      [400, 0],
    ],
    270: [
      [0, 400],
      [0, 0],
      [200, 0],
      [200, 400],
    ],
  };
  const corners = [
    [0, 0],
    [400, 0],
    [400, 200],
    [0, 200],
  ] as const;
  for (const rotationDeg of [0, 90, 180, 270] as const) {
    for (const isMirrored of [false, true]) {
      const g = createGeometry({ widthPx: 400, heightPx: 200, rotationDeg, isMirrored });
      const actual = corners.map(([x, y]) =>
        transformPoint(g.H_standardFromInput, isMirrored ? 400 - x : x, y),
      );
      assert.deepEqual(actual, expected[rotationDeg]);
    }
  }
});

test('crop, downscale, contain and a mirrored viewport are explicit', () => {
  const g = createGeometry({
    widthPx: 1280,
    heightPx: 720,
    crop: { x: 100, y: 50, width: 1000, height: 500 },
    longEdge: 500,
    viewportWidthCss: 300,
    viewportHeightCss: 300,
    fit: 'contain',
    isViewportMirrored: true,
    devicePixelRatio: 2,
  });
  assert.deepEqual(transformPoint(g.H_standardFromInput, 100, 50), [0, 0]);
  assert.deepEqual(transformPoint(g.H_standardFromInput, 1100, 550), [500, 250]);
  assert.deepEqual(transformPoint(g.H_viewportFromStandard, 0, 0), [300, 75]);
  assert.deepEqual(transformPoint(g.H_viewportFromStandard, 500, 250), [0, 225]);
  assert.equal(g.devicePixelRatio, 2);
});

test('native long edge, portrait and landscape rotation, crop and no upscaling', () => {
  const g1 = createGeometry({ widthPx: 720, heightPx: 1280, rotationDeg: 90, longEdge: 'native' });
  assert.deepEqual([g1.standardWidthPx, g1.standardHeightPx], [1280, 720]);
  const g2 = createGeometry({
    widthPx: 1920,
    heightPx: 1080,
    crop: { x: 0, y: 0, width: 800, height: 600 },
    longEdge: 960,
  });
  assert.deepEqual([g2.standardWidthPx, g2.standardHeightPx], [800, 600]);
  // Native keeps the cropped, rotated source size; a mirrored crop maps its far edge to the origin.
  const g3 = createGeometry({
    widthPx: 1920,
    heightPx: 1080,
    isMirrored: true,
    rotationDeg: 90,
    crop: { x: 100, y: 40, width: 1000, height: 800 },
    longEdge: 'native',
  });
  assert.deepEqual([g3.standardWidthPx, g3.standardHeightPx], [800, 1000]);
  assert.deepEqual(transformPoint(g3.H_standardFromInput, 100, 40), [800, 1000]);
  assert.deepEqual(transformPoint(g3.H_standardFromInput, 1100, 840), [0, 0]);
  const g4 = createGeometry({ widthPx: 1080, heightPx: 1920, longEdge: 'native' });
  assert.deepEqual([g4.standardWidthPx, g4.standardHeightPx], [1080, 1920]);
  const g5 = createGeometry({ widthPx: 1280, heightPx: 720 });
  assert.deepEqual([g5.standardWidthPx, g5.standardHeightPx], [640, 360], 'default long edge 640');
});

test('cover fills the viewport, contain fits inside it, both centred', () => {
  const cover = createGeometry({
    widthPx: 1280,
    heightPx: 720,
    viewportWidthCss: 390,
    viewportHeightCss: 844,
  });
  assert.equal(cover.fit, 'cover');
  const [x0, y0] = transformPoint(cover.H_viewportFromStandard, 0, 0);
  const [x1, y1] = transformPoint(
    cover.H_viewportFromStandard,
    cover.standardWidthPx,
    cover.standardHeightPx,
  );
  assert.ok(x0 < 0 && x1 > 390 && y0 === 0 && y1 === 844);
  assert.ok(Math.abs(x0 + x1 - 390) < 1e-9);
  const contain = createGeometry({
    widthPx: 1280,
    heightPx: 720,
    viewportWidthCss: 390,
    viewportHeightCss: 844,
    fit: 'contain',
  });
  const [c0x, c0y] = transformPoint(contain.H_viewportFromStandard, 0, 0);
  const [c1x, c1y] = transformPoint(
    contain.H_viewportFromStandard,
    contain.standardWidthPx,
    contain.standardHeightPx,
  );
  assert.ok(c0x === 0 && c1x === 390 && c0y > 0 && c1y < 844);
});

test('invalid sizes, crops, long edges, rotations and fits are rejected', () => {
  for (const params of [
    { widthPx: 0, heightPx: 2 },
    { widthPx: 100, heightPx: 100, longEdge: -10 },
    { widthPx: 100, heightPx: 100, longEdge: 'auto' as 'native' },
    { widthPx: 100, heightPx: 100, longEdge: NaN },
    { widthPx: 100, heightPx: 100, crop: { x: 50, y: 0, width: 60, height: 10 } },
    { widthPx: 100, heightPx: 100, crop: { x: -1, y: 0, width: 10, height: 10 } },
    { widthPx: 100, heightPx: 100, rotationDeg: 45 as 0 },
    { widthPx: 100, heightPx: 100, fit: 'fill' as 'cover' },
    { widthPx: 100, heightPx: 100, devicePixelRatio: 0 },
  ]) {
    assert.throws(() => createGeometry(params), isInvalid, JSON.stringify(params));
  }
});

test('matrix helpers compose row-major matrices acting on column vectors', () => {
  const translate = [1, 0, 5, 0, 1, 7, 0, 0, 1];
  const scale = [2, 0, 0, 0, 3, 0, 0, 0, 1];
  assert.deepEqual(transformPoint(multiply3(translate, scale), 1, 1), [7, 10]);
  assert.deepEqual(transformPoint(multiply3(scale, translate), 1, 1), [12, 24]);
});
