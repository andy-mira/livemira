// SPDX-License-Identifier: Apache-2.0
// Markdown report of a benchmark run: scorecards side by side, the metrics behind them, and per-sequence detail.

import type { PipelineResult } from './run.ts';
import { DIMENSION_NAMES, DIMENSION_WEIGHTS, METRICS, type Dimension } from './score/score.ts';

const fmt = (v: number | null | undefined, digits = 2): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/** The weight sets of design doc §4.6 (D1…D7). */
export const WEIGHT_SETS: readonly { readonly name: string; readonly weights: readonly number[] }[] = [
  { name: '默认', weights: [0.18, 0.18, 0.17, 0.15, 0.08, 0.12, 0.12] },
  { name: '体验优先', weights: [0.2, 0.22, 0.22, 0.12, 0.06, 0.1, 0.08] },
  { name: '兼容与成本优先', weights: [0.15, 0.15, 0.13, 0.15, 0.12, 0.18, 0.12] },
  { name: '等权', weights: Array.from({ length: 7 }, () => 1 / 7) },
];

/** Total of a scorecard under another weight set. */
function reweighted(r: PipelineResult, weights: readonly number[]): number {
  return (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).reduce(
    (s, d, i) => s + weights[i]! * r.scorecard.dimensions[d].score,
    0,
  );
}

/** Platform tier weights for the device aggregate (design doc §5.2.4). */
export const TIER_WEIGHTS: Readonly<Record<string, number>> = { low: 0.35, mid: 0.4, high: 0.25 };

const ci = (r: PipelineResult): string => (r.totalCi ? ` [${fmt(r.totalCi.low)}, ${fmt(r.totalCi.high)}]` : '');

/**
 * Per tier, the best total and, among the pipelines whose 95% interval overlaps the best one's, the cheapest (least
 * CPU per camera frame including the concurrent slow loop, then highest total): overlapping intervals are not a
 * difference, and the lower cost wins (design doc §5.2.4).
 */
export function selectTiers(
  results: readonly PipelineResult[],
): { tier: string; chosen: PipelineResult; best: PipelineResult; tied: readonly string[] }[] {
  return Object.keys(TIER_WEIGHTS).flatMap((tier) => {
    const list = results.filter((r) => r.tier === tier && !r.id.startsWith('B0'));
    if (!list.length) return [];
    const best = list.reduce((a, b) => (b.scorecard.total > a.scorecard.total ? b : a));
    const low = best.totalCi?.low ?? best.scorecard.total;
    const tied = list.filter((r) => (r.totalCi?.high ?? r.scorecard.total) >= low);
    const cost = (r: PipelineResult): number => r.metrics.cpuPerFrameMs ?? r.metrics.computeP95Ms ?? Infinity;
    const chosen = [...tied].sort((a, b) => cost(a) - cost(b) || b.scorecard.total - a.scorecard.total)[0]!;
    return [{ tier, chosen, best, tied: tied.map((r) => r.id) }];
  });
}

export function markdownReport(
  results: readonly PipelineResult[],
  context: { readonly tiers: readonly string[]; readonly kinds: readonly string[]; readonly date: string },
): string {
  const dims = Object.keys(DIMENSION_WEIGHTS) as Dimension[];
  const lines: string[] = [];
  lines.push(`# LiveMira Next 基准报告`, '');
  lines.push(`- 日期：${context.date}`);
  lines.push(
    `- 模拟设备档位：${context.tiers.join(', ')}（计算耗时按本机实测 × 档位系数，见 bench/src/sim/realtime.ts）`,
  );
  lines.push(`- 目标类型：${context.kinds.join(', ')}`);
  lines.push('- 分数中“实测占比”<100% 的维度，未测部分沿用设计文档预估值；D6 需真机/浏览器矩阵，当前全为预估。');
  lines.push(
    '- 总分后的方括号为 95% bootstrap 区间（S1 按扫描取值分层重采样，S2 按序列分层重采样）；区间重叠即不判优劣。',
    '',
  );
  for (const tier of context.tiers) {
    const rows = results.filter((r) => r.tier === tier);
    lines.push(`## 评分（${tier}）`, '');
    lines.push(`| 管线 | ${dims.map((d) => `${DIMENSION_NAMES[d]}`).join(' | ')} | 总分 | 封顶 |`);
    lines.push(`|---|${dims.map(() => '---').join('|')}|---|---|`);
    for (const r of rows)
      lines.push(
        `| ${r.id} ${r.title} | ${dims.map((d) => `${fmt(r.scorecard.dimensions[d].score, 1)}<sub>${Math.round(r.scorecard.dimensions[d].measured * 100)}%</sub>`).join(' | ')} | **${fmt(r.scorecard.total)}**${ci(r)} | ${r.scorecard.caps.join('；') || '—'} |`,
      );
    lines.push('', '<sub>下标为该维度的实测权重占比。</sub>', '');
  }
  const selection = selectTiers(results);
  if (selection.length === Object.keys(TIER_WEIGHTS).length) {
    lines.push('## 分档定型', '');
    lines.push(
      '| 档位 | 选定 | 总分 | CPU/帧 ms | 最高分 | 区间与最高分重叠的候选（CPU/帧 ms） |',
      '|---|---|---|---|---|---|',
    );
    const cpu = (id: string, tier: string): string =>
      fmt(results.find((r) => r.id === id && r.tier === tier)?.metrics.cpuPerFrameMs, 1);
    for (const s of selection)
      lines.push(
        `| ${s.tier} | ${s.chosen.id} | ${fmt(s.chosen.scorecard.total)}${ci(s.chosen)} | ${cpu(s.chosen.id, s.tier)} | ${s.best.id} ${fmt(s.best.scorecard.total)} | ${s.tied.map((id) => `${id} (${cpu(id, s.tier)})`).join(', ')} |`,
      );
    lines.push('', '<sub>CPU/帧：快环与并发慢环的全部计算按档位系数换算后，摊到每个相机帧（能耗代理，不计分）。</sub>');
    const aggregate = (pick: (tier: string) => PipelineResult | undefined): string => {
      let total = 0;
      for (const [tier, w] of Object.entries(TIER_WEIGHTS)) total += w * (pick(tier)?.scorecard.total ?? NaN);
      return fmt(total);
    };
    lines.push(
      '',
      `- 分档配置的设备聚合总分（低 0.35 / 中 0.40 / 高 0.25）：**${aggregate((t) => selection.find((s) => s.tier === t)?.chosen)}**`,
    );
    for (const id of [...new Set(results.map((r) => r.id))])
      lines.push(`- 单一配置 ${id} 全档聚合：${aggregate((t) => results.find((r) => r.id === id && r.tier === t))}`);
    lines.push('');
    lines.push('### 权重敏感性（§4.6 四组权重；括号内为档内名次）', '');
    lines.push(
      `| 档位 | 管线 | ${WEIGHT_SETS.map((w) => w.name).join(' | ')} |`,
      `|---|---|${WEIGHT_SETS.map(() => '---').join('|')}|`,
    );
    for (const s of selection) {
      const rows = results.filter((r) => r.tier === s.tier);
      const ranks = WEIGHT_SETS.map((w) =>
        [...rows].sort((a, b) => reweighted(b, w.weights) - reweighted(a, w.weights)).map((r) => r.id),
      );
      for (const r of rows)
        lines.push(
          `| ${s.tier} | ${r.id === s.chosen.id ? `**${r.id}**` : r.id} | ${WEIGHT_SETS.map((w, i) => `${fmt(reweighted(r, w.weights))} (${ranks[i]!.indexOf(r.id) + 1})`).join(' | ')} |`,
        );
    }
    lines.push('');
  }
  for (const tier of context.tiers) {
    const rows = results.filter((r) => r.tier === tier);
    lines.push(`## 指标（${tier}）`, '');
    lines.push(`| 指标 | 维度 | ${rows.map((r) => r.id).join(' | ')} |`);
    lines.push(`|---|---|${rows.map(() => '---').join('|')}|`);
    for (const m of METRICS)
      lines.push(
        `| ${m.label} | ${m.dimension} | ${rows.map((r) => `${fmt(r.metrics[m.key])} (${fmt(r.scorecard.metricScores[m.key], 1)})`).join(' | ')} |`,
      );
    lines.push('', '<sub>括号内为该指标的 10 分制得分。</sub>', '');
  }
  lines.push('## S1 召回率', '');
  for (const r of results.filter((x) => x.tier === context.tiers[0])) {
    lines.push(`### ${r.id}`, '');
    for (const [factor, values] of Object.entries(r.sweep.recall))
      lines.push(
        `- ${factor}: ${Object.entries(values)
          .map(([v, recall]) => `${v}→${Math.round(recall * 100)}%`)
          .join(', ')}`,
      );
    lines.push(
      `- 平均角点误差：${fmt(r.sweep.meanErrorPct)}% 对角线；单帧检测中位耗时（本机）：${fmt(r.sweep.detectP50Ms)} ms`,
      '',
    );
  }
  lines.push('## S2 序列', '');
  if (context.tiers.length > 1) lines.push('多档运行时只列 T3 与 T7；完整数据见 results.json。', '');
  lines.push(
    `| 管线 | 档位 | 序列 | 目标 | TTFP ms | 跟踪存活 % | 显示正确 % | 错位 p50/p95 % | 高频抖动 px | 静止 σ px | 错误叠加 % | 重获 ms | 位姿年龄 ms | 背景刷新 | 计算 p50/p95 ms | 处理帧比 |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results)
    for (const s of r.sequences) {
      if (context.tiers.length > 1 && s.sequence !== 'T3-shake' && s.sequence !== 'T7-occlusion') continue;
      const m = s.metrics;
      lines.push(
        `| ${r.id} | ${r.tier} | ${s.sequence} | ${s.kind} | ${fmt(m.ttfpMs, 0)} | ${fmt(100 * s.tracking.survival, 1)} | ${fmt(100 * m.survival, 1)} | ${fmt(m.errP50 === null ? null : 100 * m.errP50)}/${fmt(m.errP95 === null ? null : 100 * m.errP95)} | ${fmt(s.tracking.hfJitterPx)} | ${s.sequence === 'T1-static' ? fmt(s.tracking.staticJitterPx, 3) : '—'} | ${fmt(100 * m.ghostRate, 1)} | ${fmt(m.reacquireMs, 0)} | ${fmt(m.overlayAgeMs, 0)} | ${fmt(m.backgroundRefresh)} | ${fmt(s.computeP50Ms, 1)}/${fmt(s.computeP95Ms, 1)} | ${fmt(s.processedRatio)} |`,
      );
    }
  lines.push('', '## 目标资产', '');
  for (const r of results.filter((x) => x.tier === context.tiers[0]))
    lines.push(
      `- ${r.id}: ${r.targets.map((t) => `${t.id} ${(t.bytes / 1024).toFixed(0)} KiB（gzip ${(t.gzipBytes / 1024).toFixed(0)} KiB，编译 ${t.compileMs.toFixed(0)} ms）`).join('；')}`,
    );
  return `${lines.join('\n')}\n`;
}
