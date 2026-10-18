/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { EngineError, type TargetBundle } from '@livemira/contracts';
import {
  ALGORITHM_VERSION,
  ANMS_SELECTION_ID,
  COMPILER_VERSION,
  extractFeatures,
  type GrayImage,
} from '@livemira/recognition';
import {
  compileGrayTarget,
  MAX_SERIALIZED_BYTES,
  parseTarget,
  serializeTarget,
} from '@livemira/target-compiler';

/** Random filled rectangles over a flat background. */
function texture(seed = 1234, widthPx = 320, heightPx = 240): GrayImage {
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const data = new Uint8Array(widthPx * heightPx).fill(80);
  for (let i = 0; i < 900; i++) {
    const x = random() % widthPx;
    const y = random() % heightPx;
    const w = 3 + (random() % 20);
    const h = 3 + (random() % 20);
    const color = random() % 256;
    for (let dy = 0; dy < h && y + dy < heightPx; dy++) {
      for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = color;
    }
  }
  return { widthPx, heightPx, data };
}

const isInvalidTarget = (error: unknown): boolean =>
  error instanceof EngineError && error.code === 'INVALID_TARGET';
const sha256 = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

test('compilation is deterministic and records the algorithm identity, levels, hash and features', async () => {
  const image = texture();
  const bundle = await compileGrayTarget(image, { targetId: 'synthetic-1' });
  assert.deepEqual(bundle, await compileGrayTarget(image, { targetId: 'synthetic-1' }));
  assert.equal(bundle.algorithmVersion, ALGORITHM_VERSION);
  assert.equal(bundle.compilerVersion, COMPILER_VERSION);
  assert.equal(bundle.features.descriptorType, ALGORITHM_VERSION);
  assert.equal(bundle.imageHash, sha256(image.data));
  assert.equal(bundle.imageHashDomain, 'canonical-gray8');
  assert.equal(bundle.physicalWidthMeters, null);
  assert.deepEqual(
    bundle.pyramid.map((l) => l.scale),
    [1, 2, 4],
  );
  assert.equal(bundle.preprocessing.selection, ANMS_SELECTION_ID);
  assert.equal(bundle.preprocessing.maxFeatures, 384);
  assert.equal(bundle.preprocessing.levels, 3);
  assert.ok(bundle.features.points.length <= 384 && bundle.features.points.length >= 100);
  assert.deepEqual(bundle.diagnostics, []);
  // The stored features are exactly what the extractor yields for the template budget.
  const expected = extractFeatures(image, { maxFeatures: 384, levels: 3 }).features;
  assert.deepEqual(
    bundle.features.points,
    expected.map((f) => [f.x, f.y]),
  );
  assert.deepEqual(
    bundle.features.descriptors,
    expected.flatMap((f) => f.descriptor),
  );
});

test('the physical width and the target identity are validated', async () => {
  const image = texture();
  assert.equal(
    (await compileGrayTarget(image, { targetId: 'metric', physicalWidthMeters: 0.3 }))
      .physicalWidthMeters,
    0.3,
  );
  for (const physicalWidthMeters of [0, -1, Infinity, NaN]) {
    await assert.rejects(
      compileGrayTarget(image, { targetId: 'bad', physicalWidthMeters }),
      isInvalidTarget,
    );
  }
  for (const targetId of ['', 'with space', 'x'.repeat(129), 'ü']) {
    await assert.rejects(compileGrayTarget(image, { targetId }), isInvalidTarget);
  }
  await assert.rejects(
    compileGrayTarget(
      { widthPx: 20, heightPx: 20, data: new Uint8Array(400) },
      { targetId: 'small' },
    ),
  );
});

test('the input is snapshotted before hashing', async () => {
  const input = texture(45);
  const original = new Uint8Array(input.data);
  const pending = compileGrayTarget(input, { targetId: 'snapshot' });
  input.data.fill(0);
  const target = await pending;
  assert.deepEqual(new Uint8Array(target.pyramid[0]!.pixels), original);
  assert.equal(target.imageHash, sha256(original));
});

test('flat and repetitive images receive actionable diagnostics', async () => {
  const flat = { widthPx: 320, heightPx: 240, data: new Uint8Array(320 * 240).fill(100) };
  assert.ok(
    (await compileGrayTarget(flat, { targetId: 'flat' })).diagnostics.some(
      (d) => d.code === 'LOW_TEXTURE',
    ),
  );
  const checker = {
    ...flat,
    data: Uint8Array.from(
      flat.data,
      (_, i) => ((Math.floor((i % 320) / 8) + Math.floor(Math.floor(i / 320) / 8)) % 2) * 255,
    ),
  };
  assert.ok(
    (await compileGrayTarget(checker, { targetId: 'checker' })).diagnostics.some(
      (d) => d.code === 'REPETITIVE_TEXTURE',
    ),
  );
});

test('serialization round-trips and carries an integrity hash of its payload', async () => {
  const bundle = await compileGrayTarget(texture(), { targetId: 'round-trip' });
  const text = await serializeTarget(bundle);
  assert.deepEqual(await parseTarget(text), bundle);
  const envelope = JSON.parse(text) as { payload: string; sha256: string };
  assert.equal(envelope.sha256, sha256(envelope.payload));
  assert.equal(await serializeTarget(await parseTarget(text)), text, 'stable text');
});

test('truncated, tampered, malformed, oversized and corrupt serialized targets are rejected', async () => {
  const bundle = await compileGrayTarget(texture(), { targetId: 'synthetic-1' });
  const text = await serializeTarget(bundle);
  await assert.rejects(parseTarget(text.slice(0, -10)), isInvalidTarget);
  await assert.rejects(
    parseTarget(text.replace('synthetic-1', 'synthetic-2')),
    (e: unknown) => isInvalidTarget(e) && /integrity/i.test((e as Error).message),
  );
  await assert.rejects(parseTarget('not json'), isInvalidTarget);
  await assert.rejects(parseTarget('null'), isInvalidTarget);
  await assert.rejects(parseTarget('x'.repeat(MAX_SERIALIZED_BYTES + 1)), isInvalidTarget);
  const rehash = (value: unknown): string => {
    const payload = JSON.stringify(value);
    return JSON.stringify({ payload, sha256: sha256(payload) });
  };
  type Mutable = Record<string, unknown> & {
    features: Record<string, unknown>;
    pyramid: Record<string, unknown>[];
  };
  const mutations: ((b: Mutable) => void)[] = [
    (b) => void (b.schemaVersion = 2),
    (b) => void (b.algorithmVersion = 'ORB'),
    (b) => void (b.compilerVersion = 'future'),
    (b) => void (b.features.descriptors as number[]).pop(),
    (b) => void ((b.features.descriptors as number[])[0] = 256),
    (b) => void ((b.features.points as number[][])[0] = [-1, 0]),
    (b) => void (b.widthPx = 100000),
    (b) => void (b.pyramid[1]!.scale = 1),
    (b) => void (b.physicalWidthMeters = -1),
    (b) => void (b.imageHash = 'f'.repeat(64)),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(bundle) as unknown as Mutable;
    mutate(bad);
    await assert.rejects(parseTarget(rehash(bad)), isInvalidTarget);
    await assert.rejects(serializeTarget(bad as unknown as TargetBundle), isInvalidTarget);
  }
});
