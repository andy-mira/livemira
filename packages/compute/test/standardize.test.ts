/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  rgbaToGray,
  SOURCE_TOO_LARGE,
  STANDARD_TOO_LARGE,
  standardize,
  StandardImageWorkspace,
  type TransferredImage,
} from '@livemira/compute';
import { EngineError, IDENTITY_3, type FrameGeometry } from '@livemira/contracts';

const hasCode = (code: string, message?: string) => (error: unknown) =>
  error instanceof EngineError &&
  error.code === code &&
  (message === undefined || error.message === message);

const cpu = (
  kind: 'gray8' | 'rgba8',
  width: number,
  height: number,
  strideBytes: number,
  fill: (i: number) => number,
): TransferredImage => {
  const buffer = new ArrayBuffer((height - 1) * strideBytes + width * (kind === 'gray8' ? 1 : 4));
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) bytes[i] = fill(i);
  return { kind, buffer, width, height, strideBytes };
};

const geometry = (standardWidthPx: number, standardHeightPx: number): FrameGeometry => ({
  H_standardFromInput: IDENTITY_3,
  H_viewportFromStandard: IDENTITY_3,
  crop: { x: 0, y: 0, width: standardWidthPx, height: standardHeightPx },
  rotationDeg: 0,
  isMirrored: false,
  fit: 'cover',
  standardWidthPx,
  standardHeightPx,
  viewportWidthCss: standardWidthPx,
  viewportHeightCss: standardHeightPx,
  devicePixelRatio: 1,
});

test('standard CPU pixels are converted without a canvas: tight and padded gray, padded RGBA', () => {
  const workspace = new StandardImageWorkspace();
  const tight = cpu('gray8', 5, 3, 5, (i) => i * 7);
  assert.deepEqual(standardize({ image: tight, geometry: null }, workspace), {
    widthPx: 5,
    heightPx: 3,
    data: new Uint8Array(tight.kind === 'gray8' ? tight.buffer : new ArrayBuffer(0), 0, 15),
  });
  const padded = cpu('gray8', 4, 3, 7, (i) => i);
  assert.deepEqual(
    [...standardize({ image: padded, geometry: null }, workspace).data],
    [0, 1, 2, 3, 7, 8, 9, 10, 14, 15, 16, 17],
  );
  const rgba = cpu('rgba8', 3, 2, 3 * 4 + 4, (i) => (i * 31) % 256);
  const bytes = new Uint8Array((rgba as { buffer: ArrayBuffer }).buffer);
  assert.deepEqual(
    standardize({ image: rgba, geometry: null }, workspace).data,
    rgbaToGray(bytes, 3, 2, 16).data,
  );
});

test('malformed layouts and oversized pictures are rejected', () => {
  const workspace = new StandardImageWorkspace();
  assert.throws(
    () =>
      standardize(
        {
          image: {
            kind: 'gray8',
            buffer: new ArrayBuffer(10),
            width: 4,
            height: 3,
            strideBytes: 4,
          },
          geometry: null,
        },
        workspace,
      ),
    hasCode('FRAME_FAILED'),
  );
  assert.throws(
    () =>
      standardize(
        {
          image: {
            kind: 'rgba8',
            buffer: new ArrayBuffer(64),
            width: 4,
            height: 4,
            strideBytes: 8,
          },
          geometry: null,
        },
        workspace,
      ),
    hasCode('FRAME_FAILED'),
  );
  assert.throws(
    () =>
      standardize(
        {
          image: {
            kind: 'gray8',
            buffer: new ArrayBuffer(16385),
            width: 16385,
            height: 1,
            strideBytes: 16385,
          },
          geometry: null,
        },
        workspace,
      ),
    hasCode('UNSUPPORTED', SOURCE_TOO_LARGE),
  );
  assert.throws(
    () =>
      standardize(
        {
          image: {
            kind: 'gray8',
            buffer: new ArrayBuffer(4097 * 2),
            width: 4097,
            height: 2,
            strideBytes: 4097,
          },
          geometry: null,
        },
        workspace,
      ),
    hasCode('UNSUPPORTED', STANDARD_TOO_LARGE),
  );
});

test('drawing paths need a Worker canvas and a geometry', () => {
  const workspace = new StandardImageWorkspace();
  const image = cpu('rgba8', 4, 4, 16, () => 1);
  assert.throws(
    () => standardize({ image, geometry: geometry(4, 4) }, workspace),
    hasCode('UNSUPPORTED'),
  );
  const native = {
    kind: 'video-frame',
    image: { displayWidth: 4, displayHeight: 4 },
  } as unknown as TransferredImage;
  assert.throws(
    () => standardize({ image: native, geometry: null }, workspace),
    hasCode('UNSUPPORTED'),
  );
});

test('scratch bytes are reused up to the cache size', () => {
  const workspace = new StandardImageWorkspace();
  const a = workspace.bytes(100);
  const b = workspace.bytes(50);
  assert.equal(a.buffer, b.buffer);
  assert.notEqual(workspace.bytes(17 * 1048576).buffer, a.buffer);
  workspace.dispose();
  assert.notEqual(workspace.bytes(10).buffer, a.buffer);
});
