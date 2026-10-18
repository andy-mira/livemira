/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The presentation of losses on a virtual clock: the absolute hide time of a measurement, motion-adaptive hold and
// reconfirmation after a hide.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { Corners, TrackingResult, TrackingState } from '@livemira/contracts';

import { captureTargetFrame, LossContextTracker } from '../src/engine/loss-context.ts';
import { PresentationPolicy, type PresentationModes } from '../src/engine/presentation-policy.ts';
import { makeFrame, portraitGeometry } from './core-harness.ts';

/** A 100 × 100 px square target (diagonal about 141 px) whose left edge is at `x`. */
const square = (x: number): Corners => [
  [x, 100],
  [x + 100, 100],
  [x + 100, 200],
  [x, 200],
];

function result(
  frameId: number,
  timeMs: number,
  state: TrackingState,
  corners: Corners | null,
): TrackingResult {
  const isMeasured = state === 'TRACKING' && corners !== null;
  const hasPose = (state === 'TRACKING' || state === 'LIMITED') && corners !== null;
  return {
    sessionId: 's',
    frameId,
    observationTimeUs: timeMs * 1000,
    state,
    reason: isMeasured ? 'original-target-measured' : 'no-valid-original-match',
    targetId: hasPose ? 't' : null,
    H_imageFromTarget: hasPose ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : null,
    cornersPx: hasPose ? corners : null,
    quality: {
      inlierCount: 20,
      inlierRatio: 0.9,
      reprojectionErrorPx: 1,
      spatialCoverage: 0.5,
      isDegenerate: false,
      isMeasured,
    },
    prediction: {
      ageUs: 0,
      lastMeasuredTimeUs: timeMs * 1000,
      expiresAtUs: timeMs * 1000 + 100_000,
    },
  };
}

function setup(t: TestContext, modes: PresentationModes = {}, graceMs = 200) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let nowUs = 0;
  const log: string[] = [];
  const holds: number[] = [];
  let isVisible = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const policy = new PresentationPolicy(
    {
      overlay: {
        start: async () => {},
        update: async () => {
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = null;
          isVisible = true;
        },
        hide: () => {
          if (holdTimer) clearTimeout(holdTimer);
          holdTimer = null;
          if (isVisible) log.push(`hidden@${nowUs / 1000}`);
          isVisible = false;
        },
        holdAfterLoss: (ms) => {
          if (!isVisible) return false;
          if (holdTimer) return true;
          holds.push(ms);
          holdTimer = setTimeout(() => {
            holdTimer = null;
            isVisible = false;
            log.push(`hidden@${nowUs / 1000}`);
          }, ms);
          return true;
        },
        stop: async () => {},
        dispose: async () => {},
      },
      clock: () => nowUs,
      losses: new LossContextTracker(),
      sessionId: 's',
      isRunning: true,
      isAborted: false,
      stopGeneration: 0,
      transitionEpoch: 0,
      sourceNowUs: () => nowUs,
      context: (targetId) =>
        ({
          sessionId: 's',
          targetId: targetId ?? null,
          timestampUs: nowUs,
          timestampDomain: 'source-session',
        }) as never,
      emit: (name, event) => {
        if (name === 'targetFound') log.push(`found@${nowUs / 1000}`);
        if (name === 'targetLost')
          log.push(`lost@${nowUs / 1000}:${(event as { reason: string }).reason}`);
      },
    },
    { maxPredictionMs: 100, lossDisplayGraceMs: graceMs },
    modes,
  );
  const present = async (r: TrackingResult): Promise<void> => {
    const frame = makeFrame('s', r.frameId);
    await policy.present(r, portraitGeometry(), nowUs, captureTargetFrame(frame, r), () => {});
  };
  /** Advances the clock 1 ms at a time (timers run on time), then presents a result observed and received then. */
  const at = async (timeMs: number, r?: TrackingResult): Promise<void> => {
    while (nowUs < timeMs * 1000) {
      nowUs += 1000;
      t.mock.timers.tick(1);
    }
    if (r) await present(r);
  };
  /** A busy main thread: the clock jumps, and timers that were due meanwhile run only now, late. */
  const busyUntil = async (timeMs: number, r?: TrackingResult): Promise<void> => {
    const stepMs = timeMs - nowUs / 1000;
    nowUs = timeMs * 1000;
    t.mock.timers.tick(stepMs);
    if (r) await present(r);
  };
  return {
    policy,
    log,
    holds,
    at,
    busyUntil,
    get isVisible() {
      return isVisible;
    },
  };
}

test('a timer that fires late hides at once instead of starting a full grace', async (t) => {
  const p = setup(t);
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  // The main thread is busy: the 100 ms expiry runs only at 500 ms.
  await p.busyUntil(500);
  assert.deepEqual(p.holds, [], 'nothing of the measurement is left after 300 ms');
  assert.deepEqual(p.log, ['found@0', 'hidden@500', 'lost@500:prediction-expired']);
});

test('a loss only uses what is left of the last measurement: the hold ends 300 ms after it', async (t) => {
  const p = setup(t);
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  // On time at 100 ms: held for the grace; a later loss notice neither re-times nor extends it.
  await p.at(133, result(2, 133, 'LOST', null));
  assert.deepEqual(p.holds, [200]);
  await p.at(400);
  assert.deepEqual(p.log, ['found@0', 'lost@100:prediction-expired', 'hidden@300']);
  t.mock.timers.reset();
  // A loss notice before the expiry holds only until 300 ms too.
  const early = setup(t);
  await early.at(0, result(1, 0, 'TRACKING', square(100)));
  await early.at(50, result(2, 50, 'SEARCHING', null));
  assert.deepEqual(early.holds, [200], 'grace from 50 ms ends at 250 ms, before 300 ms');
});

test('motion-adaptive: a fast target is hidden at the first frame without a new measurement', async (t) => {
  const p = setup(t, { isMotionAdaptive: true });
  // 10 px per 33 ms on a 141 px diagonal: about 2 diagonals per second.
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(33, result(2, 33, 'TRACKING', square(110)));
  await p.at(66, result(3, 66, 'TRACKING', square(120)));
  assert.equal(p.policy.motionMode, 'fast');
  await p.at(99, result(4, 99, 'LIMITED', square(120)));
  assert.equal(p.isVisible, false);
  assert.deepEqual(p.holds, []);
  assert.deepEqual(p.log, ['found@0', 'hidden@99', 'lost@99:no-valid-original-match']);
});

test('motion-adaptive: a still target keeps the prediction and the grace; a slow one only as long as it could not have moved far', async (t) => {
  const still = setup(t, { isMotionAdaptive: true });
  await still.at(0, result(1, 0, 'TRACKING', square(100)));
  await still.at(33, result(2, 33, 'TRACKING', square(100)));
  await still.at(66, result(3, 66, 'TRACKING', square(100)));
  assert.equal(still.policy.motionMode, 'slow');
  await still.at(99, result(4, 99, 'LIMITED', square(100)));
  assert.equal(still.isVisible, true, 'the prediction is shown');
  await still.at(166);
  assert.deepEqual(still.holds, [200], 'expiry at 166 ms, held until 366 ms');
  t.mock.timers.reset();

  const slow = setup(t, { isMotionAdaptive: true });
  // 1 px per 33 ms: about 0.21 diagonals per second, so 0.05 diagonals take about 233 ms.
  await slow.at(0, result(1, 0, 'TRACKING', square(100)));
  await slow.at(33, result(2, 33, 'TRACKING', square(101)));
  await slow.at(66, result(3, 66, 'TRACKING', square(102)));
  assert.equal(slow.policy.motionMode, 'slow');
  await slow.at(166);
  assert.equal(slow.holds.length, 1);
  assert.ok(Math.abs(slow.holds[0]! - 133) < 2, `held ${slow.holds[0]} ms, until about 299 ms`);
});

test('motion-adaptive: with a single measurement the motion is unknown, so only the prediction is shown', async (t) => {
  const p = setup(t, { isMotionAdaptive: true });
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  assert.equal(p.policy.motionMode, 'unknown');
  await p.at(100);
  assert.deepEqual(p.holds, []);
  assert.deepEqual(p.log, ['found@0', 'hidden@100', 'lost@100:prediction-expired']);
});

test('motion-adaptive: a target of unknown motion may be held for the unknown-motion hold', async (t) => {
  const p = setup(t, { isMotionAdaptive: true, unknownMotionHoldMs: 100 });
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(250);
  assert.deepEqual(p.holds, [100]);
  assert.deepEqual(p.log, ['found@0', 'lost@100:prediction-expired', 'hidden@200']);
});

test('a fresh measurement of a fast target is always shown', async (t) => {
  const p = setup(t, { isMotionAdaptive: true });
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(33, result(2, 33, 'TRACKING', square(110)));
  await p.at(66, result(3, 66, 'TRACKING', square(120)));
  await p.at(99, result(4, 99, 'TRACKING', square(130)));
  assert.equal(p.isVisible, true);
  assert.deepEqual(p.log, ['found@0']);
});

test('reconfirmation: after a hide, a target shows again after three measurements over 50 ms, or at once when the tracker confirmed it', async (t) => {
  const p = setup(t, { isReconfirmAfterHide: true }, 0);
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(100);
  assert.deepEqual(p.log, ['found@0', 'hidden@100', 'lost@100:prediction-expired']);
  await p.at(200, result(2, 200, 'TRACKING', square(100)));
  await p.at(233, result(3, 233, 'TRACKING', square(100)));
  assert.equal(p.isVisible, false, 'two measurements are not enough');
  await p.at(266, result(4, 266, 'TRACKING', square(100)));
  assert.equal(p.isVisible, true);
  await p.at(366);
  assert.equal(p.isVisible, false);
  // The tracker went through ACQUIRING itself: no second confirmation.
  await p.at(400, result(5, 400, 'ACQUIRING', null));
  await p.at(433, result(6, 433, 'TRACKING', square(100)));
  assert.equal(p.isVisible, true);
  // Without reconfirmation a single measurement shows the overlay again.
  t.mock.timers.reset();
  const plain = setup(t, {}, 0);
  await plain.at(0, result(1, 0, 'TRACKING', square(100)));
  await plain.at(100);
  await plain.at(200, result(2, 200, 'TRACKING', square(100)));
  assert.equal(plain.isVisible, true);
});

test('a recovery during a hold ends it: a later loss holds anew and needs no reconfirmation', async (t) => {
  const p = setup(t, { isReconfirmAfterHide: true });
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(100);
  // Held from 100 ms; recovered at 150 ms.
  await p.at(150, result(2, 150, 'TRACKING', square(100)));
  assert.equal(p.isVisible, true);
  // Lost again at 250 ms (expiry), held until 450 ms; a fresh measurement at 310 ms recovers at once.
  await p.at(310, result(3, 310, 'TRACKING', square(100)));
  assert.equal(p.isVisible, true);
  assert.deepEqual(p.holds, [200, 200]);
});

test('reconfirmation counts only fresh measurements in a row, at most 100 ms apart', async (t) => {
  const p = setup(t, { isReconfirmAfterHide: true }, 0);
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(100);
  // Sparse measurements do not confirm.
  await p.at(200, result(2, 200, 'TRACKING', square(100)));
  await p.at(500, result(3, 500, 'TRACKING', square(100)));
  await p.at(800, result(4, 800, 'TRACKING', square(100)));
  assert.equal(p.isVisible, false);
  // Measurements that were already stale on arrival (observed 150 ms earlier) do not count either.
  await p.at(1000, result(5, 850, 'TRACKING', square(100)));
  await p.at(1033, result(6, 883, 'TRACKING', square(100)));
  assert.equal(p.isVisible, false);
  await p.at(1066, result(7, 1066, 'TRACKING', square(100)));
  await p.at(1099, result(8, 1099, 'TRACKING', square(100)));
  assert.equal(p.isVisible, false, 'two fresh ones after the stale pair');
  await p.at(1132, result(9, 1132, 'TRACKING', square(100)));
  assert.equal(p.isVisible, true);
});

test('motion belongs to its target: a new target is not judged by the previous one', async (t) => {
  const p = setup(t, { isMotionAdaptive: true, unknownMotionHoldMs: 100 });
  await p.at(0, result(1, 0, 'TRACKING', square(100)));
  await p.at(33, result(2, 33, 'TRACKING', square(110)));
  await p.at(66, result(3, 66, 'TRACKING', square(120)));
  assert.equal(p.policy.motionMode, 'fast');
  await p.at(99, result(4, 99, 'LIMITED', square(120)));
  // Another target (here the same id after a hard hide) starts with unknown motion.
  await p.at(200, result(5, 200, 'TRACKING', square(300)));
  assert.equal(p.policy.motionMode, 'unknown');
});
