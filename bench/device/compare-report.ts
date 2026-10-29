// SPDX-License-Identifier: Apache-2.0
// ⑩ LiveMorae material comparison, the analysis: splits the phone's frame report by what the computer showed
// (compare/targets.html) and compares tracking, losses, recovery, the photo's size on screen, pose quality and times
// per way of showing the photo. The phone's clock is mapped to the server's by its last upload (the computer showing
// the pictures is the server, so its times are the server's).
//   node bench/device/compare-report.ts [<reports dir>] [<phone run id>] [--round-sizes 720x1280,360x640]
// One page can be run several times (a round each): rounds start at the page's 'start' events and are reported
// apart; reports from before rounds recorded their size can give the sizes with --round-sizes.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--round-sizes');
const dir = args[0] ?? join('bench', 'results', 'device', 'reports');
const wanted = args[1];
const sizesArg = process.argv.includes('--round-sizes')
  ? process.argv[process.argv.indexOf('--round-sizes') + 1]!.split(',').map((s) => s.split('x').map(Number))
  : [];

/** Server receipt time from a report's file name (`2026-10-24T08-04-27-134Z-<kind>.json`). */
const receivedAt = (name: string): number =>
  Date.parse(name.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z'));

interface PhoneReport {
  readonly run: string;
  readonly final: boolean;
  readonly startedWall: number;
  readonly uploadWall: number;
  readonly userAgent: string;
  readonly info: Record<string, unknown>;
  readonly fields: readonly string[];
  readonly frames: readonly (string | number)[][];
  readonly events: readonly (string | number)[][];
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const phoneFiles = files
  .filter((f) => /-compare-[0-9a-z]+\.json$/.test(f) && !f.endsWith('-compare-targets.json'))
  .map((f) => ({ f, at: receivedAt(f), r: JSON.parse(readFileSync(join(dir, f), 'utf8')) as PhoneReport }))
  .filter((x) => !wanted || x.r.run === wanted)
  .sort((a, b) => a.at - b.at);
const last = phoneFiles.at(-1);
if (!last) throw new Error(`没有 ⑩ 的手机回传（${dir}）`);
// The most complete upload of that run.
const phone = phoneFiles
  .filter((x) => x.r.run === last.r.run)
  .sort((a, b) => b.r.frames.length - a.r.frames.length)[0]!;
const skew = phone.at - phone.r.uploadWall;
const col = Object.fromEntries(phone.r.fields.map((name, i) => [name, i])) as Record<string, number>;
const at = (ms: number): number => phone.r.startedWall + ms + skew;
const frames = phone.r.frames.map((f) => ({ t: at(Number(f[col.ms!])), f }));
const events = phone.r.events.map((e) => ({ t: at(Number(e[0])), e }));

// The computer's intervals within the phone's span.
const marks = files
  .filter((f) => f.endsWith('-compare-targets.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as { phase: string; variant?: string; wallMs: number })
  .filter((m) => m.wallMs >= frames[0]!.t - 600_000 && m.wallMs <= frames.at(-1)!.t + 60_000)
  .sort((a, b) => a.wallMs - b.wallMs);
const segments: { variant: string; from: number; to: number }[] = [];
for (const m of marks)
  if (m.phase === 'start') segments.push({ variant: m.variant!, from: m.wallMs, to: Number.NaN });
  else if (m.phase === 'end') {
    const open = [...segments].reverse().find((s) => s.variant === m.variant && Number.isNaN(s.to));
    if (open) open.to = m.wallMs;
  }
const complete = segments.filter((s) => !Number.isNaN(s.to));

// Rounds of this page: their settings and processed picture size.
const startEvents = events.filter((x) => x.e[1] === 'start');
const rounds = (startEvents.length ? startEvents : [{ t: frames[0]!.t, e: [0, 'start'] }]).map((x, i, all) => {
  const to = all[i + 1]?.t ?? Infinity;
  const size = events.find((y) => y.t >= x.t && y.t < to && y.e[1] === 'size');
  const dims = size
    ? [Number(size.e[2]), Number(size.e[3])]
    : (sizesArg[i] ?? (i === 0 ? (phone.r.info.standardSize as number[]) : null));
  return {
    index: i + 1,
    from: x.t,
    to,
    label: `第 ${i + 1} 轮${x.e[3] !== undefined ? `（${String(x.e[2])}，处理尺寸 ${String(x.e[3])}）` : ''}`,
    short: dims ? Math.min(dims[0]!, dims[1]!) : Number.NaN,
    dims,
  };
});
const roundAt = (t: number): (typeof rounds)[number] => rounds.find((r) => t >= r.from && t < r.to) ?? rounds[0]!;
if (!complete.length) complete.push({ variant: '整段（无电脑轮换记录）', from: frames[0]!.t, to: frames.at(-1)!.t });

const median = (xs: number[]): number => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const p95 = (xs: number[]): number => {
  if (!xs.length) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]!;
};
const pct = (x: number): string => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : '—');
const num = (x: number, digits = 0): string => (Number.isFinite(x) ? x.toFixed(digits) : '—');

console.log(`手机：${phone.r.userAgent}`);
console.log(
  `运行 ${phone.r.run}，${phone.r.frames.length} 帧，档位 ${String(phone.r.info.profile)}，采集 ${String(phone.r.info.capture)}，` +
    `手机时钟偏差 ${(skew / 1000).toFixed(1)} 秒`,
);
for (const r of rounds)
  console.log(`${r.label}：处理画面 ${r.dims ? r.dims.join('×') : '未知（可用 --round-sizes 给出）'}`);
const rows: string[][] = [];
for (const s of complete) {
  // The first second after a switch is the hand finding the new picture.
  const from = s.from + 1000;
  const own = frames.filter((x) => x.t >= from && x.t < s.to).map((x) => x.f);
  const seconds = (s.to - from) / 1000;
  const tracked = own.filter((f) => f[col.target!]);
  const measured = own.filter((f) => f[col.origin!] === 'tracker' || f[col.origin!] === 'detector');
  const searching = own.filter((f) => f[col.state!] === 'SEARCHING' || f[col.state!] === 'LOST');
  const lost = events.filter((x) => x.t >= from && x.t < s.to && x.e[1] === 'lost' && x.e[3] === 'out-of-view');
  const recoveries = lost.map((l) => {
    const next = events.find((x) => x.t > l.t && x.e[1] === 'found');
    return next ? (next.t - l.t) / 1000 : Number.NaN;
  });
  const firstFound = own.findIndex((f) => f[col.target!]);
  const ids = [...new Set(tracked.map((f) => String(f[col.target!])))].join(',');
  rows.push([
    `${rounds.length > 1 ? `${roundAt(s.from).index}·` : ''}${s.variant}`,
    num(own.length / seconds, 1),
    pct(tracked.length / own.length),
    pct(measured.length / own.length),
    pct(own.filter((f) => f[col.state!] === 'DEGRADED').length / own.length),
    `${lost.length}（${num((60 * lost.length) / seconds, 1)}/分）`,
    `${num(median(recoveries.filter(Number.isFinite)), 1)} / ${num(Math.max(0, ...recoveries.filter(Number.isFinite)), 1)}`,
    firstFound < 0 ? '未识别' : num((Number(own[firstFound]![col.ms!]) - Number(own[0]![col.ms!])) / 1000, 1),
    num(median(tracked.map((f) => Number(f[col.longEdgePx!])))),
    num(median(measured.map((f) => Number(f[col.ratio!]))), 2),
    num(median(measured.map((f) => Number(f[col.residual!]))), 1),
    num(median(measured.map((f) => Number(f[col.support!])))),
    `${searching.length}（检测 ${num(median(searching.map((f) => Number(f[col.detectUs!]) / 1000)), 1)} ms）`,
    `${num(median(own.map((f) => Number(f[col.processUs!]) / 1000)), 1)} / ${num(p95(own.map((f) => Number(f[col.processUs!]) / 1000)), 1)}`,
    num(median(own.map((f) => Number(f[col.lumaUs!]) / 1000)), 1),
    ids || '—',
  ]);
}
const header = [
  '显示方式',
  '帧/秒',
  '有叠加',
  '实测位姿',
  '降级',
  '丢失',
  '找回 中位/最长 秒',
  '首次识别 秒',
  '照片长边 px',
  '匹配比例',
  '残差',
  '支持点',
  '搜索帧',
  '处理 ms 中位/P95',
  '亮度 ms',
  '识别到',
];
console.log(header.join(' | '));
for (const r of rows) console.log(r.join(' | '));

// By the photo's share of the frame's short edge (its long edge on screen), per round: where losses happen.
const BINS = [0, 0.3, 0.4, 0.5, 0.6, 0.8, Infinity];
const binOf = (share: number): number => BINS.findIndex((b, i) => share >= b && share < BINS[i + 1]!);
for (const round of rounds) {
  if (!Number.isFinite(round.short)) continue;
  const bins = BINS.slice(0, -1).map(() => ({ frames: 0, coasting: 0, losses: 0, ratio: [] as number[] }));
  const lossTimes = events
    .filter((x) => x.t >= round.from && x.t < round.to && x.e[1] === 'lost' && x.e[3] === 'out-of-view')
    .map((x) => x.t)
    .sort((a, b) => a - b);
  let nextLoss = 0;
  let lastShare = -1;
  for (const { t, f } of frames) {
    if (t < round.from || t >= round.to) continue;
    for (; nextLoss < lossTimes.length && lossTimes[nextLoss]! <= t; nextLoss++)
      if (lastShare >= 0) bins[binOf(lastShare)]!.losses++;
    if (!f[col.target!]) continue;
    lastShare = Number(f[col.longEdgePx!]) / round.short;
    const b = bins[binOf(lastShare)]!;
    b.frames++;
    if (f[col.state!] === 'COASTING') b.coasting++;
    if (f[col.origin!] === 'tracker' || f[col.origin!] === 'detector') b.ratio.push(Number(f[col.ratio!]));
  }
  console.log(`\n${round.label}：按照片占画面短边的比例（短边 ${round.short} px；丢失按丢失前最后一帧的大小归档）`);
  console.log(['占短边', '跟踪 秒', '丢失', '丢失/跟踪分钟', '外推帧', '匹配比例'].join(' | '));
  bins.forEach((b, i) => {
    if (!b.frames && !b.losses) return;
    const seconds = b.frames / 30;
    const hi = BINS[i + 1]!;
    console.log(
      [
        `${Math.round(100 * BINS[i]!)}–${Number.isFinite(hi) ? Math.round(100 * hi) : '∞'}%`,
        num(seconds),
        String(b.losses),
        num((60 * b.losses) / Math.max(seconds, 1e-9), 1),
        pct(b.coasting / Math.max(1, b.frames)),
        num(median(b.ratio), 2),
      ].join(' | '),
    );
  });
}
