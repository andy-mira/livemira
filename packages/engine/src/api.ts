// SPDX-License-Identifier: Apache-2.0
// Public types of the LiveMira engine (`@livemira/engine`). This file is the source of the published declarations:
// it imports nothing, and the implementation is written against it.

/**
 * Engine profiles, from the most to the least demanding. `'swift'` is the default. A device that cannot run the
 * chosen profile falls back along this order; `'hawk'` also steps down to `'swift'` while running when the device
 * cannot keep up with the camera.
 *
 * - `'hawk'`: the keenest tracking (KLT prior + ESM, relocalisation 3 Hz in a second Worker); most power.
 * - `'swift'`: the default (ESM, relocalisation 0.5 Hz in a second Worker).
 * - `'wren'`: the widest reach (frame snapshots from the page, one Worker); needs the least of the device.
 */
export type ProfileName = 'hawk' | 'swift' | 'wren';

export type EngineState = 'idle' | 'starting' | 'running' | 'stopping' | 'disposed';

export type ErrorCode =
  /** An option or argument is invalid. */
  | 'INVALID_CONFIG'
  /** Target data is damaged, from another engine version, or its id is invalid. */
  | 'INVALID_TARGET'
  /** The picture cannot be recognised reliably (too small, too plain); try another photo. */
  | 'UNSUITABLE_TARGET'
  /** The picture could not be decoded. */
  | 'DECODE_FAILED'
  /** The device or browser lacks what the engine needs (WebGL2 and VideoFrame, a secure context, a camera API). */
  | 'UNSUPPORTED_DEVICE'
  | 'CAMERA_PERMISSION_DENIED'
  /** No camera, or none matching the request. */
  | 'CAMERA_UNAVAILABLE'
  | 'CAMERA_START_FAILED'
  /** The camera stopped while running (another app took it, the permission was revoked, the device slept). */
  | 'CAMERA_ENDED'
  /** A recognition Worker failed. */
  | 'WORKER_FAILED'
  | 'MEDIA_FAILED'
  /** An operation was cancelled (stop during start, an aborted compilation). */
  | 'ABORTED'
  | 'DISPOSED';

/** Every error the engine reports or rejects with. Branch on `code`; the message is for people. */
export interface EngineErrorShape extends Error {
  readonly name: 'EngineError';
  readonly code: ErrorCode;
  /** Whether trying again (another start, another photo) can succeed without changing the device. */
  readonly isRecoverable: boolean;
  /** For UNSUPPORTED_DEVICE: the capabilities the device lacks. */
  readonly missing?: readonly string[];
}

/**
 * A compiled target: what the engine recognises. Make one from a photo with `compileTargetImage`, store `bytes`
 * wherever you like (a file, a database, a CDN) and load it again with `parseTarget`. The bytes carry a SHA-256 and
 * the descriptor version; a target from an incompatible engine is refused with INVALID_TARGET.
 */
export interface TargetBundle {
  readonly format: 'livemira-target/2';
  /** 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
  readonly targetId: string;
  /** Size of the picture as compiled (after scaling to `maxEdgePx`). */
  readonly widthPx: number;
  readonly heightPx: number;
  /** Recognition points found in the picture (more is better; very few means a poor target). */
  readonly pointCount: number;
  readonly bytes: Uint8Array;
}

export interface CompileImageOptions {
  readonly targetId: string;
  /** Long edge the picture is scaled down to before compiling, 64..2048; default 640. */
  readonly maxEdgePx?: number;
  readonly signal?: AbortSignal;
  /** The engine's Worker file, for pages whose CSP forbids `blob:` Workers (see the integration guide). */
  readonly workerUrl?: string | URL;
}

/**
 * A video shown on a target. Exactly one of `file` and `url`. A `url` is played by the browser while it downloads
 * (range requests: the server must support them, as web servers and CDNs do by default).
 */
export interface TargetMedia {
  readonly file?: Blob;
  readonly url?: string;
  /** Default true. */
  readonly isLooping?: boolean;
  /** How the video fills the target: whole video inside it ('contain', default), filling it ('cover'), stretched ('fill'). */
  readonly fit?: 'contain' | 'cover' | 'fill';
  /** For `url` on another origin; default 'anonymous' (the server must send CORS headers). */
  readonly crossOrigin?: 'anonymous' | 'use-credentials';
}

export interface PresentationOptions {
  /** The centre-out reveal when a video first appears on its photo, ms (0..3000); default 900. */
  readonly revealMs?: number;
  /** The shorter reveal when the same video comes back after the photo was lost, ms (0..3000); default 320. */
  readonly resumeRevealMs?: number;
  /** Opacity of the dark region in the video's shape shown while the video loads, 0..1; default 0.5. */
  readonly veilOpacity?: number;
  /** Colour of the recognition glow and the reveal's wavefront, as `#rrggbb`; default '#c0674a'. */
  readonly accent?: string;
}

export interface EngineOptions {
  /** Positioned element with a size. The engine adds its own layers inside it and removes them when stopping. */
  readonly container: HTMLElement;
  /** Default 'swift'. */
  readonly profile?: ProfileName;
  readonly camera?: {
    /** Default 'environment'. */
    readonly facingMode?: 'environment' | 'user';
    /** Overrides `facingMode`. */
    readonly deviceId?: string;
    /** How the camera picture fills the container: cropped to fill it ('cover', default) or whole ('contain'). */
    readonly fit?: 'cover' | 'contain';
    /**
     * The share of the camera picture's size that recognition and tracking work on: 1 (the camera's own size,
     * default), 0.75 or 0.5. The own size finds and keeps photos that are small on screen (tested on phones: no
     * losses where 0.5 lost the photo 6 times in 2.5 minutes) for about 2 ms more per frame; smaller costs less.
     */
    readonly processingScale?: 1 | 0.75 | 0.5;
  };
  readonly tracking?: {
    /** After a loss, the video stays (fading out) this long before the target counts as lost, ms (0..1000); default 200. */
    readonly lossGraceMs?: number;
  };
  /** Loading veil, recognition glow and reveal; `false` shows videos directly. */
  readonly presentation?: PresentationOptions | false;
  /** The engine's Worker file, for pages whose CSP forbids `blob:` Workers. */
  readonly workerUrl?: string | URL;
}

export type MediaState =
  /** No video for this target. */
  | 'none'
  /** Set; decoding the first frames. */
  | 'loading'
  /** Can play; waits for its photo to be in view. */
  | 'ready'
  | 'playing'
  /** Paused because its photo left the view (it resumes when the photo is back). */
  | 'paused'
  /** The browser refused to start playback without a tap: call `media.retry()` from one. */
  | 'blocked'
  | 'error';

export interface EngineEvents {
  state: { readonly state: EngineState };
  /** The camera runs and recognition has started. */
  ready: {
    readonly profile: ProfileName;
    /** How frames reach recognition: 'mstp-window', 'mstp-worker' or 'videoframe'. */
    readonly capture: string;
    /** Profiles passed over because the device lacked what they need. */
    readonly fallbacks: readonly { readonly profile: ProfileName; readonly missing: readonly string[] }[];
  };
  /** The targets given to `setTargets` are loaded and recognised from now on. */
  targetsReady: { readonly targetIds: readonly string[] };
  targetFound: { readonly targetId: string };
  targetLost: { readonly targetId: string; readonly reason: 'out-of-view' | 'viewport' | 'stopped' };
  /**
   * The view changes shape (rotation, resize): from 'begin' to 'end' the picture is unstable and nothing is drawn on
   * targets; a page may cover the stage meanwhile.
   */
  viewport: { readonly phase: 'begin' | 'end' };
  media: {
    readonly targetId: string;
    readonly state: MediaState;
    /** For 'error': 'decode', 'network', 'unsupported' or 'unknown'. */
    readonly code?: string;
  };
  /** Playback needs a tap (the media state is 'blocked'). */
  playbackBlocked: { readonly targetId: string };
  /** Hawk stepped down to Swift while running. */
  profileChange: { readonly from: ProfileName; readonly to: ProfileName; readonly reason: string };
  /** A running or starting session ended. `error` is set unless it was stopped on purpose. */
  ended: { readonly reason: string; readonly error?: EngineErrorShape };
  error: { readonly error: EngineErrorShape };
}

export interface Engine {
  readonly state: EngineState;
  /** The profile running now; null while idle. */
  readonly profile: ProfileName | null;
  /**
   * Replaces all targets (0..10, unique ids). Allowed in any state but 'disposed'; while running they are loaded in
   * the background and recognised from `targetsReady` on. Media of targets no longer present is released.
   */
  setTargets(targets: readonly TargetBundle[]): Promise<void>;
  /** Sets, replaces or (null) clears the video of one target. */
  setTargetMedia(targetId: string, media: TargetMedia | null): void;
  /**
   * The host is downloading this target's video: 0..1, or NaN when the size is unknown; null when done or abandoned.
   * Shown by the loading veil while the photo is in view.
   */
  setTargetProgress(targetId: string, progress: number | null): void;
  /** Opens the camera and starts recognition. Call it from a tap where you can (camera prompt, playback, sound). */
  start(): Promise<void>;
  /** Stops the camera and recognition; videos and targets stay set for the next start. Idempotent. */
  stop(reason?: string): Promise<void>;
  /** Stops and releases everything; the engine cannot be used afterwards. Idempotent. */
  dispose(): Promise<void>;
  /** Returns the unsubscribe function. A listener that throws does not affect the engine. */
  on<K extends keyof EngineEvents>(type: K, listener: (event: EngineEvents[K]) => void): () => void;
  readonly media: {
    readonly isMuted: boolean;
    /** From a tap. Resolves true when the change took effect (playback continues with the new setting). */
    setMuted(isMuted: boolean): Promise<boolean>;
    /** From a tap, after 'blocked' or 'error': plays (or reloads) the video of the photo in view. */
    retry(): Promise<boolean>;
  };
}

export interface DeviceSupport {
  /** False: the engine refuses to start here (UNSUPPORTED_DEVICE). */
  readonly isSupported: boolean;
  readonly missing: readonly string[];
  /** The profile 'swift' resolves to on this device; null when unsupported. */
  readonly profile: ProfileName | null;
}

export interface EngineBuildInfo {
  readonly version: string;
  /** SHA-256 of the engine's Worker code and main module source; identifies one build. */
  readonly buildId: string;
  readonly variant: 'minified' | 'readable' | 'development';
}

/** What `@livemira/ui` (or any host) needs of the engine module. */
export interface EngineModule {
  readonly ENGINE_VERSION: string;
  createEngine(options: EngineOptions): Engine;
  compileTargetImage(image: Blob, options: CompileImageOptions): Promise<TargetBundle>;
  parseTarget(bytes: Uint8Array | ArrayBuffer): Promise<TargetBundle>;
}
