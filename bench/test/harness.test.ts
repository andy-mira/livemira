// SPDX-License-Identifier: Apache-2.0
// The benchmark judges every candidate, so its own pieces are tested against independent expectations.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FrameHandle, FrameOutput, PoseEstimate, VisionPipeline } from '@livemira-next/contracts';
import { cornersOf, mat3 } from '@livemira-next/contracts';

import { cornerError, sequenceMetrics, trackingMetrics } from '../src/metrics/sequence.ts';
import { distanceForLongEdge, imageFromPlane, imageFromTarget, standardCamera } from '../src/scene/camera.ts';
import { renderSweep, sceneTarget, TARGET_GEOMETRY, type GroundTruthFrame } from '../src/scene/suites.ts';
import { anchorScore, score } from '../src/score/score.ts';
import { DEFAULT_DISPLAY, simulateDisplay } from '../src/sim/display.ts';
import { runRealtime, type ProcessedFrame } from '../src/sim/realtime.ts';

test('anchor scores interpolate in both directions and clamp', () => {
  const lowerBetter = [0.03, 0.08, 0.2, 0.5, 1, 2] as const;
  assert.equal(anchorScore(0.01, lowerBetter), 10);
  assert.equal(anchorScore(0.2, lowerBetter), 6);
  assert.ok(Math.abs(anchorScore(0.14, lowerBetter) - 7) < 1e-9);
  assert.equal(anchorScore(5, lowerBetter), 0);
  const higherBetter = [180, 180, 45, 15, 5, 0] as const;
  assert.equal(anchorScore(180, higherBetter), 10);
  assert.equal(anchorScore(15, higherBetter), 4);
  assert.equal(anchorScore(0, higherBetter), 0);
});

test('unmeasured metrics fall back to the estimate in proportion to their weight', () => {
  const estimate = { D1: 5, D2: 5, D3: 5, D4: 5, D5: 5, D6: 5, D7: 5 };
  const card = score({}, estimate);
  assert.ok(Math.abs(card.total - 5) < 1e-9);
  assert.equal(card.dimensions.D6.measured, 0);
  const partial = score({ determinismPct: 100 }, estimate);
  assert.ok(partial.dimensions.D7.measured > 0.3 && partial.dimensions.D7.measured < 0.4);
  assert.ok(partial.dimensions.D7.score > 5);
});

test('cap rules bound a dimension whatever its other metrics', () => {
  const estimate = { D1: 9, D2: 5, D3: 9, D4: 5, D5: 5, D6: 5, D7: 5 };
  const clean = score({ falsePerThousand: 0, rollCoverageDeg: 180, registrationP95Pct: 0.1 }, estimate);
  assert.deepEqual(clean.caps, []);
  assert.ok(clean.dimensions.D1.score > 9);
  const capped = score({ falsePerThousand: 3, rollCoverageDeg: 180, registrationP95Pct: 9 }, estimate);
  assert.equal(capped.caps.length, 2);
  assert.equal(capped.dimensions.D1.score, 4);
  assert.equal(capped.dimensions.D3.score, 3);
  assert.ok(capped.total < clean.total - 1);
});

test('the target homography agrees with the plane projection of the target corners', () => {
  const camera = standardCamera();
  const pose = { distanceM: 0.4, pitchDeg: 30, yawDeg: -15, rollDeg: 40, offsetXPx: 25, offsetYPx: -10 };
  const H = imageFromTarget(camera, pose, TARGET_GEOMETRY);
  const P = imageFromPlane(camera, pose);
  const s = TARGET_GEOMETRY.widthM / TARGET_GEOMETRY.widthPx;
  const corners = cornersOf(H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
  const plane = [
    [-320, -240],
    [320, -240],
    [320, 240],
    [-320, 240],
  ].map(([u, v]) => {
    const X = u! * s;
    const Y = v! * s;
    const w = P[6]! * X + P[7]! * Y + P[8]!;
    return [(P[0]! * X + P[1]! * Y + P[2]!) / w, (P[3]! * X + P[4]! * Y + P[5]!) / w];
  });
  corners.forEach((c, i) => assert.ok(Math.hypot(c[0] - plane[i]![0]!, c[1] - plane[i]![1]!) < 1e-6));
  // A frontal target at the distance for a 300 px long edge is 300 px wide.
  const frontal = imageFromTarget(
    camera,
    {
      distanceM: distanceForLongEdge(camera, TARGET_GEOMETRY, 300),
      pitchDeg: 0,
      yawDeg: 0,
      rollDeg: 0,
      offsetXPx: 0,
      offsetYPx: 0,
    },
    TARGET_GEOMETRY,
  );
  const f = cornersOf(frontal, 640, 480);
  assert.ok(Math.abs(f[1][0] - f[0][0] - 300) < 1e-6);
});

test('a rendered frame shows the target where its ground truth says', () => {
  const target = sceneTarget('graphic');
  const frame = renderSweep(target, { factor: 'roll', value: 0, variant: 0 });
  const H = frame.H!;
  // Sample the rendered picture at projected target pixels: it must correlate with the target, not the table.
  let agree = 0;
  let total = 0;
  for (let v = 40; v < 480; v += 37)
    for (let u = 40; u < 640; u += 41) {
      const w = H[6]! * u + H[7]! * v + H[8]!;
      const x = Math.floor((H[0]! * u + H[1]! * v + H[2]!) / w);
      const y = Math.floor((H[3]! * u + H[4]! * v + H[5]!) / w);
      const rendered = frame.image[y * 640 + x]!;
      const expected = target.gray[Math.floor(v) * 640 + Math.floor(u)]!;
      total++;
      if (Math.abs(rendered - expected) < 40) agree++;
    }
  assert.ok(agree / total > 0.8, `agreement ${agree}/${total}`);
});

function fakeFrames(count: number): GroundTruthFrame[] {
  const H = mat3([0.5, 0, 100, 0, 0.5, 50, 0, 0, 1]);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    timeUs: Math.round((i * 1e6) / 30),
    image: new Uint8Array(4),
    targetId: 't',
    H,
    visible: 1,
  }));
}

class FixedCostPipeline implements VisionPipeline {
  readonly info = { id: 'fake', layer: 'L3', route: 'light', determinism: 'bit-exact', requires: [] } as const;
  seen: number[] = [];
  private readonly busyMs: number;
  constructor(busyMs: number) {
    this.busyMs = busyMs;
  }
  probe() {
    return { isAvailable: true };
  }
  async load() {
    return { targets: [] };
  }
  reset() {
    this.seen = [];
  }
  async process(frame: FrameHandle): Promise<FrameOutput> {
    this.seen.push(frame.frameId);
    const until = performance.now() + this.busyMs;
    while (performance.now() < until);
    const H = mat3([0.5, 0, 100, 0, 0.5, 50, 0, 0, 1]);
    const pose: PoseEstimate = {
      targetId: 't',
      frameId: frame.frameId,
      timeUs: frame.time.captureUs,
      H_imageFromTarget: H,
      corners: cornersOf(H, 640, 480),
      covariance: null,
      quality: { support: 1, ratio: 1, residual: 0, residualKind: 'px', coverage: 1 },
      origin: 'tracker',
    };
    return {
      frameId: frame.frameId,
      timeUs: frame.time.captureUs,
      state: 'TRACKING',
      poses: [pose],
      display: [pose],
      timings: {},
    };
  }
  async detect() {
    return [];
  }
  dispose() {}
}

test('real-time scheduling skips frames that arrive while the pipeline is busy', async () => {
  const frames = fakeFrames(30);
  const fast = new FixedCostPipeline(1);
  const all = await runRealtime(fast, frames, {
    tier: 'host',
    costs: { arrivalUs: 0, mainThreadUs: 0 },
    width: 2,
    height: 2,
    sessionId: 's',
  });
  assert.equal(all.length, 30);
  // 30 frames span ~1 s: a 100 ms pipeline gets about ten of them.
  const slow = new FixedCostPipeline(100);
  const some = await runRealtime(slow, frames, {
    tier: 'host',
    costs: { arrivalUs: 0, mainThreadUs: 0 },
    width: 2,
    height: 2,
    sessionId: 's',
  });
  assert.ok(some.length >= 8 && some.length <= 12, `processed ${some.length}`);
  assert.ok(some.every((p, i) => i === 0 || p.index > some[i - 1]!.index));
  assert.ok(some.every((p, i) => i === 0 || p.startUs >= some[i - 1]!.endUs));
});

test('frame-locked display shows processed frames only; async shows the native frame', () => {
  const frames = fakeFrames(30);
  const processed: ProcessedFrame[] = [0, 3, 6, 9].map((index) => ({
    index,
    startUs: frames[index]!.timeUs,
    endUs: frames[index]!.timeUs + 80_000,
    computeUs: 80_000,
    output: {
      frameId: index,
      timeUs: frames[index]!.timeUs,
      state: 'TRACKING',
      poses: [],
      display: [],
      timings: {},
    },
  }));
  const locked = simulateDisplay(frames, processed, { ...DEFAULT_DISPLAY, mode: 'frame-locked' });
  assert.ok(locked.every((s) => [0, 3, 6, 9].includes(s.background)));
  const native = simulateDisplay(frames, processed, { ...DEFAULT_DISPLAY, mode: 'async' });
  assert.ok(native.some((s) => s.background === 20));
  const m = sequenceMetrics(
    locked,
    frames.map((f) => f.timeUs),
    { nativeLatencyUs: DEFAULT_DISPLAY.nativeLatencyUs, fps: 30 },
  );
  assert.ok(m.backgroundRefresh < 0.5);
  assert.ok(m.backgroundLagMs > 50);
});

test('tracking metrics judge each processed frame against its own truth', () => {
  const truth = cornersOf(mat3([0.5, 0, 100, 0, 0.5, 50, 0, 0, 1]), 640, 480);
  const off = truth.map(([x, y]) => [x + 20, y]) as unknown as typeof truth;
  const t = Array.from({ length: 10 }, (_, i) => ({ corners: truth, visible: 1, timeUs: i * 33_333 }));
  const m = trackingMetrics(
    t,
    t.map((_, i) => ({ index: i, corners: i % 2 ? off : truth })),
  );
  assert.equal(m.survival, 0.5);
  assert.ok(cornerError(off, truth) === 20);
});
