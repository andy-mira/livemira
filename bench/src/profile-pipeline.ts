// SPDX-License-Identifier: Apache-2.0
// Per-stage time split of a pipeline over a sequence (host times): node bench/src/profile-pipeline.ts [pipelineId] [sequenceId]

import { quantile } from './metrics/sequence.ts';
import { pipelineById } from './pipelines.ts';
import { CAMERA, renderSequence, sceneTarget, sequences } from './scene/suites.ts';
import { frameHandle } from './sim/realtime.ts';

const entry = pipelineById(process.argv[2] ?? 'N3-F1-r30');
const spec = sequences().find((s) => s.id === (process.argv[3] ?? 'T3-shake'))!;
const pipeline = entry.create();
const target = sceneTarget('poster');
await pipeline.load([
  {
    info: { id: target.id, width: 640, height: 480, physicalWidthMeters: 0.2 },
    image: { width: 640, height: 480, stride: 640, data: target.gray },
  },
]);
const frames = renderSequence(target, spec);
pipeline.reset('profile');
const stages: Record<string, number[]> = {};
for (const f of frames) {
  const out = await pipeline.process(frameHandle('profile', f, CAMERA.width, CAMERA.height, 0));
  for (const [k, v] of Object.entries(out.timings)) (stages[k] ??= []).push(v / 1000);
}
for (const [k, v] of Object.entries(stages)) {
  const nonzero = v.filter((x) => x > 0.01);
  console.log(
    `${k.padEnd(9)} p50=${quantile(v, 0.5)!.toFixed(2)}ms p95=${quantile(v, 0.95)!.toFixed(2)}ms max=${Math.max(...v).toFixed(2)}ms frames>0=${nonzero.length}/${v.length}`,
  );
}
