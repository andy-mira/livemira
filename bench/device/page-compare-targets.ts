// SPDX-License-Identifier: Apache-2.0
// ⑩ LiveMorae material comparison, the computer side: shows LiveMorae's demo photo in turn in the ways that may
// matter (large and alone as in the validation, the homepage's size, the homepage's card with its badge and buttons on
// the photo) and a validation photo as the control, each for a fixed time. Every start and end is sent to the test
// server, on the server's own clock, to split the phone's report by what was on the screen.
//   compare/targets.html[?seconds=30]

const SECONDS = Number(new URLSearchParams(location.search).get('seconds')) || 30;
const READY_S = 4;

interface Variant {
  readonly id: string;
  readonly label: string;
  readonly html: string;
}

const photo = 'assets/demo-memory.png';
// The homepage card as LiveMorae draws it (styles.css: .demo-frame, .demo-stage, .demo-badge, .demo-controls,
// .demo-pill, .demo-scan): a 453 px photo in a paper frame turned 1.2°, a badge and two buttons on the photo.
const card = `<div class="lm-frame"><div class="lm-stage"><img src="${photo}" alt="">
  <div class="lm-controls"><span class="lm-pill">轻点照片 · 播放片段</span><span class="lm-pill lm-scan">扫码体验</span></div>
  </div><span class="lm-badge">演示素材</span></div>`;

const VARIANTS: readonly Variant[] = [
  { id: 'A-large', label: 'A. LiveMorae 照片 · 大图（同验证时）', html: `<img class="large" src="${photo}" alt="">` },
  { id: 'C-small', label: 'C. LiveMorae 照片 · 首页尺寸，无遮挡', html: `<img class="small" src="${photo}" alt="">` },
  { id: 'B-homepage', label: 'B. LiveMorae 首页样式（角标与按钮压在照片上）', html: card },
  { id: 'D-control', label: 'D. 对照：验证用照片 · 大图', html: `<img class="large" src="assets/bird-01.png" alt="">` },
];

const label = document.getElementById('label')!;
const stage = document.getElementById('stage')!;
const button = document.getElementById('start') as HTMLButtonElement;

const report = (body: Record<string, unknown>): Promise<unknown> =>
  fetch('/report?kind=compare-targets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, wallMs: Date.now() }),
  }).catch(() => undefined);

const wait = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

async function countdown(prefix: string, seconds: number): Promise<void> {
  for (let left = seconds; left > 0; left--) {
    label.textContent = `${prefix}　剩余 ${left} 秒`;
    await wait(1);
  }
}

// Keeps the display on while the run lasts (Screen Wake Lock, where supported).
let lock: { release(): Promise<void> } | null = null;
const keepAwake = (): void => {
  const wakeLock = (navigator as { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } })
    .wakeLock;
  void wakeLock?.request('screen').then(
    (l) => (lock = l),
    () => undefined,
  );
};

button.addEventListener('click', async () => {
  button.hidden = true;
  keepAwake();
  const run = Date.now().toString(36);
  await report({ run, phase: 'run-start', seconds: SECONDS });
  for (const [i, v] of VARIANTS.entries()) {
    stage.innerHTML = v.html;
    await countdown(`第 ${i + 1}/${VARIANTS.length} 项 ${v.label}：准备，把手机对准它`, READY_S);
    await report({ run, phase: 'start', variant: v.id });
    await countdown(`第 ${i + 1}/${VARIANTS.length} 项 ${v.label}：测量中，像平时一样手持扫描`, SECONDS);
    await report({ run, phase: 'end', variant: v.id });
  }
  stage.innerHTML = '';
  label.textContent = '全部完成。请在手机上点左上角 × 结束，数据会自动回传。';
  await report({ run, phase: 'run-end' });
  void lock?.release();
  button.hidden = false;
  button.textContent = '再测一轮';
});
