// SPDX-License-Identifier: Apache-2.0
// ⑩ LiveMorae material comparison, the phone side: the camera UI over a diagnostic build of the engine, with
// LiveMorae's demo photo and video added to the release demo's photos. Every processed frame (tracking state, the
// target's size on screen, pose quality, stage times) and every recognition event is recorded and sent to the test
// server every 30 s and on exit. The computer shows the photo in turn in several ways (compare/targets.html); the
// report is split by those intervals afterwards (bench/device/compare-report.ts).

import { mountArCamera, type ArCameraHandle, type ArTarget, type EngineModule } from '@livemira-next/ui';

interface Trace {
  readonly timeMs: number;
  readonly wallMs: number;
  readonly state: string;
  readonly size: readonly [number, number];
  readonly poses: readonly { readonly targetId: string; readonly corners: readonly (readonly number[])[] }[];
  readonly processUs: number;
  readonly lumaUs: number;
  readonly measured?: readonly {
    readonly origin: string;
    readonly support: number;
    readonly ratio: number;
    readonly residual: number;
    readonly coverage: number;
  }[];
  readonly timings?: Readonly<Record<string, number>>;
}

/** Columns of `frames`, one row per processed frame. */
const FIELDS = [
  'ms',
  'state',
  'target',
  'longEdgePx',
  'areaShare',
  'origin',
  'support',
  'ratio',
  'residual',
  'coverage',
  'trackUs',
  'detectUs',
  'processUs',
  'lumaUs',
] as const;

const run = Date.now().toString(36);
const startedWall = Date.now();
const started = performance.now();
const frames: (string | number)[][] = [];
const events: (string | number)[][] = [];
const info: Record<string, unknown> = {};
const ms = (): number => Math.round(performance.now() - started);
const event = (...fields: (string | number)[]): void => {
  events.push([ms(), ...fields]);
};

const longEdge = (c: Trace['poses'][number]['corners']): number =>
  Math.max(...c.map((p, i) => Math.hypot(c[(i + 1) % 4]![0]! - p[0]!, c[(i + 1) % 4]![1]! - p[1]!)));
const area = (c: Trace['poses'][number]['corners']): number =>
  Math.abs(c.reduce((sum, p, i) => sum + p[0]! * c[(i + 1) % 4]![1]! - c[(i + 1) % 4]![0]! * p[1]!, 0)) / 2;

let lastSize: readonly [number, number] = [0, 0];

function record(t: Trace): void {
  const pose = t.poses[0];
  const m = t.measured?.[0];
  frames.push([
    Math.round(t.timeMs - started),
    t.state,
    pose?.targetId ?? '',
    pose ? Math.round(longEdge(pose.corners)) : 0,
    pose ? +(area(pose.corners) / (t.size[0] * t.size[1])).toFixed(3) : 0,
    m?.origin ?? '',
    m?.support ?? 0,
    m ? +m.ratio.toFixed(3) : 0,
    m ? +m.residual.toFixed(1) : 0,
    m ? +m.coverage.toFixed(2) : 0,
    Math.round(t.timings?.track ?? 0),
    Math.round(t.timings?.detect ?? 0),
    Math.round(t.processUs),
    Math.round(t.lumaUs),
  ]);
  info.standardSize ??= t.size;
  if (t.size[0] !== lastSize[0] || t.size[1] !== lastSize[1]) {
    lastSize = t.size;
    event('size', t.size[0], t.size[1]);
  }
}

let uploading: Promise<boolean> | null = null;
async function upload(final: boolean): Promise<boolean> {
  await uploading;
  const body = JSON.stringify({
    kind: 'compare',
    run,
    final,
    startedWall,
    uploadWall: Date.now(),
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio },
    info,
    fields: FIELDS,
    frames,
    events,
  });
  uploading = fetch(`/report?kind=compare-${run}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }).then(
    (r) => r.ok,
    () => false,
  );
  return uploading;
}

/** The engine module with every created engine's events recorded. */
async function loadEngine(): Promise<EngineModule> {
  const module = (await import(new URL('./livemira-engine.mjs', location.href).href)) as EngineModule;
  return {
    ...module,
    createEngine(options) {
      const engine = module.createEngine(options);
      const on = engine.on.bind(engine) as (type: string, listener: (e: Record<string, unknown>) => void) => () => void;
      on('trace', (t) => record(t as unknown as Trace));
      on('ready', (e) => {
        Object.assign(info, { profile: e.profile, capture: e.capture, fallbacks: e.fallbacks });
        event('ready', String(e.profile), String(e.capture));
      });
      on('targetFound', (e) => event('found', String(e.targetId)));
      on('targetLost', (e) => event('lost', String(e.targetId), String(e.reason)));
      on('media', (e) => event('media', String(e.targetId), String(e.state), String(e.code ?? '')));
      on('viewport', (e) => event('viewport', String(e.phase)));
      on('profileChange', (e) => event('profile', String(e.from), String(e.to)));
      on('ended', (e) => event('ended', String(e.reason)));
      return engine;
    },
  };
}

const landing = document.getElementById('landing')!;
const result = document.getElementById('result')!;
const video = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"')
  ? 'assets/demo-video.mp4'
  : 'assets/demo-video.webm';
const targets: ArTarget[] = [
  { id: 'livemorae-demo', photo: 'assets/demo-memory.png', video: 'assets/demo-memory.mp4' },
  ...['bird-01', 'forest-03', 'mountain-01', 'ship-01'].map((id) => ({ id, photo: `assets/${id}.png`, video })),
];

function summary(): string {
  const byTarget = new Map<string, number>();
  for (const f of frames) if (f[2]) byTarget.set(String(f[2]), (byTarget.get(String(f[2])) ?? 0) + 1);
  const losses = events.filter((e) => e[1] === 'lost' && e[3] === 'out-of-view').length;
  const seen = [...byTarget].map(([id, n]) => `${id} ${n} 帧`).join('，') || '无';
  return `共 ${frames.length} 帧；识别到：${seen}；丢失 ${losses} 次。`;
}

let camera: ArCameraHandle | null = null;
let timer = 0;
document.getElementById('start')!.addEventListener('click', () => {
  if (camera) return;
  landing.hidden = true;
  const profile = (document.getElementById('profile') as HTMLSelectElement).value as 'swift' | 'hawk';
  const processingScale = Number((document.getElementById('scale') as HTMLSelectElement).value) as 1 | 0.75 | 0.5;
  Object.assign(info, { requestedProfile: profile, processingScale });
  // Each run of one page records its own settings: the report is split at these.
  event('start', profile, processingScale);
  camera = mountArCamera(document.body, {
    loadEngine,
    targets,
    engineOptions: { profile, camera: { processingScale } },
    locale: 'zh-CN',
    isAutoStart: false,
    classifyError: (cause, context) => {
      const e = cause as { code?: string; message?: string } | null;
      event('error', context.phase, context.targetId ?? '', e?.code ?? '', String(e?.message ?? cause).slice(0, 200));
      console.error('compare', context.phase, cause);
    },
    observe: (o) => {
      if (o.type === 'target' && o.name.startsWith('video'))
        event(o.name, o.targetId, o.durationMs ?? '', o.code ?? '');
    },
    onExit: () => {
      const closing = camera;
      camera = null;
      clearInterval(timer);
      event('exit');
      result.textContent = '正在回传…';
      landing.hidden = false;
      void closing
        ?.destroy()
        .then(() => upload(true))
        .then((ok) => {
          result.textContent = `${ok ? '已回传' : '回传失败，请重试或截图'}。${summary()}`;
        });
    },
  });
  // Started from the tap: the camera prompt and playback have the user's gesture.
  camera.view.start();
  timer = window.setInterval(() => void upload(false), 30_000);
});
