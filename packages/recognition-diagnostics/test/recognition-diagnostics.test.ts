/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type TrackingResult } from '@livemira/contracts';
import type { ExtensionHost, RecognitionTrace } from '@livemira/engine';
import { createRecognitionDiagnostics } from '@livemira/recognition-diagnostics';

const trace = (frameId: number, extra: Partial<RecognitionTrace> = {}): RecognitionTrace => ({
  sessionId: 's1',
  frameId,
  algorithmVersion: 'm0-harris-anms-brief256-v1',
  featureCount: 400,
  candidateCount: 3,
  scalePasses: 1,
  observationCount: 0,
  isAmbiguous: false,
  isBudgetExhausted: false,
  rejected: [{ targetId: 't1', reason: 'NOT_SHORTLISTED' }],
  ...extra,
});

const measured = (frameId: number): TrackingResult => ({
  sessionId: 's1',
  frameId,
  observationTimeUs: 0,
  state: 'TRACKING',
  reason: 'original-target-measured',
  targetId: 't1',
  H_imageFromTarget: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  cornersPx: null,
  quality: {
    inlierCount: 4,
    inlierRatio: 1,
    reprojectionErrorPx: 0,
    spatialCoverage: 1,
    isDegenerate: false,
    isMeasured: true,
  },
  prediction: { ageUs: 0, lastMeasuredTimeUs: 0, expiresAtUs: 1 },
  matchedPoints: {
    sessionId: 's1',
    frameId,
    targetId: 't1',
    pointsPx: [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ],
  },
});

test('as an extension it observes traces and results from the host and uses its target sizes', () => {
  let onTrace: ((t: RecognitionTrace) => void) | null = null;
  let onResult: ((r: TrackingResult) => void) | null = null;
  const host = {
    onRecognitionTrace: (l: typeof onTrace) => ((onTrace = l), () => void (onTrace = null)),
    onResult: (l: typeof onResult) => ((onResult = l), () => void (onResult = null)),
    getTargets: () => [{ targetId: 't1', widthPx: 100, heightPx: 100 }],
  } as unknown as ExtensionHost;
  const diagnostics = createRecognitionDiagnostics({ minDispersionIntervalMs: 0 });
  assert.deepEqual(diagnostics.needs, { matchedPoints: true, recognitionTrace: true });
  const handle = diagnostics.attach(host);
  onTrace!(trace(1));
  onResult!(measured(1));
  const [session] = diagnostics.snapshot().sessions;
  assert.equal(session!.recognition.passes, 1);
  assert.deepEqual(session!.targets[0]!.rejections.byStage, { retrieval: 1 });
  assert.equal(session!.dispersion.computed, 1);
  assert.equal(session!.targets[0]!.measured.hullCoverage.mean, 1);
  handle.detach();
  assert.equal(onTrace, null);
});

test('malformed and stale input is counted, never stored', () => {
  const diagnostics = createRecognitionDiagnostics();
  diagnostics.observeRecognition(trace(1, { algorithmVersion: '' }));
  diagnostics.observeRecognition(trace(2));
  diagnostics.observeRecognition(trace(2));
  assert.deepEqual(diagnostics.snapshot().dropped, {
    stale: 1,
    malformed: 1,
    closedSession: 0,
    sessions: 0,
    targets: 0,
  });
  diagnostics.dispose();
  assert.equal(diagnostics.snapshot().isDisposed, true);
  assert.throws(
    () => createRecognitionDiagnostics({ maxSessions: 0 }),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
});
