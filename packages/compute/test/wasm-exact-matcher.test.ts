/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  createWasmMatchOperator,
  matchHammingReference,
  selectWasmExactMatcher,
  WasmExactMatcher,
  type WasmMatcherVariant,
  type WebAssemblyApi,
} from '@livemira/compute';
import { EngineError } from '@livemira/contracts';

import { EXACT_MATCHING_WASM } from '../src/matching/generated/exact-matching-wasm.ts';
import {
  definitionOracle,
  join,
  ones,
  planted,
  randomDescriptors,
  rng,
} from './matching-oracles.ts';

const VARIANTS: readonly WasmMatcherVariant[] = ['simd', 'scalar'];
const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
const repo = new URL('../../../', import.meta.url);
const bytesOf = (variant: WasmMatcherVariant): Uint8Array<ArrayBuffer> =>
  new Uint8Array(Buffer.from(EXACT_MATCHING_WASM[variant].base64, 'base64'));

interface MatcherExports {
  memory: WebAssembly.Memory;
  abi(): number;
  match(...args: number[]): number;
}

const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof EngineError && error.code === code;

async function variant(name: WasmMatcherVariant): Promise<WasmExactMatcher> {
  const selection = await selectWasmExactMatcher({ variants: [name] });
  assert.equal(selection.variant, name, JSON.stringify(selection.attempts));
  return selection.matcher!;
}

test('generated modules match the manifest and sources; they are import-free and memory cannot grow', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('packages/compute/src/matching/generated/exact-matching-wasm.manifest.json', repo),
      'utf8',
    ),
  ) as {
    generatedModule: string;
    generatedModuleSha256: string;
    variants: {
      id: WasmMatcherVariant;
      source: string;
      sourceSha256: string;
      byteLength: number;
      sha256: string;
      features: string[];
    }[];
  };
  assert.equal(
    manifest.generatedModuleSha256,
    sha(readFileSync(new URL(manifest.generatedModule, repo))),
  );
  assert.equal(EXACT_MATCHING_WASM.abi, 1);
  for (const v of manifest.variants) {
    const embedded = EXACT_MATCHING_WASM[v.id];
    const bytes = bytesOf(v.id);
    assert.equal(
      sha(readFileSync(new URL(v.source, repo))),
      v.sourceSha256,
      `${v.id} source changed without a rebuild`,
    );
    assert.equal(bytes.length, v.byteLength);
    assert.equal(sha(bytes), v.sha256);
    assert.equal(embedded.sha256, v.sha256);
    assert.ok(bytes.length < 2048, `${v.id} stays small`);
    const module = new WebAssembly.Module(bytes);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    assert.deepEqual(
      WebAssembly.Module.exports(module)
        .map((e) => `${e.kind}:${e.name}`)
        .sort(),
      ['function:abi', 'function:match', 'memory:memory'],
    );
    const exports = new WebAssembly.Instance(module, {}).exports as unknown as MatcherExports;
    assert.equal(exports.memory.buffer.byteLength, 4 * 65536);
    assert.throws(() => exports.memory.grow(1), RangeError, 'maximum equals minimum');
  }
  assert.equal(manifest.variants.find((v) => v.id === 'simd')!.features.join(), 'simd');
  assert.equal(manifest.variants.find((v) => v.id === 'scalar')!.features.length, 0);
});

test('the module ABI rejects arguments outside the fixed layout instead of touching other regions', () => {
  for (const name of VARIANTS) {
    const exports = new WebAssembly.Instance(new WebAssembly.Module(bytesOf(name)), {})
      .exports as unknown as MatcherExports;
    const OUT = 194560;
    assert.equal(exports.abi(), 1);
    for (const args of [
      [0, 513, OUT, 1],
      [0, 1, OUT, 513],
      [16, 1, OUT, 1],
      [163840, 1, OUT, 1],
      [9 * 16384 + 32, 512, OUT, 1],
      [0, 1, OUT - 2, 1],
      [0, 1, OUT + 1, 1],
      [0, 512, 225280 - 6 * 511, 1],
      [-32, 1, OUT, 1],
      [0, 1, -2, 1],
    ]) {
      assert.equal(exports.match(...args), -1, `${name} ${args.join(',')}`);
    }
    assert.equal(exports.match(0, 0, OUT, 5), 0);
    assert.equal(exports.match(0, 5, OUT, 0), 0);
    assert.ok(
      exports.match(9 * 16384, 512, 225280 - 6 * 512, 512) >= 0,
      `${name} last slot at full capacity`,
    );
  }
});

test('both variants equal the definition oracle and the reference on structured cases', async () => {
  const r = rng(11);
  const zero = new Uint8Array(32);
  const base = randomDescriptors(r, 8);
  const cases: Record<string, [Uint8Array, Uint8Array]> = {
    'empty target': [new Uint8Array(0), randomDescriptors(r, 5)],
    'empty frame': [randomDescriptors(r, 5), new Uint8Array(0)],
    'both empty': [new Uint8Array(0), new Uint8Array(0)],
    'identical sets': [base, base.slice()],
    'duplicate targets (reverse tie)': [
      join([base.subarray(0, 32), base.subarray(0, 32), base.subarray(32, 64)]),
      base.subarray(0, 96).slice(),
    ],
    'duplicate frames (forward tie => second = best)': [
      base.subarray(0, 64).slice(),
      join([base.subarray(0, 32), base.subarray(0, 32), base.subarray(32, 64)]),
    ],
    'all descriptors equal': [
      join(Array<Uint8Array>(6).fill(zero)),
      join(Array<Uint8Array>(7).fill(zero)),
    ],
    'distance 64 accepted': [zero, ones(64)],
    'distance 65 rejected': [zero, ones(65)],
    'distance 0': [zero, zero.slice()],
    'distance 256': [ones(256), zero],
    'ratio equality rejected (30 vs 40)': [zero, join([ones(30), ones(40)])],
    'ratio just accepted (30 vs 41)': [zero, join([ones(30), ones(41)])],
    'ratio just rejected (30 vs 39)': [zero, join([ones(39), ones(30)])],
    'single frame descriptor (second = 257)': [join([zero, ones(10)]), ones(5)],
    'reverse tie broken by a later closer target': [join([ones(20), ones(20), ones(3)]), zero],
    'reverse tie after a closer target': [join([ones(3), ones(20), ones(3)]), zero],
  };
  for (const n of [1, 3, 4, 5, 63, 64, 65, 511, 512]) {
    for (const m of [1, 2, 3, 4, 5, 7, 8, 9, 511, 512]) {
      if (n * m <= 512 * 64 || n === m) {
        const t = randomDescriptors(r, n);
        cases[`n=${n} m=${m}`] = [t, planted(r, t, m)];
      }
    }
  }
  const matchers = await Promise.all(
    VARIANTS.map(async (name) => [name, await variant(name)] as const),
  );
  let accepted = 0;
  for (const [label, [target, frame]] of Object.entries(cases)) {
    const want = definitionOracle(target, frame);
    assert.deepStrictEqual(
      matchHammingReference(target, frame),
      want,
      `${label}: reference vs definition`,
    );
    accepted += want.length;
    for (const [name, matcher] of matchers) {
      matcher.setTargets([{ id: 'a', descriptors: target }]);
      assert.deepStrictEqual(
        matcher.matchBatch(['a'], frame).matches,
        [{ targetId: 'a', pairs: want }],
        `${name}: ${label}`,
      );
    }
  }
  assert.ok(accepted > 500, `${accepted} accepted pairs exercised`);
  for (const [, matcher] of matchers) matcher.dispose();
});

test('randomized batches of 1 and 10 resident targets: request order kept, ascending target index, exact equality', async () => {
  for (const name of VARIANTS) {
    const matcher = await variant(name);
    const r = rng(name === 'simd' ? 3 : 4);
    for (let round = 0; round < 40; round++) {
      const load = round % 2 ? 10 : 1;
      const targets = Array.from({ length: load }, (_, k) => ({
        id: `t${k}`,
        descriptors: randomDescriptors(r, round % 7 === 0 ? 512 : 1 + (r() % 400)),
      }));
      matcher.setTargets(targets);
      const pool = join(targets.map((t) => t.descriptors));
      const frame = planted(r, pool, round % 5 === 0 ? 512 : r() % 513, 0.5, 70);
      const order = targets.map((t) => t.id).reverse();
      const result = matcher.matchBatch(order, frame);
      assert.equal(result.backend, 'wasm');
      assert.equal(result.variant, name);
      assert.equal(result.matchingVersion, 'hamming32-mutual-ratio075-max64/1');
      assert.deepStrictEqual(
        result.matches.map((x) => x.targetId),
        order,
      );
      for (const { targetId, pairs } of result.matches) {
        const t = targets.find((x) => x.id === targetId)!.descriptors;
        assert.deepStrictEqual(
          pairs,
          matchHammingReference(t, frame),
          `${name} round ${round} ${targetId}`,
        );
        if (round < 6) assert.deepStrictEqual(pairs, definitionOracle(t, frame));
        assert.ok(pairs.every((p, i) => !i || pairs[i - 1]!.targetIndex < p.targetIndex));
      }
      // Resident targets survive later frames without a new setTargets.
      const second = planted(r, pool, 200);
      const again = matcher.matchBatch(['t0'], second);
      assert.deepStrictEqual(
        again.matches[0]!.pairs,
        matchHammingReference(targets[0]!.descriptors, second),
      );
    }
    matcher.dispose();
  }
});

test('invalid requests throw before changing state; abort rejects; dispose releases and later calls throw', async () => {
  const matcher = await variant('simd');
  const r = rng(9);
  const t = randomDescriptors(r, 20);
  const frame = planted(r, t, 30);
  matcher.setTargets([{ id: 'keep', descriptors: t }]);
  const before = matcher.matchBatch(['keep'], frame);
  for (const bad of [
    [{ id: 'x', descriptors: new Uint8Array(31) }],
    [{ id: 'x', descriptors: new Uint8Array(513 * 32) }],
    [{ id: 'x', descriptors: [1, 2, 3] as unknown as Uint8Array }],
    [{ id: '', descriptors: t }],
    [
      { id: 'a', descriptors: t },
      { id: 'a', descriptors: t },
    ],
    Array.from({ length: 11 }, (_, i) => ({ id: `${i}`, descriptors: t })),
    [
      { id: 'good', descriptors: randomDescriptors(r, 3) },
      { id: 'bad', descriptors: new Uint8Array(33) },
    ],
  ]) {
    assert.throws(() => matcher.setTargets(bad), hasCode('INVALID_CONFIG'));
  }
  assert.deepStrictEqual(
    matcher.matchBatch(['keep'], frame).matches,
    before.matches,
    'roster unchanged by rejected updates',
  );
  for (const [ids, f] of [
    [['missing'], frame],
    [['keep', 'keep'], frame],
    [['keep'], new Uint8Array(40)],
    [['keep'], new Uint8Array(513 * 32)],
    ['keep' as unknown as string[], frame],
  ] as const) {
    assert.throws(() => matcher.matchBatch(ids, f), hasCode('INVALID_CONFIG'));
  }
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => matcher.matchBatch(['keep'], frame, controller.signal), hasCode('ABORTED'));
  const operator = createWasmMatchOperator(matcher);
  await assert.rejects(
    operator([{ targetId: 'keep', descriptors: t }], frame, controller.signal),
    hasCode('ABORTED'),
  );
  assert.equal(matcher.isAvailable, true, 'abort does not disable the matcher');
  matcher.dispose();
  assert.equal(matcher.isAvailable, false);
  assert.equal(matcher.diagnostics.backend, 'cpu');
  assert.equal(matcher.diagnostics.targetCount, 0);
  assert.throws(() => matcher.matchBatch(['keep'], frame), /unavailable/);
  assert.throws(() => matcher.setTargets([]), /unavailable/);
  assert.equal(
    await operator([{ targetId: 'keep', descriptors: t }], frame),
    null,
    'a disposed matcher leaves matching to JavaScript',
  );
});

test('selection: SIMD first, scalar when SIMD is unsupported, JavaScript when WebAssembly is absent or every variant fails', async () => {
  const auto = await selectWasmExactMatcher();
  assert.equal(auto.variant, 'simd');
  assert.equal(auto.fallbackReason, null);
  assert.deepEqual(auto.attempts, [{ variant: 'simd', outcome: 'selected' }]);
  auto.matcher!.dispose();
  const noSimd = {
    ...EXACT_MATCHING_WASM,
    simd: { ...EXACT_MATCHING_WASM.simd, base64: Buffer.from('not wasm').toString('base64') },
  };
  const scalar = await selectWasmExactMatcher({ binaries: noSimd });
  assert.equal(scalar.variant, 'scalar');
  assert.equal(scalar.fallbackReason, 'WASM_SIMD_UNSUPPORTED');
  assert.equal(scalar.matcher!.variant, 'scalar');
  scalar.matcher!.dispose();
  // An engine that refuses SIMD at validation (as browsers without SIMD128 do) gets scalar.
  const simdBytes = bytesOf('simd');
  const refusing: WebAssemblyApi = {
    validate: (bytes) => !Buffer.from(bytes as Uint8Array).equals(simdBytes),
    instantiate: (bytes, imports) => WebAssembly.instantiate(bytes, imports),
  };
  assert.equal((await selectWasmExactMatcher({ webAssembly: refusing })).variant, 'scalar');
  assert.deepEqual(await selectWasmExactMatcher({ webAssembly: null }), {
    matcher: null,
    variant: null,
    fallbackReason: 'WASM_UNAVAILABLE',
    attempts: [{ variant: '*', outcome: 'WASM_UNAVAILABLE' }],
  });
  const failing: WebAssemblyApi = {
    validate: () => true,
    instantiate: async () => {
      throw new WebAssembly.CompileError('CSP: wasm-unsafe-eval');
    },
  };
  const none = await selectWasmExactMatcher({ webAssembly: failing });
  assert.equal(none.matcher, null);
  assert.equal(none.fallbackReason, 'WASM_INIT_FAILED');
  assert.equal(none.attempts.length, 2);
  // A module that instantiates but computes the wrong answer is never selected (self-test against the reference).
  const wrong: WebAssemblyApi = {
    validate: () => true,
    instantiate: async () =>
      ({
        instance: {
          exports: {
            memory: new WebAssembly.Memory({ initial: 4, maximum: 4 }),
            abi: () => 1,
            match: () => 0,
          },
        },
      }) as unknown as WebAssembly.WebAssemblyInstantiatedSource,
  };
  const mismatch = await selectWasmExactMatcher({ webAssembly: wrong });
  assert.equal(mismatch.matcher, null);
  assert.deepEqual(
    mismatch.attempts.map((a) => a.outcome),
    ['WASM_SELFTEST_MISMATCH', 'WASM_SELFTEST_MISMATCH'],
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(selectWasmExactMatcher({ signal: controller.signal }), hasCode('ABORTED'));
  await assert.rejects(
    selectWasmExactMatcher({ variants: ['avx' as WasmMatcherVariant] }),
    hasCode('INVALID_CONFIG'),
  );
});

test('an execution failure disables the matcher once and the operator hands that frame back to JavaScript', async () => {
  let calls = 0;
  const failures: string[] = [];
  const instance = {
    exports: {
      memory: new WebAssembly.Memory({ initial: 4, maximum: 4 }),
      abi: () => 1,
      match: () => {
        calls++;
        throw new WebAssembly.RuntimeError('unreachable');
      },
    },
  } as unknown as WebAssembly.Instance;
  const broken = new WasmExactMatcher(instance, 'scalar');
  const operator = createWasmMatchOperator(broken, {
    onFailure: (reason) => failures.push(reason),
  });
  const t = randomDescriptors(rng(5), 4);
  assert.equal(await operator([{ targetId: 'only', descriptors: t }], t), null);
  assert.equal(calls, 1);
  assert.deepEqual(failures, ['WASM_EXECUTION_FAILED']);
  assert.equal(broken.isAvailable, false);
  assert.equal(broken.diagnostics.fallbackReason, 'WASM_EXECUTION_FAILED');
  assert.equal(await operator([{ targetId: 'only', descriptors: t }], t), null);
  assert.equal(calls, 1, 'a disabled matcher is not retried');
});
