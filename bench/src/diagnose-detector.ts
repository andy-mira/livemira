// SPDX-License-Identifier: Apache-2.0
// Where C1 recognition fails on the S1 sweeps: per sweep value, frame keypoints on the target, how many have a model
// point at their true target position, correct nearest neighbours before and after the ratio test, and the recall of
// the detector alone vs detector + ESM refinement.
//   node bench/src/diagnose-detector.ts [factor=value,...]   e.g. longPx=128,tilt=60,blurPx=12,occlusion=0.5

import { readFileSync } from 'node:fs';

import {
  compileTarget,
  extractOrb,
  HammingMatcher,
  OrbDetector,
  type CompileOptions,
  type OrbOptions,
} from '@livemira-next/features';
import { DualLoopPipeline, TemplateTracker } from '@livemira-next/tracking';

import { judge } from './metrics/sweep.ts';
import { CAMERA, TARGET_GEOMETRY, renderSweep, sceneTarget, type SweepCase, type SweepFactor } from './scene/suites.ts';
import { frameHandle } from './sim/realtime.ts';

const wanted = (
  process.argv[2] ??
  'longPx=160,longPx=128,longPx=96,tilt=50,tilt=60,tilt=65,blurPx=8,blurPx=12,blurPx=16,occlusion=0.35,occlusion=0.5'
)
  .split(',')
  .map((s) => {
    const [f, v] = s.split('=');
    return { factor: f as SweepFactor, value: Number(v) };
  });
// PATTERN=<pattern.json from learn-pattern.ts> tries a BRIEF pattern on both sides.
const pattern = process.env.PATTERN
  ? Int8Array.from(JSON.parse(readFileSync(process.env.PATTERN, 'utf8')).pattern as number[])
  : undefined;
const orb: OrbOptions = { ...JSON.parse(process.env.ORB ?? '{}'), ...(pattern ? { pattern } : {}) };
const compile: CompileOptions = { ...JSON.parse(process.env.COMPILE ?? '{}'), orb };
const variants = Number(process.env.VARIANTS ?? 4);
const kinds = ['poster', 'photo'] as const;
const scene = [...kinds, 'graphic' as const].map((k) => sceneTarget(k));
const images = scene.map((t) => ({
  info: { id: t.id, width: 640, height: 480, physicalWidthMeters: 0.2 },
  image: { width: 640, height: 480, stride: 640, data: t.gray },
}));
const models = new Map(images.map((t) => [t.info.id, compileTarget(t, compile)]));
const matcher = HammingMatcher.create();
const detector = new OrbDetector({ compile, orb });
await detector.load(images);
const pipeline = new DualLoopPipeline({
  id: 'diag',
  detector: new OrbDetector({ compile, orb }),
  tracker: new TemplateTracker({ mode: 'esm' }),
});
await pipeline.load(images);

const size = { width: TARGET_GEOMETRY.widthPx, height: TARGET_GEOMETRY.heightPx };
console.log(
  'case           onTarget  modelHit  nnOK  ratioOK/ratioAll  det  det+esm   (Hamming distances of model hits)',
);
for (const w of wanted) {
  const sum = { on: 0, hit: 0, nn: 0, rok: 0, rall: 0, det: 0, ref: 0, n: 0 };
  const trueD: number[] = [];
  /** Wrong nearest neighbours of model hits by distance from the true position, frame px: < 6, 6–20, ≥ 20. */
  const missPx = [0, 0, 0];
  const bestD: number[] = [];
  for (const kind of kinds)
    for (let variant = 0; variant < variants; variant++) {
      const c: SweepCase = { ...w, variant };
      const target = sceneTarget(kind);
      const f = renderSweep(target, c);
      const handle = frameHandle('diag', f, CAMERA.width, CAMERA.height, 0);
      const model = models.get(target.id)!;
      const k = extractOrb(handle.image.kind === 'cpu-gray' ? handle.image.image : (null as never), {
        budget: 700,
        ...orb,
      });
      const H = f.H!;
      // Target position of each frame keypoint (inverse homography) and the frame-to-target scale there.
      const inv = invert(H);
      const nn = matcher.nearest2Grouped(k.descriptors, model.descriptors, model.descriptorPoint);
      for (let q = 0; q < k.count; q++) {
        const [tx, ty, s] = project(inv, k.x[q]!, k.y[q]!);
        if (tx < 0 || ty < 0 || tx >= 640 || ty >= 480) continue;
        sum.on++;
        // Tolerance: 3 frame px, in target px.
        const tol = 3 * s;
        let hit = false;
        for (let p = 0; p < model.points.length / 2 && !hit; p++)
          hit = Math.hypot(model.points[2 * p]! - tx, model.points[2 * p + 1]! - ty) <= tol;
        if (hit) sum.hit++;
        if (hit) {
          // Distance to the nearest descriptor of any model point within tolerance (the right answer).
          let dTrue = 257;
          for (let r = 0; r < model.descriptorPoint.length; r++) {
            const p = model.descriptorPoint[r]!;
            if (Math.hypot(model.points[2 * p]! - tx, model.points[2 * p + 1]! - ty) > tol) continue;
            dTrue = Math.min(dTrue, hammingAt(k.descriptors, q, model.descriptors, r));
          }
          trueD.push(dTrue);
          bestD.push(nn[3 * q + 1]!);
        }
        const point = model.descriptorPoint[nn[3 * q]!]!;
        const ok = Math.hypot(model.points[2 * point]! - tx, model.points[2 * point + 1]! - ty) <= tol;
        if (ok) sum.nn++;
        else if (hit) {
          const miss = Math.hypot(model.points[2 * point]! - tx, model.points[2 * point + 1]! - ty) / s;
          missPx[miss < 6 ? 0 : miss < 20 ? 1 : 2]!++;
        }
        const best = nn[3 * q + 1]!;
        const second = nn[3 * q + 2]!;
        if (best <= 80 && best < 0.85 * second) {
          sum.rall++;
          if (ok) sum.rok++;
        }
      }
      sum.det += judge(c, f, await detector.detect(handle), 0, size).correct ? 1 : 0;
      sum.ref += judge(c, f, await pipeline.detect(handle), 0, size).correct ? 1 : 0;
      sum.n++;
    }
  const avg = (v: number): string => (v / sum.n).toFixed(0).padStart(5);
  console.log(
    `${`${w.factor}=${w.value}`.padEnd(15)}${avg(sum.on)}    ${avg(sum.hit)}   ${avg(sum.nn)}   ${avg(sum.rok)}/${avg(sum.rall).trim().padEnd(5)}     ${(sum.det / sum.n).toFixed(2)}  ${(sum.ref / sum.n).toFixed(2)}   dTrue p25/50/75 ${q3(trueD)}  dBest ${q3(bestD)}  miss<6/6-20/≥20 ${missPx.map((v) => (v / sum.n).toFixed(0)).join('/')}`,
  );
}

function invert(m: Float64Array): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[];
  const A = e! * i! - f! * h!;
  const B = -(d! * i! - f! * g!);
  const C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  return Float64Array.from(
    [
      A,
      -(b! * i! - c! * h!),
      b! * f! - c! * e!,
      B,
      a! * i! - c! * g!,
      -(a! * f! - c! * d!),
      C,
      -(a! * h! - b! * g!),
      a! * e! - b! * d!,
    ].map((v) => v / det),
  );
}

/** Target position of image point (x, y) and target px per image px there. */
function project(m: Float64Array, x: number, y: number): [number, number, number] {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  const u = (m[0]! * x + m[1]! * y + m[2]!) / w;
  const v = (m[3]! * x + m[4]! * y + m[5]!) / w;
  const a = (m[0]! - u * m[6]!) / w;
  const b = (m[1]! - u * m[7]!) / w;
  const c = (m[3]! - v * m[6]!) / w;
  const d = (m[4]! - v * m[7]!) / w;
  return [u, v, Math.sqrt(Math.abs(a * d - b * c))];
}

function hammingAt(a: Uint8Array, i: number, b: Uint8Array, j: number): number {
  let d = 0;
  for (let k = 0; k < 32; k++) {
    let v = a[32 * i + k]! ^ b[32 * j + k]!;
    while (v) {
      v &= v - 1;
      d++;
    }
  }
  return d;
}

function q3(v: number[]): string {
  const s = [...v].sort((a, b) => a - b);
  const at = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  return `${at(0.25)}/${at(0.5)}/${at(0.75)}`;
}
