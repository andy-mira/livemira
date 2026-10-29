// SPDX-License-Identifier: Apache-2.0
// Benchmark entry point.
//   node bench/src/cli.ts run [--pipelines B0,N1] [--tier mid | --tiers low,mid,high] [--kinds poster,photo]
//                             [--variants 4] [--sequences T1-static,T3-shake] [--bootstrap 1000] [--quick]
//                             [--out bench/results/<name>]
// With low, mid and high tiers the report adds the tiered selection (design doc §5.3.2 P6).
//   node bench/src/cli.ts report <results.json>   regenerates report.md from saved results

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { pipelineById, PIPELINES } from './pipelines.ts';
import { markdownReport } from './report.ts';
import { runBenchmark, type PipelineResult } from './run.ts';
import type { TargetKind } from './scene/textures.ts';
import { TIERS, type Tier } from './sim/realtime.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'run';
  if (command === 'report') {
    // Regenerates report.md next to a results.json (e.g. after a report change), without rerunning.
    const file = process.argv[3] ?? join('bench', 'results', 'latest', 'results.json');
    const results = JSON.parse(readFileSync(file, 'utf8')) as PipelineResult[];
    const tiers = [...new Set(results.map((r) => r.tier))];
    const kinds = [...new Set(results.flatMap((r) => r.sequences.map((s) => s.kind)))];
    writeFileSync(
      join(dirname(file), 'report.md'),
      markdownReport(results, { tiers, kinds, date: statSync(file).mtime.toISOString() }),
    );
    console.log(`report: ${join(dirname(file), 'report.md')}`);
    return;
  }
  if (command !== 'run') throw new Error(`Unknown command ${command}`);
  const quick = process.argv.includes('--quick');
  const tiers = (option('tiers') ?? option('tier') ?? 'mid').split(',') as Tier[];
  for (const tier of tiers) if (!(tier in TIERS)) throw new Error(`Unknown tier ${tier}`);
  const bootstrap = Number(option('bootstrap') ?? (quick ? 200 : 1000));
  const ids = (option('pipelines') ?? PIPELINES.map((p) => p.id).join(',')).split(',');
  const kinds = (option('kinds') ?? (quick ? 'poster' : 'poster,photo')).split(',') as TargetKind[];
  const variants = Number(option('variants') ?? (quick ? 2 : 4));
  const sequenceIds =
    option('sequences')?.split(',') ?? (quick ? ['T1-static', 'T3-shake', 'T5-roll', 'T10-exit'] : null);
  const date = new Date().toISOString();
  const out = option('out') ?? join('bench', 'results', date.replace(/[:.]/g, '-'));
  const started = performance.now();
  const results = await runBenchmark(ids.map(pipelineById), {
    kinds,
    variants,
    sequenceIds,
    tiers,
    bootstrap,
    log: (line) => console.log(`[${((performance.now() - started) / 1000).toFixed(0)}s] ${line}`),
  });
  // Only when missing: a recursive mkdir of an existing directory has been seen to spin forever under the
  // background-command sandbox.
  if (!existsSync(out)) mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, 'report.md'), markdownReport(results, { tiers, kinds, date }));
  for (const r of results)
    console.log(
      `${r.id}@${r.tier}: total ${r.scorecard.total.toFixed(2)}${r.totalCi ? ` [${r.totalCi.low.toFixed(2)}, ${r.totalCi.high.toFixed(2)}]` : ''}${r.scorecard.caps.length ? ` caps: ${r.scorecard.caps.join('; ')}` : ''}`,
    );
  console.log(`report: ${join(out, 'report.md')}`);
}

await main();
