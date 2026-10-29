// SPDX-License-Identifier: Apache-2.0
// Filter parameter sweep: the inner pipeline runs once per sequence in real time; its raw outputs are then filtered
// offline with every parameter set (filters do not change scheduling), and judged on the display timeline.
//   node bench/src/tune-filter.ts [--pipeline B0+C4] [--kinds poster]

import { cornersOf, type FrameOutput, type PoseEstimate, type TargetInfo } from '@livemira-next/contracts';
import { KalmanPoseFilter, OneEuroPoseFilter } from '@livemira-next/filters';

import { trackingMetrics, sequenceMetrics } from './metrics/sequence.ts';
import { pipelineById } from './pipelines.ts';
import { CAMERA, TARGET_GEOMETRY, renderSequence, sceneTarget, sequences } from './scene/suites.ts';
import type { TargetKind } from './scene/textures.ts';
import { DEFAULT_DISPLAY, simulateDisplay, type CompositorMode } from './sim/display.ts';
import { runRealtime, type ProcessedFrame } from './sim/realtime.ts';

export interface FilterUnderTest {
  update(m: PoseEstimate): PoseEstimate;
  predict(targetId: string, t: number): PoseEstimate | null;
  snapshot(targetId: string): ((t: number) => PoseEstimate | null) | null;
  reset(): void;
}

/** Re-filters recorded raw outputs as FilteredPipeline would have. */
export function refilter(processed: readonly ProcessedFrame[], filter: FilterUnderTest): ProcessedFrame[] {
  filter.reset();
  return processed.map((p) => {
    const out: FrameOutput = p.output;
    const display: PoseEstimate[] = [];
    // Raw measurements when the pipeline reports them (its own display may already be filtered).
    if (out.poses.length) for (const pose of out.poses) display.push(filter.update(pose));
    else
      for (const pose of out.display) {
        if (pose.origin === 'detector' || pose.origin === 'tracker') display.push(filter.update(pose));
        else display.push(filter.predict(pose.targetId, out.timeUs) ?? pose);
      }
    if (!out.display.length) filter.reset();
    const snaps = display.map((d) => filter.snapshot(d.targetId)).filter((s) => s !== null);
    return {
      ...p,
      output: {
        ...out,
        display,
        predict: (t: number) => snaps.map((s) => s(t)).filter((x): x is PoseEstimate => x !== null),
      },
    };
  });
}

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const entry = pipelineById(option('pipeline') ?? 'B0+C4');
  const kinds = (option('kinds') ?? 'poster').split(',') as TargetKind[];
  const ids = ['T1-static', 'T2-pan', 'T3-shake', 'T12-drift'];
  const pipeline = entry.create();
  const targets = [...new Set([...kinds, 'graphic' as TargetKind])].map((k) => sceneTarget(k));
  const infos: TargetInfo[] = targets.map((t) => ({
    id: t.id,
    width: TARGET_GEOMETRY.widthPx,
    height: TARGET_GEOMETRY.heightPx,
    physicalWidthMeters: TARGET_GEOMETRY.widthM,
  }));
  await pipeline.load(
    targets.map((t, i) => ({ info: infos[i]!, image: { width: 640, height: 480, stride: 640, data: t.gray } })),
  );
  const runs: { id: string; frames: ReturnType<typeof renderSequence>; processed: ProcessedFrame[] }[] = [];
  for (const kind of kinds)
    for (const spec of sequences().filter((s) => ids.includes(s.id))) {
      const frames = renderSequence(sceneTarget(kind), spec);
      const processed = await runRealtime(pipeline, frames, {
        tier: 'mid',
        costs: entry.costs,
        width: CAMERA.width,
        height: CAMERA.height,
        sessionId: spec.id,
      });
      runs.push({ id: `${spec.id}/${kind}`, frames, processed });
    }
  const grid: { name: string; make: (() => FilterUnderTest) | null }[] = [{ name: 'raw', make: null }];
  if (!process.argv.includes('--kalman-only'))
    for (const minCutoffHz of [0.7, 1.5])
      for (const beta of [0.06, 0.15])
        grid.push({
          name: `E1 mc=${minCutoffHz} β=${beta}`,
          make: () => new OneEuroPoseFilter(infos, { minCutoffHz, beta, derivativeCutoffHz: 4 }),
        });
  for (const accelerationNoise of [2e4, 2e5, 2e6])
    for (const trackerSigmaPx of [0.05, 0.15, 0.4])
      grid.push({
        name: `E2 q=${accelerationNoise} σt=${trackerSigmaPx}`,
        make: () => new KalmanPoseFilter(infos, { accelerationNoise, trackerSigmaPx }),
      });
  const rows: string[] = [];
  const modes = (option('modes') ?? 'predicted,frame-locked').split(',') as CompositorMode[];
  for (const { name, make } of grid)
    for (const mode of modes) {
      const cells: Record<string, number> = {};
      for (const run of runs) {
        const processed = make ? refilter(run.processed, make()) : run.processed;
        const truth = run.frames.map((f) => ({
          corners: f.H ? cornersOf(f.H, 640, 480) : null,
          visible: f.visible,
          timeUs: f.timeUs,
        }));
        const tracking = trackingMetrics(
          truth,
          processed.map((p) => ({ index: p.index, corners: p.output.display[0]?.corners ?? null })),
        );
        const display = sequenceMetrics(
          simulateDisplay(run.frames, processed, { ...DEFAULT_DISPLAY, mode }),
          run.frames.map((f) => f.timeUs),
          { nativeLatencyUs: DEFAULT_DISPLAY.nativeLatencyUs, fps: 30 },
        );
        const seq = run.id.split('/')[0]!;
        if (seq === 'T1-static') cells.jitter = tracking.staticJitterPx ?? NaN;
        else {
          cells[`${seq}:surv`] = 100 * tracking.survival;
          cells[`${seq}:reg95`] = 100 * (display.errP95 ?? NaN);
        }
      }
      rows.push(
        `${name} ${mode} | ${Object.entries(cells)
          .map(([k, v]) => `${k}=${v.toFixed(2)}`)
          .join(' ')}`,
      );
    }
  console.log(rows.join('\n'));
  pipeline.dispose();
}

if (process.argv[1]?.endsWith('tune-filter.ts')) await main();
