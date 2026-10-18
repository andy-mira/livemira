/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EngineError } from '@livemira/contracts';
import type { MediaConfig, MediaSnapshot, MediaState } from '@livemira/media';

/** A target's printed size in target pixels; the video plane has this size. */
export interface TargetSize {
  readonly targetId: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** A media URL, or a file the renderer owns an object URL for. */
export type TargetMediaSource = string | Blob;

export type MediaOptions = Omit<MediaConfig, 'url'>;

export interface RendererEventContext {
  readonly sessionId: string | null;
  readonly targetId: string | null;
  /** Renderer clock (the `nowUs` option). */
  readonly timestampUs: number;
}

export type RendererEvent =
  | (RendererEventContext & {
      readonly type: 'mediaState';
      readonly state: MediaState;
      readonly media: MediaSnapshot;
    })
  /** Playback needs a user gesture: call `resumeBlockedFromGesture()` from one. */
  | (RendererEventContext & { readonly type: 'playbackBlocked' })
  | (RendererEventContext & { readonly type: 'error'; readonly error: EngineError });
