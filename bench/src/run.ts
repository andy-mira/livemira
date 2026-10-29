// SPDX-License-Identifier: Apache-2.0
// Runs S1 sweeps and S2 sequences for several pipelines on identical rendered inputs and scores them.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { cornersOf, type TargetImage, type VisionPipeline } from '@livemira-next/contracts';

import { judge, sweepMetrics, type SweepMetrics, type SweepOutcome } from './metrics/sweep.ts';
import {
  quantile,
  sequenceMetrics,
  trackingMetrics,
  type SequenceMetrics,
  type TrackingMetrics,
} from './metrics/sequence.ts';
import { bundleGzipBytes } from './bundle.ts';
import type { PipelineEntry } from './pipelines.ts';
import {
  CAMERA,
  FRAME_INTERVAL_US,
  TARGET_GEOMETRY,
  renderSequence,
  renderSweep,
  sceneTarget,
  sequences,
  sweepCases,
  type GroundTruthFrame,
  type SceneTarget,
} from './scene/suites.ts';
import type { TargetKind } from './scene/textures.ts';
import { hashSeed, uniform } from './rng.ts';
import { DEFAULT_DISPLAY, simulateDisplay } from './sim/display.ts';
import { frameHandle, runRealtime, TIERS, type Tier } from './sim/realtime.ts';
import { score, type Scorecard } from './score/score.ts';

export interface RunOptions {
  readonly kinds: readonly TargetKind[];
  readonly variants: number;
  readonly sequenceIds: readonly string[] | null;
  /** Simulated device tiers; S1 (tier-independent) runs once, S2 once per tier. */
  readonly tiers: readonly Tier[];
  /** Bootstrap resamples for the total's 95% interval (0: none). */
  readonly bootstrap?: number;
  readonly log: (line: string) => void;
}

export interface SequenceResult {
  readonly sequence: string;
  readonly kind: TargetKind;
  readonly metrics: SequenceMetrics;
  readonly tracking: TrackingMetrics;
  readonly computeP50Ms: number | null;
  readonly computeP95Ms: number | null;
  readonly processedRatio: number;
  /** All CPU per camera frame, fast loop plus concurrent slow loop, on the tier (energy proxy; not scored), ms. */
  readonly cpuPerFrameMs: number;
  readonly stages: Readonly<Record<string, number>>;
}

export interface PipelineResult {
  readonly id: string;
  readonly title: string;
  readonly tier: Tier;
  readonly sweep: SweepMetrics;
  readonly sequences: readonly SequenceResult[];
  readonly targets: readonly {
    readonly id: string;
    readonly compileMs: number;
    readonly bytes: number;
    readonly gzipBytes: number;
  }[];
  readonly determinismPct: number;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly scorecard: Scorecard;
  /** 95% bootstrap interval of the total (S1 cases resampled within each sweep value, S2 runs within each sequence). */
  readonly totalCi: { readonly low: number; readonly high: number } | null;
}

/** Everything the metrics of one pipeline on one tier are computed from (and resampled from). */
interface Measurements {
  readonly entry: PipelineEntry;
  readonly tier: Tier;
  readonly outcomes: readonly SweepOutcome[];
  readonly sequences: readonly SequenceResult[];
  readonly determinismPct: number | null;
  readonly targets: PipelineResult['targets'];
  readonly bundledBytes: number | null;
}

/** The loaded target set: one target per scene kind plus a distractor kind that never appears. */
function loadedTargets(kinds: readonly TargetKind[]): SceneTarget[] {
  const all = new Set<TargetKind>([...kinds, 'graphic']);
  return [...all].map((k) => sceneTarget(k));
}

function targetImage(t: SceneTarget): TargetImage {
  return {
    info: {
      id: t.id,
      width: TARGET_GEOMETRY.widthPx,
      height: TARGET_GEOMETRY.heightPx,
      physicalWidthMeters: TARGET_GEOMETRY.widthM,
    },
    image: {
      width: TARGET_GEOMETRY.widthPx,
      height: TARGET_GEOMETRY.heightPx,
      stride: TARGET_GEOMETRY.widthPx,
      data: t.gray,
    },
  };
}

async function detectAll(
  pipeline: VisionPipeline,
  frames: readonly { c: ReturnType<typeof sweepCases>[number]; f: GroundTruthFrame }[],
): Promise<SweepOutcome[]> {
  const out: SweepOutcome[] = [];
  for (const { c, f } of frames) {
    const handle = frameHandle('s1', f, CAMERA.width, CAMERA.height, 0);
    const started = performance.now();
    const poses = await pipeline.detect(handle);
    out.push(
      judge(c, f, poses, (performance.now() - started) * 1000, {
        width: TARGET_GEOMETRY.widthPx,
        height: TARGET_GEOMETRY.heightPx,
      }),
    );
  }
  return out;
}

/** Lines of the largest source file under `dirs` (a proxy for the largest module). */
export function maxModuleLoc(dirs: readonly string[]): number | null {
  let max = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.ts')) max = Math.max(max, readFileSync(path, 'utf8').split('\n').length);
    }
  };
  try {
    dirs.forEach(walk);
  } catch {
    return null;
  }
  return max || null;
}

function median(values: readonly (number | null)[]): number | null {
  return quantile(
    values.filter((v): v is number => v !== null && Number.isFinite(v)),
    0.5,
  );
}

/** The metric set of design doc §5.2.4 from one pipeline's measurements. */
function metricsOf(m: Measurements, sweep: SweepMetrics = sweepMetrics(m.outcomes)): Record<string, number | null> {
  const seq = m.sequences;
  // Registration is judged on the hand-shake sequence (design doc §5.2.4, Y-1 at the T3 level).
  const shake = seq.filter((s) => s.sequence === 'T3-shake');
  const survivalSet = seq.filter((s) => !['T1-static'].includes(s.sequence));
  const engineBytes = m.bundledBytes ?? m.entry.engineGzipBytes;
  return {
    rollCoverageDeg: sweep.rollCoverageDeg,
    minLongPx: sweep.minLongPx,
    maxTiltDeg: sweep.maxTiltDeg,
    minGain: sweep.minGain,
    maxBlurPx: sweep.maxBlurPx,
    falsePerThousand: sweep.falsePerThousand,
    staticJitterPx: median(seq.filter((s) => s.sequence === 'T1-static').map((s) => s.tracking.staticJitterPx)),
    hfJitterPx: median(seq.map((s) => s.tracking.hfJitterPx)),
    survivalPct: survivalSet.length
      ? 100 * (survivalSet.reduce((a, s) => a + s.tracking.survival, 0) / survivalSet.length)
      : null,
    maxOcclusion: sweep.maxOcclusion,
    ghostPct: seq.length ? 100 * (seq.reduce((a, s) => a + s.metrics.ghostRate, 0) / seq.length) : null,
    reacquireMs: median(seq.map((s) => s.metrics.reacquireMs)),
    registrationP95Pct: median(shake.map((s) => (s.metrics.errP95 === null ? null : 100 * s.metrics.errP95))),
    overlayAgeMs: median(seq.map((s) => s.metrics.overlayAgeMs)),
    backgroundLagMs: median(seq.map((s) => s.metrics.backgroundLagMs)),
    backgroundRefresh: median(seq.map((s) => s.metrics.backgroundRefresh)),
    computeP95Ms: median(seq.map((s) => s.computeP95Ms)),
    mainThreadMs: (m.entry.costs.mainThreadUs * TIERS[m.tier]) / TIERS.mid / 1000,
    processedRatio: median(seq.map((s) => s.processedRatio)),
    cpuPerFrameMs: median(seq.map((s) => s.cpuPerFrameMs)),
    engineKb: engineBytes === null ? null : engineBytes / 1024,
    targetKb: median(m.targets.map((t) => t.gzipBytes / 1024)),
    ttfpMs: median(seq.map((s) => s.metrics.ttfpMs)),
    determinismPct: m.determinismPct,
    maxModuleLoc: maxModuleLoc(m.entry.sources),
  };
}

/** Seeded resampling with replacement inside each group, groups kept in order. */
function resample<T>(items: readonly T[], group: (item: T) => string, random: () => number): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(group(item), [...(groups.get(group(item)) ?? []), item]);
  return [...groups.values()].flatMap((list) => list.map(() => list[Math.floor(random() * list.length)]!));
}

/** 95% percentile interval of the total over `n` stratified bootstrap resamples (deterministic seed). */
function bootstrapTotal(m: Measurements, n: number): { low: number; high: number } | null {
  if (n <= 0) return null;
  const random = uniform(hashSeed(`bootstrap:${m.entry.id}:${m.tier}`));
  const loc = maxModuleLoc(m.entry.sources);
  const fixed: Measurements = { ...m, entry: { ...m.entry, sources: [] } };
  const totals: number[] = [];
  for (let i = 0; i < n; i++) {
    const sample: Measurements = {
      ...fixed,
      outcomes: resample(m.outcomes, (o) => `${o.case.factor}|${o.case.value}`, random),
      sequences: resample(m.sequences, (s) => s.sequence, random),
    };
    totals.push(score({ ...metricsOf(sample), maxModuleLoc: loc }, m.entry.estimate).total);
  }
  totals.sort((a, b) => a - b);
  return { low: totals[Math.floor(0.025 * (n - 1))]!, high: totals[Math.ceil(0.975 * (n - 1))]! };
}

export async function runBenchmark(entries: readonly PipelineEntry[], options: RunOptions): Promise<PipelineResult[]> {
  const log = options.log;
  const targets = loadedTargets(options.kinds);
  const pipelines = entries.map((e) => ({ entry: e, pipeline: e.create() }));
  const loads = new Map<string, PipelineResult['targets']>();
  for (const { entry, pipeline } of pipelines) {
    const report = await pipeline.load(targets.map(targetImage));
    loads.set(
      entry.id,
      report.targets.map((t) => ({
        id: t.id,
        compileMs: t.compileUs / 1000,
        bytes: t.serialized.length,
        gzipBytes: gzipSync(t.serialized).length,
      })),
    );
  }

  // S1: render once, detect with every pipeline.
  const cases = sweepCases(options.variants);
  const sweepFrames = options.kinds.flatMap((kind) => cases.map((c) => ({ c, f: renderSweep(sceneTarget(kind), c) })));
  log(`S1: ${sweepFrames.length} frames rendered`);
  const sweeps = new Map<string, SweepOutcome[]>();
  const determinism = new Map<string, number>();
  for (const { entry, pipeline } of pipelines) {
    const outcomes = await detectAll(pipeline, sweepFrames);
    sweeps.set(entry.id, outcomes);
    // Determinism: the same frames again must give identical poses.
    const subset = sweepFrames.filter((_, i) => i % 7 === 0);
    const again = await detectAll(pipeline, subset);
    const first = outcomes.filter((_, i) => i % 7 === 0);
    const same = again.filter((o, i) => o.error === first[i]!.error && o.correct === first[i]!.correct).length;
    determinism.set(entry.id, (100 * same) / subset.length);
    log(`S1 ${entry.id}: done`);
  }

  // S2: render each sequence once, run every pipeline in real time on the simulated tier.
  const specs = sequences().filter((s) => !options.sequenceIds || options.sequenceIds.includes(s.id));
  const key = (id: string, tier: Tier): string => `${id}@${tier}`;
  const results = new Map<string, SequenceResult[]>(
    entries.flatMap((e) => options.tiers.map((t) => [key(e.id, t), []] as [string, SequenceResult[]])),
  );
  for (const kind of options.kinds) {
    for (const spec of specs) {
      const frames = renderSequence(sceneTarget(kind), spec);
      const times = frames.map((f) => f.timeUs);
      for (const tier of options.tiers) {
        for (const { entry, pipeline } of pipelines) {
          const processed = await runRealtime(pipeline, frames, {
            tier,
            costs: entry.costs,
            width: CAMERA.width,
            height: CAMERA.height,
            sessionId: `${spec.id}:${kind}`,
          });
          const samples = simulateDisplay(frames, processed, { ...DEFAULT_DISPLAY, mode: entry.compositor });
          const metrics = sequenceMetrics(samples, times, {
            nativeLatencyUs: DEFAULT_DISPLAY.nativeLatencyUs,
            fps: 1e6 / FRAME_INTERVAL_US,
          });
          const tracking = trackingMetrics(
            frames.map((f) => ({
              corners: f.H ? cornersOf(f.H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx) : null,
              visible: f.visible,
              timeUs: f.timeUs,
            })),
            processed.map((p) => {
              const display = p.output.display;
              const pose = display.find((d) => d.targetId === frames[p.index]!.targetId) ?? display[0] ?? null;
              return { index: p.index, corners: pose ? pose.corners : null };
            }),
          );
          const compute = processed.map((p) => (p.computeUs * TIERS[tier]) / 1000);
          const stageKeys = new Set(processed.flatMap((p) => Object.keys(p.output.timings)));
          const stages = Object.fromEntries(
            [...stageKeys].map((k) => [k, (median(processed.map((p) => p.output.timings[k] ?? null)) ?? 0) / 1000]),
          );
          results.get(key(entry.id, tier))!.push({
            sequence: spec.id,
            kind,
            metrics,
            tracking,
            computeP50Ms: quantile(compute, 0.5),
            computeP95Ms: quantile(compute, 0.95),
            processedRatio: processed.length / frames.length,
            cpuPerFrameMs:
              (processed.reduce((a, p) => a + p.computeUs + (p.output.timings.background ?? 0), 0) * TIERS[tier]) /
              1000 /
              frames.length,
            stages,
          });
        }
      }
      log(`S2 ${spec.id} (${kind}): ${frames.length} frames`);
    }
  }

  const bundled = new Map<string, number>();
  for (const { entry } of pipelines) if (entry.bundle) bundled.set(entry.id, await bundleGzipBytes(entry.bundle));
  for (const { pipeline } of pipelines) pipeline.dispose();
  return options.tiers.flatMap((tier) =>
    pipelines.map(({ entry }): PipelineResult => {
      const m: Measurements = {
        entry,
        tier,
        outcomes: sweeps.get(entry.id)!,
        sequences: results.get(key(entry.id, tier))!,
        determinismPct: determinism.get(entry.id) ?? null,
        targets: loads.get(entry.id)!,
        bundledBytes: bundled.get(entry.id) ?? null,
      };
      const sweep = sweepMetrics(m.outcomes);
      const metrics = metricsOf(m, sweep);
      return {
        id: entry.id,
        title: entry.title,
        tier,
        sweep,
        sequences: m.sequences,
        targets: m.targets,
        determinismPct: m.determinismPct ?? 0,
        metrics,
        scorecard: score(metrics, entry.estimate),
        totalCi: bootstrapTotal(m, options.bootstrap ?? 0),
      };
    }),
  );
}
