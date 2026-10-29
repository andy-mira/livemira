// SPDX-License-Identifier: Apache-2.0
// Probe page (test side): starts the engine against the page's camera (Chromium fake device or the injected WebKit
// canvas camera) with diagnostics on, and keeps every result and presentation for the runner to collect.

import type { CapturePath } from '@livemira-next/web';

import { startEngine, type CompositorKind } from '../prototype/index.ts';

interface ProbeRecord {
  results: {
    t: number;
    sequence: number;
    strip: number[] | null;
    state: string;
    corners: number[][];
    lumaUs: number;
    processUs: number;
    lumaPath: string;
  }[];
  presents: { t: number; tag: number[] | null; drawUs: number; corners: number[][] }[];
  info: Record<string, unknown> | null;
  error: string | null;
  /** performance.now() when the engine was ready and when the first pose arrived (navigation start = 0). */
  readyMs: number | null;
  firstPoseMs: number | null;
}

const record: ProbeRecord = { results: [], presents: [], info: null, error: null, readyMs: null, firstPoseMs: null };
(globalThis as unknown as { __probe: ProbeRecord }).__probe = record;

/** Frame number from the 128×8 bottom-left strip: 16 cells of 8 px, bright = 1, least significant first. */
function decode(strip: ArrayLike<number> | null | undefined): number | null {
  if (!strip || strip.length < 128 * 8) return null;
  let value = 0;
  for (let bit = 0; bit < 16; bit++) {
    let sum = 0;
    for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) sum += strip[y * 128 + bit * 8 + x]!;
    if (sum / 16 > 128) value |= 1 << bit;
  }
  return value;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const compositor = (params.get('compositor') ?? 'frame-locked') as CompositorKind;
  const capture = params.get('capture')?.split(',') as CapturePath[] | undefined;
  const manifest = (await (await fetch('/targets.json')).json()) as { id: string; width: number; height: number }[];
  const targets = await Promise.all(
    manifest.map(async (t) => ({
      info: { id: t.id, width: t.width, height: t.height, physicalWidthMeters: 0.2 },
      gray: new Uint8Array(await (await fetch(`/targets/${t.id}.gray`)).arrayBuffer()),
    })),
  );
  const container = document.getElementById('stage')!;
  // 'async' variant: precompiled G2 assets and the concurrent relocalisation Worker.
  const isAsync = params.get('variant') === 'async';
  const assets = isAsync
    ? await Promise.all(
        manifest.map(async (t) => new Uint8Array(await (await fetch(`/assets/${t.id}.lmt`)).arrayBuffer())),
      )
    : undefined;
  const handle = await startEngine({
    container,
    ...(assets ? { assets, relocalizerUrl: '/relocalize-worker.js' } : { targets }),
    workerUrl: '/worker.js',
    compositor,
    ...(capture ? { capture } : {}),
    video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 } },
    probe: true,
    onResult: (r) => {
      if (record.firstPoseMs === null && r.poses.length) record.firstPoseMs = performance.now();
      record.results.push({
        t: performance.now(),
        sequence: r.sequence,
        strip: r.strip ? [decode(r.strip) ?? -1] : null,
        state: r.state,
        corners: r.poses.flatMap((p) => p.corners.map((c) => [c[0], c[1]])),
        lumaUs: r.stats.lumaUs,
        processUs: r.stats.processUs,
        lumaPath: r.stats.lumaPath,
      });
    },
    onPresent: (p) => {
      const tag = p.tag instanceof Uint8Array ? [decode(p.tag) ?? -1] : null;
      record.presents.push({
        t: performance.now(),
        tag,
        drawUs: p.drawUs,
        corners: p.corners.map((c) => [c[0]!, c[1]!]),
      });
    },
  });
  record.readyMs = performance.now();
  record.info = {
    capturePath: handle.capturePath,
    compositor: handle.compositor,
    capabilities: [...handle.capabilities],
    matcher: handle.matcher,
    compileMs: handle.compileMs,
    userAgent: navigator.userAgent,
  };
  (globalThis as unknown as { __stats: () => unknown }).__stats = () => handle.stats();
}

main().catch((error) => {
  record.error = String(error?.stack ?? error);
});
