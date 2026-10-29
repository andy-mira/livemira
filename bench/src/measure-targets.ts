// SPDX-License-Identifier: Apache-2.0
// How hard target pictures really are, to calibrate the target rating against (rate-targets.ts --measured): each
// picture in the bench's scene, single frames at hard values of each factor (S1, the engine's detector) and hand-held
// sequences (S2, the Swift pipeline). Prints the recall under hard conditions, the frames tracked correctly, and their
// mean, `measured`.
//   node bench/src/measure-targets.ts <picture> … [--json <file>]

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import { cornersOf, type TargetImage } from '@livemira-next/contracts';
import { OrbDetector } from '@livemira-next/features';
import { KalmanPoseFilter } from '@livemira-next/filters';
import { DualLoopPipeline, TemplateTracker } from '@livemira-next/tracking';

import { cornerError, diagonal } from './metrics/sequence.ts';
import { judge, sweepMetrics, type SweepOutcome } from './metrics/sweep.ts';
import { distanceForLongEdge } from './scene/camera.ts';
import { pictureTarget } from './scene/picture.ts';
import { NEUTRAL_LIGHT } from './scene/render.ts';
import {
  CAMERA,
  renderSequence,
  renderSweep,
  sequences,
  sweepCases,
  TARGET_GEOMETRY,
  type SceneTarget,
  type SequenceSpec,
} from './scene/suites.ts';
import { frameHandle } from './sim/realtime.ts';

/** The hard end of each S1 sweep (suites.ts SWEEPS); roll is left out: the detector is rotation-invariant. */
const HARD: Readonly<Record<string, readonly number[]>> = {
  longPx: [64, 80, 96, 128],
  tilt: [50, 60, 65, 70],
  gain: [0.15, 0.25, 0.4],
  blurPx: [8, 12, 16],
  occlusion: [0.35, 0.5, 0.65],
  noise: [6, 10],
};
const SEQUENCES = ['T3-shake', 'T6-tilt', 'T7-occlusion', 'T8-light', 'T9-blur', 'T10-exit'];

/** Hand-held at a small size (long edge 130 px of the 640 × 360 frame). */
const small: SequenceSpec = {
  id: 'small-hand',
  title: '小尺寸手持',
  durationS: 5,
  stateAt: (t) => ({
    pose: {
      distanceM: distanceForLongEdge(CAMERA, TARGET_GEOMETRY, 130),
      pitchDeg: 15 + 4 * Math.sin(2 * Math.PI * 0.5 * t),
      yawDeg: -8,
      rollDeg: 3 + 3 * Math.sin(2 * Math.PI * 0.6 * t),
      offsetXPx: 50 * Math.sin(2 * Math.PI * 0.35 * t) + 4 * Math.sin(2 * Math.PI * 2.3 * t),
      offsetYPx: 25 * Math.sin(2 * Math.PI * 0.27 * t),
    },
    light: NEUTRAL_LIGHT,
    occluders: [],
    exposureMs: 8,
  }),
};

const assetOf = (t: SceneTarget): TargetImage => ({
  info: { id: t.id, width: TARGET_GEOMETRY.widthPx, height: TARGET_GEOMETRY.heightPx, physicalWidthMeters: 0.2 },
  image: {
    width: TARGET_GEOMETRY.widthPx,
    height: TARGET_GEOMETRY.heightPx,
    stride: TARGET_GEOMETRY.widthPx,
    data: t.gray,
  },
});

async function sweep(t: SceneTarget): Promise<Record<string, number>> {
  const detector = new OrbDetector();
  await detector.load([assetOf(t)]);
  const outcomes: SweepOutcome[] = [];
  for (const c of sweepCases(2)) {
    if (!HARD[c.factor]?.includes(c.value)) continue;
    const f = renderSweep(t, c);
    const poses = await detector.detect(frameHandle('m', f, CAMERA.width, CAMERA.height, 0));
    outcomes.push(judge(c, f, poses, 0, { width: TARGET_GEOMETRY.widthPx, height: TARGET_GEOMETRY.heightPx }));
  }
  const { recall } = sweepMetrics(outcomes);
  return Object.fromEntries(
    Object.keys(HARD).map((factor) => {
      const values = Object.values(recall[factor] ?? {});
      return [factor, values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)];
    }),
  );
}

/** Share of the frames after the first 0.3 s with half the picture in view whose pose is within 2% of its diagonal. */
async function survival(t: SceneTarget, spec: SequenceSpec): Promise<number> {
  const pipeline = new DualLoopPipeline(
    {
      id: 'swift',
      detector: new OrbDetector(),
      tracker: new TemplateTracker({ mode: 'esm' }),
      filter: (targets) => new KalmanPoseFilter(targets),
    },
    { relocalizeEvery: 60, asyncRelocalization: true },
  );
  await pipeline.load([assetOf(t)]);
  pipeline.reset('m');
  let shown = 0;
  let correct = 0;
  for (const f of renderSequence(t, spec)) {
    const out = await pipeline.process(frameHandle('m', { ...f, index: f.index + 1 }, CAMERA.width, CAMERA.height, 0));
    if (f.timeUs < 300_000 || !f.H || f.visible < 0.5) continue;
    const truth = cornersOf(f.H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
    const pose = out.display[0];
    shown++;
    if (pose && cornerError(pose.corners, truth) / diagonal(truth) < 0.02) correct++;
  }
  pipeline.dispose();
  return shown ? correct / shown : 0;
}

export interface Measured {
  readonly name: string;
  readonly recall: Record<string, number>;
  readonly tracking: Record<string, number>;
  /** Mean hard recall, mean tracking, and their mean. */
  readonly s1: number;
  readonly s2: number;
  readonly measured: number;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const files = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--json');
const specs = [...sequences().filter((s) => SEQUENCES.includes(s.id)), small];
const results: Measured[] = [];
for (const file of files) {
  const t = pictureTarget(file, basename(file).replace(/\.[^.]+$/, ''));
  const recall = await sweep(t);
  const tracking: Record<string, number> = {};
  for (const spec of specs) tracking[spec.id] = await survival(t, spec);
  const s1 = mean(Object.values(recall));
  const s2 = mean(Object.values(tracking));
  results.push({ name: basename(file), recall, tracking, s1, s2, measured: (s1 + s2) / 2 });
  const p = (x: number): string => String(Math.round(100 * x)).padStart(3);
  console.log(
    [
      basename(file).padEnd(22),
      `实测 ${p((s1 + s2) / 2)}`,
      `检测 ${p(s1)} [${Object.values(recall).map(p).join(' ')}]`,
      `跟踪 ${p(s2)} [${Object.values(tracking).map(p).join(' ')}]`,
    ].join(' | '),
  );
}
const json = process.argv.indexOf('--json');
if (json > 0) writeFileSync(process.argv[json + 1]!, JSON.stringify(results, null, 2));
