// SPDX-License-Identifier: Apache-2.0
// Target rating: a picture, or a frame of a video (first, last or any), rated by the target rating module
// (rateTargetImage; the engine is not loaded), with the points it counts and their spread drawn over the picture; and the
// ratings of the 0.4.1 release's sample targets, or, where the page is served with it (target-set/index.json), of the
// whole picture set they come from.

import { rateTargetImage } from './livemira-target-rating.min.mjs';

const $ = (id) => document.getElementById(id);
const status = $('status');

const FACTORS = [
  ['detail', '细节'],
  ['spread', '分布'],
  ['distinctiveness', '独特性'],
  ['recognition', '实测识别'],
];
const TESTS = [
  ['size', '缩小'],
  ['tilt', '斜拍'],
  ['blur', '晃动模糊'],
  ['dim', '暗光'],
  ['covered', '部分遮挡'],
];
const QUARTERS = ['左上', '右上', '左下', '右下'];
const ADVICE = {
  HARD_TO_FIND: () =>
    '在缩小、斜拍、晃动模糊、暗光、部分遮挡等常见情况下，引擎多数认不出或很勉强。建议换一张细节更丰富、对比更清楚的图。',
  CONCENTRATED: () =>
    '细节集中在画面的一部分，其余地方偏空。扫描时只要那一块被挡住或出了画面就会丢失，建议选细节铺满画面的帧。',
  WEAK_QUARTER: (r) =>
    `${QUARTERS[r.metrics.weakestQuarter.index]}角几乎没有细节（只占 ${Math.round(100 * r.metrics.weakestQuarter.share)}% 的点）。其他部分被手指、反光挡住时容易丢失。`,
  FEW_DETAILS: () => '能从不同角度稳定认出的细节点偏少，多见于大面积平涂、虚化或模糊的画面。',
  REPETITIVE: () => '画面里有不少相似的图案（格子、砖墙、条纹等），容易认错位置。',
  FAILS_SMALL: () => '照片在相机画面里偏小时很难认出：扫描时需要靠近，照片宜印大一些。',
  FAILS_TILTED: () => '斜着拍时很难认出：扫描时需要尽量正对照片。',
  FAILS_BLURRED: () => '手一晃、画面一糊就认不出：图里缺少粗一些的轮廓和明暗对比。',
  FAILS_DIM: () => '光线暗、对比低时很难认出：图里明暗差别偏小。',
  FAILS_COVERED: () => '被手指、反光挡住一部分后很难认出：细节没有均匀铺开。',
};
/** 0.4.1 samples, with the score 0.4.1's own scorer gives them (livemira-target-quality) and their measured
 * robustness (bench/src/measure-targets.ts), both computed once. */
const SAMPLES = [
  { id: 'bird-01', name: '鸟屋', old: 5, measured: 83 },
  { id: 'forest-03', name: '森林', old: 5, measured: 80 },
  { id: 'mountain-01', name: '山脉', old: 1.8, measured: 77 },
  { id: 'ship-01', name: '船', old: 4.2, measured: 78 },
];

function starsInto(element, stars) {
  element.querySelector('span').style.width = `${(100 * stars) / 5}%`;
  element.setAttribute('aria-label', `${stars} 星`);
  element.title = `${stars} 星`;
}

/** The picture with the counted points, the grid shaded by how many fall in each cell, and the weakest quarter. */
async function drawOverlay(canvas, blob, rating, maxWidth) {
  const bitmap = await createImageBitmap(blob);
  const k = Math.min(1, maxWidth / bitmap.width);
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  const c = canvas.getContext('2d');
  c.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const sx = canvas.width / rating.width;
  const sy = canvas.height / rating.height;
  const { columns, rows, counts } = rating.metrics.grid;
  const most = Math.max(1, ...counts);
  c.fillStyle = 'rgba(20, 16, 10, 0.45)';
  c.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < rows; r++)
    for (let q = 0; q < columns; q++) {
      const share = counts[r * columns + q] / most;
      c.fillStyle = `rgba(242, 184, 75, ${0.32 * share})`;
      c.fillRect(
        (q * canvas.width) / columns,
        (r * canvas.height) / rows,
        canvas.width / columns,
        canvas.height / rows,
      );
    }
  c.strokeStyle = 'rgba(255, 248, 238, 0.18)';
  c.lineWidth = 1;
  for (let q = 1; q < columns; q++) {
    c.beginPath();
    c.moveTo((q * canvas.width) / columns, 0);
    c.lineTo((q * canvas.width) / columns, canvas.height);
    c.stroke();
  }
  for (let r = 1; r < rows; r++) {
    c.beginPath();
    c.moveTo(0, (r * canvas.height) / rows);
    c.lineTo(canvas.width, (r * canvas.height) / rows);
    c.stroke();
  }
  c.fillStyle = '#f2b84b';
  const dot = Math.max(1.5, canvas.width / 320);
  for (let i = 0; i < rating.points.length; i += 2) {
    c.beginPath();
    c.arc(rating.points[i] * sx, rating.points[i + 1] * sy, dot, 0, 2 * Math.PI);
    c.fill();
  }
  if (rating.advice.includes('WEAK_QUARTER')) {
    const w = rating.metrics.weakestQuarter.index;
    c.strokeStyle = '#e5533d';
    c.lineWidth = Math.max(2, canvas.width / 200);
    c.strokeRect(
      (w % 2) * (canvas.width / 2) + 2,
      Math.floor(w / 2) * (canvas.height / 2) + 2,
      canvas.width / 2 - 4,
      canvas.height / 2 - 4,
    );
  }
}

/** Rates a picture; null for a picture the engine would refuse outright. */
async function rate(blob) {
  try {
    return await rateTargetImage(blob);
  } catch (error) {
    if (error?.code === 'UNSUITABLE_TARGET' || error?.code === 'DECODE_FAILED') return null;
    throw error;
  }
}

async function showRating(blob) {
  status.textContent = '正在评分…';
  const rating = await rate(blob);
  $('result-box').hidden = false;
  const advice = $('advice');
  advice.replaceChildren();
  const bars = $('bars');
  bars.replaceChildren();
  if (!rating) {
    starsInto($('stars'), 0.5);
    $('score').textContent = '无法作为目标图';
    advice.append(
      Object.assign(document.createElement('li'), {
        textContent: '这张图细节太少（或无法解码），引擎不能把它作为目标图。',
      }),
    );
    const canvas = $('overlay');
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap) {
      canvas.width = Math.min(960, bitmap.width);
      canvas.height = Math.round((bitmap.height * canvas.width) / bitmap.width);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
    }
    status.textContent = '';
    return;
  }
  starsInto($('stars'), rating.stars);
  $('score').textContent = `${rating.stars} 星 · ${rating.score} 分`;
  for (const [key, label] of FACTORS) {
    const row = document.createElement('div');
    row.className = 'bar';
    const value = rating.factors[key];
    row.innerHTML = `<span>${label}</span><i><b style="width:${Math.round(100 * value)}%"></b></i><em>${Math.round(100 * value)}</em>`;
    bars.append(row);
  }
  for (const [key, label] of TESTS) {
    const row = document.createElement('div');
    row.className = 'bar test';
    const value = rating.metrics.tests[key];
    row.innerHTML = `<span>${label}</span><i><b style="width:${Math.round(100 * value)}%"></b></i><em>${Math.round(100 * value)}</em>`;
    bars.append(row);
  }
  const found = rating.metrics.views.filter((v) => v.found).length;
  const lines = rating.advice.length
    ? rating.advice.map((a) => ADVICE[a](rating))
    : ['细节丰富、铺满画面，在较难的拍摄条件下也多能认出。'];
  lines.push(
    `稳定细节点 ${rating.metrics.robustPoints} 个，覆盖 ${rating.metrics.populatedCells}/${rating.metrics.grid.columns * rating.metrics.grid.rows} 格；${rating.metrics.views.length} 个由易到难的合成画面中认出 ${found} 个。`,
  );
  for (const line of lines) advice.append(Object.assign(document.createElement('li'), { textContent: line }));
  await drawOverlay($('overlay'), blob, rating, 960);
  status.textContent = '';
  $('result-box').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const run = (task) =>
  task().catch((error) => {
    status.textContent = `评分失败：${error?.code ?? error?.name ?? ''} ${error?.message ?? error}`;
  });

$('image-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  $('video-box').hidden = true;
  if (file) void run(() => showRating(file));
});

// A video: the first, the last or any frame, drawn at the video's own size.
const video = $('video');
const seek = $('seek');
const once = (target, type) => new Promise((resolve) => target.addEventListener(type, resolve, { once: true }));
async function seekTo(t) {
  const end = Math.max(0, video.duration - 0.05);
  const time = Math.min(end, Math.max(0, t));
  if (Math.abs(video.currentTime - time) > 0.001) {
    const seeked = once(video, 'seeked');
    video.currentTime = time;
    await seeked;
  }
  seek.value = String(time);
  $('time').textContent = `${time.toFixed(2)} / ${video.duration.toFixed(2)} 秒`;
}
async function frameBlob() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
$('video-file').addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  void run(async () => {
    $('video-box').hidden = false;
    if (video.src) URL.revokeObjectURL(video.src);
    video.src = URL.createObjectURL(file);
    await once(video, 'loadeddata');
    seek.max = String(Math.max(0, video.duration - 0.05));
    seek.step = '0.04';
    await seekTo(0);
  });
});
seek.addEventListener('input', () => void run(() => seekTo(Number(seek.value))));
$('first').addEventListener('click', () => void run(async () => (await seekTo(0), showRating(await frameBlob()))));
$('last').addEventListener(
  'click',
  () => void run(async () => (await seekTo(video.duration), showRating(await frameBlob()))),
);
$('use').addEventListener('click', () => void run(async () => showRating(await frameBlob())));

// The 0.4.1 samples, or the whole set they come from where the page is served with it. Three requests are kept
// waiting so the rating Worker never idles; it rates one picture at a time.
async function samples() {
  try {
    const response = await fetch('target-set/index.json');
    if (response.ok)
      return (await response.json()).pictures.map((p) => ({ ...p, name: p.group, url: `target-set/${p.id}.png` }));
  } catch {
    // Not served with the set: the release's four.
  }
  return SAMPLES.map((s) => ({ ...s, url: `assets/${s.id}.png`, inRelease041: true, old041: s.old }));
}

async function rateSamples() {
  const box = $('samples');
  const list = await samples();
  $('samples-title').textContent =
    list.length > SAMPLES.length ? `0.4.1 目标图集的评分（${list.length} 张）` : '0.4.1 示例目标图的评分';
  for (const s of list) {
    const card = document.createElement('div');
    card.className = 'sample';
    card.dataset.id = s.id;
    card.innerHTML =
      `<canvas></canvas><div><strong>${s.name}</strong> <small>${s.id}</small>` +
      `${list.length > SAMPLES.length && s.inRelease041 ? ' <span class="tag">0.4.1 示例</span>' : ''}</div>` +
      `<div class="line">等待评分…</div>`;
    box.append(card);
  }
  const queue = [...list];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const card = box.querySelector(`[data-id="${s.id}"]`);
      const line = card.querySelector('.line');
      line.textContent = '评分中…';
      const blob = await (await fetch(s.url)).blob();
      const rating = await rate(blob);
      if (!rating) {
        line.textContent = '无法作为目标图';
        card.dataset.stars = '0';
        card.dataset.score = '0';
        continue;
      }
      await drawOverlay(card.querySelector('canvas'), blob, rating, 420);
      const f = rating.factors;
      line.innerHTML =
        `<span class="stars"><span></span></span> <strong>${rating.stars}</strong> 星 · ${rating.score} 分<br>` +
        `<small>细节 ${Math.round(100 * f.detail)} · 分布 ${Math.round(100 * f.spread)} · 独特 ${Math.round(100 * f.distinctiveness)} · 识别 ${Math.round(100 * f.recognition)}</small><br>` +
        `<small>0.4.1 旧评分 ${s.old041} / 5${s.measured !== undefined ? ` · 仿真实测 ${s.measured}` : ''}</small>`;
      starsInto(line.querySelector('.stars'), rating.stars);
      card.dataset.stars = String(rating.stars);
      card.dataset.score = String(rating.score);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const counts = new Map();
  for (const card of box.children)
    counts.set(Number(card.dataset.stars), (counts.get(Number(card.dataset.stars)) ?? 0) + 1);
  $('summary').textContent = `分布：${[...counts]
    .sort((a, b) => b[0] - a[0])
    .map(([stars, n]) => `${stars} 星 ${n} 张`)
    .join(' · ')}`;
  $('sort').hidden = false;
  status.textContent = '';
}

$('sort').addEventListener('change', (event) => {
  const box = $('samples');
  const cards = [...box.children];
  const byStars = event.target.value === 'stars';
  cards.sort((a, b) =>
    byStars ? Number(b.dataset.score) - Number(a.dataset.score) : a.dataset.id.localeCompare(b.dataset.id),
  );
  box.append(...cards);
});
void run(rateSamples);
