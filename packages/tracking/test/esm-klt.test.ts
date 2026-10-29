// SPDX-License-Identifier: Apache-2.0
// ESM and KLT against frames rendered with a known homography (independent bilinear warp, not the product kernels).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TargetImage } from '@livemira-next/contracts';
import { buildPyramid } from '@livemira-next/imaging';

import { TemplateTracker } from '../src/index.ts';
import { cornerError, frame, H_TRUE, poseOf, render, TARGET, texture, INFO } from './support.ts';

const targets: TargetImage[] = [{ info: INFO, image: TARGET }];

test('ESM converges from a several-pixel offset to sub-pixel accuracy, also under a gain/bias change', () => {
  const tracker = new TemplateTracker({ mode: 'esm' });
  tracker.prepare(targets);
  const image = render(TARGET, H_TRUE, 0.7, 20);
  const pyramid = buildPyramid(image, 4);
  // Prior: shifted by 9 px and slightly rotated.
  const c = Math.cos(0.03);
  const s = Math.sin(0.03);
  const prior = Float64Array.from([
    c * 0.62 - s * -0.08,
    c * 0.12 - s * 0.55,
    179,
    s * 0.62 + c * -0.08,
    s * 0.12 + c * 0.55,
    64,
    0.0002,
    -0.00015,
    1,
  ]);
  assert.ok(cornerError(prior, H_TRUE) > 6);
  const result = tracker.track({ frame: frame(1, image), pyramid, prior: poseOf(prior, 1), previous: null });
  assert.ok('H_imageFromTarget' in result, JSON.stringify(result));
  if (!('H_imageFromTarget' in result)) return;
  assert.ok(
    cornerError(result.H_imageFromTarget, H_TRUE) < 0.25,
    `corner error ${cornerError(result.H_imageFromTarget, H_TRUE)}`,
  );
  assert.ok(result.quality.ratio > 0.9);
});

test('KLT follows a 20 px inter-frame motion from the previous frame', () => {
  const tracker = new TemplateTracker({ mode: 'klt' });
  tracker.prepare(targets);
  const prevImage = render(TARGET, H_TRUE);
  const moved = Float64Array.from(H_TRUE);
  moved[2] = H_TRUE[2]! + 20;
  moved[5] = H_TRUE[5]! - 6;
  const nextImage = render(TARGET, moved);
  const result = tracker.track({
    frame: frame(2, nextImage),
    pyramid: buildPyramid(nextImage, 4),
    prior: poseOf(H_TRUE, 2),
    previous: { pyramid: buildPyramid(prevImage, 4), pose: poseOf(H_TRUE, 1) },
  });
  assert.ok('H_imageFromTarget' in result, JSON.stringify(result));
  if ('H_imageFromTarget' in result)
    assert.ok(
      cornerError(result.H_imageFromTarget, moved) < 0.5,
      `corner error ${cornerError(result.H_imageFromTarget, moved)}`,
    );
});

test('ESM rejects a frame without the target', () => {
  const tracker = new TemplateTracker({ mode: 'esm' });
  tracker.prepare(targets);
  const empty = render(texture(400, 300, 5), H_TRUE);
  const result = tracker.track({
    frame: frame(3, empty),
    pyramid: buildPyramid(empty, 4),
    prior: poseOf(H_TRUE, 3),
    previous: null,
  });
  assert.ok(!('H_imageFromTarget' in result));
});

test('NCC patches recover the pose from a 5 px offset prior', () => {
  const tracker = new TemplateTracker({ mode: 'ncc' });
  tracker.prepare(targets);
  const image = render(TARGET, H_TRUE);
  const prior = Float64Array.from(H_TRUE);
  prior[2] = H_TRUE[2]! - 5;
  prior[5] = H_TRUE[5]! + 3;
  const result = tracker.track({
    frame: frame(4, image),
    pyramid: buildPyramid(image, 4),
    prior: poseOf(prior, 4),
    previous: null,
  });
  assert.ok('H_imageFromTarget' in result, JSON.stringify(result));
  if ('H_imageFromTarget' in result)
    assert.ok(
      cornerError(result.H_imageFromTarget, H_TRUE) < 0.6,
      `corner error ${cornerError(result.H_imageFromTarget, H_TRUE)}`,
    );
});
