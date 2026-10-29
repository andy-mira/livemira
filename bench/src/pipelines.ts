// SPDX-License-Identifier: Apache-2.0
// Pipelines the benchmark can run, with the costs and estimates the simulation needs. Costs not measurable in Node
// (capture-to-worker arrival, main-thread work) are mid-tier assumptions until the browser probes measure them.

import type { VisionPipeline } from '@livemira-next/contracts';

import { KalmanPoseFilter, OneEuroPoseFilter } from '@livemira-next/filters';
import { OrbDetector } from '@livemira-next/features';
import { DualLoopPipeline, TemplateTracker, type EsmOptions, type TemplateTrackerMode } from '@livemira-next/tracking';

import { BaselinePipeline } from './adapters/baseline.ts';
import { FilteredPipeline } from './adapters/compose.ts';
import { BaselineC4Detector } from './adapters/detector.ts';
import type { Dimension } from './score/score.ts';
import type { CompositorMode } from './sim/display.ts';
import type { PipelineCosts } from './sim/realtime.ts';

export interface PipelineEntry {
  readonly id: string;
  readonly title: string;
  readonly create: () => VisionPipeline;
  readonly costs: PipelineCosts;
  readonly compositor: CompositorMode;
  /** Gzip bytes of the shipped engine (JS + WASM), when known. */
  readonly engineGzipBytes: number | null;
  /** Product modules to bundle for the size metric instead of a fixed size (entry source of re-exports). */
  readonly bundle?: string;
  /** Source directories of the shipped product code, for the module-size metric. */
  readonly sources: readonly string[];
  /** Design-doc estimate, used for what this run cannot measure. */
  readonly estimate: Readonly<Record<Dimension, number>>;
}

/** Baseline costs: main-thread canvas readback + preview draw, copy, transfer and gray conversion (§2.5.1). */
const BASELINE_COSTS: PipelineCosts = { arrivalUs: 8000, mainThreadUs: 6000 };
const BASELINE_SOURCES = ['contracts', 'compute', 'recognition', 'target-compiler', 'tracking'].map(
  (p) => `bench/baseline/${p}/src`,
);
const B0_ESTIMATE = { D1: 4.0, D2: 4.5, D3: 3.5, D4: 4.0, D5: 6.0, D6: 7.0, D7: 7.5 } as const;
const oneEuro = (inner: VisionPipeline, id: string): VisionPipeline =>
  new FilteredPipeline(inner, (targets) => new OneEuroPoseFilter(targets), id);

/**
 * Next-gen capture (A1 worker capture + A2 luma read). From the P4 browser probes (bench/browser/run.ts, M4 Max):
 * luma 0.9 ms (Chromium, Y plane) – 2.4 ms (WebKit, RGB), main thread 0.01–0.03 ms plus a 0.1–0.7 ms WebGL draw;
 * scaled to the mid tier (×4) these are ≈6 ms arrival and ≈1.5 ms main thread per frame.
 */
const NEXT_COSTS: PipelineCosts = { arrivalUs: 6000, mainThreadUs: 1500 };
const NEXT_SOURCES = ['contracts', 'geometry', 'filters', 'imaging', 'tracking'].map((p) => `packages/${p}/src`);
const N3_SOURCES = [...NEXT_SOURCES, 'packages/features/src'];
/** Product exports an N3 engine ships (the engine shell and renderer are added in P4). */
const N3_BUNDLE = [
  "export { DualLoopPipeline, TemplateTracker } from '@livemira-next/tracking';",
  "export { OrbDetector } from '@livemira-next/features';",
  "export { KalmanPoseFilter } from '@livemira-next/filters';",
].join('\n');

const n3 = (
  id: string,
  relocalizeEvery: number,
  filter: 'E1' | 'E2' = 'E2',
  asyncRelocalization = false,
  esm: EsmOptions = {},
): VisionPipeline =>
  new DualLoopPipeline(
    {
      id,
      detector: new OrbDetector(),
      tracker: new TemplateTracker({ mode: 'esm', esm }),
      filter: (targets) => (filter === 'E2' ? new KalmanPoseFilter(targets) : new OneEuroPoseFilter(targets)),
    },
    { relocalizeEvery, asyncRelocalization },
  );

/** R2-type single-Worker pipelines of the combination page: slow loop 1 Hz in the same Worker. */
const r2 = (id: string, mode: TemplateTrackerMode, filter: 'E1' | 'E2', esm: EsmOptions = {}): VisionPipeline =>
  new DualLoopPipeline(
    {
      id,
      detector: new OrbDetector(),
      tracker: new TemplateTracker({ mode, esm }),
      filter: (targets) => (filter === 'E2' ? new KalmanPoseFilter(targets) : new OneEuroPoseFilter(targets)),
    },
    { relocalizeEvery: 30, asyncRelocalization: false },
  );

const dualLoop = (mode: TemplateTrackerMode, id: string, relocalizeEvery = 10): VisionPipeline =>
  new DualLoopPipeline(
    {
      id,
      detector: new BaselineC4Detector(),
      tracker: new TemplateTracker({ mode }),
      filter: (targets) => new OneEuroPoseFilter(targets),
    },
    { relocalizeEvery },
  );

export const PIPELINES: readonly PipelineEntry[] = [
  {
    id: 'B0',
    title: '基线 LiveMira 0.4.1',
    create: () => new BaselinePipeline(),
    costs: BASELINE_COSTS,
    compositor: 'async',
    engineGzipBytes: 57457,
    sources: BASELINE_SOURCES,
    estimate: B0_ESTIMATE,
  },
  {
    id: 'B0+E1',
    title: '基线 + One Euro 滤波',
    create: () => oneEuro(new BaselinePipeline(), 'B0+E1'),
    costs: BASELINE_COSTS,
    compositor: 'async',
    engineGzipBytes: 57457 + 1500,
    sources: [...BASELINE_SOURCES, 'packages/filters/src'],
    estimate: { ...B0_ESTIMATE, D2: 6.2, D3: 3.3, D7: 7.8 },
  },
  {
    id: 'B0+E1+F4',
    title: '基线 + One Euro + 显示时刻预测（F4/F2 晚绑定）',
    create: () => oneEuro(new BaselinePipeline(), 'B0+E1+F4'),
    costs: BASELINE_COSTS,
    compositor: 'predicted',
    engineGzipBytes: 57457 + 2000,
    sources: [...BASELINE_SOURCES, 'packages/filters/src'],
    estimate: { ...B0_ESTIMATE, D2: 6.2, D3: 4.5, D7: 7.6 },
  },
  {
    id: 'B0+C4',
    title: '基线 + 鲁棒几何 C4（含引导匹配）',
    create: () => new BaselinePipeline({ geometry: 'c4' }),
    costs: BASELINE_COSTS,
    compositor: 'async',
    engineGzipBytes: 57457 + 4000,
    sources: [...BASELINE_SOURCES, 'packages/geometry/src'],
    estimate: { D1: 4.6, D2: 5.3, D3: 3.6, D4: 4.6, D5: 6.0, D6: 7.0, D7: 7.6 },
  },
  {
    id: 'B0+C4+E1+F4',
    title: '基线 + C4 + One Euro + 显示时刻预测',
    create: () => oneEuro(new BaselinePipeline({ geometry: 'c4' }), 'B0+C4+E1+F4'),
    costs: BASELINE_COSTS,
    compositor: 'predicted',
    engineGzipBytes: 57457 + 6000,
    sources: [...BASELINE_SOURCES, 'packages/geometry/src', 'packages/filters/src'],
    estimate: { D1: 4.6, D2: 6.5, D3: 4.6, D4: 4.6, D5: 6.0, D6: 7.0, D7: 7.5 },
  },
  ...(['klt', 'esm', 'klt+esm'] as const).flatMap((mode) =>
    (['predicted', 'frame-locked'] as const).map((compositor): PipelineEntry => ({
      id: `N2-${mode}${compositor === 'frame-locked' ? '-F1' : ''}`,
      title: `双环 D4 + ${mode.toUpperCase()} + E1 ${compositor === 'frame-locked' ? '+ 帧锁定 F1' : '+ 预测 F2'}（慢环 B0+C4）`,
      create: () => dualLoop(mode, `N2-${mode}`),
      costs: NEXT_COSTS,
      compositor,
      engineGzipBytes: 57457 + 14000,
      sources: [...BASELINE_SOURCES, ...NEXT_SOURCES],
      estimate: { D1: 4.6, D2: 7.5, D3: compositor === 'frame-locked' ? 7.0 : 5.5, D4: 6.0, D5: 6.2, D6: 6.8, D7: 7.0 },
    })),
  ),
  {
    id: 'N2-ncc-F1',
    title: '双环 D4 + NCC 补丁 D3 + E1 + 帧锁定 F1（慢环 B0+C4）',
    create: () => dualLoop('ncc', 'N2-ncc'),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: 57457 + 14000,
    sources: [...BASELINE_SOURCES, ...NEXT_SOURCES],
    estimate: { D1: 4.4, D2: 7.0, D3: 6.8, D4: 6.2, D5: 6.2, D6: 6.8, D7: 7.0 },
  },
  {
    id: 'N3-F1-r30',
    title: '双环 D4：C1 定向特征慢环（1 Hz）+ ESM 快环 + E2 + 帧锁定 F1',
    create: () => n3('N3-r30', 30),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.2, D2: 8.0, D3: 7.5, D4: 6.5, D5: 7.5, D6: 6.8, D7: 7.0 },
  },
  {
    id: 'N3-F1-r10-async',
    title: '双环 D4（慢环并发 Worker，3 Hz）：C1 + ESM + E2 + 帧锁定 F1',
    create: () => n3('N3-r10-async', 10, 'E2', true),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.2, D2: 8.2, D3: 7.8, D4: 7.4, D5: 7.6, D6: 6.6, D7: 6.8 },
  },
  {
    id: 'N3-F1-r30-field',
    title: '同 N3-F1-r30，但 ESM 用整层 Scharr 梯度图（梯度 A/B）',
    create: () => n3('N3-r30-field', 30, 'E2', false, { gradients: 'field' }),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.2, D2: 8.0, D3: 7.5, D4: 6.5, D5: 7.5, D6: 6.8, D7: 7.0 },
  },
  // P6 combination search: slow-loop rate and concurrency, ESM effort, composition (design doc §5.3.2).
  ...(
    [
      ['N3-F1-r30-async', '双环 D4（慢环并发，1 Hz）：C1 + ESM + E2 + 帧锁定 F1', 30, true, {}, 'frame-locked'],
      ['N3-F1-r60-async', '双环 D4（慢环并发，0.5 Hz）：C1 + ESM + E2 + 帧锁定 F1', 60, true, {}, 'frame-locked'],
      [
        'N3-F1-r10-async-lite',
        '双环 D4（慢环并发，3 Hz）+ 轻量 ESM（迭代 5/4/3）+ E2 + 帧锁定 F1',
        10,
        true,
        { iterations: [5, 4, 3] },
        'frame-locked',
      ],
      [
        'N3-F1-r30-async-lite',
        '双环 D4（慢环并发，1 Hz）+ 轻量 ESM（迭代 5/4/3）+ E2 + 帧锁定 F1',
        30,
        true,
        { iterations: [5, 4, 3] },
        'frame-locked',
      ],
      [
        'N3-F2-r10-async',
        '双环 D4（慢环并发，3 Hz）：C1 + ESM + E2 + 预测 F2/F4（无 WebGL2/VideoFrame 时）',
        10,
        true,
        {},
        'predicted',
      ],
    ] as const
  ).map(([id, title, every, concurrent, esm, compositor]): PipelineEntry => ({
    id,
    title,
    create: () => n3(id, every, 'E2', concurrent, esm),
    costs: NEXT_COSTS,
    compositor,
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: {
      D1: 7.2,
      D2: 8.2,
      D3: compositor === 'frame-locked' ? 7.8 : 6.0,
      D4: 7.4,
      D5: 7.6,
      D6: compositor === 'frame-locked' ? 6.6 : 7.0,
      D7: 6.8,
    },
  })),
  // The R2 family of the device combination page (bench/device/modules.ts), simulated.
  ...(
    [
      ['R2', 'R2 轻量全兼容：D3 + 1 Hz 串行 + E1 + F4（无预测）', 'ncc', 'E1', 'async'],
      ['R2a', 'R2a 预测兼容：D2 轻量 + 1 Hz 串行 + E2 + F2', 'esm', 'E2', 'predicted'],
      ['R2b', 'R2b 轻量帧锁定：D2 轻量 + 1 Hz 串行 + E2 + F1', 'esm', 'E2', 'frame-locked'],
      ['R2c', 'R2c 保留 NCC：D3 + 1 Hz 串行 + E2 + F2', 'ncc', 'E2', 'predicted'],
    ] as const
  ).map(([id, title, mode, filter, compositor]): PipelineEntry => ({
    id,
    title,
    create: () => r2(id, mode, filter, mode === 'esm' ? { iterations: [5, 4, 3] } : {}),
    costs: NEXT_COSTS,
    compositor,
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.0, D2: 7.2, D3: 6.5, D4: 7.0, D5: 8.2, D6: 7.6, D7: 7.6 },
  })),
  {
    id: 'N3-E1-F1-r30',
    title: '双环 D4：C1 慢环（1 Hz）+ ESM + E1 + 帧锁定 F1（滤波 A/B）',
    create: () => n3('N3-E1-r30', 30, 'E1'),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.2, D2: 8.0, D3: 7.5, D4: 6.5, D5: 7.5, D6: 6.8, D7: 7.0 },
  },
  {
    id: 'N3-F2-r30',
    title: '双环 D4：C1 慢环（1 Hz）+ ESM + E2 + 预测 F2',
    create: () => n3('N3-r30', 30),
    costs: NEXT_COSTS,
    compositor: 'predicted',
    engineGzipBytes: null,
    bundle: N3_BUNDLE,
    sources: N3_SOURCES,
    estimate: { D1: 7.2, D2: 8.0, D3: 6.0, D4: 6.5, D5: 7.5, D6: 7.0, D7: 7.0 },
  },
  {
    id: 'N2-esm-F1-r30',
    title: '双环 D4 + ESM + E1 + 帧锁定 F1，慢环 1 Hz（慢环 B0+C4）',
    create: () => dualLoop('esm', 'N2-esm-r30', 30),
    costs: NEXT_COSTS,
    compositor: 'frame-locked',
    engineGzipBytes: 57457 + 14000,
    sources: [...BASELINE_SOURCES, ...NEXT_SOURCES],
    estimate: { D1: 4.6, D2: 7.5, D3: 7.0, D4: 6.0, D5: 6.2, D6: 6.8, D7: 7.0 },
  },
];

export function pipelineById(id: string): PipelineEntry {
  const entry = PIPELINES.find((p) => p.id === id);
  if (!entry) throw new Error(`Unknown pipeline ${id}; known: ${PIPELINES.map((p) => p.id).join(', ')}`);
  return entry;
}
