// SPDX-License-Identifier: Apache-2.0
// Module catalogue of the combination test page (test side): the layers and candidates of design doc §3 that the
// browser engine can swap today, the dependency and exclusion rules of §3.12 restricted to them, the device
// capabilities each needs, three presets (§3.11 R1/R2/R3 as far as implemented), and the mapping of a combination
// to engine options. Candidates that are not implemented are listed with the reason, never selectable.

import type { Capability } from '@livemira-next/contracts';
import type { CapturePath, PipelineConfig, ProfileId } from '@livemira-next/web';

import type { CompositorKind } from '../prototype/index.ts';

/** The engine profiles' combination ids in the design doc and the device reports. */
export const PROFILE_CODES: Readonly<Record<ProfileId, 'R3' | 'R1' | 'R2b'>> = { hawk: 'R3', swift: 'R1', wren: 'R2b' };

export interface Combination {
  /** L0: A1 Worker capture (MSTP), A2 main-thread VideoFrame snapshots, or the baseline's canvas readback. */
  readonly capture: 'A1' | 'A2' | 'canvas';
  /** L1: B1 WASM SIMD kernels, or the JavaScript references. */
  readonly compute: 'B1' | 'js';
  /** L3 fast loop: D2 ESM, D1 KLT, D1 prior + D2 refinement, D3 NCC patches. */
  readonly tracker: 'D2' | 'D1' | 'D1+D2' | 'D3';
  /** ESM effort (D2 only): iterations 8/6/5 or 5/4/3. */
  readonly esm: 'standard' | 'lite';
  /** L3 slow loop (D4): relocalisation rate and whether it runs in a second Worker. */
  readonly slowRate: '3' | '1' | '0.5';
  readonly slowConcurrent: boolean;
  /** L4: E2 Kalman or E1 One Euro. */
  readonly filter: 'E2' | 'E1';
  /** L5: F1 frame-locked WebGL2, F2 predicted CSS (late binding), F4 plain CSS. */
  readonly render: 'F1' | 'F2' | 'F4';
  /** L6: G2 precompiled assets, or compiling the targets on the device. */
  readonly startup: 'G2' | 'compile';
}

export type Field = keyof Combination;

export interface Option<F extends Field = Field> {
  readonly value: Combination[F];
  readonly label: string;
  readonly note: string;
}

export interface Layer {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly { readonly field: Field; readonly title: string; readonly options: readonly Option[] }[];
  /** Candidates of this layer the engine does not have (shown, never selectable). */
  readonly missing: readonly { readonly id: string; readonly label: string; readonly reason: string }[];
}

export const LAYERS: readonly Layer[] = [
  {
    id: 'L0',
    title: 'L0 采集与传输',
    fields: [
      {
        field: 'capture',
        title: '采集路径',
        options: [
          { value: 'A1', label: 'A1 Worker 直采', note: 'MSTP 读帧（主线程或 Worker），亮度平面直读（A2）' },
          { value: 'A2', label: 'A2 主线程快照', note: 'rVFC 回调中 new VideoFrame(video)，转移给 Worker' },
          { value: 'canvas', label: '画布读回', note: '基线方式：主线程 drawImage + getImageData' },
        ],
      },
    ],
    missing: [{ id: 'A3', label: 'A3 采集参数治理', reason: '时间戳部分已内置；帧率/曝光约束未实现' }],
  },
  {
    id: 'L1',
    title: 'L1 计算加速',
    fields: [
      {
        field: 'compute',
        title: '内核',
        options: [
          { value: 'B1', label: 'B1 WASM SIMD', note: 'FAST-9 与 Hamming 匹配走 SIMD 内核' },
          { value: 'js', label: 'JavaScript 参考实现', note: '结果逐位相同，仅速度不同（用于 A/B）' },
        ],
      },
    ],
    missing: [
      { id: 'B2', label: 'B2 WebGPU 计算', reason: '只有可行性探针（测试 ②），未接入管线' },
      { id: 'B3', label: 'B3 WebGL2 GPGPU', reason: '未实现' },
    ],
  },
  {
    id: 'L2',
    title: 'L2 识别（慢环）',
    fields: [],
    missing: [
      { id: 'C2', label: 'C2 学习型特征', reason: '未实现（依赖 B2）' },
      { id: 'C3', label: 'C3 两级检索', reason: '未实现（目标超过 10 个时才需要）' },
    ],
  },
  {
    id: 'L3',
    title: 'L3 帧间跟踪（快环）与双环编排',
    fields: [
      {
        field: 'tracker',
        title: '快环跟踪器',
        options: [
          { value: 'D2', label: 'D2 ESM', note: '整幅模板直接法对齐（默认）' },
          { value: 'D1+D2', label: 'D1 先验 + D2 精化', note: 'KLT 给先验，ESM 绝对精化' },
          { value: 'D1', label: 'D1 KLT', note: '金字塔光流 + 单应传播' },
          { value: 'D3', label: 'D3 NCC 补丁', note: '目标锚定补丁，与 D2 互为 A/B' },
        ],
      },
      {
        field: 'esm',
        title: 'ESM 迭代',
        options: [
          { value: 'standard', label: '标准 8/6/5', note: '' },
          { value: 'lite', label: '轻量 5/4/3', note: '省算力' },
        ],
      },
      {
        field: 'slowRate',
        title: '慢环频率（D4）',
        options: [
          { value: '0.5', label: '0.5 Hz', note: 'P6 定型' },
          { value: '1', label: '1 Hz', note: '' },
          { value: '3', label: '3 Hz', note: '纠偏更快，更耗电' },
        ],
      },
      {
        field: 'slowConcurrent',
        title: '慢环运行位置',
        options: [
          { value: true, label: '独立 Worker（并发）', note: '检测不阻塞快环' },
          { value: false, label: '同一 Worker（串行）', note: '单线程，兼容性最好' },
        ],
      },
    ],
    missing: [{ id: 'D5', label: 'D5 学习型点跟踪', reason: '未实现' }],
  },
  {
    id: 'L4',
    title: 'L4 防抖滤波与融合',
    fields: [
      {
        field: 'filter',
        title: '滤波',
        options: [
          { value: 'E2', label: 'E2 卡尔曼（角点空间）', note: '带协方差与预测（默认）' },
          { value: 'E1', label: 'E1 One Euro', note: '自适应低通，无协方差' },
        ],
      },
    ],
    missing: [{ id: 'E3', label: 'E3 陀螺仪/IMU 融合', reason: '未实现（需 iOS 运动权限）' }],
  },
  {
    id: 'L5',
    title: 'L5 虚实同步渲染',
    fields: [
      {
        field: 'render',
        title: '合成方式',
        options: [
          { value: 'F1', label: 'F1 帧锁定（WebGL2）', note: '同一帧画面与位姿一起绘制' },
          { value: 'F2', label: 'F2 预测晚绑定（CSS）', note: '原生视频 + 外推到屏上帧时刻' },
          { value: 'F4', label: 'F4 CSS 兜底', note: '原生视频 + 最新位姿，不预测' },
        ],
      },
    ],
    missing: [{ id: 'F3', label: 'F3 3D 位姿渲染', reason: '6DoF 位姿已算出，3D 内容渲染未实现' }],
  },
  {
    id: 'L6',
    title: 'L6 调度与启动',
    fields: [
      {
        field: 'startup',
        title: '目标加载',
        options: [
          { value: 'G2', label: 'G2 预编译资产', note: '启动快（默认）' },
          { value: 'compile', label: '现场编译', note: '开发路径，启动慢约 0.5 s' },
        ],
      },
    ],
    missing: [{ id: 'G1', label: 'G1 自适应 QoS', reason: '未实现' }],
  },
];

export interface Preset {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly combination: Combination;
  /** Candidates of the design-time preset that are not implemented (and what stands in for them). */
  readonly gaps: string;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'R1',
    title: 'R1 混合双环主线 · Swift 默认档位（P6 定型）',
    summary: 'A1 + B1 + C1/C4 + D2 ESM + D4 慢环 0.5 Hz 并发 + E2 + F1 + G2',
    combination: {
      capture: 'A1',
      compute: 'B1',
      tracker: 'D2',
      esm: 'standard',
      slowRate: '0.5',
      slowConcurrent: true,
      filter: 'E2',
      render: 'F1',
      startup: 'G2',
    },
    gaps: '设计中的 E3、B2 可选加速未实现',
  },
  {
    id: 'R2',
    title: 'R2 轻量全兼容',
    summary: 'A2 + B1 + C1/C4 + D3 NCC + D4 慢环 1 Hz 串行 + E1 + F4 + G2',
    combination: {
      capture: 'A2',
      compute: 'B1',
      tracker: 'D3',
      esm: 'standard',
      slowRate: '1',
      slowConcurrent: false,
      filter: 'E1',
      render: 'F4',
      startup: 'G2',
    },
    gaps: '与设计一致（单线程、CSS 兜底）。仿真 T3 错位 p95 中档 20%、低档 19%，与真机所见漂移一致',
  },
  // R2 variants (bench/results/r2-variants): one change each against R2 / R2a, to locate R2's drift.
  {
    id: 'R2a',
    title: 'R2a 预测兼容（无需 WebGL）',
    summary: 'A2 + B1 + C1/C4 + D2 轻量 + D4 慢环 1 Hz 串行 + E2 + F2 预测晚绑定 + G2',
    combination: {
      capture: 'A2',
      compute: 'B1',
      tracker: 'D2',
      esm: 'lite',
      slowRate: '1',
      slowConcurrent: false,
      filter: 'E2',
      render: 'F2',
      startup: 'G2',
    },
    gaps: '对比 R2：跟踪、滤波、显示都换掉。仿真 T3 错位 p95 中档 3.0%、低档 37.6%（低端机手抖时预测失效）',
  },
  {
    id: 'R2b',
    title: 'R2b 轻量帧锁定 · Wren 兼容档位（单线程 + WebGL2）',
    summary: 'A2 + B1 + C1/C4 + D2 轻量 + D4 慢环 1 Hz 串行 + E2 + F1 帧锁定 + G2',
    combination: {
      capture: 'A2',
      compute: 'B1',
      tracker: 'D2',
      esm: 'lite',
      slowRate: '1',
      slowConcurrent: false,
      filter: 'E2',
      render: 'F1',
      startup: 'G2',
    },
    gaps: '对比 R2a：只把显示换成帧锁定。仿真 T3 错位 p95 中、低档均为 0.10%，与 R1 相当',
  },
  {
    id: 'R2c',
    title: 'R2c 保留 NCC 跟踪',
    summary: 'A2 + B1 + C1/C4 + D3 NCC + D4 慢环 1 Hz 串行 + E2 + F2 预测晚绑定 + G2',
    combination: {
      capture: 'A2',
      compute: 'B1',
      tracker: 'D3',
      esm: 'standard',
      slowRate: '1',
      slowConcurrent: false,
      filter: 'E2',
      render: 'F2',
      startup: 'G2',
    },
    gaps: '对比 R2a：只把跟踪器换回 D3。仿真 T3 错位 p95 中档 38%、低档 30%，用于确认 D3 是 R2 漂移的主因',
  },
  {
    id: 'R3',
    title: 'R3 旗舰算力 · Hawk 可选档位（现有模块近似）',
    summary: 'A1 + B1 + C1/C4 + D1 先验 + D2 精化 + D4 慢环 3 Hz 并发 + E2 + F1 + G2',
    combination: {
      capture: 'A1',
      compute: 'B1',
      tracker: 'D1+D2',
      esm: 'standard',
      slowRate: '3',
      slowConcurrent: true,
      filter: 'E2',
      render: 'F1',
      startup: 'G2',
    },
    gaps: '设计中的 B2/X1（GPU 常驻）、C2、E3、F3 未实现，以 B1 与更高慢环频率代替',
  },
];

/** The baseline release engine, offered as a fourth preset for comparison (it is not built from these modules). */
export const BASELINE = {
  id: 'B0',
  title: 'B0 基线 LiveMira 0.4.1（原发布版）',
  summary: '主线程画布读回 + 每帧重新识别（无帧间跟踪）+ 基线滤波 + CSS 叠加',
  gaps: '独立的原发布版引擎，不参与模块组合；叠加层为识别到的目标边框（基线自带的可视化扩展）',
} as const;

/** A rule's verdict on one option given the rest of the combination and the device. */
export interface Verdict {
  /** Hard: the option cannot be used (dependency, exclusion or missing capability). */
  readonly blocked: string | null;
  /** Soft: usable, but against a recommendation. */
  readonly warning: string | null;
}

const has = (caps: ReadonlySet<Capability>, ...needed: Capability[]): boolean => needed.every((c) => caps.has(c));

/** §3.12 (implemented part) plus device capabilities, for `field` = `value` with the rest of `c`. */
export function verdict<F extends Field>(
  field: F,
  value: Combination[F],
  c: Combination,
  caps: ReadonlySet<Capability>,
): Verdict {
  const next = { ...c, [field]: value } as Combination;
  let blocked: string | null = null;
  let warning: string | null = null;
  switch (field) {
    case 'capture':
      if (value === 'A1' && !caps.has('mstp-window') && !caps.has('mstp-worker'))
        blocked = '本机不支持 MediaStreamTrackProcessor';
      else if (value === 'A2' && !has(caps, 'videoframe', 'rvfc')) blocked = 'A2 强依赖 VideoFrame 与 rVFC';
      else if (value === 'canvas' && !caps.has('rvfc')) blocked = '需要 rVFC';
      else if (value === 'canvas' && next.render === 'F1') blocked = 'F1 强依赖帧与位姿成对（A1/A2），画布读回不提供帧';
      break;
    case 'compute':
      if (value === 'js') warning = 'C1 依赖 B1 获得性能：慢环会明显变慢';
      break;
    case 'tracker':
      if (value === 'D2' && next.filter === 'E1') blocked = 'D2 强依赖先验（D1、E2 或 E3）：E1 不提供预测先验';
      break;
    case 'esm':
      if (next.tracker === 'D1' || next.tracker === 'D3') blocked = '只对含 D2 的快环有效';
      break;
    case 'slowRate':
      if (value === '3' && !next.slowConcurrent) warning = '3 Hz 串行慢环会周期性阻塞快环';
      break;
    case 'filter':
      if (value === 'E1' && next.tracker === 'D2')
        blocked = 'D2 强依赖先验（D1、E2 或 E3）：改用 D1+D2 或 D3 才能选 E1';
      else if (value === 'E1' && next.render === 'F2') blocked = 'F2 强依赖 E2/E3 的预测';
      break;
    case 'render':
      if (value === 'F1' && !has(caps, 'webgl2', 'videoframe')) blocked = '本机不支持 WebGL2 + VideoFrame';
      else if (value === 'F1' && next.capture === 'canvas') blocked = 'F1 强依赖帧与位姿成对（A1/A2 + D4）';
      else if (value === 'F2' && !caps.has('rvfc')) blocked = 'F2 强依赖 rVFC';
      else if (value === 'F2' && next.filter !== 'E2') blocked = 'F2 强依赖 E2/E3 的预测';
      else if (value === 'F4') warning = '无预测：快速移动时叠加层会滞后';
      break;
    case 'startup':
      if (value === 'compile') warning = '启动更慢；正式环境应使用 G2 资产';
      break;
  }
  return { blocked, warning };
}

/** Hard violations of a whole combination (empty: runnable). */
export function violations(c: Combination, caps: ReadonlySet<Capability>): string[] {
  const out: string[] = [];
  for (const field of Object.keys(c) as Field[]) {
    if (field === 'esm' && (c.tracker === 'D1' || c.tracker === 'D3')) continue;
    const v = verdict(field, c[field], c, caps);
    if (v.blocked) out.push(`${field}: ${v.blocked}`);
  }
  return out;
}

/**
 * After `field` changed: every other field whose value became blocked moves to its first allowed option. Returns
 * the repaired combination and what was changed, for the page to explain.
 */
export function repair(
  c: Combination,
  field: Field,
  caps: ReadonlySet<Capability>,
): { combination: Combination; changes: string[] } {
  let current = c;
  const changes: string[] = [];
  for (const layer of LAYERS)
    for (const f of layer.fields) {
      if (f.field === field || f.field === 'esm') continue;
      const v = verdict(f.field, current[f.field], current, caps);
      if (!v.blocked) continue;
      const replacement = f.options.find((o) => !verdict(f.field, o.value, current, caps).blocked);
      if (!replacement) continue;
      const from = f.options.find((o) => o.value === current[f.field])?.label ?? String(current[f.field]);
      changes.push(`${f.title}：${from} → ${replacement.label}（${v.blocked}）`);
      current = { ...current, [f.field]: replacement.value } as Combination;
    }
  return { combination: current, changes };
}

/** A combination made runnable on this device: every blocked field moves to its first allowed option. */
export function fit(c: Combination, caps: ReadonlySet<Capability>): { combination: Combination; changes: string[] } {
  let current = c;
  const changes: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const r = repair(current, 'esm', caps);
    current = r.combination;
    changes.push(...r.changes);
    if (!r.changes.length) break;
  }
  return { combination: current, changes };
}

/** Engine options of a combination (the page adds container, targets and callbacks). */
export function engineSettings(c: Combination): {
  capture: CapturePath[];
  compositor: CompositorKind;
  cssPrediction: boolean;
  pipeline: PipelineConfig;
  relocalizer: boolean;
  assets: boolean;
} {
  return {
    capture: c.capture === 'A1' ? ['mstp-window', 'mstp-worker'] : c.capture === 'A2' ? ['videoframe'] : ['canvas'],
    compositor: c.render === 'F1' ? 'frame-locked' : 'css',
    cssPrediction: c.render === 'F2',
    pipeline: {
      tracker: ({ D2: 'esm', D1: 'klt', 'D1+D2': 'klt+esm', D3: 'ncc' } as const)[c.tracker],
      ...(c.esm === 'lite' && (c.tracker === 'D2' || c.tracker === 'D1+D2') ? { esmIterations: [5, 4, 3] } : {}),
      filter: c.filter,
      relocalizeEvery: ({ '3': 10, '1': 30, '0.5': 60 } as const)[c.slowRate],
      wasm: c.compute === 'B1',
    },
    relocalizer: c.slowConcurrent,
    assets: c.startup === 'G2',
  };
}

/** One-line description of a combination by module ids. */
export function describe(c: Combination): string {
  return [
    c.capture === 'canvas' ? '画布读回' : c.capture,
    c.compute === 'B1' ? 'B1' : 'JS',
    'C1/C4',
    c.tracker + (c.esm === 'lite' && c.tracker.includes('D2') ? '(轻)' : ''),
    `D4 ${c.slowRate}Hz ${c.slowConcurrent ? '并发' : '串行'}`,
    c.filter,
    c.render,
    c.startup,
  ].join(' + ');
}

export const encodeCombination = (c: Combination): string =>
  btoa(unescape(encodeURIComponent(JSON.stringify(c))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function decodeCombination(text: string): Combination | null {
  try {
    const json = decodeURIComponent(escape(atob(text.replace(/-/g, '+').replace(/_/g, '/'))));
    const c = JSON.parse(json) as Combination;
    const base = PRESETS[0]!.combination;
    return Object.fromEntries(
      (Object.keys(base) as Field[]).map((k) => [k, c[k] ?? base[k]]),
    ) as unknown as Combination;
  } catch {
    return null;
  }
}
