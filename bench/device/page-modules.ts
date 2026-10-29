// SPDX-License-Identifier: Apache-2.0
// Module combination page (test side, Chinese UI): three presets, the baseline release engine as a fourth, and a
// custom combination whose options follow the dependency and exclusion rules of design doc §3.12 and this device's
// capabilities (modules.ts). A run opens the engine test page with the combination (assembled on load); finished
// runs are listed here for comparison.

import type { Capability } from '@livemira-next/contracts';
import { probeMainThread, probeWorkerTrackProcessor } from '@livemira-next/web';

import {
  BASELINE,
  describe,
  encodeCombination,
  fit,
  LAYERS,
  PRESETS,
  verdict,
  violations,
  type Combination,
  type Field,
} from './modules.ts';

const root = document.getElementById('app')!;
let caps: ReadonlySet<Capability> = new Set();
let current: Combination = PRESETS[0]!.combination;
let presetId: string | null = PRESETS[0]!.id;
let notice: string[] = [];
/** The baseline release engine is chosen instead of a combination. */
let baseline = false;
let runSeconds = 15;

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
};

function choose(next: Combination, id: string | null, changes: string[] = []): void {
  current = next;
  presetId = id;
  notice = changes;
  baseline = false;
  render();
}

function render(): void {
  root.innerHTML = '';
  root.append(h('h2', {}, 'LiveMira Next 模块组合测试'));

  // Run.
  const problems = baseline ? [] : violations(current, caps);
  const seconds = h(
    'select',
    {},
    ...[15, 30, 60].map((s) => h('option', { value: String(s), selected: s === runSeconds }, `${s} 秒`)),
  );
  seconds.onchange = () => {
    runSeconds = Number(seconds.value);
  };
  const run = h('button', { disabled: problems.length > 0 }, '开始测试');
  run.onclick = () => {
    const params = new URLSearchParams(
      baseline
        ? { test: 'baseline', seconds: String(runSeconds), name: BASELINE.id }
        : {
            test: 'engine',
            seconds: String(runSeconds),
            combo: encodeCombination(current),
            name: presetId ?? '自定义',
          },
    );
    location.href = `/device.html?${params}`;
  };
  root.append(
    h('h3', {}, '运行'),
    h('div', {}, baseline ? `组合：${BASELINE.title}` : `组合：${presetId ?? '自定义'}：${describe(current)}`),
    ...(problems.length ? [h('div', { className: 'why' }, `不可运行：${problems.join('；')}`)] : []),
    h('p', {}, '测试时长 ', seconds, ' ', run),
    h('p', { className: 'muted' }, '对准电脑上的 poster 目标，手持自然晃动；结束后自动回传并回到这里对比。'),
  );

  // Presets, then the baseline as the fourth.
  root.append(h('h3', {}, '预设组合'));
  for (const p of PRESETS) {
    const fitted = fit(p.combination, caps);
    const card = h(
      'div',
      { className: `card${!baseline && presetId === p.id ? ' active' : ''}` },
      h('b', {}, p.title),
      h('div', {}, p.summary),
      h('div', { className: 'muted' }, `与设计的差别：${p.gaps}`),
      ...(fitted.changes.length ? [h('div', { className: 'warn' }, `本机调整：${fitted.changes.join('；')}`)] : []),
    );
    card.onclick = () => choose(fitted.combination, p.id, fitted.changes);
    root.append(card);
  }
  const b0 = h(
    'div',
    { className: `card${baseline ? ' active' : ''}` },
    h('b', {}, BASELINE.title),
    h('div', {}, BASELINE.summary),
    h('div', { className: 'muted' }, BASELINE.gaps),
  );
  b0.onclick = () => {
    baseline = true;
    presetId = BASELINE.id;
    notice = [];
    render();
  };
  root.append(b0);

  // Custom: every layer, options checked against the rules.
  root.append(
    h(
      'h3',
      {},
      baseline
        ? '自定义组合（当前选的是基线 B0，它不由这些模块组成；修改任一项即改为自定义组合）'
        : presetId
          ? `当前：${presetId}（修改任一项即成为自定义组合）`
          : '当前：自定义组合',
    ),
  );
  if (notice.length) root.append(h('div', { className: 'warn' }, `已自动调整：${notice.join('；')}`));
  for (const layer of LAYERS) {
    const box = h('fieldset', {}, h('legend', {}, layer.title));
    for (const f of layer.fields) {
      const row = h('div', { className: 'row' }, h('div', { className: 'field' }, f.title));
      for (const o of f.options) {
        const v = verdict(f.field, o.value, current, caps);
        const inactive = f.field === 'esm' && (current.tracker === 'D1' || current.tracker === 'D3');
        const input = h('input', {
          type: 'radio',
          name: f.field,
          checked: !baseline && current[f.field] === o.value,
          disabled: !!v.blocked || inactive,
        });
        input.onchange = () => choose({ ...current, [f.field]: o.value } as Combination, null);
        const label = h(
          'label',
          { className: v.blocked || inactive ? 'off' : '' },
          input,
          ` ${o.label}`,
          ...(o.note ? [h('span', { className: 'muted' }, ` · ${o.note}`)] : []),
          ...(v.blocked ? [h('span', { className: 'why' }, ` ⛔ ${v.blocked}`)] : []),
          ...(!v.blocked && v.warning && current[f.field] === o.value
            ? [h('span', { className: 'warn' }, ` ⚠ ${v.warning}`)]
            : []),
        );
        row.append(label);
      }
      box.append(row);
    }
    for (const m of layer.missing)
      box.append(
        h('div', { className: 'off' }, `☐ ${m.label}`, h('span', { className: 'why' }, ` 未接入：${m.reason}`)),
      );
    root.append(box);
  }

  // About this page, then the history.
  root.append(
    h(
      'p',
      { className: 'muted' },
      `本机能力：${[...caps].sort().join('、') || '探测中…'}。按设计文档 §3.12 的依赖与互斥关系、以及本机能力，限制可选项；灰色选项旁写明原因。组合在打开测试页时组装，不做运行中替换。`,
    ),
  );

  // History (this browser).
  let history: Record<string, unknown>[] = [];
  try {
    history = JSON.parse(localStorage.getItem('livemira-combos') ?? '[]') as Record<string, unknown>[];
  } catch {
    history = [];
  }
  if (history.length) {
    const num = (v: unknown, d = 1): string => (typeof v === 'number' ? v.toFixed(d) : '—');
    const table = h(
      'table',
      {},
      h(
        'tr',
        {},
        ...[
          '时间',
          '组合',
          '采集',
          '跟踪帧/秒',
          '帧率',
          '跟踪占比',
          'Worker ms',
          '亮度 ms',
          '就绪 ms',
          '首位姿 ms',
          '呈现 p99',
        ].map((t) => h('th', {}, t)),
      ),
      ...history.map((r) =>
        h(
          'tr',
          {},
          h('td', {}, String(r.time).slice(11, 19)),
          h('td', {}, `${String(r.name)}：${String(r.combination)}`),
          h('td', {}, String(r.capturePath)),
          h('td', {}, num(r.trackedFps)),
          h('td', {}, num(r.processedFps)),
          h('td', {}, num(r.trackedShare, 2)),
          h('td', {}, num(r.processMs, 2)),
          h('td', {}, num(r.lumaMs, 2)),
          h('td', {}, num(r.readyMs, 0)),
          h('td', {}, num(r.firstPoseMs, 0)),
          h('td', {}, num(r.presentGapP99Ms, 0)),
        ),
      ),
    );
    const clear = h('button', {}, '清空记录');
    clear.onclick = () => {
      try {
        localStorage.removeItem('livemira-combos');
      } catch {
        // Nothing stored.
      }
      render();
    };
    root.append(h('h3', {}, '历次结果（本浏览器）'), h('div', { className: 'scroll' }, table), clear);
  }
}

render();
void (async () => {
  const found = probeMainThread();
  if (await probeWorkerTrackProcessor()) found.add('mstp-worker');
  caps = found;
  const fitted = fit(current, caps);
  choose(fitted.combination, presetId, fitted.changes);
})();
