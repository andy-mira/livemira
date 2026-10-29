// SPDX-License-Identifier: Apache-2.0
// Calibration of the target rating (packages/rating/src/rating.ts): rates pictures compiled as the engine compiles
// them (long edge 640), the synthetic target kinds of the bench, and pictures made from a photo with detail kept in
// only part of it, and prints the factors, the stars and the advice. With --measured (JSON files of
// measure-targets.ts), also how the score and each factor rank the pictures against how hard they measured to be.
//   node bench/src/rate-targets.ts [<picture> …] [--json <file>] [--measured <file>,…]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { GrayImage } from '@livemira-next/contracts';
import { compileTarget, encodeTarget } from '@livemira-next/features';
import type { TargetRating } from '@livemira-next/rating';
import { rateCompiledTarget } from '@livemira-next/rating/core';

import { targetPicture, toGray8, type TargetKind } from './scene/textures.ts';

function grayOf(file: string): GrayImage {
  const [w0, h0] = execFileSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    file,
  ])
    .toString()
    .trim()
    .split(',')
    .map(Number) as [number, number];
  const s = Math.min(1, 640 / Math.max(w0, h0));
  const width = Math.round(w0 * s);
  const height = Math.round(h0 * s);
  const data = new Uint8Array(
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-i',
        file,
        '-vf',
        `scale=${width}:${height}:flags=area`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'gray',
        '-',
      ],
      {
        maxBuffer: 1 << 26,
      },
    ),
  );
  return { width, height, stride: width, data };
}

/** `image` with the pixels `keep` refuses flattened to the kept pixels' mean gray (x, y as fractions). */
function keepOnly(image: GrayImage, keep: (x: number, y: number) => boolean): GrayImage {
  const { width, height } = image;
  const kept = (i: number): boolean => keep((i % width) / width, Math.floor(i / width) / height);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < width * height; i++)
    if (kept(i)) {
      sum += image.data[i]!;
      count++;
    }
  const mean = Math.round(sum / Math.max(1, count));
  return { width, height, stride: width, data: Uint8Array.from(image.data, (v, i) => (kept(i) ? v : mean)) };
}

async function rate(name: string, image: GrayImage): Promise<TargetRating & { name: string }> {
  const compiled = compileTarget({
    info: { id: 't', width: image.width, height: image.height, physicalWidthMeters: null },
    image,
  });
  return { name, ...(await rateCompiledTarget(await encodeTarget(compiled, image))) };
}

const files = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--json' && all[i - 1] !== '--measured');
const results: (TargetRating & { name: string })[] = [];
for (const f of files) results.push(await rate(basename(f), grayOf(f)));
for (const kind of ['photo', 'poster', 'graphic', 'lowtex', 'repetitive'] as TargetKind[])
  results.push(
    await rate(`合成 ${kind}`, {
      width: 640,
      height: 480,
      stride: 640,
      data: toGray8(targetPicture(kind, 7, 640, 480)),
    }),
  );
if (files[0]) {
  const base = grayOf(files[0]);
  const stem = basename(files[0]);
  results.push(
    await rate(
      `${stem} 仅左上 1/4`,
      keepOnly(base, (x, y) => x < 0.5 && y < 0.5),
    ),
  );
  results.push(
    await rate(
      `${stem} 仅左半`,
      keepOnly(base, (x) => x < 0.5),
    ),
  );
  results.push(
    await rate(
      `${stem} 仅中央 1/3`,
      keepOnly(base, (x, y) => x >= 0.33 && x < 0.67 && y >= 0.33 && y < 0.67),
    ),
  );
  results.push(
    await rate(
      `${stem} 去掉右下 1/4`,
      keepOnly(base, (x, y) => x < 0.5 || y < 0.5),
    ),
  );
}

const f2 = (x: number): string => x.toFixed(2);
console.log(
  [
    '图片'.padEnd(26),
    '星',
    '分',
    '细节',
    '分布',
    '独特',
    '识别',
    '尺寸/倾斜/模糊/暗/遮挡',
    '稳定点',
    '格',
    '均匀',
    '最弱象限',
    '建议',
  ].join(' | '),
);
for (const r of results)
  console.log(
    [
      r.name.padEnd(26),
      r.stars.toFixed(1),
      String(r.score),
      f2(r.factors.detail),
      f2(r.factors.spread),
      f2(r.factors.distinctiveness),
      f2(r.factors.recognition),
      Object.values(r.metrics.tests).map(f2).join('/'),
      String(r.metrics.robustPoints),
      `${r.metrics.populatedCells}/${r.metrics.grid.columns * r.metrics.grid.rows}`,
      f2(r.metrics.evenness),
      `${r.metrics.weakestQuarter.index}:${f2(r.metrics.weakestQuarter.share)}`,
      r.advice.join(',') || '—',
    ].join(' | '),
  );
const json = process.argv.indexOf('--json');
if (json > 0)
  writeFileSync(
    process.argv[json + 1]!,
    JSON.stringify(
      results.map(({ points: _p, ...r }) => r),
      null,
      2,
    ),
  );

// Against the measured difficulty: Spearman rank correlation of the score and of each factor and test.
const measuredArg = process.argv.indexOf('--measured');
if (measuredArg > 0) {
  const measured = new Map<string, number>();
  for (const file of process.argv[measuredArg + 1]!.split(','))
    for (const m of JSON.parse(readFileSync(file, 'utf8')) as { name: string; measured: number }[])
      measured.set(m.name, m.measured);
  const both = results.filter((r) => measured.has(r.name));
  const ranks = (xs: readonly number[]): number[] => {
    const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const out = new Array<number>(xs.length);
    for (let i = 0; i < order.length;) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return out;
  };
  const spearman = (xs: readonly number[], ys: readonly number[]): number => {
    const a = ranks(xs);
    const b = ranks(ys);
    const mean = (a.length - 1) / 2;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i]! - mean) * (b[i]! - mean);
      da += (a[i]! - mean) ** 2;
      db += (b[i]! - mean) ** 2;
    }
    return num / Math.sqrt(da * db || 1);
  };
  const truth = both.map((r) => measured.get(r.name)!);
  const columns: [string, (r: TargetRating) => number][] = [
    ['分', (r) => r.score],
    ['细节', (r) => r.factors.detail],
    ['分布', (r) => r.factors.spread],
    ['独特', (r) => r.factors.distinctiveness],
    ['识别', (r) => r.factors.recognition],
    ['稳定点', (r) => r.metrics.robustPoints],
    ...Object.keys(both[0]?.metrics.tests ?? {}).map((test): [string, (r: TargetRating) => number] => [
      test,
      (r) => r.metrics.tests[test as keyof TargetRating['metrics']['tests']],
    ]),
  ];
  console.log(`\n与仿真实测的等级相关（${both.length} 张）：`);
  console.log(columns.map(([name, of]) => `${name} ${spearman(both.map(of), truth).toFixed(2)}`).join(' | '));
  for (const r of [...both].sort((a, b) => measured.get(b.name)! - measured.get(a.name)!))
    console.log(`${r.name.padEnd(22)} 实测 ${Math.round(100 * measured.get(r.name)!)}  星 ${r.stars}  分 ${r.score}`);
}
