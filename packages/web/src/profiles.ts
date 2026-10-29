// SPDX-License-Identifier: Apache-2.0
// Engine profiles, chosen from module combinations tested on phones: Swift by default; Wren where the device lacks
// Worker capture; Hawk on request, falling back to Swift or Wren. All three draw the video in the same WebGL2 frame
// as the camera picture (composition over the native video drifted on every device tested), so a device without
// WebGL2 + VideoFrame is not supported.

import type { Capability } from '@livemira-next/contracts';

import type { PipelineConfig } from './protocol.ts';

/** How camera frames reach the vision Worker, from the fastest: a track processor in the window (its stream
 * transferred) or in the Worker, a VideoFrame per frame, or a canvas readback. */
export type CapturePath = 'mstp-window' | 'mstp-worker' | 'videoframe' | 'canvas';

export type ProfileId = 'hawk' | 'swift' | 'wren';

export interface Profile {
  readonly id: ProfileId;
  /** Display name. */
  readonly name: string;
  /** Capture paths tried in order. */
  readonly capture: readonly CapturePath[];
  /** Slow loop in a second Worker (when the host provides its entry). */
  readonly concurrentSlowLoop: boolean;
  readonly pipeline: PipelineConfig;
}

export const PROFILES: Readonly<Record<ProfileId, Profile>> = {
  // Keenest: KLT prior + ESM, slow loop 3 Hz in a second Worker.
  hawk: {
    id: 'hawk',
    name: 'Hawk',
    capture: ['mstp-window', 'mstp-worker'],
    concurrentSlowLoop: true,
    pipeline: { tracker: 'klt+esm', filter: 'E2', relocalizeEvery: 10, wasm: true },
  },
  // Default: ESM, slow loop 0.5 Hz in a second Worker.
  swift: {
    id: 'swift',
    name: 'Swift',
    capture: ['mstp-window', 'mstp-worker'],
    concurrentSlowLoop: true,
    pipeline: { tracker: 'esm', filter: 'E2', relocalizeEvery: 60, wasm: true },
  },
  // Widest reach: main-thread frame snapshots, one Worker, light ESM, slow loop 1 Hz in the same Worker.
  wren: {
    id: 'wren',
    name: 'Wren',
    capture: ['videoframe'],
    concurrentSlowLoop: false,
    pipeline: { tracker: 'esm', esmIterations: [5, 4, 3], filter: 'E2', relocalizeEvery: 30, wasm: true },
  },
};

/** From the most to the least demanding; a profile falls back along this order. */
export const PROFILE_ORDER: readonly ProfileId[] = ['hawk', 'swift', 'wren'];

/** Capabilities each profile needs beyond frame-locked composition (WebGL2 + VideoFrame). */
function missing(id: ProfileId, caps: ReadonlySet<Capability>): Capability[] {
  if (id === 'wren') return caps.has('rvfc') ? [] : ['rvfc'];
  return caps.has('mstp-window') || caps.has('mstp-worker') ? [] : ['mstp-worker'];
}

export interface ProfileChoice {
  readonly profile: Profile;
  /** Each profile passed over on the way, with the capabilities it lacked. */
  readonly skipped: readonly { readonly id: ProfileId; readonly missing: readonly Capability[] }[];
}

/**
 * The preferred profile if this device can run it, else the next one down. Null when none can run: frame-locked
 * composition needs WebGL2 and VideoFrame, and every profile needs a way to read camera frames.
 */
export function resolveProfile(preferred: ProfileId, caps: ReadonlySet<Capability>): ProfileChoice | null {
  if (!caps.has('webgl2') || !caps.has('videoframe')) return null;
  const skipped: { id: ProfileId; missing: Capability[] }[] = [];
  for (const id of PROFILE_ORDER.slice(PROFILE_ORDER.indexOf(preferred))) {
    const lacks = missing(id, caps);
    if (!lacks.length) return { profile: PROFILES[id], skipped };
    skipped.push({ id, missing: lacks });
  }
  return null;
}

/**
 * Hawk at run time: when the Worker's mean processing time over the last `window` frames exceeds `budgetUs` (it no
 * longer keeps up with the camera), the engine steps down to Swift.
 */
export const HAWK_BUDGET = { budgetUs: 22_000, window: 60, warmup: 90 } as const;
