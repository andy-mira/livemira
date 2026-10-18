/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Camera UI probe: the real UI over the real engine. A photo URL is downloaded and compiled, the synthetic camera
// shows it, the video is downloaded only after recognition and plays, the photo goes away, and destroy() leaves
// nothing behind. The report holds only states, counts and codes.

import * as engine from '../../../packages/sdk/src/index.ts';
import { mountArCamera, type ArState } from '../../../packages/ui/src/index.ts';
import type { SyntheticCameraControl } from '../harness/synthetic-camera.ts';
import { recordClip, targetPicture } from './pictures.ts';

export interface UiProbeReport {
  readonly phases: readonly string[];
  readonly views: readonly string[];
  readonly statuses: readonly string[];
  /** Media kinds in the order they were requested. */
  readonly requests: readonly string[];
  /** Requests made before the photo was recognized. */
  readonly requestsBeforeFound: number;
  readonly hasClip: boolean;
  readonly notice: string | null;
  readonly soundShownWhileScanning: boolean;
  readonly engineLayersWhileRunning: number;
  readonly after: {
    readonly roots: number;
    readonly styles: number;
    readonly bodyOverflow: string;
    readonly engineLayers: number;
    readonly isDisposed: boolean;
  };
  readonly error: string | null;
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

async function probe(): Promise<UiProbeReport> {
  const picture = targetPicture();
  const photo = await new Promise<Blob>((resolve) =>
    picture.toBlob((b) => resolve(b!), 'image/png'),
  );
  const clip = await recordClip();
  const requests: string[] = [];
  let requestsBeforeFound = 0;
  const phases: string[] = [];
  const views: string[] = [];
  const statuses: string[] = [];
  const camera = (window as unknown as { __syntheticCamera: SyntheticCameraControl })
    .__syntheticCamera;
  camera.setImage(picture, 0.6);
  document.body.style.overflow = 'visible';
  const handle = mountArCamera(document.body, {
    loadEngine: () => engine,
    targets: [{ id: 'probe-photo', photo: '/media/photo.png', video: '/media/video.webm' }],
    engineOptions: {
      adapters: { workerFactory: () => new Worker(WORKER_URL, { type: 'module' }) },
    },
    loadMedia: async (_url, { kind }) => {
      requests.push(kind);
      return kind === 'photo' ? photo : (clip ?? new Blob(['not a video'], { type: 'video/webm' }));
    },
    observe: (o) => {
      if (o.type === 'target' && o.name === 'found' && requestsBeforeFound === 0)
        requestsBeforeFound = requests.length;
    },
    locale: 'en',
    onExit: () => {},
  });
  const record = (state: ArState): void => {
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
    if (state.phase === 'scanning' && views.at(-1) !== state.view) views.push(state.view);
    const status = document.querySelector('.lm-ar__text')?.textContent ?? '';
    if (status && statuses.at(-1) !== status) statuses.push(status);
  };
  handle.session.subscribe(() => record(handle.session.getState()));
  const state = (): ArState => handle.session.getState();
  await waitFor(() => state().view === (clip ? 'playing' : 'videoError'), 20000);
  const stage = document.querySelector('.lm-ar__stage');
  const engineLayersWhileRunning = stage?.children.length ?? 0;
  const sound = document.querySelector('.lm-ar__sound') as HTMLElement | null;
  const soundShownWhileScanning = sound !== null && !sound.hidden;
  camera.setImage(null);
  await waitFor(() => state().view === 'lost', 8000);
  const notice = state().notice?.key ?? null;
  await handle.destroy();
  return {
    phases,
    views,
    statuses,
    requests,
    requestsBeforeFound,
    hasClip: clip !== null,
    notice,
    soundShownWhileScanning,
    engineLayersWhileRunning,
    after: {
      roots: document.querySelectorAll('.lm-ar').length,
      styles: document.querySelectorAll('style[data-livemira-ui]').length,
      bodyOverflow: document.body.style.overflow,
      engineLayers: stage?.children.length ?? 0,
      isDisposed: state().isDisposed,
    },
    error: null,
  };
}

(window as unknown as { __probe: Promise<UiProbeReport> }).__probe = probe().catch(
  (error: unknown) =>
    ({ error: error instanceof Error ? error.message : String(error) }) as unknown as UiProbeReport,
);
