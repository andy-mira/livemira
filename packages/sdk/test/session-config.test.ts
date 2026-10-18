/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// What a session records about itself: targets, hashed media identities, the real prediction and grace policy, the
// startup stages and their clocks.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError } from '@livemira/contracts';
import { DiagnosticLog } from '@livemira/diagnostics';
import { createEngine } from '@livemira/engine';
import { compileGrayTarget } from '@livemira/target-compiler';

import { EngineCore } from '../src/engine/engine-core.ts';
import { harness } from './core-harness.ts';
import { texture } from './support.ts';

const container = {} as HTMLElement;
type Logged = { type: string; [key: string]: unknown };
const events = (log: DiagnosticLog): Logged[] => log.export().events as unknown as Logged[];

test('each session snapshot keeps its own targets and a hashed media identity, never the URL', async () => {
  const log = new DiagnosticLog({ level: 'key' });
  const facts = { previewSurface: 'canvas' as 'canvas' | 'video' };
  const h = harness({ telemetry: log, sessionIdPrefix: 'instance-', sessionFacts: () => facts });
  await h.core.setTargets([await compileGrayTarget(texture(), { targetId: 'one' })]);
  h.core.setTargetMedia('one', {
    url: 'https://example.invalid/private-path?token=SYNTHETIC_SECRET',
  });
  await h.core.start(container);
  facts.previewSurface = 'video';
  await h.core.stop('switch');
  await h.core.setTargets([await compileGrayTarget(texture(7), { targetId: 'two' })]);
  await h.core.start(container);
  await h.core.stop();
  await h.core.dispose();
  const snapshots = events(log).filter((e) => e.type === 'sessionConfig') as unknown as {
    config: {
      targets: { targetId: string }[];
      media: { identityKind: string; identityHash: string }[];
      previewSurface: string;
    };
  }[];
  assert.deepEqual(
    snapshots.map((e) => e.config.targets[0]!.targetId),
    ['one', 'two'],
  );
  assert.equal(snapshots[0]!.config.previewSurface, 'canvas');
  assert.equal(snapshots[0]!.config.media[0]!.identityKind, 'url-sha256');
  assert.match(snapshots[0]!.config.media[0]!.identityHash, /^[0-9a-f]{64}$/);
  const text = JSON.stringify(log.export());
  assert.equal(text.includes('SYNTHETIC_SECRET'), false);
  assert.equal(text.includes('private-path'), false);
  assert.deepEqual(
    events(log)
      .filter((e) => e.type === 'sessionEnded')
      .map((e) => e['sessionId']),
    ['instance-session-1', 'instance-session-2'],
  );
});

test('the snapshot records the real grace and prediction policy; session facts cannot override them', async () => {
  for (const [grace, expected] of [
    [500, 500],
    [undefined, 0],
  ] as const) {
    const log = new DiagnosticLog({ level: 'key' });
    const h = harness({
      telemetry: log,
      ...(grace === undefined ? {} : { lossDisplayGraceMs: grace }),
      sessionFacts: () => ({ maxPredictionMs: 900, lossDisplayGraceMs: 900 }) as never,
    });
    await h.core.start(container);
    h.core.refreshSessionConfig();
    await h.core.stop();
    await h.core.dispose();
    for (const type of ['sessionConfig', 'sessionConfigUpdated']) {
      const config = events(log).find((e) => e.type === type)!['config'] as {
        lossDisplayGraceMs: number;
        maxPredictionMs: number;
      };
      assert.equal(config.lossDisplayGraceMs, expected, type);
      assert.equal(config.maxPredictionMs, 100, type);
    }
  }
});

test('the loss display grace accepts only an absent value or a finite number in range', () => {
  const element = { ownerDocument: {} } as unknown as HTMLElement;
  const parts = { source: {}, pipeline: {}, overlay: {} } as never as object;
  const isInvalid = (e: unknown): boolean =>
    e instanceof EngineError && e.code === 'INVALID_CONFIG';
  for (const bad of [null, '500', '0', {}, [], true, -1, NaN, Infinity, 1001]) {
    assert.throws(
      () => createEngine({ container: element, tracking: { lossDisplayGraceMs: bad as never } }),
      isInvalid,
      String(bad),
    );
    assert.throws(
      () => new EngineCore({ ...parts, lossDisplayGraceMs: bad } as never),
      isInvalid,
      String(bad),
    );
  }
  for (const ok of [undefined, 0, 500, 1000])
    assert.doesNotThrow(() => new EngineCore({ ...parts, lossDisplayGraceMs: ok } as never));
});

test('a failed camera start keeps the snapshot, the failed stage, one error and one end, and no frames', async () => {
  let nowUs = 1000;
  const log = new DiagnosticLog({ level: 'full' });
  const core = new EngineCore({
    source: {
      start: async () => {
        nowUs += 500000;
        throw new Error('denied');
      },
      stop: async () => {},
      dispose: async () => {},
    },
    pipeline: {
      loadTargets: async () => {},
      reset: async () => {},
      process: async () => ({}) as never,
      dispose: async () => {},
    },
    overlay: {
      start: async () => {},
      update: async () => {},
      hide: () => {},
      stop: async () => {},
      dispose: async () => {},
    },
    telemetry: log,
    nowUs: () => nowUs,
  });
  await core.setTargets([await compileGrayTarget(texture(), { targetId: 'one' })]);
  await assert.rejects(
    core.start(container),
    (e) => e instanceof EngineError && e.code === 'START_FAILED',
  );
  await core.stop();
  await core.dispose();
  const data = log.export();
  assert.equal(data.frames?.length ?? 0, 0);
  assert.equal(events(log).filter((e) => e.type === 'sessionEnded').length, 1);
  assert.equal(events(log).filter((e) => e.type === 'error').length, 1);
  const config = events(log).find((e) => e.type === 'sessionConfig')!['config'] as {
    inputWidthPx: unknown;
  };
  assert.equal(config.inputWidthPx, null);
  assert.equal(events(log).find((e) => e.type === 'sessionStartFailed')!['attemptTimeUs'], 500000);
  const stage = events(log).find((e) => e.type === 'stageTiming' && e['stage'] === 'camera-init')!;
  assert.equal(stage['durationUs'], 500000);
  assert.equal(stage['status'], 'failed');
  assert.equal(stage['timestampDomain'], 'attempt');
});

test('the source clock begins after initialization; stage durations use the attempt clock', async () => {
  let nowUs = 0;
  let origin: number | null = null;
  const log = new DiagnosticLog({ level: 'key' });
  const core = new EngineCore({
    source: {
      start: async () => {
        nowUs += 800000;
        origin = nowUs;
      },
      stop: async () => {
        origin = null;
      },
      dispose: async () => {},
      nowSessionUs: () => (origin === null ? null : nowUs - origin),
    },
    pipeline: {
      loadTargets: async () => {},
      reset: async () => {},
      process: async () => ({}) as never,
      dispose: async () => {},
    },
    overlay: {
      start: async () => {},
      update: async () => {},
      hide: () => {},
      stop: async () => {},
      dispose: async () => {},
    },
    telemetry: log,
    nowUs: () => nowUs,
  });
  await core.start(container);
  nowUs += 10000;
  core.refreshSessionConfig();
  await core.stop();
  const find = (type: string, stage?: string): Logged =>
    events(log).find((e) => e.type === type && (stage === undefined || e['stage'] === stage))!;
  assert.equal(find('sessionConfig')['timestampDomain'], 'attempt');
  assert.equal(find('stageTiming', 'camera-init')['durationUs'], 800000);
  assert.equal(find('sessionConfigUpdated')['timestampUs'], 0);
  assert.equal(find('sessionConfigUpdated')['timestampDomain'], 'source-session');
  assert.equal(find('sessionEnded')['timestampUs'], 10000);
  await core.dispose();
});
