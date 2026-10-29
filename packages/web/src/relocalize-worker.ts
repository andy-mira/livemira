// SPDX-License-Identifier: Apache-2.0
// The relocalisation Worker: the slow loop's periodic detection, run concurrently with tracking. It receives a
// frame's gray pixels, the ROI and the pose tracked in that frame from the vision Worker over a MessagePort, and
// answers with the detection (or null) so the vision Worker can correct drift without ever waiting for it.
// `startRelocalizer` installs it on a Worker scope (the engine's single Worker file picks a role first).

import type { TargetImage } from '@livemira-next/contracts';
import { OrbDetector } from '@livemira-next/features';
import { upscaleFor } from '@livemira-next/tracking';

import type { RelocalizerRequest, RelocalizerResponse, ToRelocalizer } from './protocol.ts';

export interface RelocalizerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<ToRelocalizer>) => void): void;
}

/** Installs the relocalisation Worker's message handling on `scope` (a Worker's global scope). */
export function startRelocalizer(scope: RelocalizerScope = globalThis as unknown as RelocalizerScope): void {
  scope.addEventListener('message', onMessage);
}

/** Loaded after 'init'; a 'targets' message replaces what it detects. */
let detector: OrbDetector | null = null;
/** Requests wait for the targets being (re)loaded, so an answer never mixes two target sets. */
let loading: Promise<void> = Promise.resolve();

function onMessage(event: MessageEvent<ToRelocalizer>): void {
  const message = event.data;
  if (message.type === 'targets') {
    const assets = message.assets.map((a) => new Uint8Array(a));
    loading = loading.then(async () => {
      await detector?.loadEncoded(assets);
    });
    return;
  }
  if (message.type !== 'init') return;
  const created = new OrbDetector(
    message.wasm === false ? { allowWasm: false, orb: { wasm: false }, compile: { orb: { wasm: false } } } : {},
  );
  detector = created;
  loading = (async () => {
    if (message.assets?.length) await created.loadEncoded(message.assets.map((a) => new Uint8Array(a)));
    else
      await created.load(
        message.targets.map((t): TargetImage => ({
          info: t.info,
          image: { width: t.info.width, height: t.info.height, stride: t.info.width, data: new Uint8Array(t.gray) },
        })),
      );
  })();
  const port = message.port;
  port.addEventListener('message', (e: MessageEvent<RelocalizerRequest>) => {
    const r = e.data;
    void (async () => {
      await loading;
      const started = performance.now();
      const found = await created.detect(
        {
          sessionId: 'relocalize',
          frameId: r.frameId,
          time: { captureUs: r.captureUs, receiveUs: started * 1000, source: 'videoframe-timestamp' },
          image: {
            kind: 'cpu-gray',
            image: { width: r.width, height: r.height, stride: r.width, data: new Uint8Array(r.gray) },
          },
        },
        { roi: r.roi, upscale: upscaleFor(r.tracked) },
      );
      const response: RelocalizerResponse = {
        type: 'relocalized',
        id: r.id,
        detected: found.find((d) => d.targetId === r.tracked.targetId) ?? null,
        tracked: r.tracked,
        detectUs: (performance.now() - started) * 1000,
      };
      port.postMessage(response);
    })();
  });
  port.start();
}
