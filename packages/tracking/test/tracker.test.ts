/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EngineError,
  type Point2,
  type TargetBundle,
  type TrackingResult,
} from '@livemira/contracts';
import type { RecognitionObservation } from '@livemira/recognition';
import { Tracker, type GrayFrame, type RecognizeFrame } from '@livemira/tracking';

const target: TargetBundle = {
  schemaVersion: 1,
  compilerVersion: 'test',
  algorithmVersion: 'test',
  targetId: 'a',
  imageHash: '0'.repeat(64),
  widthPx: 400,
  heightPx: 300,
  physicalWidthMeters: null,
  orientation: 'top-left',
  pyramid: [],
  features: { points: [], descriptorType: 'test', descriptorLength: 1, descriptors: [] },
  preprocessing: {},
  diagnostics: [],
};
const points: Point2[] = [
  [10, 10],
  [200, 10],
  [390, 10],
  [390, 150],
  [390, 290],
  [200, 290],
  [10, 290],
  [10, 150],
];
const H = [1, 0, 40, 0, 1, 20, 0, 0, 1] as const;

function observation(
  frame: GrayFrame,
  extra: Partial<RecognitionObservation> = {},
): RecognitionObservation {
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    targetId: 'a',
    algorithmVersion: 'test',
    H_imageFromTarget: H,
    targetPoints: points,
    imagePoints: points.map(([x, y]) => [x + 40, y + 20]),
    inliers: points.map(() => true),
    reprojectionErrorPx: 0,
    spatialCoverage: 1,
    ...extra,
  };
}

const image = { widthPx: 640, heightPx: 480, data: new Uint8Array(640 * 480) };
function frame(
  id: number,
  time: number | null = (id - 1) * 30000,
  extra: Partial<GrayFrame> = {},
): GrayFrame {
  return {
    sessionId: 's',
    frameId: id,
    pictureKey: `image-${id}`,
    observationTimeUs: time,
    image,
    ...extra,
  };
}
const signal = (): AbortSignal => new AbortController().signal;
const hasCode = (code: string) => (error: unknown) =>
  error instanceof EngineError && error.code === code;

async function setup(
  recognize: RecognizeFrame = async (f) => [observation(f)],
  options = {},
): Promise<Tracker> {
  const tracker = new Tracker({ recognize, ...options });
  await tracker.loadTargets([target]);
  await tracker.reset('s');
  return tracker;
}
async function acquire(tracker: Tracker): Promise<TrackingResult> {
  await tracker.process(frame(1), signal());
  await tracker.process(frame(2), signal());
  return tracker.process(frame(3), signal());
}

test('three observations acquire a target with edge corners and recomputed quality', async () => {
  const p = await setup();
  assert.equal((await p.process(frame(1), signal())).state, 'ACQUIRING');
  assert.equal((await p.process(frame(2), signal())).reason, 'confirming-original-match');
  const r = await p.process(frame(3), signal());
  assert.equal(r.state, 'TRACKING');
  assert.equal(r.reason, 'original-target-measured');
  assert.deepEqual(r.cornersPx, [
    [40, 20],
    [440, 20],
    [440, 320],
    [40, 320],
  ]);
  assert.ok(Math.abs(r.quality.spatialCoverage - (380 * 280) / 120000) < 1e-10);
  assert.deepEqual(r.prediction, { ageUs: 0, lastMeasuredTimeUs: 60000, expiresAtUs: 160000 });
  await p.dispose();
});

test('repeated pictures skip recognition and do not renew the measurement; expiry is exact', async () => {
  let calls = 0;
  const p = await setup(async (f) => {
    calls++;
    return [observation(f)];
  });
  await acquire(p);
  const r = await p.process(frame(4, 90000, { pictureKey: 'image-1' }), signal());
  assert.equal(r.state, 'LIMITED');
  assert.equal(r.reason, 'duplicate-image');
  assert.equal(r.quality.isMeasured, false);
  assert.equal(r.prediction.ageUs, 30000);
  assert.equal(calls, 3);
  const lost = await p.process(frame(5, 160000, { pictureKey: 'image-3' }), signal());
  assert.equal(lost.state, 'LOST');
  assert.equal(lost.reason, 'prediction-expired');
  assert.equal((await p.process(frame(6, 190000), signal())).state, 'ACQUIRING');
  await p.dispose();
});

test('a fresh valid match after a gap is measured', async () => {
  const p = await setup();
  await acquire(p);
  const r = await p.process(frame(4, 200000), signal());
  assert.equal(r.state, 'TRACKING');
  assert.equal(r.quality.isMeasured, true);
  assert.deepEqual(r.prediction, { ageUs: 0, lastMeasuredTimeUs: 200000, expiresAtUs: 300000 });
  await p.dispose();
});

test('claimed perfect quality cannot bypass recomputed reprojection, coverage, horizon, algorithm or frame identity', async () => {
  for (const extra of [
    { imagePoints: points.map(([x, y]): Point2 => [x + 60, y + 20]) },
    {
      targetPoints: points.map((_, i): Point2 => [i * 10, 20]),
      imagePoints: points.map((_, i): Point2 => [i * 10 + 40, 40]),
    },
    { H_imageFromTarget: [1, 0, 0, 0, 1, 0, -0.005, 0, 1] as const },
    { algorithmVersion: 'other' },
    { frameId: 999 },
  ]) {
    const p = await setup(async (f) => [observation(f, extra)]);
    assert.equal((await acquire(p)).state, 'SEARCHING', JSON.stringify(Object.keys(extra)));
    await p.dispose();
  }
});

test('a missing or backwards clock, an old session and an old frame are rejected without changing state', async () => {
  const p = await setup();
  await acquire(p);
  for (const f of [
    frame(4, null),
    frame(4, 90000, { sessionId: 'old' }),
    frame(3, 90000),
    frame(4, 59000),
    frame(4, 90000, { pictureKey: '' }),
  ]) {
    await assert.rejects(p.process(f, signal()), hasCode('FRAME_FAILED'));
  }
  assert.equal((await p.process(frame(4), signal())).state, 'TRACKING');
  await p.dispose();
});

test('abort waits for the borrowed recognition work and prevents state mutation', async () => {
  let release = (): void => {};
  const p = await setup(async (f) => {
    await new Promise<void>((r) => (release = r));
    return [observation(f)];
  });
  const c = new AbortController();
  const work = p.process(frame(1), c.signal);
  c.abort();
  let settled = false;
  const rejected = assert.rejects(work, hasCode('ABORTED')).then(() => (settled = true));
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await rejected;
  await p.dispose();
});

test('reset cancels the old job, waits for it, and accepts only the new session', async () => {
  let release = (): void => {};
  let delay = true;
  const p = await setup(async (f) => {
    if (delay) await new Promise<void>((r) => (release = r));
    return [observation(f)];
  });
  const old = p.process(frame(1), signal());
  const rejected = assert.rejects(old, hasCode('ABORTED'));
  const reset = p.reset('new');
  release();
  await reset;
  await rejected;
  delay = false;
  await assert.rejects(p.process(frame(2), signal()), hasCode('FRAME_FAILED'));
  assert.equal((await p.process(frame(1, 0, { sessionId: 'new' }), signal())).state, 'ACQUIRING');
  await p.dispose();
});

test('one frame at a time; dispose waits for the frame in progress', async () => {
  let release = (): void => {};
  const p = await setup(async (f) => {
    await new Promise<void>((r) => (release = r));
    return [observation(f)];
  });
  const first = p.process(frame(1), signal());
  const rejected = assert.rejects(first, hasCode('ABORTED'));
  await assert.rejects(p.process(frame(2), signal()), hasCode('INVALID_CONFIG'));
  let done = false;
  const disposed = p.dispose().then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await disposed;
  await rejected;
  assert.throws(() => p.process(frame(3), signal()), hasCode('DISPOSED'));
});

test('mutating a returned result cannot alter the held measurement', async () => {
  const p = await setup();
  const r = await acquire(p);
  (r.H_imageFromTarget as unknown as number[])[2] = 999;
  const held = await p.process(frame(4, 90000, { pictureKey: 'image-3' }), signal());
  assert.equal(held.H_imageFromTarget![2], 40);
  await p.dispose();
});

test('slow but increasing observation gaps confirm without extending the prediction lifetime', async () => {
  const p = await setup();
  assert.equal((await p.process(frame(1, 0), signal())).state, 'ACQUIRING');
  assert.equal((await p.process(frame(2, 200000), signal())).state, 'ACQUIRING');
  const r = await p.process(frame(3, 700000), signal());
  assert.equal(r.state, 'TRACKING');
  assert.equal(r.observationTimeUs, 700000);
  assert.equal(r.prediction.expiresAtUs, 800000);
  await p.dispose();
});

test('the acquisition bound, bad observations and recognition errors break confirmation', async () => {
  let bad = false;
  let fail = false;
  const p = await setup(async (f) => {
    if (fail) throw new Error('recognizer failed');
    return bad ? [] : [observation(f)];
  });
  await p.process(frame(1, 0), signal());
  await p.process(frame(2, 200000), signal());
  assert.equal((await p.process(frame(3, 1200001), signal())).state, 'ACQUIRING');
  bad = true;
  assert.equal((await p.process(frame(4, 1400000), signal())).state, 'SEARCHING');
  bad = false;
  await p.process(frame(5, 1600000), signal());
  fail = true;
  await assert.rejects(p.process(frame(6, 1800000), signal()));
  fail = false;
  assert.equal((await p.process(frame(7, 2000000), signal())).state, 'ACQUIRING');
  assert.equal((await p.process(frame(8, 2200000), signal())).state, 'ACQUIRING');
  assert.equal((await p.process(frame(9, 2400000), signal())).state, 'TRACKING');
  await p.dispose();
});

test('the acquisition gap is configurable within bounds', async () => {
  for (const value of [0, 124999, 2000001, Infinity, NaN]) {
    assert.throws(
      () => new Tracker({ recognize: async () => [], maxObservationGapUs: value }),
      hasCode('INVALID_CONFIG'),
    );
  }
  const p = await setup(async (f) => [observation(f)], { maxObservationGapUs: 1500000 });
  await p.process(frame(1, 0), signal());
  await p.process(frame(2, 1200000), signal());
  assert.equal((await p.process(frame(3, 2500000), signal())).state, 'TRACKING');
  await p.dispose();
});

test('a tracked target cannot jump to another one; recovery needs a new acquisition after loss', async () => {
  const other = { ...target, targetId: 'b' };
  let id = 'a';
  const p = new Tracker({ recognize: async (f) => [observation(f, { targetId: id })] });
  await p.loadTargets([target, other]);
  await p.reset('s');
  assert.equal((await acquire(p)).targetId, 'a');
  id = 'b';
  const held = await p.process(frame(4, 90000), signal());
  assert.equal(held.state, 'LIMITED');
  assert.equal(held.targetId, 'a');
  assert.equal((await p.process(frame(5, 160000), signal())).state, 'LOST');
  assert.equal((await p.process(frame(6, 190000), signal())).state, 'ACQUIRING');
  await p.dispose();
});

test('matched points: absent by default; when collected, only on measured results and exactly the inlier image points', async () => {
  const off = await setup();
  for (const r of [
    await acquire(off),
    await off.process(frame(4, 90000, { pictureKey: 'image-3' }), signal()),
  ]) {
    assert.equal('matchedPoints' in r, false);
  }
  await off.dispose();
  // Eight inliers plus one outlier correspondence that must not be reported.
  const withOutlier: Partial<RecognitionObservation> = {
    targetPoints: [...points, [200, 150]],
    imagePoints: [...points.map(([x, y]): Point2 => [x + 40, y + 20]), [999, 999]],
    inliers: [...points.map(() => true), false],
  };
  const on = await setup(async (f) => [observation(f, withOutlier)], {
    collectMatchedPoints: true,
  });
  const states: TrackingResult[] = [];
  for (const [id, time, key] of [
    [1, 0],
    [2, 30000],
    [3, 60000],
    [4, 90000, 'image-3'],
    [5, 170000, 'image-3'],
  ] as const) {
    states.push(await on.process(frame(id, time, key ? { pictureKey: key } : {}), signal()));
  }
  assert.deepEqual(
    states.map((r) => r.state),
    ['ACQUIRING', 'ACQUIRING', 'TRACKING', 'LIMITED', 'LOST'],
  );
  for (const r of states)
    if (r.state !== 'TRACKING')
      assert.equal('matchedPoints' in r, false, `${r.state} carries no points`);
  const tracked = states[2]!;
  assert.deepEqual(tracked.matchedPoints, {
    sessionId: 's',
    frameId: 3,
    targetId: 'a',
    pointsPx: points.map(([x, y]) => [x + 40, y + 20]),
  });
  assert.equal(tracked.matchedPoints!.pointsPx.length, tracked.quality.inlierCount);
  assert.throws(
    () =>
      new Tracker({ recognize: async () => [], collectMatchedPoints: 'yes' as unknown as boolean }),
    hasCode('INVALID_CONFIG'),
  );
  await on.dispose();
});

test('targets are validated on load and cannot be replaced during processing', async () => {
  const p = new Tracker({ recognize: async (f) => [observation(f)] });
  await assert.rejects(p.loadTargets([]), hasCode('INVALID_TARGET'));
  await assert.rejects(p.loadTargets([target, target]), hasCode('INVALID_TARGET'));
  await assert.rejects(
    p.loadTargets([{ ...target, schemaVersion: 2 as 1 }]),
    hasCode('INVALID_TARGET'),
  );
  await assert.rejects(p.reset(''), hasCode('INVALID_CONFIG'));
  await p.dispose();
});
