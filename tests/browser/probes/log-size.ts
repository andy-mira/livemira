/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Diagnostic log size measurement: a real engine session against the synthetic camera, the target alternately in view
// (5 s) and out of view (2 s), a playing video, at the log level given in the query (?level=key|full&seconds=60).
// Reports the export size and record counts; run by tests/browser/measure-log-size.ts.

import {
  compileTargetImage,
  createEngine,
  DiagnosticLog,
} from '../../../packages/sdk/src/index.ts';
import type { SyntheticCameraControl } from '../harness/synthetic-camera.ts';

export interface LogSizeReport {
  readonly level: string;
  readonly seconds: number;
  readonly bytes: number;
  readonly events: number;
  readonly frames: number;
  readonly results: number;
  readonly workerTimings: number;
  readonly dropped: number;
  readonly eventTypes: Readonly<Record<string, number>>;
}

const WORKER_URL = '/worker/vision.js';

/** A deterministic, feature-rich picture: seeded blocks and circles. */
function targetPicture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  let seed = 12345;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 480, 360);
  for (let i = 0; i < 220; i++) {
    const shade = Math.floor(random() * 256);
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    const x = random() * 480;
    const y = random() * 360;
    if (random() < 0.5) g.fillRect(x, y, 8 + random() * 40, 8 + random() * 40);
    else {
      g.beginPath();
      g.arc(x, y, 4 + random() * 22, 0, Math.PI * 2);
      g.fill();
    }
  }
  return canvas;
}

/** A short recorded clip of an animated canvas, or null where MediaRecorder cannot record one. */
async function recordClip(): Promise<Blob | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const g = canvas.getContext('2d')!;
  let n = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(n++ * 25) % 360} 70% 50%)`;
    g.fillRect(0, 0, 320, 240);
  }, 40);
  const type = ['video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) {
    clearInterval(timer);
    return null;
  }
  const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: type });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  recorder.stop();
  await stopped;
  clearInterval(timer);
  return new Blob(chunks, { type });
}

async function measure(): Promise<LogSizeReport> {
  const query = new URLSearchParams(location.search);
  const level = query.get('level') === 'full' ? 'full' : 'key';
  const seconds = Number(query.get('seconds') ?? '60');
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'fixed', inset: '0' });
  document.body.append(stage);
  const workerFactory = (): Worker => new Worker(WORKER_URL, { type: 'module' });
  const picture = targetPicture();
  const blob = await new Promise<Blob>((resolve) =>
    picture.toBlob((b) => resolve(b!), 'image/png'),
  );
  const target = await compileTargetImage(blob, { targetId: 'log-target', workerFactory });
  const clip = await recordClip();
  const log = new DiagnosticLog({ level });
  const engine = createEngine({
    container: stage,
    camera: {
      processingLongEdge: 640,
      ...(query.get('timestamps') === 'callback' ? { timestamps: 'callback' as const } : {}),
    },
    tracking: { lossDisplayGraceMs: 500 },
    adapters: { workerFactory },
    diagnostics: log,
  });
  await engine.setTargets([{ target, ...(clip ? { media: { file: clip } } : {}) }]);
  const camera = (window as unknown as { __syntheticCamera: SyntheticCameraControl })
    .__syntheticCamera;
  await engine.start();
  const started = performance.now();
  while (performance.now() - started < seconds * 1000) {
    camera.setImage(picture, 0.6);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    camera.setImage(null);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await engine.stop('measured');
  await engine.dispose();
  const exported = log.export();
  const eventTypes: Record<string, number> = {};
  for (const e of exported.events) eventTypes[e.type] = (eventTypes[e.type] ?? 0) + 1;
  return {
    level,
    seconds: (performance.now() - started) / 1000,
    bytes: new TextEncoder().encode(JSON.stringify(exported)).length,
    events: exported.events.length,
    frames: exported.frames?.length ?? 0,
    results: exported.results?.length ?? 0,
    workerTimings: exported.workerTimings?.length ?? 0,
    dropped: exported.droppedRecords,
    eventTypes,
  };
}

(window as unknown as { __probe: Promise<LogSizeReport> }).__probe = measure();
