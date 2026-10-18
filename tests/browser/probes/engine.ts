/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end engine probe: a generated target picture is compiled in the Worker, shown by the synthetic camera, and
// recognised by a full engine (camera, Worker, overlay with a recorded video, diagnostics). Then the engine stops and
// is disposed after a second, short session. The report holds only events, counts and states.

import {
  createEngine,
  DiagnosticLog,
  compileTargetImage,
  type EngineEvents,
} from '../../../packages/sdk/src/index.ts';
import type { SyntheticCameraControl } from '../harness/synthetic-camera.ts';
import { recordClip, targetPicture } from './pictures.ts';

export interface EngineProbeReport {
  readonly events: readonly string[];
  readonly found: { targetId: string | null; state: string } | null;
  readonly capability: Record<string, unknown> | null;
  readonly layersWhileRunning: number;
  readonly planeShown: boolean;
  readonly layersAfterDispose: number;
  readonly diagnostics: {
    level: string;
    events: number;
    frames: number;
    results: number;
    timings: number;
  };
  readonly mediaStates: readonly string[];
  readonly error: string | null;
  readonly camera: unknown;
  /** Internal presentation switches reported by the engine. */
  readonly experiments: unknown;
  /** The loss display grace each session snapshot recorded (the engine default here). */
  readonly graces: readonly number[];
  /** Per session: the camera clock offset in its first snapshot and in its latest update. */
  readonly clockMappings: readonly { initial: number | null; latest: number | null }[];
}

const WORKER_URL = '/worker/vision.js';

const waitFor = (check: () => boolean, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    const started = performance.now();
    const tick = (): void => {
      if (check()) resolve(true);
      else if (performance.now() - started > ms) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  });

async function probe(): Promise<EngineProbeReport> {
  const events: string[] = [];
  const mediaStates: string[] = [];
  let found: EngineProbeReport['found'] = null;
  let capability: Record<string, unknown> | null = null;
  let error: string | null = null;
  const stage = document.createElement('div');
  Object.assign(stage.style, { position: 'fixed', inset: '0' });
  document.body.append(stage);
  const workerFactory = (): Worker => new Worker(WORKER_URL, { type: 'module' });
  const picture = targetPicture();
  const blob = await new Promise<Blob>((resolve) =>
    picture.toBlob((b) => resolve(b!), 'image/png'),
  );
  const target = await compileTargetImage(blob, { targetId: 'probe-target', workerFactory });
  const clip = await recordClip();
  const log = new DiagnosticLog({ level: 'full' });
  const query = new URLSearchParams(location.search);
  const engine = createEngine({
    container: stage,
    camera: {
      processingLongEdge: 640,
      ...(query.get('capture') === 'auto' ? { capture: 'auto' as const } : {}),
      ...(query.get('timestamps') === 'media-time' ? { timestamps: 'media-time' as const } : {}),
    },
    adapters: { workerFactory },
    diagnostics: log,
  });
  const names: (keyof EngineEvents)[] = [
    'attemptStart',
    'sessionConfig',
    'stageTiming',
    'cameraPermission',
    'cameraSize',
    'capabilityChanged',
    'ready',
    'targetFound',
    'targetLost',
    'sessionEnded',
    'sessionStartFailed',
    'error',
  ];
  for (const name of names) {
    engine.on(name, (event) => {
      events.push(name);
      if (name === 'targetFound') {
        const result = (event as EngineEvents['targetFound']).result;
        found ??= { targetId: result.targetId, state: result.state };
      }
      if (name === 'capabilityChanged')
        capability = { ...(event as EngineEvents['capabilityChanged']).capability };
      if (name === 'error') error = (event as EngineEvents['error']).error.code;
    });
  }
  engine.on('mediaState', (event) => mediaStates.push(event.state));
  const clockMappings: { initial: number | null; latest: number | null }[] = [];
  const offset = (config: { cameraClockMapping: { sourceToSessionOffsetUs: number } | null }) =>
    config.cameraClockMapping?.sourceToSessionOffsetUs ?? null;
  const graces: number[] = [];
  engine.on('sessionConfig', (event) => {
    graces.push(event.config.lossDisplayGraceMs);
    clockMappings.push({ initial: offset(event.config), latest: offset(event.config) });
  });
  engine.on('sessionConfigUpdated', (event) => {
    clockMappings.at(-1)!.latest = offset(event.config);
  });
  await engine.setTargets([{ target, ...(clip ? { media: { file: clip } } : {}) }]);
  const camera = (window as unknown as { __syntheticCamera: SyntheticCameraControl })
    .__syntheticCamera;
  camera.setImage(picture, 0.6);
  await engine.start();
  await waitFor(() => found !== null, 15000);
  await waitFor(() => !clip || mediaStates.includes('shown'), 3000);
  const layersWhileRunning = stage.children.length;
  const cameraDiagnostics = engine.getDiagnostics().camera;
  const { experiments } = engine.getDiagnostics();
  const plane = stage.querySelector('[data-livemira-layer="overlay"] > div') as HTMLElement | null;
  const planeShown = plane?.style.display === 'block';
  camera.setImage(null);
  await waitFor(() => events.includes('targetLost'), 5000);
  await engine.stop('probe-done');
  // A second session must map its own clock, not keep the first one's.
  await engine.start();
  await waitFor(() => clockMappings[1]?.latest != null, 5000);
  await engine.stop('probe-done');
  await engine.dispose();
  const exported = log.export();
  return {
    events,
    found,
    capability,
    layersWhileRunning,
    planeShown,
    layersAfterDispose: stage.children.length,
    diagnostics: {
      level: exported.level,
      events: exported.events.length,
      frames: exported.frames?.length ?? 0,
      results: exported.results?.length ?? 0,
      timings: exported.workerTimings?.length ?? 0,
    },
    mediaStates: [...new Set(mediaStates)],
    error,
    camera: cameraDiagnostics,
    experiments,
    graces,
    clockMappings,
  };
}

(window as unknown as { __probe: Promise<EngineProbeReport> }).__probe = probe();
