/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_TRACE_REJECTIONS,
  MAX_TRACE_TEXT,
  traceForFrame,
  traceOf,
  type RecognitionBatch,
} from '@livemira/recognition';

const facts = {
  algorithmVersion: 'm0-harris-anms-brief256-v1',
  matchingBackend: 'cpu' as const,
  scalePasses: 1,
  featureMs: 1.5,
  retrievalMs: 0.1,
  matchMs: 2,
  geometryMs: 3,
  totalMs: 7,
  featureCount: 400,
  candidateCount: 3,
  isBudgetExhausted: false,
  fineComparisons: 1000,
};
const rejection = (i: number) => ({ targetId: `t${i}`, reason: 'NO_ROBUST_MODEL' });
const batch = (overrides: Partial<RecognitionBatch> = {}): RecognitionBatch => ({
  observations: [],
  isAmbiguous: false,
  rejected: [rejection(0)],
  facts: { ...facts },
  ...overrides,
});
const frame = { sessionId: 's', frameId: 7 };

test('a trace is a bounded numeric projection of the batch', () => {
  const trace = traceOf(
    batch({
      rejected: Array.from({ length: 40 }, (_, i) => ({
        targetId: `t${i}`,
        reason: 'X'.repeat(100),
      })),
    }),
    frame,
  );
  assert.equal(trace.sessionId, 's');
  assert.equal(trace.frameId, 7);
  assert.equal(trace.rejected.length, MAX_TRACE_REJECTIONS);
  assert.ok(trace.rejected.every((r) => r.reason.length === MAX_TRACE_TEXT));
  assert.equal(trace.stageMs, undefined, 'stage times only when passes were captured');
  assert.equal(trace.passes, undefined);
  assert.equal(JSON.stringify(trace).includes('imagePoints'), false);
});

test('captured passes add stage times and per-pass records', () => {
  const pass = {
    scale: 1,
    prepareMs: 0,
    featureMs: 1,
    retrievalMs: 0,
    matchMs: 1,
    geometryMs: 1,
    totalMs: 3,
    featureCount: 400,
    candidateCount: 3,
    observationCount: 0,
    isAmbiguous: false,
    isBudgetExhausted: false,
    rejected: [rejection(1)],
  };
  const trace = traceOf(
    batch({
      facts: {
        ...facts,
        scalePasses: 2,
        passes: [pass, { ...pass, scale: Math.SQRT1_2, prepareMs: 0.4 }],
      },
    }),
    frame,
  );
  assert.deepEqual(trace.stageMs, {
    featureMs: 1.5,
    retrievalMs: 0.1,
    matchMs: 2,
    geometryMs: 3,
    totalMs: 7,
  });
  assert.equal(trace.passes?.length, 2);
  assert.deepEqual(traceForFrame(trace, frame), trace);
});

test('traces of another frame, malformed traces and inconsistent pass counts are dropped', () => {
  const trace = traceOf(batch(), frame);
  assert.deepEqual(traceForFrame(trace, frame), trace);
  assert.equal(traceForFrame(trace, { sessionId: 's', frameId: 8 }), null);
  assert.equal(traceForFrame(trace, { sessionId: 'other', frameId: 7 }), null);
  assert.equal(traceForFrame(null, frame), null);
  assert.equal(traceForFrame({ ...trace, featureCount: -1 }, frame), null);
  assert.equal(traceForFrame({ ...trace, rejected: [{ targetId: 't', reason: '' }] }, frame), null);
  assert.equal(traceForFrame({ ...trace, stageMs: { featureMs: NaN } }, frame), null);
  assert.equal(traceForFrame({ ...trace, passes: [] }, frame), null);
  const extra = traceForFrame({ ...trace, imagePoints: [[1, 2]] }, frame);
  assert.ok(extra && !('imagePoints' in extra), 'unknown fields are dropped');
});
