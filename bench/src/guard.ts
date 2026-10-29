// SPDX-License-Identifier: Apache-2.0
// Regression lock of the release configurations (design doc §5.2.5 CI gate): S1 in full (poster + photo, 4 variants)
// and the quick S2 set at the mid tier, compared with bench/baselines/release.json. Fails on: any S1 coverage
// limit or recall value more than 2 points worse, more false detections, static jitter +20%, registration p95 +20%,
// survival −1 point; compute p95 +15% is machine-dependent and only fails with --strict.
//   node bench/src/guard.ts [--update] [--strict]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { pipelineById } from './pipelines.ts';
import { runBenchmark, type PipelineResult } from './run.ts';

/**
 * The release configurations chosen in P6 (bench/results/p6-search): the frame-locked main path, chosen for every
 * tier, and the CSS fallback for browsers without WebGL2/VideoFrame.
 */
export const RELEASE = ['N3-F1-r60-async', 'N3-F2-r10-async'] as const;

const FILE = join('bench', 'baselines', 'release.json');

interface Locked {
  readonly id: string;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly recall: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const update = process.argv.includes('--update');
const strict = process.argv.includes('--strict');
const results: PipelineResult[] = await runBenchmark(RELEASE.map(pipelineById), {
  kinds: ['poster', 'photo'],
  variants: 4,
  sequenceIds: ['T1-static', 'T3-shake', 'T5-roll', 'T10-exit'],
  tiers: ['mid'],
  bootstrap: 0,
  log: () => {},
});
const current: Locked[] = results.map((r) => ({ id: r.id, metrics: r.metrics, recall: r.sweep.recall }));
if (update || !existsSync(FILE)) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify({ updated: new Date().toISOString(), configurations: current }, null, 2)}\n`);
  console.log(`baseline written: ${FILE}`);
  process.exit(0);
}
const locked = (JSON.parse(readFileSync(FILE, 'utf8')) as { configurations: Locked[] }).configurations;
const failures: string[] = [];
const warnings: string[] = [];
for (const now of current) {
  const was = locked.find((l) => l.id === now.id);
  if (!was) {
    failures.push(`${now.id}: not in the baseline (run with --update)`);
    continue;
  }
  const m = (k: string, l: Locked): number | null => l.metrics[k] ?? null;
  const check = (key: string, worse: (now: number, was: number) => boolean, label: string, soft = false): void => {
    const a = m(key, now);
    const b = m(key, was);
    if (a === null || b === null) return;
    if (worse(a, b)) (soft && !strict ? warnings : failures).push(`${now.id}: ${label} ${b} → ${a}`);
  };
  for (const key of ['rollCoverageDeg', 'maxTiltDeg', 'maxBlurPx', 'maxOcclusion']) check(key, (a, b) => a < b, key);
  for (const key of ['minLongPx', 'minGain']) check(key, (a, b) => a > b, key);
  check('falsePerThousand', (a, b) => a > b, 'false detections per 1000');
  check('staticJitterPx', (a, b) => a > 1.2 * b + 0.002, 'static jitter σ px');
  check('registrationP95Pct', (a, b) => a > 1.2 * b + 0.01, 'T3 registration p95 %');
  check('survivalPct', (a, b) => a < b - 1, 'survival %');
  check('computeP95Ms', (a, b) => a > 1.15 * b, 'compute p95 ms (machine-dependent)', true);
  for (const [factor, values] of Object.entries(was.recall))
    for (const [value, recall] of Object.entries(values)) {
      const r = now.recall[factor]?.[value];
      if (r !== undefined && r < recall - 0.02)
        failures.push(`${now.id}: S1 recall ${factor}=${value} ${recall} → ${r}`);
    }
}
for (const w of warnings) console.log(`warning: ${w}`);
for (const f of failures) console.log(`REGRESSION: ${f}`);
console.log(
  failures.length
    ? `${failures.length} regression(s)`
    : `release configurations hold (${current.map((c) => c.id).join(', ')})`,
);
process.exit(failures.length ? 1 : 0);
