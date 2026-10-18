/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type TargetBundle } from '@livemira/contracts';
import { ANMS_SELECTION_ID, preflightTarget, validateTarget } from '@livemira/recognition';

import { bundleFor } from './bundles.ts';
import { texture } from './images.ts';

type Mutable = { -readonly [K in keyof TargetBundle]: TargetBundle[K] } & Record<string, unknown>;

const rejectsTarget = (pattern?: RegExp) => (error: unknown) =>
  error instanceof EngineError &&
  error.code === 'INVALID_TARGET' &&
  (!pattern || pattern.test(error.message));

function mutate(bundle: TargetBundle, change: (b: Mutable) => void): TargetBundle {
  const copy = structuredClone(bundle) as Mutable;
  change(copy);
  return copy as TargetBundle;
}

test('a well-formed bundle passes preflight and full validation', async () => {
  const bundle = await bundleFor(texture(), 'a');
  preflightTarget(bundle);
  assert.equal(await validateTarget(bundle), bundle);
  assert.equal(bundle.preprocessing.selection, ANMS_SELECTION_ID);
});

test('corrupt bundles are rejected by identity, preprocessing, pyramid and hash', async () => {
  const bundle = await bundleFor(texture(), 'a');
  const bad: [string, TargetBundle][] = [
    [
      'another compiler version',
      mutate(bundle, (b) => void (b.compilerVersion = 'webar-gray8-cpu/0.1.0')),
    ],
    [
      'no selection',
      mutate(bundle, (b) => void delete (b.preprocessing as Record<string, unknown>).selection),
    ],
    [
      'another selection',
      mutate(
        bundle,
        (b) =>
          void ((b.preprocessing as Record<string, unknown>).selection =
            'anms-c0.8-pool1024-per-level'),
      ),
    ],
    [
      'descriptor type of another algorithm',
      mutate(
        bundle,
        (b) =>
          void ((b.features as { descriptorType: string }).descriptorType =
            'm0-harris-brief256-v1'),
      ),
    ],
    [
      'unknown algorithm',
      mutate(bundle, (b) => {
        b.algorithmVersion = 'm0-harris-anms-brief256-v2';
        (b.features as { descriptorType: string }).descriptorType = b.algorithmVersion;
      }),
    ],
    [
      'tampered pyramid',
      mutate(
        bundle,
        (b) => void ((b.pyramid[1]!.pixels as number[])[0] = (b.pyramid[1]!.pixels[0]! + 1) % 256),
      ),
    ],
    [
      'tampered base level',
      mutate(
        bundle,
        (b) => void ((b.pyramid[0]!.pixels as number[])[0] = (b.pyramid[0]!.pixels[0]! + 1) % 256),
      ),
    ],
    ['wrong hash domain', mutate(bundle, (b) => void (b.imageHashDomain = 'encoded-image'))],
    [
      'feature outside the target',
      mutate(bundle, (b) => void ((b.features.points as [number, number][])[0] = [b.widthPx, 0])),
    ],
    [
      'too many features',
      mutate(bundle, (b) => {
        const f = b.features as unknown as { points: unknown[]; descriptors: number[] };
        f.points = Array(513).fill(f.points[0]);
        f.descriptors = Array(513 * 32).fill(0);
      }),
    ],
  ];
  for (const [name, candidate] of bad) {
    await assert.rejects(validateTarget(candidate), rejectsTarget(), name);
  }
});

test('targets of retired algorithms are rejected with a request to recompile', async () => {
  const bundle = await bundleFor(texture(), 'a');
  for (const algorithm of ['m0-harris-brief256-v1', 'c-oriented-brief256-v2']) {
    const retired = mutate(bundle, (b) => {
      b.algorithmVersion = algorithm;
      (b.features as { descriptorType: string }).descriptorType = algorithm;
    });
    assert.throws(() => preflightTarget(retired), rejectsTarget(/recompile/));
  }
});
