// SPDX-License-Identifier: Apache-2.0
// Device test page (test side, Chinese UI): capability matrix (`?test=caps`) or a timed engine run against the real
// camera (`?test=engine&seconds=60&compositor=frame-locked|css`). Results are shown on screen and POSTed to the kit
// server (bench/device/serve.ts), which stores them under bench/results/device/.

import { PROFILES, probeMainThread, probeWorkerTrackProcessor, type ProfileId } from '@livemira-next/web';

import { startEngine, type CompositorKind } from '../prototype/index.ts';

import { decodeCombination, describe, engineSettings, PROFILE_CODES } from './modules.ts';

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const stage = document.getElementById('stage')!;
const say = (text: string): void => {
  status.textContent = text;
};

async function post(kind: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const response = await fetch(`/report?kind=${encodeURIComponent(kind)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Keeps the screen on for an unattended run (Screen Wake Lock), re-acquired when the page shows again or is touched. */
function keepScreenOn(): () => string {
  if (!('wakeLock' in navigator)) return () => '浏览器不支持（请把自动锁屏设为“永不”）';
  let state = '开启中';
  let lock: WakeLockSentinel | null = null;
  const request = (): void => {
    if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
    navigator.wakeLock.request('screen').then(
      (l) => {
        lock = l;
        state = '已开启';
        l.addEventListener('release', () => {
          state = '已解除（轻点屏幕重新开启）';
        });
      },
      (e: unknown) => {
        state = `未开启：${e instanceof Error ? e.name : String(e)}（轻点屏幕重试，或把自动锁屏设为“永不”）`;
      },
    );
  };
  request();
  document.addEventListener('visibilitychange', request);
  document.addEventListener('pointerdown', request);
  return () => state;
}

/** Static jitter: corner σ within 1 s windows, median over windows (meaningful only with the phone on a stand). */
function jitter(corners: readonly { t: number; c: number[] }[]): number | null {
  const sigmas: number[] = [];
  let i = 0;
  for (let w = corners[0]?.t ?? 0; corners.length && w < corners.at(-1)!.t; w += 1000) {
    while (i < corners.length && corners[i]!.t < w) i++;
    let j = i;
    while (j < corners.length && corners[j]!.t < w + 1000) j++;
    const win = corners.slice(i, j);
    if (win.length < 10) continue;
    let sum = 0;
    for (let k = 0; k < 8; k++) {
      const mean = win.reduce((a, c) => a + c.c[k]!, 0) / win.length;
      sum += win.reduce((a, c) => a + (c.c[k]! - mean) ** 2, 0) / win.length;
    }
    sigmas.push(Math.sqrt(sum / 8));
  }
  sigmas.sort((a, b) => a - b);
  return sigmas.length ? sigmas[Math.floor(sigmas.length / 2)]! : null;
}

function environment(): Record<string, unknown> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    time: new Date().toISOString(),
  };
}

async function capabilities(): Promise<void> {
  say('正在探测能力…');
  const caps = probeMainThread();
  const workerMstp = await probeWorkerTrackProcessor();
  let webgpu: Record<string, unknown> = { available: false };
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      const info = adapter ? (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info : undefined;
      webgpu = adapter
        ? {
            available: true,
            vendor: info?.vendor ?? null,
            architecture: info?.architecture ?? null,
            features: [...adapter.features].sort(),
          }
        : { available: false, reason: 'requestAdapter 返回 null' };
    } catch (e) {
      webgpu = { available: false, reason: String(e) };
    }
  }
  const result = { ...environment(), capabilities: [...caps].sort(), workerTrackProcessor: workerMstp, webgpu };
  const saved = await post('caps', result);
  say(`能力探测完成${saved ? '，结果已回传' : '（回传失败，请截图本页）'}`);
  stage.textContent = JSON.stringify(result, null, 2);
}

interface Second {
  /** Results (processed frames) and presentations in this second. */
  results: number;
  presents: number;
  tracked: number;
  processUs: number;
  lumaUs: number;
}

async function engine(): Promise<void> {
  const seconds = Number(params.get('seconds') ?? 60);
  // A module combination from the combination page (modules.html), or the release configuration.
  const combination = params.get('combo') ? decodeCombination(params.get('combo')!) : null;
  const comboName = combination ? (params.get('name') ?? '自定义') : null;
  const combo = combination ? engineSettings(combination) : null;
  // Unattended on a stand (static jitter + sustained performance in one run): the screen is kept on, and timing starts
  // once the phone has been placed and the picture is steady.
  const stand = params.has('stand');
  const screenOn = stand ? keepScreenOn() : null;
  // A combination or an explicit compositor is a hand-made setup; otherwise the engine picks by profile (Swift
  // default, `?profile=hawk` on request; the design-doc ids R3/R1/R2b work too) and falls back as the device requires.
  const explicitCompositor = params.get('compositor') as CompositorKind | null;
  const compositor = combo?.compositor ?? explicitCompositor ?? undefined;
  const asked = (params.get('profile') ?? 'swift').toLowerCase();
  const preferred = (Object.values(PROFILES).find((p) => PROFILE_CODES[p.id].toLowerCase() === asked)?.id ??
    asked) as ProfileId;
  /** "Hawk（R3）": the display name with the combination id the reports and the design doc use. */
  const label = (id: ProfileId | null): string => (id ? `${PROFILES[id].name}（${PROFILE_CODES[id]}）` : '无');
  const profileChanges: { t: number; from: string; to: string; reason: string }[] = [];
  const manifest = (await (await fetch('/targets.json')).json()) as { id: string; width: number; height: number }[];
  const assets =
    combo?.assets === false
      ? undefined
      : await Promise.all(
          manifest.map(async (t) => new Uint8Array(await (await fetch(`/assets/${t.id}.lmt`)).arrayBuffer())),
        );
  const targets = assets
    ? undefined
    : await Promise.all(
        manifest.map(async (t) => ({
          info: { id: t.id, width: t.width, height: t.height, physicalWidthMeters: 0.2 },
          gray: new Uint8Array(await (await fetch(`/targets/${t.id}.gray`)).arrayBuffer()),
        })),
      );
  say('正在启动相机与引擎…（首次会弹出相机权限，请允许）');
  const started = performance.now();
  /** Start of the measured period: engine start, or the moment the picture settled on a stand run. */
  let origin = started;
  let firstPoseMs: number | null = null;
  const perSecond: Second[] = [];
  const bucket = (): Second => {
    const i = Math.floor((performance.now() - origin) / 1000);
    while (perSecond.length <= i) perSecond.push({ results: 0, presents: 0, tracked: 0, processUs: 0, lumaUs: 0 });
    return perSecond[i]!;
  };
  const presentTimes: number[] = [];
  /** Corner positions while tracked, for the static jitter (phone on a stand, target still). */
  const corners: { t: number; c: number[] }[] = [];
  const states = new Map<string, number>();
  /** Shown orientation the Worker applied to the camera planes, and where it came from. */
  const orientations = new Map<string, number>();
  /** Standard image size changes (the device turned), with the time since start, ms. */
  const resizes: { t: number; standard: number[]; screen: string | null }[] = [];
  let orientationDetail = '';
  const lumaPaths = new Map<string, number>();
  /** The Worker's first orientation detection with thumbnails (raw planes, 2D draw, WebGL upload). */
  let orientationDiagnostics: unknown = null;
  const handle = await startEngine({
    container: stage,
    ...(assets ? { assets } : { targets: targets! }),
    workerUrl: '/worker.js',
    ...(combo?.relocalizer === false ? {} : { relocalizerUrl: '/relocalize-worker.js' }),
    ...(compositor ? { compositor } : { profile: preferred }),
    ...(combo ? { capture: combo.capture, cssPrediction: combo.cssPrediction, pipeline: combo.pipeline } : {}),
    onProfileChange: (change) => profileChanges.push({ t: Math.round(performance.now() - started), ...change }),
    ...(params.get('hawkbudget') ? { hawkBudgetUs: Number(params.get('hawkbudget')) } : {}),
    onResult: (r) => {
      const b = bucket();
      b.results++;
      b.processUs += r.stats.processUs;
      b.lumaUs += r.stats.lumaUs;
      states.set(r.state, (states.get(r.state) ?? 0) + 1);
      const o = r.stats.orientation ?? 'unknown';
      orientations.set(o, (orientations.get(o) ?? 0) + 1);
      if (r.stats.orientationDetail) orientationDetail = r.stats.orientationDetail;
      lumaPaths.set(r.stats.lumaPath, (lumaPaths.get(r.stats.lumaPath) ?? 0) + 1);
      if (r.diagnostics && !orientationDiagnostics) orientationDiagnostics = r.diagnostics;
      if (r.poses.length) {
        b.tracked++;
        firstPoseMs ??= performance.now() - started;
        corners.push({ t: performance.now(), c: r.poses[0]!.corners.flatMap((p) => [p[0], p[1]]) });
      }
    },
    onResize: (size) => {
      resizes.push({
        t: Math.round(performance.now() - started),
        standard: [size.width, size.height],
        screen: screen.orientation?.type ?? null,
      });
    },
    onPresent: () => {
      bucket().presents++;
      presentTimes.push(performance.now());
    },
  });
  const readyMs = performance.now() - started;
  const info = {
    profile: handle.profile(),
    profileFallbacks: handle.profileFallbacks,
    capturePath: handle.capturePath,
    compositor: handle.compositor,
    capabilities: [...handle.capabilities].sort(),
    matcher: handle.matcher,
  };
  // What the browser shows vs what the camera track reports (iOS reports the sensor orientation).
  const element = stage.querySelector('video');
  const track = (element?.srcObject as MediaStream | null)?.getVideoTracks()[0];
  const settings = track?.getSettings();
  const video = {
    shown: element ? [element.videoWidth, element.videoHeight] : null,
    trackSettings: settings ? [settings.width ?? null, settings.height ?? null] : null,
    screenOrientation: screen.orientation?.type ?? null,
  };
  const battery = await (navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> })
    .getBattery?.()
    .catch(() => null);
  let settled: boolean | null = null;
  let settleMs: number | null = null;
  if (stand) {
    const deadline = performance.now() + 180_000;
    settled = await new Promise<boolean>((resolve) => {
      const tick = (): void => {
        const now = performance.now();
        // Steady: tracked through the last 3 s with every corner coordinate within a 4 px range.
        const recent = corners.filter((c) => c.t > now - 3000);
        const steady =
          recent.length >= 20 &&
          recent[0]!.t < now - 2700 &&
          Array.from({ length: 8 }, (_, k) => recent.map((c) => c.c[k]!)).every(
            (v) => Math.max(...v) - Math.min(...v) <= 4,
          );
        say(
          `请把手机放到支架上，对准电脑上的目标图，之后不要再碰。画面稳定 3 秒后自动开始计时（最多再等 ${Math.ceil((deadline - now) / 1000)} 秒）· 屏幕常亮：${screenOn!()}`,
        );
        if (steady) resolve(true);
        else if (now >= deadline) resolve(false);
        else setTimeout(tick, 250);
      };
      tick();
    });
    settleMs = performance.now() - started;
    // Measure from here: drop what was recorded while the phone was being placed.
    origin = performance.now();
    perSecond.length = 0;
    corners.length = 0;
    presentTimes.length = 0;
    states.clear();
  }
  const batteryStart = battery ? { level: battery.level, charging: battery.charging } : null;
  const end = stand ? origin + seconds * 1000 : started + readyMs + seconds * 1000;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      const last = perSecond.at(-2);
      say(
        `运行中，剩余 ${left} 秒 · 采集 ${info.capturePath} · 处理 ${last?.results ?? 0} 帧/秒 · 跟踪 ${last?.tracked ?? 0} 帧/秒${screenOn ? ` · 屏幕常亮：${screenOn()}` : ''}`,
      );
      if (performance.now() >= end) resolve();
      else setTimeout(tick, 500);
    };
    tick();
  });
  const stats = handle.stats();
  handle.stop();
  const full = perSecond.slice(1, -1);
  const fps = (list: Second[]): number | null =>
    list.length ? list.reduce((a, s) => a + s.results, 0) / list.length : null;
  const minute = Math.min(60, Math.floor(full.length / 2));
  const firstMinute = fps(full.slice(0, minute));
  const lastMinute = fps(full.slice(-minute));
  const staticJitterPx = jitter(corners);
  const staticJitterFirst30sPx = jitter(corners.filter((c) => c.t < origin + 30_000));
  // Per minute: frames processed per second, tracked share, Worker ms per frame (thermal throttling shows here). A last
  // minute cut short by the dropped edge seconds still counts when it has at least half its seconds.
  const perMinute = Array.from({ length: Math.floor((full.length + 30) / 60) }, (_, m) => {
    const list = full.slice(60 * m, 60 * m + 60);
    const results = list.reduce((a, s) => a + s.results, 0);
    return [
      results / list.length,
      list.reduce((a, s) => a + s.tracked, 0) / Math.max(1, results),
      list.reduce((a, s) => a + s.processUs, 0) / Math.max(1, results) / 1000,
    ];
  });
  const gaps = presentTimes
    .slice(1)
    .map((t, i) => t - presentTimes[i]!)
    .sort((a, b) => a - b);
  const result = {
    ...environment(),
    test: 'engine',
    seconds,
    stand: stand ? { settled, settleMs, screenOn: screenOn!() } : null,
    comboName,
    combination,
    preferredProfile: compositor ? null : preferred,
    profileNow: handle.profile(),
    profileCode: handle.profile() ? PROFILE_CODES[handle.profile()!] : null,
    profileChanges,
    info,
    readyMs,
    firstPoseMs,
    processedFps: fps(full),
    trackedShare: full.length
      ? full.reduce((a, s) => a + s.tracked, 0) /
        Math.max(
          1,
          full.reduce((a, s) => a + s.results, 0),
        )
      : null,
    sustainedRatio: firstMinute && lastMinute && full.length >= 120 ? lastMinute / firstMinute : null,
    processMsMean: stats.processUs / 1000,
    lumaMsMean: stats.lumaUs / 1000,
    mainThreadMsPerFrame: stats.mainThreadUs / 1000,
    drawMsMean: stats.drawUs / 1000,
    presentGapP99Ms: gaps.length ? gaps[Math.floor(0.99 * (gaps.length - 1))]! : null,
    staticJitterPx,
    staticJitterFirst30sPx,
    perMinute,
    states: Object.fromEntries(states),
    orientations: Object.fromEntries(orientations),
    resizes,
    orientationDetail,
    lumaPaths: Object.fromEntries(lumaPaths),
    orientationDiagnostics,
    video,
    batteryStart,
    batteryEnd: battery ? { level: battery.level, charging: battery.charging } : null,
    perSecond: perSecond.map((s) => [
      s.results,
      s.tracked,
      s.presents,
      Math.round(s.processUs / Math.max(1, s.results)),
    ]),
  };
  const saved = await post(
    combination
      ? `combo-${comboName}-${seconds}s`
      : `${stand ? 'stand' : 'engine'}-${compositor ?? `profile-${preferred}`}-${seconds}s`,
    result,
  );
  say(`测试完成${saved ? '，结果已回传' : '（回传失败，请截图本页）'}`);
  stage.innerHTML = '';
  const pre = document.createElement('pre');
  const summary = {
    ...(combination ? { 组合: `${comboName}：${describe(combination)}` } : {}),
    采集路径: info.capturePath,
    ...(info.profile
      ? {
          档位: `${label(handle.profile())}${info.profileFallbacks.length ? `；跳过 ${info.profileFallbacks.map((f) => `${label(f.id)} 缺 ${f.missing.join('、')}`).join('，')}` : ''}${profileChanges.length ? `；运行中 ${profileChanges.map((c) => `${(c.t / 1000).toFixed(1)}s ${label(c.from as ProfileId)}→${label(c.to as ProfileId)}`).join('，')}` : ''}`,
        }
      : {}),
    合成方式: info.compositor,
    画面方向: [...orientations.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '无',
    屏幕旋转: resizes.length
      ? resizes.map((r) => `${(r.t / 1000).toFixed(1)}s→${r.standard.join('×')}`).join('，')
      : '无',
    '显示尺寸 / 相机设置': `${video.shown?.join('×') ?? '?'} / ${video.trackSettings?.join('×') ?? '?'}`,
    '就绪(ms)': Math.round(readyMs),
    '首个位姿(ms)': firstPoseMs === null ? '未识别到目标' : Math.round(firstPoseMs),
    '处理帧率(帧/秒)': result.processedFps?.toFixed(1),
    跟踪占比: result.trackedShare?.toFixed(2),
    持续性能比: result.sustainedRatio?.toFixed(2) ?? '运行不足 2 分钟',
    'Worker 每帧处理(ms)': result.processMsMean.toFixed(2),
    '主线程每帧(ms)': result.mainThreadMsPerFrame.toFixed(2),
    '呈现间隔 p99(ms)': result.presentGapP99Ms?.toFixed(0),
    '静止抖动 σ(px)': result.staticJitterPx?.toFixed(3) ?? '无数据',
    ...(stand
      ? {
          开始方式: settled
            ? `画面稳定后自动开始（准备用了 ${Math.round(settleMs! / 1000)} 秒）`
            : '3 分钟内没等到稳定画面，已按时开始（抖动数据可能偏大）',
          '静止抖动 σ 前 30 秒(px)': result.staticJitterFirst30sPx?.toFixed(3) ?? '无数据',
          每分钟处理帧率: perMinute.map((m) => m[0]!.toFixed(1)).join(' / ') || '不足 1 分钟',
          '每分钟 Worker(ms)': perMinute.map((m) => m[2]!.toFixed(1)).join(' / ') || '不足 1 分钟',
          电量: batteryStart
            ? `${Math.round(batteryStart.level * 100)}% → ${Math.round(battery!.level * 100)}%${batteryStart.charging || battery!.charging ? '（充电中，耗电数据无效）' : ''}`
            : '浏览器不提供',
          屏幕常亮: screenOn!(),
        }
      : {}),
  };
  pre.textContent = JSON.stringify(summary, null, 2);
  stage.append(pre);
  if (combination) {
    // History for side-by-side comparison on the combination page (this browser only).
    try {
      const history = JSON.parse(localStorage.getItem('livemira-combos') ?? '[]') as unknown[];
      history.unshift({
        time: new Date().toISOString(),
        name: comboName,
        combination: describe(combination),
        seconds,
        readyMs,
        firstPoseMs,
        processedFps: result.processedFps,
        trackedShare: result.trackedShare,
        trackedFps:
          result.processedFps !== null && result.trackedShare !== null
            ? result.processedFps * result.trackedShare
            : null,
        processMs: result.processMsMean,
        lumaMs: result.lumaMsMean,
        mainMs: result.mainThreadMsPerFrame,
        presentGapP99Ms: result.presentGapP99Ms,
        capturePath: info.capturePath,
      });
      localStorage.setItem('livemira-combos', JSON.stringify(history.slice(0, 30)));
    } catch {
      // Storage unavailable (private mode): the server still has the report.
    }
    const back = document.createElement('p');
    back.innerHTML = '<a href="/modules.html">← 返回模块组合页（可对比历次结果）</a>';
    back.style.padding = '0 16px';
    stage.append(back);
  }
}

/** The baseline release engine (LiveMira 0.4.1), loaded at run time from the kit server, as served. */
interface BaselineModule {
  compileGrayTarget(
    image: { widthPx: number; heightPx: number; data: Uint8Array },
    options: { targetId: string },
  ): Promise<unknown>;
  createEngine(options: { container: HTMLElement; extensions?: readonly unknown[] }): {
    setTargets(entries: readonly { target: unknown }[]): Promise<void>;
    start(): Promise<void>;
    stop(reason?: string): Promise<void>;
    dispose(): Promise<void>;
    on(
      type: string,
      listener: (event: { result?: { state: string; cornersPx: readonly (readonly number[])[] | null } }) => void,
    ): () => void;
  };
}

/** Same run and report as `engine()` for the baseline, measured from its events (tracking updates, losses). */
async function baselineRun(): Promise<void> {
  const seconds = Number(params.get('seconds') ?? 60);
  say('正在加载基线引擎并编译目标…');
  // Runtime URLs: the release files are served as they are, not bundled.
  const engineModule = (await import(['', 'baseline-engine.js'].join('/'))) as BaselineModule;
  const visuals = (await import(['', 'baseline-visuals.js'].join('/'))) as {
    createTrackingVisuals(options: { boundary?: boolean }): unknown;
  };
  const manifest = (await (await fetch('/targets.json')).json()) as { id: string; width: number; height: number }[];
  const compileStarted = performance.now();
  const targets = await Promise.all(
    manifest.map(async (t) =>
      engineModule.compileGrayTarget(
        {
          widthPx: t.width,
          heightPx: t.height,
          data: new Uint8Array(await (await fetch(`/targets/${t.id}.gray`)).arrayBuffer()),
        },
        { targetId: t.id },
      ),
    ),
  );
  const compileMs = performance.now() - compileStarted;
  say('正在启动相机与基线引擎…（首次会弹出相机权限，请允许）');
  const started = performance.now();
  const engineInstance = engineModule.createEngine({
    container: stage,
    extensions: [visuals.createTrackingVisuals({ boundary: true })],
  });
  await engineInstance.setTargets(targets.map((target) => ({ target })));
  const perSecond: number[] = [];
  const states = new Map<string, number>();
  const corners: { t: number; c: number[] }[] = [];
  let firstPoseMs: number | null = null;
  let losses = 0;
  const onResult = (event: { result?: { state: string; cornersPx: readonly (readonly number[])[] | null } }): void => {
    const r = event.result;
    if (!r) return;
    const i = Math.floor((performance.now() - started) / 1000);
    while (perSecond.length <= i) perSecond.push(0);
    perSecond[i]!++;
    states.set(r.state, (states.get(r.state) ?? 0) + 1);
    if (r.cornersPx) {
      firstPoseMs ??= performance.now() - started;
      corners.push({ t: performance.now(), c: r.cornersPx.flatMap((p) => [p[0]!, p[1]!]) });
    }
  };
  engineInstance.on('targetFound', onResult);
  engineInstance.on('targetUpdated', onResult);
  engineInstance.on('targetLost', () => losses++);
  await engineInstance.start();
  const readyMs = performance.now() - started;
  const end = performance.now() + seconds * 1000;
  await new Promise<void>((resolve) => {
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
      say(`基线运行中，剩余 ${left} 秒 · 跟踪更新 ${perSecond.at(-2) ?? 0} 次/秒`);
      if (performance.now() >= end) resolve();
      else setTimeout(tick, 500);
    };
    tick();
  });
  await engineInstance.stop('test finished');
  await engineInstance.dispose();
  const full = perSecond.slice(1, -1);
  const trackedFps = full.length ? full.reduce((a, b) => a + b, 0) / full.length : null;
  const result = {
    ...environment(),
    test: 'baseline',
    seconds,
    comboName: 'B0',
    compileMs,
    readyMs,
    firstPoseMs,
    trackedFps,
    losses,
    staticJitterPx: jitter(corners),
    states: Object.fromEntries(states),
    perSecond,
  };
  const saved = await post(`baseline-B0-${seconds}s`, result);
  say(`测试完成${saved ? '，结果已回传' : '（回传失败，请截图本页）'}`);
  stage.innerHTML = '';
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(
    {
      组合: 'B0：LiveMira 0.4.1 原发布版',
      '目标编译(ms)': Math.round(compileMs),
      '就绪(ms)': Math.round(readyMs),
      '首个位姿(ms)': firstPoseMs === null ? '未识别到目标' : Math.round(firstPoseMs),
      '跟踪更新(次/秒)': trackedFps?.toFixed(1) ?? '—',
      丢失次数: losses,
      '静止抖动 σ(px)': result.staticJitterPx?.toFixed(3) ?? '无数据',
    },
    null,
    2,
  );
  stage.append(pre);
  try {
    const history = JSON.parse(localStorage.getItem('livemira-combos') ?? '[]') as unknown[];
    history.unshift({
      time: new Date().toISOString(),
      name: 'B0',
      combination: 'LiveMira 0.4.1 原发布版',
      seconds,
      readyMs,
      firstPoseMs,
      trackedFps,
      capturePath: 'baseline-canvas',
    });
    localStorage.setItem('livemira-combos', JSON.stringify(history.slice(0, 30)));
  } catch {
    // Storage unavailable: the server still has the report.
  }
  const back = document.createElement('p');
  back.innerHTML = '<a href="/modules.html">← 返回模块组合页（可对比历次结果）</a>';
  back.style.padding = '0 16px';
  stage.append(back);
}

const test = params.get('test') ?? 'caps';
(test === 'engine' ? engine() : test === 'baseline' ? baselineRun() : capabilities()).catch(async (e: unknown) => {
  // Engine errors carry a code and the underlying cause (the baseline's EngineError does): keep all of it.
  const error = e as { message?: string; stack?: string; code?: string; cause?: unknown } | null;
  const cause = error?.cause as { message?: string; name?: string; stack?: string } | undefined;
  const message = String(error?.message ?? e);
  if (error?.code === 'UNSUPPORTED_DEVICE') {
    const missing = (e as { missing?: string[] }).missing ?? [];
    say(
      `本设备无法进行识别：${missing.includes('webgl2') ? '需要 WebGL2 支持' : `缺少 ${missing.join('、')}`}（请换用较新的浏览器或设备）`,
    );
    await post('unsupported', { ...environment(), test, missing });
    return;
  }
  say(
    `出错：${error?.code ? `${error.code} ` : ''}${message}${cause ? `（原因：${cause.name ?? ''} ${cause.message ?? String(cause)}）` : ''}`,
  );
  await post('error', {
    ...environment(),
    test,
    code: error?.code ?? null,
    message,
    stack: error?.stack ?? null,
    cause: cause
      ? { name: cause.name ?? null, message: cause.message ?? String(cause), stack: cause.stack ?? null }
      : null,
  });
});
