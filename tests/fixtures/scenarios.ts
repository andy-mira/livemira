/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic synthetic inputs for each algorithm stage. Expected outputs in tests/snapshots/
// detect changes in recognition, geometry and tracking behavior.

import { pattern, renderFrame, rgba, type Gray8, type Quad } from './synthetic.ts';

const FRAME = { widthPx: 640, heightPx: 480 } as const;

/** Loaded targets (in load order) and one picture that is never loaded. */
export const TARGETS: Readonly<Record<string, Gray8>> = {
  'pattern-a': pattern(11, 320, 240),
  'pattern-b': pattern(22, 240, 320),
  'pattern-c': pattern(33, 288, 288),
};
export const UNLOADED = pattern(44, 320, 240);

export const RGBA_CASES: readonly {
  readonly id: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly strideBytes: number;
  readonly rgba: Uint8Array;
}[] = [
  { id: 'rgba-16x9', widthPx: 16, heightPx: 9, strideBytes: 64, rgba: rgba(5, 16, 9, 64) },
  { id: 'rgba-7x5-padded', widthPx: 7, heightPx: 5, strideBytes: 32, rgba: rgba(6, 7, 5, 32) },
];

/** Geometry parameters (the camera package's names). */
export const GEOMETRY_CASES: readonly {
  readonly id: string;
  readonly params: Record<string, unknown>;
}[] = [
  { id: 'landscape-default', params: { widthPx: 1280, heightPx: 720 } },
  {
    id: 'portrait-cover-dpr3',
    params: {
      widthPx: 1920,
      heightPx: 1080,
      rotationDeg: 90,
      viewportWidthCss: 390,
      viewportHeightCss: 844,
      devicePixelRatio: 3,
    },
  },
  {
    id: 'mirrored-contain',
    params: {
      widthPx: 1280,
      heightPx: 720,
      isMirrored: true,
      fit: 'contain',
      viewportWidthCss: 800,
      viewportHeightCss: 800,
      longEdge: 480,
    },
  },
  {
    id: 'cropped-rotated-native',
    params: {
      widthPx: 1280,
      heightPx: 960,
      rotationDeg: 270,
      crop: { x: 64, y: 48, width: 1024, height: 768 },
      longEdge: 'native',
    },
  },
  {
    id: 'viewport-mirrored-960',
    params: {
      widthPx: 1920,
      heightPx: 1440,
      rotationDeg: 180,
      isViewportMirrored: true,
      longEdge: 960,
      viewportWidthCss: 1024,
      viewportHeightCss: 600,
    },
  },
];

/** Axis-aligned quad of a picture scaled to `longEdgePx`, centred at (cx, cy). */
function box(picture: Gray8, cx: number, cy: number, longEdgePx: number): Quad {
  const ratio = longEdgePx / Math.max(picture.widthPx, picture.heightPx);
  const hw = (picture.widthPx * ratio) / 2;
  const hh = (picture.heightPx * ratio) / 2;
  return [
    [cx - hw, cy - hh],
    [cx + hw, cy - hh],
    [cx + hw, cy + hh],
    [cx - hw, cy + hh],
  ];
}

/** The quad turned about its centre by the angle whose cosine and sine are given (constants, not computed). */
function turn(quad: Quad, cos: number, sin: number): Quad {
  const cx = (quad[0][0] + quad[2][0]) / 2;
  const cy = (quad[0][1] + quad[2][1]) / 2;
  return quad.map(([x, y]) => [
    cx + (x - cx) * cos - (y - cy) * sin,
    cy + (x - cx) * sin + (y - cy) * cos,
  ]) as unknown as Quad;
}

/** Perspective: the top edge shortened by `inset` of the width on each side. */
function tilt(quad: Quad, inset: number): Quad {
  const d = (quad[1][0] - quad[0][0]) * inset;
  return [[quad[0][0] + d, quad[0][1]], [quad[1][0] - d, quad[1][1]], quad[2], quad[3]];
}

// cos and sin of 10°.
const COS_10 = 0.984807753012208;
const SIN_10 = 0.17364817766693033;

export interface Scene {
  readonly id: string;
  readonly image: Gray8;
}

function scenes(): Scene[] {
  const list: Scene[] = [];
  let seed = 100;
  for (const [id, picture] of Object.entries(TARGETS)) {
    const views: [string, Quad, number][] = [
      ['frontal', box(picture, 320, 240, 336), 0],
      ['turned', turn(box(picture, 330, 236, 300), COS_10, SIN_10), 3],
      ['tilted', tilt(box(picture, 310, 246, 320), 0.12), 5],
    ];
    for (const [view, quad, noise] of views)
      list.push({
        id: `${id}-${view}`,
        image: renderFrame({ ...FRAME, seed: ++seed, pictures: [{ picture, quad }], noise }),
      });
  }
  list.push({
    id: 'empty',
    image: renderFrame({ ...FRAME, seed: ++seed, pictures: [], noise: 3 }),
  });
  list.push({
    id: 'unloaded',
    image: renderFrame({
      ...FRAME,
      seed: ++seed,
      pictures: [{ picture: UNLOADED, quad: box(UNLOADED, 320, 240, 336) }],
      noise: 3,
    }),
  });
  const a = TARGETS['pattern-a']!;
  const b = TARGETS['pattern-b']!;
  list.push({
    id: 'pair-a-b',
    image: renderFrame({
      ...FRAME,
      seed: seed + 1,
      pictures: [
        { picture: a, quad: box(a, 172, 240, 210) },
        { picture: b, quad: box(b, 468, 240, 210) },
      ],
      noise: 3,
    }),
  });
  return list;
}

export const SCENES: readonly Scene[] = scenes();

/** One step of a tracking sequence: a frame `afterMs` after the previous one showing a target, or nothing. */
export interface SequenceStep {
  readonly afterMs: number;
  readonly targetId: string | null;
  readonly image: Gray8;
}

function sequence(seed: number, parts: readonly [number, string | null][]): SequenceStep[] {
  const steps: SequenceStep[] = [];
  for (const [count, targetId] of parts) {
    for (let i = 0; i < count; i++) {
      const k = steps.length;
      const picture = targetId === null ? null : TARGETS[targetId]!;
      const pictures =
        picture === null
          ? []
          : [{ picture, quad: tilt(box(picture, 300 + 3 * k, 240 - 2 * k, 300 + 2 * k), 0.04) }];
      steps.push({
        afterMs: 33,
        targetId,
        image: renderFrame({ ...FRAME, seed: seed + k, pictures, noise: 3 }),
      });
    }
  }
  return steps;
}

export const SEQUENCES: Readonly<Record<string, readonly SequenceStep[]>> = {
  'hold-gap-recover': sequence(500, [
    [6, 'pattern-a'],
    [4, null],
    [4, 'pattern-a'],
  ]),
  'switch-targets': sequence(600, [
    [5, 'pattern-b'],
    [8, 'pattern-c'],
  ]),
};
