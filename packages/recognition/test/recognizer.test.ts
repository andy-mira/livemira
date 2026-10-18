/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type TargetBundle } from '@livemira/contracts';
import {
  ALGORITHM_VERSION,
  project,
  Recognizer,
  type ExactMatcher,
  type GrayImage,
  type RecognitionBatch,
} from '@livemira/recognition';

import { bundleFor } from './bundles.ts';
import { similarity, texture, warp } from './images.ts';

const hasCode = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;
const identity = (frameId: number) => ({ sessionId: 's', frameId });
const flat = (widthPx: number, heightPx: number, value = 100): GrayImage => ({
  widthPx,
  heightPx,
  data: new Uint8Array(widthPx * heightPx).fill(value),
});

const IMAGES = Array.from({ length: 11 }, (_, i) => texture(500 + i, 320, 240));
let corpus: Promise<TargetBundle[]> | null = null;
/** Ten bundles t0..t9; image 10 is never compiled (a negative). */
const bundles = (): Promise<TargetBundle[]> =>
  (corpus ??= Promise.all(IMAGES.slice(0, 10).map((image, i) => bundleFor(image, `t${i}`))));
const frameOf = (k: number, scale = 0.8, size: [number, number] = [640, 480]): GrayImage =>
  warp(IMAGES[k]!, similarity(IMAGES[k]!, size[0], size[1], scale), size[0], size[1]);

async function withRecognizer<T>(
  targets: readonly TargetBundle[],
  run: (r: Recognizer) => Promise<T>,
  options = {},
): Promise<T> {
  const recognizer = new Recognizer(options);
  await recognizer.loadTargets(targets);
  try {
    return await run(recognizer);
  } finally {
    recognizer.dispose();
  }
}

test('recognizes its own image, recovers a known transformation and rejects a different image', async () => {
  const image = texture();
  const bundle = await bundleFor(image, 'a');
  await withRecognizer([bundle], async (r) => {
    const hit = await r.recognize(image, identity(1));
    assert.equal(hit.observations.length, 1);
    assert.equal(hit.observations[0]!.algorithmVersion, ALGORITHM_VERSION);
    assert.equal(hit.facts.algorithmVersion, ALGORITHM_VERSION);
    assert.equal(hit.facts.scalePasses, 1);
    const miss = await r.recognize(texture(777), identity(2));
    assert.equal(miss.observations.length, 0);
    const h = [0.9, -0.12, 40, 0.12, 0.9, 25, 0, 0, 1];
    const found = await r.recognize(warp(image, h, 640, 480), identity(3));
    assert.equal(found.observations.length, 1);
    const o = found.observations[0]!;
    assert.equal(o.sessionId, 's');
    assert.equal(o.frameId, 3);
    for (const p of [
      [0, 0],
      [320, 0],
      [320, 240],
      [0, 240],
    ] as const) {
      const got = project(o.H_imageFromTarget, p);
      const want = project(h, p);
      assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 3);
    }
    for (let i = 0; i < o.inliers.length; i++) {
      if (!o.inliers[i]) continue;
      const q = project(o.H_imageFromTarget, o.targetPoints[i]!);
      assert.ok(Math.hypot(q[0] - o.imagePoints[i]![0], q[1] - o.imagePoints[i]![1]) <= 3);
    }
  });
});

test('with ten targets loaded the right one is chosen without ambiguity; negatives and blank frames find nothing', async () => {
  const targets = await bundles();
  await withRecognizer(targets, async (r) => {
    for (const k of [0, 4, 9]) {
      const batch = await r.recognize(frameOf(k), identity(k));
      assert.equal(batch.isAmbiguous, false);
      assert.deepEqual(
        batch.observations.map((o) => o.targetId),
        [`t${k}`],
      );
    }
    assert.equal((await r.recognize(frameOf(10), identity(20))).observations.length, 0);
    const blank = await r.recognize(flat(640, 480, 18), identity(21));
    assert.equal(blank.observations.length, 0);
    assert.equal(blank.rejected.length, 10);
  });
});

test('a duplicate target makes the result ambiguous and suppresses every candidate', async () => {
  const targets = await bundles();
  const twin = { ...structuredClone(targets[1]!), targetId: 't1-twin' };
  await withRecognizer([targets[0]!, targets[1]!, twin, targets[2]!], async (r) => {
    const batch = await r.recognize(frameOf(1), identity(1));
    assert.ok(batch.isAmbiguous);
    assert.deepEqual(batch.observations, []);
    assert.equal(batch.rejected.filter((x) => x.reason === 'AMBIGUOUS_TARGETS').length, 2);
    assert.equal(batch.facts.scalePasses, 1, 'an ambiguous result is never retried');
  });
});

test('the half-octave retry runs only after a global miss, not with a region of interest, and can be turned off', async () => {
  const targets = await bundles();
  await withRecognizer(targets.slice(0, 1), async (r) => {
    assert.equal((await r.recognize(frameOf(0), identity(1))).facts.scalePasses, 1);
    assert.equal((await r.recognize(flat(640, 480), identity(2))).facts.scalePasses, 2);
    const roi = { x: 0, y: 0, width: 100, height: 100 };
    assert.equal((await r.recognize(flat(640, 480), identity(3), { roi })).facts.scalePasses, 1);
  });
  await withRecognizer(
    targets.slice(0, 1),
    async (r) => {
      assert.equal((await r.recognize(flat(640, 480), identity(4))).facts.scalePasses, 1);
    },
    { scaleRetry: false },
  );
});

test('captured pass facts are snapshotted per pass; summed stage times keep the last feature count', async () => {
  const targets = await bundles();
  await withRecognizer(
    targets.slice(0, 3),
    async (r) => {
      const once = await r.recognize(frameOf(0), identity(1));
      assert.equal(once.facts.passes?.length, 1);
      assert.equal(once.facts.passes![0]!.scale, 1);
      assert.equal(once.facts.passes![0]!.observationCount, 1);
      const twice = await r.recognize(flat(640, 480), identity(2));
      assert.equal(twice.facts.passes?.length, 2);
      assert.equal(twice.facts.passes![1]!.scale, Math.SQRT1_2);
      assert.ok(twice.facts.passes![1]!.prepareMs >= 0);
      assert.equal(twice.facts.featureCount, twice.facts.passes![1]!.featureCount);
    },
    { capturePasses: true },
  );
  await withRecognizer(targets.slice(0, 1), async (r) => {
    assert.equal((await r.recognize(frameOf(0), identity(1))).facts.passes, undefined);
  });
});

test('cancellation, invalid identity and the in-flight guard', async () => {
  const targets = await bundles();
  await withRecognizer(targets, async (r) => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      r.recognize(frameOf(0), identity(1), { signal: controller.signal }),
      hasCode('ABORTED'),
    );
    await assert.rejects(
      r.recognize(frameOf(0), { sessionId: '', frameId: 1 }),
      hasCode('FRAME_FAILED'),
    );
    // The guard is released after a failure, so the next frame is processed normally.
    assert.equal((await r.recognize(frameOf(0), identity(2))).observations[0]?.targetId, 't0');
    const first = r.recognize(frameOf(0), identity(3));
    await assert.rejects(r.recognize(frameOf(0), identity(4)), hasCode('INVALID_CONFIG'));
    await first;
  });
});

test('target loading validates counts and duplicates; a disposed recognizer refuses work', async () => {
  const targets = await bundles();
  const r = new Recognizer();
  await assert.rejects(r.loadTargets([]), hasCode('INVALID_TARGET'));
  await assert.rejects(r.loadTargets([...targets, targets[0]!]), hasCode('INVALID_TARGET'));
  await assert.rejects(r.loadTargets([targets[0]!, targets[0]!]), hasCode('INVALID_TARGET'));
  const corrupt = { ...structuredClone(targets[0]!), compilerVersion: 'webar-gray8-cpu/0.1.0' };
  await assert.rejects(r.loadTargets([corrupt]), hasCode('INVALID_TARGET'));
  await assert.rejects(r.recognize(frameOf(0), identity(1)), hasCode('INVALID_TARGET'));
  r.dispose();
  await assert.rejects(r.loadTargets(targets.slice(0, 1)), hasCode('DISPOSED'));
  assert.throws(
    () => new Recognizer({ scaleRetry: 'no' as unknown as boolean }),
    hasCode('INVALID_CONFIG'),
  );
});

const comparable = (batch: RecognitionBatch): unknown => {
  const { featureMs, retrievalMs, matchMs, geometryMs, totalMs, matchingBackend, ...facts } =
    batch.facts;
  void [featureMs, retrievalMs, matchMs, geometryMs, totalMs, matchingBackend];
  return { ...batch, facts };
};

test('an exact matcher that follows the contract gives the built-in result; null hands the frame back', async () => {
  const targets = await bundles();
  const frames = [frameOf(0), frameOf(1, 0.75), frameOf(10), flat(320, 240, 18), frameOf(0, 0.45)];
  const builtIn: unknown[] = [];
  await withRecognizer(targets, async (r) => {
    for (const [k, f] of frames.entries())
      builtIn.push(comparable(await r.recognize(f, identity(k))));
  });
  // An exact matcher built from the recognizer's own contract, reporting a WebAssembly backend.
  const { matchPacked } = await import('@livemira/recognition');
  const exact: ExactMatcher = async (requests, frameDescriptors) => ({
    backend: 'wasm',
    matches: requests.map(({ targetId, descriptors }) => {
      const asPoints = (bytes: Uint8Array) =>
        Array.from({ length: bytes.length / 32 }, (_, i) => ({
          x: i,
          y: 0,
          descriptor: Array.from(bytes.subarray(i * 32, i * 32 + 32)),
        }));
      const pairs = matchPacked(asPoints(descriptors), asPoints(frameDescriptors)).map((p) => ({
        targetIndex: p.target[0],
        frameIndex: p.image[0],
        distance: p.distance,
      }));
      return { targetId, pairs };
    }),
  });
  for (const matcher of [exact, (async () => null) as ExactMatcher]) {
    await withRecognizer(
      targets,
      async (r) => {
        for (const [k, f] of frames.entries()) {
          const batch = await r.recognize(f, identity(k));
          assert.deepStrictEqual(comparable(batch), builtIn[k], `frame ${k}`);
          assert.equal(batch.facts.matchingBackend, matcher === exact ? 'wasm' : 'cpu');
        }
      },
      { exactMatcher: matcher },
    );
  }
});

test('exact matcher output is validated and cancellation inside it aborts the recognition', async () => {
  const image = texture(901, 320, 240);
  const target = await bundleFor(image, 'only');
  const frame = warp(image, similarity(image, 320, 240, 0.8), 320, 240);
  const run = (matcher: ExactMatcher, signal?: AbortSignal) =>
    withRecognizer([target], (r) => r.recognize(frame, identity(1), signal ? { signal } : {}), {
      exactMatcher: matcher,
    });
  await assert.rejects(
    run(async () => ({ backend: 'wasm', matches: [] })),
    hasCode('FRAME_FAILED'),
  );
  await assert.rejects(
    run(async () => ({ backend: 'gpu', matches: [{ targetId: 'only', pairs: [] }] })),
    hasCode('FRAME_FAILED'),
  );
  await assert.rejects(
    run(async () => ({
      backend: 'wasm',
      matches: [{ targetId: 'only', pairs: [{ targetIndex: 0, frameIndex: 0, distance: 65 }] }],
    })),
    hasCode('FRAME_FAILED'),
  );
  await assert.rejects(
    run(async () => ({
      backend: 'wasm',
      matches: [
        {
          targetId: 'only',
          pairs: [
            { targetIndex: 0, frameIndex: 0, distance: 1 },
            { targetIndex: 1, frameIndex: 0, distance: 1 },
          ],
        },
      ],
    })),
    hasCode('FRAME_FAILED'),
  );
  const controller = new AbortController();
  await assert.rejects(
    run(async () => {
      controller.abort();
      return { backend: 'wasm', matches: [{ targetId: 'only', pairs: [] }] };
    }, controller.signal),
    hasCode('ABORTED'),
  );
});
