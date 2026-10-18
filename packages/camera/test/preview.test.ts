/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createGeometry,
  mountPreviewLayer,
  previewStyle,
  videoPreviewSurface,
} from '@livemira/camera';

import { FakeBrowser, type FakeBrowserOptions } from './fake-browser.ts';

function mount(options: FakeBrowserOptions = {}, useVideo = false) {
  const browser = new FakeBrowser(options);
  const doc = browser.env.document as unknown as { createElement(tag: string): never };
  const video = Object.assign(doc.createElement('video'), {
    videoWidth: 720,
    videoHeight: 1280,
  }) as {
    style: Record<string, string>;
    videoWidth: number;
    videoHeight: number;
  };
  const layer = mountPreviewLayer(
    video as never,
    browser.container as never,
    useVideo ? videoPreviewSurface : undefined,
  );
  const root = browser.container.children[0]!;
  const canvas = root.children.find((c) => c.tag === 'canvas');
  const geometry = createGeometry({
    widthPx: 720,
    heightPx: 1280,
    viewportWidthCss: 400,
    viewportHeightCss: 800,
    devicePixelRatio: 2,
  });
  return { browser, video, layer, root, canvas, geometry };
}

test('the preview style maps the intrinsic box through the frame geometry and clips to the crop', () => {
  const geometry = createGeometry({
    widthPx: 720,
    heightPx: 1280,
    crop: { x: 10, y: 20, width: 700, height: 1200 },
    viewportWidthCss: 400,
    viewportHeightCss: 800,
    devicePixelRatio: 2,
  });
  const style = previewStyle(geometry, 720, 1280);
  assert.equal(style.width, '720px');
  assert.equal(style.transformOrigin, '0 0');
  assert.match(style.transform!, /^matrix\(/);
  assert.equal(style.clipPath, 'inset(20px 10px 60px 10px)');
});

test('the layer holds the video, a curtain and a canvas surface; nothing shows before a geometry', () => {
  const { layer, root, video, canvas } = mount();
  assert.deepEqual(
    root.children.map((c) => c.tag),
    ['video', 'div', 'canvas'],
  );
  assert.equal(video.style.visibility, 'hidden');
  assert.equal(canvas!.style.visibility, 'hidden');
  assert.equal(layer.surface, 'canvas');
});

test('an update draws the frame and shows it; a mask hides everything until a fresh geometry arrives', () => {
  const { browser, layer, root, video, canvas, geometry } = mount();
  layer.update(geometry, 720, 1280);
  assert.equal(video.style.visibility, 'visible');
  assert.equal(canvas!.style.visibility, 'visible');
  assert.deepEqual([canvas!.width, canvas!.height], [720, 1280]);
  assert.deepEqual(browser.draws, ['preview:720x1280']);
  layer.mask(true);
  const curtain = root.children[1]!;
  assert.equal(curtain.style.display, 'block');
  assert.equal(video.style.visibility, 'hidden');
  assert.equal(canvas!.style.visibility, 'hidden');
  layer.mask(false);
  assert.equal(curtain.style.display, 'none');
  assert.equal(
    video.style.visibility,
    'hidden',
    'the geometry from before the mask is never shown again',
  );
  layer.update(geometry, 720, 1280);
  assert.equal(video.style.visibility, 'visible');
  assert.equal(canvas!.style.visibility, 'visible');
});

test('a frame of another size is never drawn into the geometry, so the surface stays hidden', () => {
  const { layer, video, canvas, geometry } = mount();
  video.videoWidth = 1280;
  video.videoHeight = 720;
  layer.update(geometry, 720, 1280);
  assert.equal(canvas!.style.visibility, 'hidden');
  assert.equal(video.style.visibility, 'visible');
});

test('without a 2D context, or after a drawing failure, the video is the picture', () => {
  const none = mount({ previewContext: false });
  assert.equal(none.canvas, undefined);
  assert.equal(none.layer.surface, 'video');
  const failing = mount({ drawThrows: true });
  failing.layer.update(failing.geometry, 720, 1280);
  assert.equal(failing.layer.surface, 'video');
  assert.equal(failing.root.children.includes(failing.canvas!), false, 'the canvas is removed');
  assert.equal(failing.video.style.visibility, 'visible');
  const video = mount({}, true);
  assert.equal(video.layer.surface, 'video');
});

test('remove takes the layer out of the container', () => {
  const { browser, layer, canvas } = mount();
  layer.remove();
  assert.equal(browser.container.children.length, 0);
  assert.deepEqual([canvas!.width, canvas!.height], [0, 0]);
});
