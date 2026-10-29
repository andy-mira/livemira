// SPDX-License-Identifier: Apache-2.0
// S1-only sweep of C1 detector settings (detect + ESM refinement, as the live path), for quick tuning.
//   node bench/src/tune-detector.ts

import { readFileSync } from 'node:fs';

import { OrbDetector, type OrbDetectorOptions } from '@livemira-next/features';
import { DualLoopPipeline, TemplateTracker } from '@livemira-next/tracking';

import { judge, sweepMetrics } from './metrics/sweep.ts';
import { CAMERA, TARGET_GEOMETRY, renderSweep, sceneTarget, sweepCases } from './scene/suites.ts';
import { frameHandle } from './sim/realtime.ts';

const variants: Record<string, OrbDetectorOptions> = {
  default: {},
  ratio085: { ratio: 0.85, maxDistance: 80, thresholdPx: 3 },
  thr3: { thresholdPx: 3 },
  budget1000: { orb: { budget: 1000, cell: 20 } },
  ratio09: { ratio: 0.9, maxDistance: 90 },
  tilts3: { compile: { tilts: [1.4, 2, 2.8], longitudes: [0, 30, 60, 90, 120, 150] } },
  blur2: { compile: { blurs: [2] } },
  blur24: { compile: { blurs: [2, 4] } },
  tilts3blur: { compile: { tilts: [1.4, 2, 2.8], longitudes: [0, 45, 90, 135], blurs: [2.5] } },
  tilt28: { compile: { tilts: [1.5, 2.2, 2.9] } },
  tilt28blur: { compile: { tilts: [1.5, 2.2, 2.9], blurs: [2.5] } },
  combo: {
    orb: { budget: 1000, cell: 20 },
    ratio: 0.9,
    maxDistance: 90,
    compile: { tilts: [1.4, 2, 2.8], longitudes: [0, 30, 60, 90, 120, 150] },
  },
};

// PATTERN=<pattern.json> applies a BRIEF pattern (frame and target side) to every variant.
const pattern = process.env.PATTERN
  ? Int8Array.from(JSON.parse(readFileSync(process.env.PATTERN, 'utf8')).pattern as number[])
  : undefined;
const withPattern = (o: OrbDetectorOptions): OrbDetectorOptions =>
  pattern
    ? { ...o, orb: { ...o.orb, pattern }, compile: { ...o.compile, orb: { ...o.compile?.orb, ...o.orb, pattern } } }
    : o;
const only = process.argv[2]?.split(',');
const kinds = ['poster', 'photo'] as const;
const frames = kinds.flatMap((kind) =>
  sweepCases(Number(process.env.VARIANTS ?? 2)).map((c) => ({ c, f: renderSweep(sceneTarget(kind), c) })),
);
const targets = [...kinds, 'graphic' as const].map((k) => sceneTarget(k));
for (const [name, options] of Object.entries(variants)) {
  if (only && !only.includes(name)) continue;
  const pipeline = new DualLoopPipeline({
    id: name,
    detector: new OrbDetector(withPattern(options)),
    tracker: new TemplateTracker({ mode: 'esm' }),
  });
  await pipeline.load(
    targets.map((t) => ({
      info: { id: t.id, width: 640, height: 480, physicalWidthMeters: 0.2 },
      image: { width: 640, height: 480, stride: 640, data: t.gray },
    })),
  );
  const outcomes = [];
  let total = 0;
  for (const { c, f } of frames) {
    const started = performance.now();
    const poses = await pipeline.detect(frameHandle('s1', f, CAMERA.width, CAMERA.height, 0));
    const us = (performance.now() - started) * 1000;
    total += us;
    outcomes.push(judge(c, f, poses, us, { width: TARGET_GEOMETRY.widthPx, height: TARGET_GEOMETRY.heightPx }));
  }
  const m = sweepMetrics(outcomes);
  console.log(
    `${name.padEnd(11)} roll=${m.rollCoverageDeg} minLong=${m.minLongPx} tilt=${m.maxTiltDeg} gain=${m.minGain} blur=${m.maxBlurPx} occ=${m.maxOcclusion} fp=${m.falsePerThousand.toFixed(1)} ms=${(total / frames.length / 1000).toFixed(1)}`,
  );
  console.log(
    `            longPx ${JSON.stringify(m.recall.longPx)} tilt ${JSON.stringify(m.recall.tilt)} blur ${JSON.stringify(m.recall.blurPx)}`,
  );
}
