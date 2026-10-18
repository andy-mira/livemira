/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The public demo: a full-screen camera stage, one target picture and its video. Everything runs on the device; the
// page uploads nothing. It uses only the public engine entry (the single-file build, loaded at run time).

import {
  compileTargetImage,
  createEngine,
  DiagnosticLog,
  type Engine,
  type EngineEvents,
  type TargetBundle,
  type TargetMedia,
} from '@livemira/engine';
import {
  DiagnosticsPanel,
  FloatingDock,
  mountShell,
  StatusBadge,
  Toast,
} from '@livemira/page-shell';

import type { TrackingVisuals } from '@livemira/tracking-visuals';

import { demoText } from './text.ts';

const SAMPLES = [
  { id: 'forest-03', file: 'forest-03.png' },
  { id: 'bird-01', file: 'bird-01.png' },
  { id: 'mountain-01', file: 'mountain-01.png' },
  { id: 'ship-01', file: 'ship-01.png' },
] as const;
const SAMPLE_VIDEO = './assets/original-grid.webm';
// The bundled script sits next to the assets folder.
const asset = (file: string): string => new URL(`./assets/${file}`, import.meta.url).href;

type MediaChoice =
  | { readonly kind: 'sample' }
  | { readonly kind: 'file'; readonly file: File }
  | { readonly kind: 'url'; readonly url: string };

interface Options {
  longEdge: 480 | 640 | 960 | 'native';
  stageFit: 'cover' | 'contain';
  graceMs: 0 | 500;
  capture: 'auto' | 'canvas';
  mediaFit: 'contain' | 'cover';
  boundary: boolean;
  points: boolean;
}

const text = demoText();
document.documentElement.lang = text === demoText('zh') ? 'zh-CN' : 'en';
document.title = `${text.title} demo`;

const shell = mountShell();
const badge = new StatusBadge(shell.floating);
const toast = new Toast(shell.floating);
const dock = new FloatingDock(shell.floating, { storageKey: 'livemira-demo-panel' });
const log = new DiagnosticLog({ level: 'key' });

// Defaults as in the earlier demo: 640 processing long edge, 500 ms grace, canvas capture with callback timestamps; the
// picture fills the screen.
const options: Options = {
  longEdge: 640,
  stageFit: 'cover',
  graceMs: 500,
  capture: 'canvas',
  mediaFit: 'contain',
  boundary: true,
  points: true,
};
let optionsKey = '';
let engine: Engine | null = null;
let visuals: TrackingVisuals | null = null;
let isBusy = false;
let target: TargetBundle | null = null;
let targetSource: { kind: 'sample'; id: string } | { kind: 'file'; file: File } = {
  kind: 'sample',
  id: SAMPLES[0].id,
};
let media: MediaChoice = { kind: 'sample' };
const compiled = new Map<string, TargetBundle>();

// ---- small DOM helpers ----

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function select<T extends string | number>(
  label: string,
  values: readonly (readonly [T, string])[],
  current: T,
  onChange: (value: T) => void,
): HTMLLabelElement {
  const input = element('select');
  for (const [value, name] of values)
    input.append(element('option', { value: String(value), textContent: name }));
  input.value = String(current);
  input.addEventListener('change', () => {
    const match = values.find(([value]) => String(value) === input.value);
    if (match) onChange(match[0]);
  });
  return element('label', {}, [label, input]);
}

// ---- panels ----

const runPanel = dock.addPanel({ id: 'run', icon: '▶', title: text.run });
const startButton = element('button', {
  type: 'button',
  className: 'lm-primary',
  textContent: text.start,
});
const stopButton = element('button', { type: 'button', textContent: text.stop, disabled: true });
const soundButton = element('button', { type: 'button', textContent: text.sound });
const muteButton = element('button', { type: 'button', textContent: text.mute });
const retryButton = element('button', { type: 'button', textContent: text.retry, hidden: true });
runPanel.append(
  element('div', {}, [startButton, stopButton]),
  element('div', {}, [soundButton, muteButton, retryButton]),
  element('p', { className: 'lm-hint', textContent: text.startHint }),
);

const targetPanel = dock.addPanel({ id: 'targets', icon: '🖼', title: text.targets });
const targetUpload = element('input', { type: 'file', accept: 'image/*' });
const videoFile = element('input', { type: 'file', accept: 'video/*' });
const videoUrl = element('input', { type: 'url', placeholder: 'https://…' });
const useUrl = element('button', { type: 'button', textContent: text.useUrl });
targetPanel.append(
  select(
    text.target,
    SAMPLES.map((s) => [s.id, s.id] as const),
    SAMPLES[0].id as string,
    (id) => {
      targetSource = { kind: 'sample', id };
      target = null;
    },
  ),
  element('label', {}, [text.uploadTarget, targetUpload]),
  element('p', { className: 'lm-hint' }, [
    element('a', {
      href: asset('CREDITS.md'),
      target: '_blank',
      rel: 'noopener',
      textContent: text.credits,
    }),
  ]),
  element('h2', { textContent: text.video }),
  select(text.video, [['sample', text.sampleVideo]] as const, 'sample', () => {
    media = { kind: 'sample' };
  }),
  element('label', {}, [text.localVideo, videoFile]),
  element('label', {}, [text.urlVideo, videoUrl]),
  useUrl,
  select(
    text.mediaFit,
    [
      ['contain', text.contain],
      ['cover', text.cover],
    ] as const,
    options.mediaFit,
    (fit) => {
      options.mediaFit = fit;
    },
  ),
);
targetUpload.addEventListener('change', () => {
  const file = targetUpload.files?.[0];
  if (file) {
    targetSource = { kind: 'file', file };
    target = null;
  }
});
videoFile.addEventListener('change', () => {
  const file = videoFile.files?.[0];
  if (file) media = { kind: 'file', file };
});
useUrl.addEventListener('click', () => {
  if (/^https:\/\//.test(videoUrl.value)) media = { kind: 'url', url: videoUrl.value };
});

const optionsPanel = dock.addPanel({ id: 'options', icon: '⚙', title: text.options });
optionsPanel.append(
  select(
    text.longEdge,
    [
      [480, '480'],
      [640, '640'],
      [960, '960'],
      ['native', text.native],
    ] as const,
    options.longEdge,
    (v) => {
      options.longEdge = v;
    },
  ),
  select(
    text.stageFit,
    [
      ['cover', text.cover],
      ['contain', text.contain],
    ] as const,
    options.stageFit,
    (v) => {
      options.stageFit = v;
    },
  ),
  select(
    text.grace,
    [
      [500, '500 ms'],
      [0, text.graceOff],
    ] as const,
    options.graceMs,
    (v) => {
      options.graceMs = v;
    },
  ),
  select(
    text.capture,
    [
      ['canvas', text.captureCanvas],
      ['auto', text.captureAuto],
    ] as const,
    options.capture,
    (v) => {
      options.capture = v;
    },
  ),
  element('p', { className: 'lm-hint', textContent: text.optionsHint }),
);

const visualsPanel = dock.addPanel({ id: 'visuals', icon: '◇', title: text.visuals });
const checkbox = (
  label: string,
  isChecked: boolean,
  onChange: (isOn: boolean) => void,
): HTMLLabelElement => {
  const input = element('input', { type: 'checkbox', checked: isChecked });
  input.addEventListener('change', () => onChange(input.checked));
  return element('label', {}, [input, ` ${label}`]);
};
const applyVisuals = (): void =>
  visuals?.setVisualization({ boundary: options.boundary, points: options.points });
visualsPanel.append(
  checkbox(text.boundary, options.boundary, (isOn) => {
    options.boundary = isOn;
    applyVisuals();
  }),
  checkbox(text.points, options.points, (isOn) => {
    options.points = isOn;
    applyVisuals();
  }),
  element('p', { className: 'lm-hint', textContent: text.visualsHint }),
);

const diagnosticsPanel = dock.addPanel({ id: 'diagnostics', icon: '🩺', title: text.diagnostics });
const diagnostics = new DiagnosticsPanel(diagnosticsPanel, log, text, (message) =>
  toast.show(message),
);

// ---- engine ----

function refreshButtons(): void {
  const state = engine?.state ?? 'idle';
  startButton.disabled = isBusy || state === 'running' || state === 'starting';
  stopButton.disabled = isBusy || state !== 'running';
}

async function prepareTarget(): Promise<TargetBundle> {
  if (target) return target;
  badge.show(text.compiling);
  if (targetSource.kind === 'sample') {
    const id = targetSource.id;
    let bundle = compiled.get(id);
    if (!bundle) {
      const file = SAMPLES.find((s) => s.id === id)!.file;
      const image = await (await fetch(asset(file))).blob();
      bundle = await compileTargetImage(image, { targetId: id });
      compiled.set(id, bundle);
    }
    target = bundle;
  } else {
    target = await compileTargetImage(targetSource.file, { targetId: 'uploaded' });
  }
  return target;
}

function mediaFor(): TargetMedia {
  const fit = options.mediaFit;
  if (media.kind === 'file') return { file: media.file, fit, isMuted: true };
  if (media.kind === 'url') return { url: media.url, fit, isMuted: true };
  return { url: new URL(SAMPLE_VIDEO, location.href).href, fit, isMuted: true, crossOrigin: null };
}

function observe(next: Engine): void {
  const on = <K extends keyof EngineEvents>(
    name: K,
    listener: (event: EngineEvents[K]) => void,
  ): void => void next.on(name, listener);
  on('ready', () => badge.show(text.searching));
  on('targetFound', () => badge.show(text.tracking, 'good'));
  on('targetUpdated', (event) =>
    badge.show(
      event.result.quality.isMeasured ? text.tracking : text.predicting,
      event.result.quality.isMeasured ? 'good' : 'warn',
    ),
  );
  on('targetLost', () => badge.show(text.lost, 'warn'));
  on('playbackBlocked', () => {
    retryButton.hidden = false;
    toast.show(text.blocked, 5000);
  });
  on('mediaState', (event) => {
    if (event.state === 'playing') retryButton.hidden = true;
  });
  on('error', (event) => {
    if (event.error.code === 'MEDIA_FAILED') retryButton.hidden = false;
  });
  on('cameraStatus', () => badge.show(text.cameraError, 'bad'));
  on('sessionEnded', (event) => {
    if (!event.reason.startsWith('camera-')) badge.show(text.stopped);
    refreshButtons();
    diagnostics.refresh();
  });
}

async function ensureEngine(): Promise<Engine> {
  const key = JSON.stringify([
    options.longEdge,
    options.stageFit,
    options.graceMs,
    options.capture,
    // Matched points come from the Worker only if requested when the engine is created.
    options.boundary || options.points,
    options.points,
  ]);
  if (engine && key === optionsKey) return engine;
  await engine?.dispose();
  visuals = null;
  if (options.boundary || options.points) {
    // The drawing is an optional module, loaded only when it is wanted.
    const { createTrackingVisuals } = await import('@livemira/tracking-visuals');
    visuals = createTrackingVisuals({ boundary: options.boundary, points: options.points });
  }
  const next = createEngine({
    container: shell.stage,
    camera: {
      processingLongEdge: options.longEdge,
      fit: options.stageFit,
      capture: options.capture,
      // Canvas readback uses callback timestamps because some browsers never advance a
      // camera stream's media time, and every frame after the first then looks like a repeat.
      timestamps: options.capture === 'canvas' ? 'callback' : 'media-time',
    },
    tracking: { lossDisplayGraceMs: options.graceMs },
    diagnostics: log,
    ...(visuals ? { extensions: [visuals] } : {}),
  });
  observe(next);
  engine = next;
  optionsKey = key;
  return next;
}

async function exclusive(action: () => Promise<void>): Promise<void> {
  if (isBusy) return;
  isBusy = true;
  refreshButtons();
  try {
    await action();
  } catch (error) {
    badge.show(text.failed, 'bad');
    toast.show(
      `${text.failed}: ${(error as { code?: string }).code ?? (error as Error).name}`,
      5000,
    );
  } finally {
    isBusy = false;
    refreshButtons();
  }
}

startButton.addEventListener(
  'click',
  () =>
    void exclusive(async () => {
      const bundle = await prepareTarget();
      const next = await ensureEngine();
      await next.setTargets([{ target: bundle, media: mediaFor() }]);
      badge.show(text.starting);
      retryButton.hidden = true;
      await next.start();
    }),
);
stopButton.addEventListener(
  'click',
  () => void exclusive(async () => void (await engine?.stop('user'))),
);
soundButton.addEventListener('click', () => void engine?.media.setMuted(false));
muteButton.addEventListener('click', () => void engine?.media.setMuted(true));
retryButton.addEventListener('click', () => void engine?.media.retry());

badge.show(text.idle);
if (dock.openPanel === null) dock.open('run');
refreshButtons();

/** For automated checks of the demo page (no effect on its behaviour). */
Object.defineProperty(window, '__livemiraDemo', {
  value: {
    get state() {
      return engine?.state ?? 'idle';
    },
    get badge() {
      return badge.text;
    },
    log,
  },
});
