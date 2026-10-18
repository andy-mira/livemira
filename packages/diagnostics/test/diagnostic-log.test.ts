/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type TrackingResult } from '@livemira/contracts';
import { DiagnosticLog, Ring, sanitizePresentation } from '@livemira/diagnostics';

const context = {
  sessionId: 's1',
  targetId: null,
  timestampUs: 10,
  timestampDomain: 'engine-session',
};

const result = (frameId: number): TrackingResult => ({
  sessionId: 's1',
  frameId,
  observationTimeUs: 0,
  state: 'TRACKING',
  reason: 'original-target-measured',
  targetId: 't1',
  H_imageFromTarget: null,
  cornersPx: null,
  quality: {
    inlierCount: 1,
    inlierRatio: 1,
    reprojectionErrorPx: null,
    spatialCoverage: 0,
    isDegenerate: false,
    isMeasured: true,
  },
  prediction: { ageUs: 0, lastMeasuredTimeUs: 0, expiresAtUs: 1 },
  matchedPoints: { sessionId: 's1', frameId, targetId: 't1', pointsPx: [[1, 2]] },
});

const frame = (frameId: number) => ({
  sessionId: 's1',
  frameId,
  targetId: null,
  pictureKey: `s1:${frameId}`,
  arrivalTimeUs: 1,
  submitTimeUs: 2,
  resultAvailableTimeUs: 3,
  renderSubmitTimeUs: null,
  queueWaitDurationUs: 0,
  dropReason: null,
});

test('the ring keeps the newest values and counts what it dropped', () => {
  const ring = new Ring<number>(3);
  for (let i = 0; i < 5; i++) ring.push(i);
  assert.deepEqual(ring.values(), [2, 3, 4]);
  assert.equal(ring.dropped, 2);
});

test('the key level keeps key events and no per-frame records', () => {
  const log = new DiagnosticLog();
  log.event('attemptStart', context);
  log.event('targetUpdated', { ...context, result: result(1) });
  log.event('mediaState', { ...context, state: 'timeupdate', media: {} });
  log.event('mediaState', { ...context, state: 'shown', media: {} });
  log.frame(frame(1));
  log.result(result(1));
  assert.equal(log.wantsFrameDetail, false);
  const out = log.export();
  assert.equal(out.schema, 'livemira-diagnostics/2');
  assert.equal(out.level, 'key');
  assert.deepEqual(
    out.events.map((e) => [e.type, e.state ?? null]),
    [
      ['attemptStart', null],
      ['mediaState', 'shown'],
    ],
  );
  assert.equal(out.frames, undefined);
});

test('a level change applies at the next session start', () => {
  const log = new DiagnosticLog();
  log.event('attemptStart', context);
  log.setLevel('full');
  assert.equal(log.activeLevel, 'key');
  log.frame(frame(1));
  log.event('attemptStart', context);
  assert.equal(log.activeLevel, 'full');
  log.frame(frame(2));
  log.result(result(2));
  const out = log.export();
  assert.equal(out.level, 'full');
  assert.deepEqual(
    out.frames!.map((f) => f.frameId),
    [2],
  );
  assert.equal('matchedPoints' in out.results![0]!, false, 'matched points are never logged');
  assert.deepEqual(
    out.events.map((e) => e.level),
    ['key', 'full'],
  );
});

test('event payloads are allowlisted and errors keep their code only', () => {
  const log = new DiagnosticLog();
  log.event('playbackBlocked', { ...context, retry: () => undefined, url: 'https://secret.test' });
  log.event('error', {
    ...context,
    error: new EngineError('MEDIA_FAILED', 'media-decode-error', { isRecoverable: true }),
  });
  const [blocked, error] = log.export().events;
  assert.deepEqual(Object.keys(blocked!).sort(), [
    'sessionId',
    'targetId',
    'timestampDomain',
    'timestampUs',
    'type',
  ]);
  assert.equal(error!.code, 'MEDIA_FAILED');
  assert.equal(error!.isRecoverable, true);
  assert.equal('error' in error!, false);
});

test('presentation telemetry is reduced to bounded numbers and closed enums', () => {
  assert.deepEqual(
    sanitizePresentation({
      requestGeneration: 2,
      phase: 'failed',
      readySignal: 'nonsense',
      elapsedMs: 5e9,
      firstFrameMs: -1,
      revealElapsedMs: null,
      revealDurationMs: 420,
      isReducedMotion: true,
      failureReason: 'loading-timeout',
      url: 'x',
    }),
    {
      requestGeneration: 2,
      phase: 'failed',
      readySignal: null,
      elapsedMs: 3.6e6,
      firstFrameMs: null,
      revealElapsedMs: null,
      revealDurationMs: 420,
      isReducedMotion: true,
      failureReason: 'loading-timeout',
    },
  );
  assert.equal(
    sanitizePresentation({
      requestGeneration: 1.5,
      phase: 'loading',
      elapsedMs: 0,
      revealDurationMs: 0,
    }),
    null,
  );
});

test('capacity overflow marks the export incomplete; metadata and sections are bounded', () => {
  const log = new DiagnosticLog({ capacity: 2 });
  for (let i = 0; i < 3; i++) log.event('ready', context);
  log.setMetadata({ deviceLabel: 'x'.repeat(2000), presetId: 'p', notes: 'n' });
  log.setSection('suite', { passed: true });
  const out = log.export();
  assert.equal(out.isComplete, false);
  assert.equal(out.droppedRecords, 1);
  assert.equal((out.metadata.deviceLabel as string).length, 1024);
  assert.equal('presetId' in out.metadata, false);
  assert.deepEqual(out.sections, { suite: { passed: true } });
  assert.throws(
    () => new DiagnosticLog({ capacity: 0 }),
    (e) => e instanceof EngineError,
  );
  log.clear();
  assert.equal(log.export().events.length, 0);
});

test('targets and the engine identity come from session configuration and capability events', () => {
  const log = new DiagnosticLog();
  const target = {
    targetId: 't1',
    imageHash: 'h',
    algorithmVersion: 'a',
    compilerVersion: 'c',
    widthPx: 2,
    heightPx: 3,
  };
  log.event('sessionConfig', { ...context, config: { targets: [target] } });
  log.event('capabilityChanged', {
    ...context,
    capability: { engine: { version: '0.3.0', buildId: null, format: 'modules', variant: null } },
  });
  const out = log.export();
  assert.deepEqual(out.targets, [target]);
  assert.equal(out.engine!.version, '0.3.0');
});
