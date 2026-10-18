/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public types of the camera UI. The engine is only described here: the UI never imports engine code, the host hands
// it the engine module (usually a dynamic import of the single-file engine).

import type * as LiveMira from '@livemira/engine';

/** What the UI uses of the engine module. */
export type EngineModule = Pick<typeof LiveMira, 'createEngine' | 'compileTargetImage'>;

/** The engine options the host may set; the UI supplies the container. */
export type ArEngineOptions = Omit<LiveMira.EngineOptions, 'container'>;

/** Playback settings applied to every video; the rest of the media policy is the engine's default. */
export interface ArVideoOptions {
  /** Default true. */
  readonly isLooping?: boolean;
  /** Default 'contain'. */
  readonly fit?: 'contain' | 'cover';
}

interface ArTargetBase {
  /** Stable id, also the engine's target id: 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
  readonly id: string;
  /** The video, played once the photo is recognized. A URL is downloaded through `loadMedia` only then. */
  readonly video: Blob | string;
}

/** A photo to recognize: compiled in the browser (a URL is downloaded through `loadMedia`) or already compiled. */
export type ArTarget = ArTargetBase &
  (
    | { readonly photo: Blob | string; readonly target?: never }
    | { readonly target: LiveMira.TargetBundle; readonly photo?: never }
  );

export type ArPhase = 'idle' | 'preparing' | 'starting' | 'scanning' | 'stopping';
/** What the user sees while scanning; derived from the recognized target and the facts of its video. */
export type ArView = 'searching' | 'loading' | 'playing' | 'lost' | 'videoError';

/** A user-facing message, resolved by the view in the active locale. */
export interface ArNotice {
  /** A message key (`notice.cameraDenied`, or one of the host's own keys). */
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Already localized text; wins over `key`. */
  readonly text?: string;
}

export interface ArState {
  readonly phase: ArPhase;
  readonly view: ArView;
  /** Photos prepared so far while preparing; null otherwise. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly notice: ArNotice | null;
  /** The sound setting the user chose; videos start with it. */
  readonly isMuted: boolean;
  /** Between a view change (rotation, resize) and the moment the engine shows the camera again. */
  readonly isAdjusting: boolean;
  /** The browser refused to start the current video without a tap; `retryVideo()` from one. */
  readonly isPlaybackBlocked: boolean;
  /** The host marked the inputs of the last run outdated (for example expired links). */
  readonly isStale: boolean;
  /** Photos of this run that cannot be recognized and were left out. */
  readonly skippedCount: number;
  /** The target the engine currently recognizes; null while searching or after a loss. */
  readonly activeTargetId: string | null;
  readonly isDisposed: boolean;
}

export type ArMediaKind = 'photo' | 'video';

/** Downloads one file. Authentication, URL policy and refresh belong to the host. */
export type ArLoadMedia = (
  url: string,
  request: { readonly signal: AbortSignal; readonly kind: ArMediaKind; readonly targetId: string },
) => Promise<Blob>;

export type ArErrorPhase = 'engine-load' | 'photo-load' | 'photo-compile' | 'start' | 'video-load';

export interface ArErrorClassification {
  readonly notice?: ArNotice;
  /** Only for 'video-load' (default false: the camera keeps running and the video can be reloaded). */
  readonly shouldStop?: boolean;
  readonly isStale?: boolean;
}

/** Return nothing to keep the default notice. */
export type ArClassifyError = (
  cause: unknown,
  context: { readonly phase: ArErrorPhase; readonly targetId: string | null },
) => ArErrorClassification | void;

/** Numbers and codes only; never a URL or a picture. */
export type ArObservation =
  | {
      readonly type: 'lifecycle';
      readonly name: 'start' | 'ready' | 'stop';
      readonly reason?: string;
    }
  | {
      readonly type: 'target';
      readonly name:
        | 'photo-compiled'
        | 'photo-rejected'
        | 'video-requested'
        | 'video-loaded'
        | 'video-failed'
        | 'found'
        | 'lost';
      readonly targetId: string;
      readonly durationMs?: number;
      readonly bytes?: number;
      readonly code?: string;
    }
  | { readonly type: 'engine'; readonly name: keyof LiveMira.EngineEvents; readonly event: unknown }
  | { readonly type: 'sound'; readonly isMuted: boolean; readonly isAccepted: boolean };

export interface ArSessionOptions {
  /** Returns the engine module (for example a dynamic import of the single-file engine); called at the first start. */
  readonly loadEngine: () => EngineModule | Promise<EngineModule>;
  /** 1..10 targets with unique ids. */
  readonly targets: readonly ArTarget[];
  /** Default: `fetch` without credentials or referrer. */
  readonly loadMedia?: ArLoadMedia;
  readonly classifyError?: ArClassifyError;
  /** Exceptions thrown here are ignored. */
  readonly observe?: (observation: ArObservation) => void;
  readonly engineOptions?: ArEngineOptions;
  readonly video?: ArVideoOptions;
  /** Long edge photos are scaled to before compiling; default 640. */
  readonly photoMaxEdgePx?: number;
}

export interface ArStopOptions {
  /** Passed to the engine (`sessionEnded.reason`); default 'ui-stop'. */
  readonly reason?: string;
  /** Shown after the stop, e.g. why the host ended the run. */
  readonly notice?: ArNotice;
  readonly isStale?: boolean;
}

export interface ArSession {
  getState(): ArState;
  /** Called after a state field changed (never per frame). Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * Starts a run in the container (positioned, with a size; the same one each time). Never rejects: resolving does not
   * mean the camera runs, the state says what happened. A start while running joins it; one while stopping waits.
   */
  start(container: HTMLElement): Promise<void>;
  /** Idempotent; concurrent calls share one stop. */
  stop(options?: ArStopOptions): Promise<void>;
  /** The targets of the next start; a running run keeps its own. */
  setTargets(targets: readonly ArTarget[]): void;
  /** Call from a tap. Resolves whether the new setting took effect. */
  setMuted(isMuted: boolean): Promise<boolean>;
  /** Call from a tap: downloads a failed video again, or retries a failed or blocked playback. */
  retryVideo(): Promise<void>;
  /** Stops, disposes the engine and ends the session for good. Idempotent. */
  dispose(): Promise<void>;
}
