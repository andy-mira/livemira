// SPDX-License-Identifier: Apache-2.0
// Public types of the LiveMira camera UI (`@livemira/ui`). This file is the source of the published declarations: it
// imports nothing. The engine appears only as the structural types the UI needs, so any engine module of the same
// release satisfies them (packages/ui/test checks this against the engine's own types).

// ---- The engine, as the UI uses it ----

export type EngineProfile = 'hawk' | 'swift' | 'wren';

/** A compiled target: from the engine's `compileTargetImage` or `parseTarget`. */
export interface TargetBundle {
  readonly format: 'livemira-target/2';
  readonly targetId: string;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pointCount: number;
  readonly bytes: Uint8Array;
}

/** The engine options a host may set; the UI supplies the container. */
export interface ArEngineOptions {
  /** Default 'swift'; 'hawk' for the keenest tracking on capable devices, 'wren' for the widest reach. */
  readonly profile?: EngineProfile;
  readonly camera?: {
    readonly facingMode?: 'environment' | 'user';
    readonly deviceId?: string;
    /** Default 'cover'; 'contain' shows the whole camera picture. */
    readonly fit?: 'cover' | 'contain';
    /** Share of the camera picture's size recognition works on: 1 (the camera's own size, default), 0.75 or 0.5. */
    readonly processingScale?: 1 | 0.75 | 0.5;
  };
  readonly tracking?: { readonly lossGraceMs?: number };
  readonly presentation?:
    | {
        readonly revealMs?: number;
        readonly resumeRevealMs?: number;
        readonly veilOpacity?: number;
        readonly accent?: string;
      }
    | false;
  readonly workerUrl?: string | URL;
}

export interface EngineError extends Error {
  readonly code: string;
  readonly isRecoverable: boolean;
}

export type EngineMediaState = 'none' | 'loading' | 'ready' | 'playing' | 'paused' | 'blocked' | 'error';

/** The engine events the UI listens to. */
export interface EngineEventMap {
  targetFound: { readonly targetId: string };
  targetLost: { readonly targetId: string; readonly reason: string };
  viewport: { readonly phase: 'begin' | 'end' };
  media: { readonly targetId: string; readonly state: EngineMediaState; readonly code?: string };
  ended: { readonly reason: string; readonly error?: EngineError };
}

export interface EngineInstance {
  readonly state: string;
  setTargets(targets: readonly TargetBundle[]): Promise<void>;
  setTargetMedia(
    targetId: string,
    media:
      | (({ readonly file: Blob; readonly url?: never } | { readonly url: string; readonly file?: never }) & {
          readonly isLooping?: boolean;
          readonly fit?: 'contain' | 'cover' | 'fill';
        })
      | null,
  ): void;
  setTargetProgress(targetId: string, progress: number | null): void;
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  dispose(): Promise<void>;
  on<K extends keyof EngineEventMap>(type: K, listener: (event: EngineEventMap[K]) => void): () => void;
  readonly media: {
    setMuted(isMuted: boolean): Promise<boolean>;
    retry(): Promise<boolean>;
  };
}

/** What the UI needs of the engine module (`import('…/livemira-engine.min.mjs')`). */
export interface EngineModule {
  createEngine(options: ArEngineOptions & { readonly container: HTMLElement }): EngineInstance;
  compileTargetImage(
    image: Blob,
    options: { readonly targetId: string; readonly maxEdgePx?: number; readonly signal?: AbortSignal },
  ): Promise<TargetBundle>;
  parseTarget(bytes: Uint8Array | ArrayBuffer): Promise<TargetBundle>;
}

// ---- Session ----

export type ArMediaKind = 'photo' | 'video';

/**
 * Downloads one file. Authentication, URL policy and refresh belong to the host. Call `onProgress` with 0..1 while
 * downloading when the size is known (the photo's loading ring shows it); it may be ignored.
 */
export type ArLoadMedia = (
  url: string,
  request: {
    readonly signal: AbortSignal;
    readonly kind: ArMediaKind;
    readonly targetId: string;
    readonly onProgress?: (fraction: number) => void;
  },
) => Promise<Blob>;

interface ArTargetBase {
  /** Stable id, also the engine's target id: 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
  readonly id: string;
  /**
   * The video, played once the photo is recognised. A URL is requested only then: streamed by the browser, or
   * downloaded through `loadMedia` first (see `ArVideoOptions.isStreamed`).
   */
  readonly video: Blob | string;
}

/**
 * A photo to recognise: compiled in the browser (a URL is downloaded through `loadMedia`), or already compiled (a
 * bundle from `parseTarget`, or its bytes, e.g. compiled on the server when the photo was uploaded).
 */
export type ArTarget = ArTargetBase &
  (
    | { readonly photo: Blob | string; readonly target?: never }
    | { readonly target: TargetBundle | Uint8Array; readonly photo?: never }
  );

export type ArErrorPhase = 'engine-load' | 'photo-load' | 'photo-compile' | 'start' | 'video-load';

/** A user-facing message, resolved by the view in the active locale. */
export interface ArNotice {
  /** A message key (`notice.cameraDenied`, or one of the host's own keys). */
  readonly key: string;
  readonly params?: Readonly<Record<string, string | number>>;
  /** Already localised text; wins over `key`. */
  readonly text?: string;
}

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
  | { readonly type: 'lifecycle'; readonly name: 'start' | 'ready' | 'stop'; readonly reason?: string }
  | {
      readonly type: 'target';
      readonly name:
        'photo-compiled' | 'photo-rejected' | 'video-requested' | 'video-loaded' | 'video-failed' | 'found' | 'lost';
      readonly targetId: string;
      readonly durationMs?: number;
      readonly bytes?: number;
      readonly code?: string;
    }
  | { readonly type: 'sound'; readonly isMuted: boolean; readonly isAccepted: boolean };

/** Playback settings applied to every video. */
export interface ArVideoOptions {
  /** Default true. */
  readonly isLooping?: boolean;
  /** Default 'contain'. */
  readonly fit?: 'contain' | 'cover';
  /**
   * A video URL goes straight to the browser's video player, which fetches it in ranges and starts playing as soon as
   * enough has arrived; requests carry the page's cookies for its own origin only, and another origin must allow
   * CORS. False: the whole file is downloaded through `loadMedia` first (media that needs request headers, such as
   * Bearer auth). Default: true, or false when `loadMedia` is given.
   */
  readonly isStreamed?: boolean;
}

export interface ArSessionOptions {
  /** Returns the engine module (for example a dynamic import of the single-file engine); called at the first start. */
  readonly loadEngine: () => EngineModule | Promise<EngineModule>;
  /** 1..10 targets with unique ids. */
  readonly targets: readonly ArTarget[];
  /** Default: `fetch` with same-origin cookies only (none to other origins), no referrer, reporting progress. */
  readonly loadMedia?: ArLoadMedia;
  readonly classifyError?: ArClassifyError;
  /** Exceptions thrown here are ignored. */
  readonly observe?: (observation: ArObservation) => void;
  readonly engineOptions?: ArEngineOptions;
  readonly video?: ArVideoOptions;
  /** Long edge photos are scaled to before compiling; default 640. */
  readonly photoMaxEdgePx?: number;
}

export type ArPhase = 'idle' | 'preparing' | 'starting' | 'scanning' | 'stopping';

/** What the user sees while scanning; derived from the recognised target and the facts of its video. */
export type ArView = 'searching' | 'loading' | 'playing' | 'lost' | 'videoError';

export interface ArState {
  readonly phase: ArPhase;
  readonly view: ArView;
  /** Photos prepared so far while preparing; null otherwise. */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Preparation as a whole (engine, photos, camera), 0..1, while preparing or starting; null otherwise. */
  readonly readiness: number | null;
  /** The camera is open (it may run while photos are still being prepared). */
  readonly isCameraOn: boolean;
  /**
   * Download progress of the recognised photo's video, 0..1 (NaN: size unknown); null when not downloading (always
   * for streamed videos).
   */
  readonly videoProgress: number | null;
  readonly notice: ArNotice | null;
  /** The sound setting the user chose; videos start with it. */
  readonly isMuted: boolean;
  /** Between a view change (rotation, resize) and the moment the engine shows the camera again. */
  readonly isAdjusting: boolean;
  /** The browser refused to start the current video without a tap; `retryVideo()` from one. */
  readonly isPlaybackBlocked: boolean;
  /** The host marked the inputs of the last run outdated (for example expired links). */
  readonly isStale: boolean;
  /** Photos of this run that cannot be recognised and were left out. */
  readonly skippedCount: number;
  /** The target the engine currently recognises; null while searching or after a loss. */
  readonly activeTargetId: string | null;
  readonly isDisposed: boolean;
}

export interface ArStopOptions {
  /** Passed to the engine (`ended.reason`); default 'ui-stop'. */
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

/** What the view needs of a session. */
export type ArSessionLike = Pick<ArSession, 'getState' | 'subscribe' | 'start' | 'stop' | 'setMuted' | 'retryVideo'>;

// ---- View and wording ----

/** One message; `{name}` is replaced by the parameter of that name. `one`/`other` choose by the `count` parameter. */
export type ArMessage = string | { readonly one: string; readonly other: string };
export type ArMessages = Readonly<Record<string, ArMessage>>;

export interface TranslatorOptions {
  readonly locale?: string;
  /** Per-locale additions or replacements, e.g. `{ en: { 'host.expired': '…' } }`. */
  readonly messages?: Readonly<Record<string, ArMessages>>;
  /** Wins whenever it returns a string; return nothing to fall back to the tables. */
  readonly translate?: (
    key: string,
    params: Readonly<Record<string, string | number>> | undefined,
    locale: string,
  ) => string | null | undefined | void;
}

export interface Translator {
  readonly locale: 'zh-CN' | 'en';
  t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

export interface ArViewOptions extends TranslatorOptions {
  /** 'fullscreen' (default): fixed to the viewport, page scrolling locked. 'embedded': fills the container you size. */
  readonly mode?: 'fullscreen' | 'embedded';
  /** Called by the exit control; with `exitHref` it is a link and this runs on its activation. */
  readonly onExit?: (event: Event) => void;
  /** Renders the exit control as a link. Fixed at mount. */
  readonly exitHref?: string;
  /** Start once the stage has a size (default true). Otherwise call `start()`, best from a tap. */
  readonly isAutoStart?: boolean;
  /** Stop the run when the page is hidden or left (default true); "Start again" resumes it. */
  readonly isStoppedWhenHidden?: boolean;
  /** A short vibration when a photo is recognised, where the device supports it (default true). */
  readonly isHapticEnabled?: boolean;
  /** CSS variables on the root, e.g. `{ accent: '#c0674a' }` sets `--lm-ar-accent`. */
  readonly theme?: Readonly<Record<string, string>>;
}

export type ArViewUpdate = Pick<ArViewOptions, 'locale' | 'messages' | 'translate' | 'onExit' | 'theme'>;

export interface ArViewHandle {
  readonly element: HTMLElement;
  /** Changes wording, callbacks or theme in place; never restarts the session or the camera. */
  update(change: ArViewUpdate): void;
  /** Starts a run in this view's stage. */
  start(): void;
  /** Removes this view's nodes, listeners, style and scroll lock. Does not stop or dispose the session. */
  destroy(): void;
}

export interface ArCameraHandle {
  readonly session: ArSession;
  readonly view: ArViewHandle;
  /** Removes the view, then disposes the session (camera, Workers, videos). Idempotent; calls share one promise. */
  destroy(): Promise<void>;
}
