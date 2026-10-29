// SPDX-License-Identifier: Apache-2.0
// Measured metrics → 10-point dimension scores (design doc §5.2.4): piecewise-linear anchors per metric, weighted
// within each dimension over the metrics this run could measure, then the §4.1 dimension weights. Dimensions or
// metrics that need a browser or a real device keep the design estimate and are marked as such.

export type Dimension = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6' | 'D7';

export const DIMENSION_WEIGHTS: Readonly<Record<Dimension, number>> = {
  D1: 0.18,
  D2: 0.18,
  D3: 0.17,
  D4: 0.15,
  D5: 0.08,
  D6: 0.12,
  D7: 0.12,
};

export const DIMENSION_NAMES: Readonly<Record<Dimension, string>> = {
  D1: '识别',
  D2: '稳定',
  D3: '同步',
  D4: '性能',
  D5: '体积启动',
  D6: '规范',
  D7: '工程',
};

/** Metric values at scores 10, 8, 6, 4, 2, 0 (monotonic, either direction). */
export type Anchors = readonly [number, number, number, number, number, number];

export interface MetricSpec {
  readonly key: string;
  readonly dimension: Dimension;
  readonly weight: number;
  readonly anchors: Anchors;
  readonly label: string;
}

export const METRICS: readonly MetricSpec[] = [
  { key: 'rollCoverageDeg', dimension: 'D1', weight: 0.25, anchors: [180, 180, 45, 15, 5, 0], label: '旋转覆盖(°)' },
  { key: 'minLongPx', dimension: 'D1', weight: 0.15, anchors: [48, 64, 96, 160, 240, 320], label: '最小长边(px)' },
  { key: 'maxTiltDeg', dimension: 'D1', weight: 0.15, anchors: [75, 70, 60, 50, 30, 0], label: '最大倾角(°)' },
  { key: 'minGain', dimension: 'D1', weight: 0.1, anchors: [0.15, 0.25, 0.4, 0.6, 0.8, 1], label: '最低增益' },
  { key: 'maxBlurPx', dimension: 'D1', weight: 0.1, anchors: [32, 24, 16, 12, 8, 0], label: '最大模糊(px)' },
  {
    key: 'falsePerThousand',
    dimension: 'D1',
    weight: 0.15,
    anchors: [0.01, 0.1, 0.5, 2, 5, 10],
    label: '误识(每千帧)',
  },
  {
    key: 'staticJitterPx',
    dimension: 'D2',
    weight: 0.3,
    anchors: [0.03, 0.08, 0.2, 0.5, 1, 2],
    label: '静止抖动σ(px)',
  },
  { key: 'hfJitterPx', dimension: 'D2', weight: 0.15, anchors: [0.05, 0.15, 0.4, 1, 2, 4], label: '高频抖动(px)' },
  { key: 'survivalPct', dimension: 'D2', weight: 0.25, anchors: [99.5, 98, 95, 85, 70, 50], label: '存活率(%)' },
  { key: 'maxOcclusion', dimension: 'D2', weight: 0.1, anchors: [0.8, 0.65, 0.5, 0.35, 0.2, 0], label: '遮挡容忍' },
  { key: 'ghostPct', dimension: 'D2', weight: 0.1, anchors: [0, 0.2, 1, 3, 8, 20], label: '错误叠加(%)' },
  { key: 'reacquireMs', dimension: 'D2', weight: 0.1, anchors: [50, 100, 200, 400, 800, 1500], label: '重获(ms)' },
  {
    key: 'registrationP95Pct',
    dimension: 'D3',
    weight: 0.45,
    anchors: [0.2, 0.5, 1.5, 4, 8, 15],
    label: '运动错位p95(%对角线)',
  },
  {
    key: 'overlayAgeMs',
    dimension: 'D3',
    weight: 0.25,
    anchors: [40, 55, 70, 100, 150, 250],
    label: '叠加位姿年龄(ms)',
  },
  {
    key: 'backgroundLagMs',
    dimension: 'D3',
    weight: 0.15,
    anchors: [0, 10, 25, 50, 100, 200],
    label: '背景额外延迟(ms)',
  },
  {
    key: 'backgroundRefresh',
    dimension: 'D3',
    weight: 0.15,
    anchors: [1, 0.95, 0.85, 0.7, 0.5, 0.3],
    label: '背景刷新比',
  },
  { key: 'computeP95Ms', dimension: 'D4', weight: 0.25, anchors: [4, 8, 16, 33, 66, 120], label: '单帧计算p95(ms)' },
  { key: 'mainThreadMs', dimension: 'D4', weight: 0.15, anchors: [0.5, 1, 2, 5, 10, 16], label: '主线程/帧(ms)' },
  { key: 'processedRatio', dimension: 'D4', weight: 0.3, anchors: [1, 0.95, 0.8, 0.6, 0.4, 0.2], label: '处理帧比' },
  {
    key: 'sustainedRatio',
    dimension: 'D4',
    weight: 0.15,
    anchors: [1, 0.95, 0.85, 0.7, 0.5, 0.3],
    label: '持续性能比[真机]',
  },
  { key: 'energyIndex', dimension: 'D4', weight: 0.15, anchors: [0.5, 0.75, 1, 1.5, 2, 3], label: '能耗指数[真机]' },
  {
    key: 'engineKb',
    dimension: 'D5',
    weight: 0.25,
    anchors: [60, 150, 300, 800, 2000, 5000],
    label: '引擎体积(KB gz)',
  },
  { key: 'targetKb', dimension: 'D5', weight: 0.2, anchors: [50, 150, 300, 800, 2000, 5000], label: '单目标(KB gz)' },
  {
    key: 'coldStartMs',
    dimension: 'D5',
    weight: 0.2,
    anchors: [300, 600, 1000, 1500, 2500, 4000],
    label: '冷启动(ms)[浏览器]',
  },
  { key: 'ttfpMs', dimension: 'D5', weight: 0.35, anchors: [50, 100, 200, 400, 800, 1500], label: '首次显示(ms)' },
  {
    key: 'matrixPassPct',
    dimension: 'D6',
    weight: 0.45,
    anchors: [100, 98, 95, 85, 70, 50],
    label: '矩阵通过率(%)[真机]',
  },
  {
    key: 'primaryPathPct',
    dimension: 'D6',
    weight: 0.25,
    anchors: [90, 75, 50, 30, 10, 0],
    label: '主路径覆盖(%)[真机]',
  },
  { key: 'errorsPerHour', dimension: 'D6', weight: 0.3, anchors: [0, 0.2, 1, 3, 10, 30], label: '错误/小时[真机]' },
  { key: 'determinismPct', dimension: 'D7', weight: 0.35, anchors: [100, 99, 95, 80, 50, 0], label: '确定性(%)' },
  { key: 'coveragePct', dimension: 'D7', weight: 0.35, anchors: [85, 75, 60, 40, 20, 0], label: '测试覆盖率(%)' },
  {
    key: 'maxModuleLoc',
    dimension: 'D7',
    weight: 0.3,
    anchors: [300, 500, 800, 1200, 2000, 4000],
    label: '最大模块行数',
  },
];

/** Piecewise-linear score of `value` against anchors for 10, 8, 6, 4, 2, 0. */
export function anchorScore(value: number, anchors: Anchors): number {
  const scores = [10, 8, 6, 4, 2, 0];
  const increasing = anchors[5] > anchors[0];
  const better = (a: number, b: number): boolean => (increasing ? a <= b : a >= b);
  if (better(value, anchors[0])) return 10;
  if (!better(value, anchors[5])) return 0;
  for (let i = 0; i < 5; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (better(value, b)) {
      if (a === b) return scores[i]!;
      return scores[i]! + ((scores[i + 1]! - scores[i]!) * (value - a)) / (b - a);
    }
  }
  return 0;
}

export interface DimensionScore {
  readonly score: number;
  /** Share of the dimension's metric weight that was measured, 0..1. */
  readonly measured: number;
}

export interface Scorecard {
  readonly dimensions: Readonly<Record<Dimension, DimensionScore>>;
  readonly total: number;
  readonly metricScores: Readonly<Record<string, number>>;
  /** Labels of the cap rules that fired. */
  readonly caps: readonly string[];
}

export interface CapRule {
  readonly key: string;
  /** The rule fires when the metric is above `above` or below `below`. */
  readonly above?: number;
  readonly below?: number;
  readonly dimension: Dimension;
  readonly cap: number;
  readonly label: string;
}

/** Design doc §5.2.4: one fatal defect must not be averaged away. */
export const CAPS: readonly CapRule[] = [
  { key: 'falsePerThousand', above: 2, dimension: 'D1', cap: 4, label: 'R-3 误识 >2/千帧 → D1 ≤4' },
  { key: 'registrationP95Pct', above: 8, dimension: 'D3', cap: 3, label: 'Y-1 p95 >8% → D3 ≤3' },
  { key: 'sustainedRatio', below: 0.5, dimension: 'D4', cap: 4, label: 'P-6 <0.5 → D4 ≤4' },
  { key: 'crashesPerHour', above: 1, dimension: 'D6', cap: 3, label: 'C-3 崩溃 >1/小时 → D6 ≤3' },
];

/**
 * Scores the measured metrics. A dimension's unmeasured weight is filled with `estimate` (the design-doc estimate of
 * the pipeline), so partially measured dimensions blend measurement and estimate in proportion.
 */
export function score(
  metrics: Readonly<Record<string, number | null | undefined>>,
  estimate: Readonly<Record<Dimension, number>>,
): Scorecard {
  const metricScores: Record<string, number> = {};
  const dims = {} as Record<Dimension, DimensionScore>;
  for (const dim of Object.keys(DIMENSION_WEIGHTS) as Dimension[]) {
    const specs = METRICS.filter((m) => m.dimension === dim);
    const total = specs.reduce((s, m) => s + m.weight, 0);
    let weighted = 0;
    let measured = 0;
    for (const m of specs) {
      const v = metrics[m.key];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      const s = anchorScore(v, m.anchors);
      metricScores[m.key] = s;
      weighted += s * m.weight;
      measured += m.weight;
    }
    const share = total ? measured / total : 0;
    const value = total ? (weighted + (total - measured) * estimate[dim]) / total : estimate[dim];
    dims[dim] = { score: value, measured: share };
  }
  const caps: string[] = [];
  for (const rule of CAPS) {
    const v = metrics[rule.key];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if ((rule.above !== undefined && v > rule.above) || (rule.below !== undefined && v < rule.below)) {
      caps.push(rule.label);
      const d = dims[rule.dimension];
      dims[rule.dimension] = { score: Math.min(d.score, rule.cap), measured: d.measured };
    }
  }
  const totalScore = (Object.keys(DIMENSION_WEIGHTS) as Dimension[]).reduce(
    (s, d) => s + DIMENSION_WEIGHTS[d] * dims[d].score,
    0,
  );
  return { dimensions: dims, total: totalScore, metricScores, caps };
}
