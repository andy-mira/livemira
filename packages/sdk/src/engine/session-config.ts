/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The session configuration: loaded targets, media identities (hashes, never URLs), the presentation policy and the
// camera and capability facts reported by the assembly.

import type { TargetBundle } from '@livemira/contracts';

import type { SessionConfig } from './engine-types.ts';

type MediaIdentity = SessionConfig['media'][number];

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer), (n) => n.toString(16).padStart(2, '0')).join('');

/** SHA-256 identity of a media URL or file. */
export async function mediaIdentity(
  targetId: string,
  source: string | Blob,
  fit: 'contain' | 'cover',
): Promise<MediaIdentity> {
  const bytes =
    typeof source === 'string'
      ? new TextEncoder().encode(source)
      : new Uint8Array(await source.arrayBuffer());
  return {
    targetId,
    identityHash: hex(await crypto.subtle.digest('SHA-256', bytes)),
    identityKind: typeof source === 'string' ? 'url-sha256' : 'file-sha256',
    fit,
  };
}

/** Camera and capability facts; anything unknown stays null. */
export type SessionFacts = Partial<
  Omit<SessionConfig, 'targets' | 'media' | 'maxPredictionMs' | 'lossDisplayGraceMs'>
>;

const EMPTY_FACTS: Omit<
  SessionConfig,
  'targets' | 'media' | 'maxPredictionMs' | 'lossDisplayGraceMs'
> = {
  requestedLongEdge: null,
  processingLongEdge: null,
  inputWidthPx: null,
  inputHeightPx: null,
  previewWidthCss: null,
  previewHeightCss: null,
  previewSurface: null,
  devicePixelRatio: null,
  geometry: null,
  cameraSettings: {},
  capture: null,
  timestampSource: null,
  cameraClockMapping: null,
  clockDomain: null,
};

export class SessionConfigState {
  private targets: SessionConfig['targets'] = [];
  private readonly media = new Map<string, Promise<MediaIdentity>>();
  private mediaSnapshot: SessionConfig['media'] = [];

  setTargets(targets: readonly TargetBundle[]): void {
    this.targets = targets.map((t) => ({
      targetId: t.targetId,
      imageHash: t.imageHash,
      algorithmVersion: t.algorithmVersion,
      compilerVersion: t.compilerVersion,
      widthPx: t.widthPx,
      heightPx: t.heightPx,
    }));
    for (const id of this.media.keys())
      if (!targets.some((t) => t.targetId === id)) this.media.delete(id);
  }

  setMedia(
    targetId: string,
    source: string | Blob | null,
    fit: 'contain' | 'cover' = 'contain',
  ): void {
    if (source === null) {
      this.media.delete(targetId);
      return;
    }
    const identity = mediaIdentity(targetId, source, fit);
    // A failed hash is reported as an unknown identity, never as a failed session.
    this.media.set(
      targetId,
      identity.catch(() => ({ targetId, identityHash: null, identityKind: null, fit })),
    );
  }

  /** Waits for the media hashes of the next session. */
  async settleMedia(): Promise<void> {
    this.mediaSnapshot = await Promise.all(this.media.values());
  }

  snapshot(
    policy: { maxPredictionMs: number; lossDisplayGraceMs: number },
    facts: SessionFacts,
  ): SessionConfig {
    return structuredClone({
      ...EMPTY_FACTS,
      ...facts,
      targets: this.targets,
      media: this.mediaSnapshot,
      maxPredictionMs: policy.maxPredictionMs,
      lossDisplayGraceMs: policy.lossDisplayGraceMs,
    });
  }
}
