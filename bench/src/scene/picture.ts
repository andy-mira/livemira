// SPDX-License-Identifier: Apache-2.0
// A picture file (PNG, JPEG, …, read with ffmpeg) as a scene target, scaled to the scene's 640 × 480.

import { execFileSync } from 'node:child_process';

import { TARGET_GEOMETRY, type SceneTarget } from './suites.ts';
import { mipmap, toGray8 } from './textures.ts';

export function pictureTarget(file: string, id = 'picture'): SceneTarget {
  const { widthPx: w, heightPx: h } = TARGET_GEOMETRY;
  const gray = new Uint8Array(
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
      {
        maxBuffer: 1 << 26,
      },
    ),
  );
  const texture = { width: w, height: h, data: Float32Array.from(gray) };
  return { id, kind: 'photo', seed: 0, gray: toGray8(texture), mip: mipmap(texture) };
}
