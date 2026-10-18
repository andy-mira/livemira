export declare interface ArCameraHandle {
    readonly session: ArSession;
    readonly view: ArViewHandle;
    /** Removes the view, then disposes the session (camera, Worker, videos). Idempotent; calls share one promise. */
    destroy(): Promise<void>;
}

/** Return nothing to keep the default notice. */
export declare type ArClassifyError = (cause: unknown, context: {
    readonly phase: ArErrorPhase;
    readonly targetId: string | null;
}) => ArErrorClassification | void;

/** The engine options the host may set; the UI supplies the container. */
export declare type ArEngineOptions = Omit<LiveMira.EngineOptions, 'container'>;

export declare interface ArErrorClassification {
    readonly notice?: ArNotice;
    /** Only for 'video-load' (default false: the camera keeps running and the video can be reloaded). */
    readonly shouldStop?: boolean;
    readonly isStale?: boolean;
}

export declare type ArErrorPhase = 'engine-load' | 'photo-load' | 'photo-compile' | 'start' | 'video-load';

/** Downloads one file. Authentication, URL policy and refresh belong to the host. */
export declare type ArLoadMedia = (url: string, request: {
    readonly signal: AbortSignal;
    readonly kind: ArMediaKind;
    readonly targetId: string;
}) => Promise<Blob>;

export declare type ArMediaKind = 'photo' | 'video';

/** One message; `{name}` is replaced by the parameter of that name. `one`/`other` choose by the `count` parameter. */
export declare type ArMessage = string | {
    readonly one: string;
    readonly other: string;
};

export declare type ArMessages = Readonly<Record<string, ArMessage>>;

/** A user-facing message, resolved by the view in the active locale. */
export declare interface ArNotice {
    /** A message key (`notice.cameraDenied`, or one of the host's own keys). */
    readonly key: string;
    readonly params?: Readonly<Record<string, string | number>>;
    /** Already localized text; wins over `key`. */
    readonly text?: string;
}

/** Numbers and codes only; never a URL or a picture. */
export declare type ArObservation = {
    readonly type: 'lifecycle';
    readonly name: 'start' | 'ready' | 'stop';
    readonly reason?: string;
} | {
    readonly type: 'target';
    readonly name: 'photo-compiled' | 'photo-rejected' | 'video-requested' | 'video-loaded' | 'video-failed' | 'found' | 'lost';
    readonly targetId: string;
    readonly durationMs?: number;
    readonly bytes?: number;
    readonly code?: string;
} | {
    readonly type: 'engine';
    readonly name: keyof LiveMira.EngineEvents;
    readonly event: unknown;
} | {
    readonly type: 'sound';
    readonly isMuted: boolean;
    readonly isAccepted: boolean;
};

export declare type ArPhase = 'idle' | 'preparing' | 'starting' | 'scanning' | 'stopping';

export declare interface ArSession {
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
export declare type ArSessionLike = Pick<ArSession, 'getState' | 'subscribe' | 'start' | 'stop' | 'setMuted' | 'retryVideo'>;

export declare interface ArSessionOptions {
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

export declare interface ArState {
    readonly phase: ArPhase;
    readonly view: ArView;
    /** Photos prepared so far while preparing; null otherwise. */
    readonly progress: {
        readonly done: number;
        readonly total: number;
    } | null;
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

export declare interface ArStopOptions {
    /** Passed to the engine (`sessionEnded.reason`); default 'ui-stop'. */
    readonly reason?: string;
    /** Shown after the stop, e.g. why the host ended the run. */
    readonly notice?: ArNotice;
    readonly isStale?: boolean;
}

/** A photo to recognize: compiled in the browser (a URL is downloaded through `loadMedia`) or already compiled. */
export declare type ArTarget = ArTargetBase & ({
    readonly photo: Blob | string;
    readonly target?: never;
} | {
    readonly target: LiveMira.TargetBundle;
    readonly photo?: never;
});

declare interface ArTargetBase {
    /** Stable id, also the engine's target id: 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
    readonly id: string;
    /** The video, played once the photo is recognized. A URL is downloaded through `loadMedia` only then. */
    readonly video: Blob | string;
}

/** Playback settings applied to every video; the rest of the media policy is the engine's default. */
export declare interface ArVideoOptions {
    /** Default true. */
    readonly isLooping?: boolean;
    /** Default 'contain'. */
    readonly fit?: 'contain' | 'cover';
}

/** What the user sees while scanning; derived from the recognized target and the facts of its video. */
export declare type ArView = 'searching' | 'loading' | 'playing' | 'lost' | 'videoError';

export declare interface ArViewHandle {
    readonly element: HTMLElement;
    /** Changes wording, callbacks or theme in place; never restarts the session or the camera. */
    update(change: ArViewUpdate): void;
    /** Starts a run in this view's stage. */
    start(): void;
    /** Removes this view's nodes, listeners, style and scroll lock. Does not stop or dispose the session. */
    destroy(): void;
}

export declare interface ArViewOptions extends TranslatorOptions {
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
    /** CSS variables on the root, e.g. `{ accent: '#c0674a' }` sets `--lm-ar-accent`. */
    readonly theme?: Readonly<Record<string, string>>;
}

export declare type ArViewUpdate = Pick<ArViewOptions, 'locale' | 'messages' | 'translate' | 'onExit' | 'theme'>;

declare type CameraChange = Pick<NonNullable<EngineOptions['camera']>, 'facingMode' | 'deviceId' | 'processingLongEdge' | 'fit'>;

/** The default surface: a 2D canvas drawn with the same frame as recognition, above the video. */
declare const canvasPreviewSurface: PreviewSurfaceFactory;

declare type ClearReason = 'hide' | 'loss' | 'stop' | 'session' | 'page-hidden' | 'media-failed';

/**
 * Compiles a canonical gray8 image (32..4096 pixels per edge) into a target bundle: the base image and two pyramid
 * levels, at most 384 ANMS features with BRIEF-256 descriptors, the SHA-256 of the base image and quality diagnostics.
 * The input is copied before the first await, so later changes by the caller cannot affect the result.
 */
declare function compileGrayTarget(image: GrayImage, options: CompileOptions): Promise<TargetBundle>;

declare interface CompileImageOptions {
    readonly targetId: string;
    /** Long edge the image is scaled to before compiling; default 640. */
    readonly maxEdgePx?: number;
    readonly signal?: AbortSignal;
    /** Default: the engine's embedded Worker. */
    readonly workerFactory?: () => Worker | WorkerEndpoint;
}

declare interface CompileOptions {
    /** 1..128 characters from A–Z, a–z, 0–9, '_', '.', '-'. */
    readonly targetId: string;
    /** Printed width in metres, when known; stored in the bundle only. */
    readonly physicalWidthMeters?: number | null;
}

/** Decodes and compiles an image file (PNG, JPEG, WebP, …) into a target bundle in a short-lived Worker. */
declare function compileTargetImage(image: Blob, options: CompileImageOptions): Promise<TargetBundle>;

/** Events defined by the core contracts; the engine adds media, capability and diagnostic events. */
declare interface CoreEvents {
    attemptStart: EventContext;
    ready: EventContext;
    sessionStartFailed: EventContext & {
        readonly code: ErrorCode;
        readonly attemptTimeUs: number;
    };
    sessionEnded: EventContext & {
        readonly reason: string;
    };
    viewportTransition: EventContext & ViewportTransition;
    targetFound: EventContext & {
        readonly result: TrackingResult;
    };
    targetUpdated: EventContext & {
        readonly result: TrackingResult;
    };
    targetLost: EventContext & {
        readonly reason: string;
    };
    error: EventContext & {
        readonly error: EngineError;
    };
}

/** Four corners in the order top-left, top-right, bottom-right, bottom-left. */
declare type Corners = readonly [Point2, Point2, Point2, Point2];

export declare function createArSession(options: ArSessionOptions): ArSession;

/** Creates an engine in `options.container`. Throws INVALID_CONFIG for invalid options. */
declare function createEngine(options: EngineOptions): Engine;

/** Host override, then the host table, then the built-in table of the locale, then Chinese, then the key itself. */
export declare function createTranslator(options?: TranslatorOptions): Translator;

export declare const DEFAULT_LOCALE = "zh-CN";

/** One engine event: its context and an allowlisted copy of its payload. */
declare interface DiagnosticEventRecord {
    readonly type: string;
    readonly sessionId: string | null;
    readonly targetId: string | null;
    readonly timestampUs: number | null;
    readonly timestampDomain: string | null;
    readonly [field: string]: unknown;
}

declare interface DiagnosticExport {
    readonly schema: 'livemira-diagnostics/2';
    readonly engine: EngineIdentity | null;
    readonly runId: string;
    /** ISO 8601. */
    readonly createdAt: string;
    /** 'full' when any recorded session ran at the full level (each attemptStart record carries its level). */
    readonly level: DiagnosticLevel;
    readonly metadata: Readonly<Record<string, MetadataValue>>;
    readonly targets: readonly DiagnosticTargetRecord[];
    readonly events: readonly DiagnosticEventRecord[];
    readonly frames?: readonly FrameRecord[];
    readonly results?: readonly ResultRecord[];
    readonly workerTimings?: readonly WorkerTimingRecord[];
    readonly isComplete: boolean;
    readonly droppedRecords: number;
    /** Host-owned sections (e.g. a test suite's results or an extension snapshot). */
    readonly sections?: Readonly<Record<string, unknown>>;
}

/** 'key': session, error, permission, visibility, transition, recognition, media and capability events. 'full': also per-frame records. */
declare type DiagnosticLevel = 'key' | 'full';

declare class DiagnosticLog implements TelemetrySink {
    private requestedLevel;
    private sessionLevel;
    private hasFullSession;
    private readonly capacity;
    private readonly events;
    private readonly frames;
    private readonly results;
    private readonly timings;
    private metadata;
    private targets;
    private engine;
    private sections;
    private runId;
    private createdAt;
    constructor(options?: DiagnosticLogOptions);
    /** The requested level; it applies from the next session start. */
    get level(): DiagnosticLevel;
    /** The level of the current (or last) session. */
    get activeLevel(): DiagnosticLevel;
    get wantsFrameDetail(): boolean;
    setLevel(level: DiagnosticLevel): void;
    /** Host context (device label, notes, …); only allowlisted keys and primitive values are kept. */
    setMetadata(values: Readonly<Record<string, MetadataValue>>): void;
    /** Adds or replaces a host-owned export section (deep-copied); null removes it. */
    setSection(name: string, value: unknown): void;
    event(type: string, payload: unknown): void;
    frame(record: FrameRecord): void;
    workerTiming(record: WorkerTimingRecord): void;
    /** Matched points are display data and never retained. */
    result(result: TrackingResult): void;
    /** Session configuration and capability events identify the targets and the engine build. */
    private observe;
    private get droppedRecords();
    getCapacity(): {
        capacity: number;
        records: number;
        dropped: number;
    };
    export(): DiagnosticExport;
    /** Starts a new run: all records, sections and the run id are replaced; metadata and the level are kept. */
    clear(): void;
}

declare interface DiagnosticLogOptions {
    /** Default 'key'. */
    readonly level?: DiagnosticLevel;
    /** Records kept per kind, 1..100000; default 10000. */
    readonly capacity?: number;
}

declare interface DiagnosticTargetRecord {
    readonly targetId: string;
    readonly imageHash: string;
    readonly algorithmVersion: string;
    readonly compilerVersion: string;
    readonly widthPx: number;
    readonly heightPx: number;
}

export declare const EN: ArMessages;

declare interface Engine {
    readonly state: EngineState;
    /** Replaces all targets (1..10, unique ids) and their media. Only while idle. */
    setTargets(entries: readonly {
        target: TargetBundle;
        media?: TargetMedia;
    }[]): Promise<void>;
    /** Sets, replaces or (null) clears one target's media; while running, the active media is released. */
    setTargetMedia(targetId: string, media: TargetMedia | null): void;
    /** Starts a session. Call from a user gesture so the camera prompt and playback can proceed. */
    start(): Promise<void>;
    stop(reason?: string): Promise<void>;
    dispose(): Promise<void>;
    on<K extends keyof EngineEvents>(type: K, listener: (event: EngineEvents[K]) => void): () => void;
    readonly media: {
        /** From a user gesture. Resolves true when playback continued with the new muted state. */
        setMuted(isMuted: boolean): Promise<boolean>;
        /** From a user gesture after `playbackBlocked` or a media error. */
        retry(): Promise<boolean>;
    };
    readonly camera: {
        list(): Promise<readonly {
            deviceId: string;
            label: string;
        }[]>;
        /** Only while idle; applies to the next start. */
        configure(change: CameraChange): void;
    };
    /** Current event context (same clock and domain as events). */
    getEventContext(): EventContext;
    getDiagnostics(): Record<string, unknown>;
}

/** Engine version; kept equal to the package version by the release checks. */
declare const ENGINE_VERSION = "0.4.1";

/** Which engine build is running, so diagnostic logs can prove what ran. */
declare interface EngineBuildInfo {
    readonly version: string;
    /** 'single': the bundled single-file engine; 'modules': the workspace sources (development and tests). */
    readonly format: 'single' | 'modules';
    /** Text variant of the single-file engine; both variants behave identically. Null for 'modules'. */
    readonly variant: 'readable' | 'minified' | null;
    /** SHA-256 of the build inputs; null for 'modules'. */
    readonly buildId: string | null;
}

declare const engineBuildInfo: EngineBuildInfo;

/** What actually runs: engine build, preview surface, frame detection and the matching operator in the Worker. */
declare interface EngineCapability {
    readonly engine: {
        readonly version: string;
        readonly buildId: string | null;
        readonly format: string;
        readonly variant: string | null;
    };
    readonly previewSurface: 'canvas' | 'video' | null;
    readonly capturePath: 'video-frame-callback' | 'decoded-frame-count' | null;
    readonly capture: 'auto' | 'canvas' | null;
    readonly execution: 'worker' | null;
    readonly workerGeneration: number | null;
    readonly algorithmVersion: string | null;
    readonly matching: string | null;
    readonly matchingSelection: string | null;
    readonly matchingFallback: string | null;
    readonly fallbackReason: string | null;
}

/** The only error type the engine throws or reports. */
declare class EngineError extends Error {
    readonly code: ErrorCode;
    readonly isRecoverable: boolean;
    constructor(code: ErrorCode, message: string, options: EngineErrorOptions);
}

declare interface EngineErrorOptions {
    /** True when the same operation may succeed later (for example after a restart or a user gesture). */
    readonly isRecoverable: boolean;
    readonly cause?: unknown;
}

declare interface EngineEvents extends Omit<CoreEvents, 'targetLost' | 'viewportTransition'> {
    sessionConfig: EventContext & {
        readonly config: SessionConfig;
    };
    sessionConfigUpdated: EventContext & {
        readonly config: SessionConfig;
    };
    stageTiming: EventContext & {
        readonly stage: StartupStage;
        readonly durationUs: number;
        readonly status: 'completed' | 'failed' | 'cancelled';
        readonly attemptTimeUs: number;
    };
    cameraPermission: EventContext & {
        readonly phase: 'request' | 'result';
        readonly permission: 'pending' | 'granted' | 'denied' | 'failed';
    };
    /** The camera stopped: its error code and the original fine-grained reason. */
    cameraStatus: EventContext & {
        readonly code: ErrorCode;
        readonly detail: string;
    };
    /** The camera picture's size, announced while it is still hidden or masked; a host may relayout now. */
    cameraSize: EventContext & {
        readonly widthPx: number;
        readonly heightPx: number;
    };
    pageVisibility: EventContext & {
        readonly visibility: 'hidden' | 'visible' | 'pagehide' | 'pageshow';
    };
    viewportTransition: EventContext & ViewportTransition & {
        readonly sizes: {
            readonly viewportWidthCss: number | null;
            readonly viewportHeightCss: number | null;
            readonly cameraWidthPx: number | null;
            readonly cameraHeightPx: number | null;
        };
    };
    capabilityChanged: EventContext & {
        readonly capability: EngineCapability;
    };
    targetLost: EventContext & {
        readonly reason: string;
        readonly lossContext: TargetLossContext;
    };
    mediaState: EventContext & {
        readonly state: MediaState;
        readonly media: MediaSnapshot;
    };
    /** Playback needs a user gesture: call `engine.media.retry()` from one. */
    playbackBlocked: EventContext;
}

declare interface EngineExtension {
    readonly name: string;
    /** What the extension needs from the Worker; fixed for the engine's lifetime. */
    readonly needs?: {
        readonly matchedPoints?: boolean;
        readonly recognitionTrace?: boolean;
    };
    attach(host: ExtensionHost): ExtensionHandle;
}

declare interface EngineIdentity {
    readonly version: string;
    readonly buildId: string | null;
    readonly format: string;
    readonly variant: string | null;
}

/** What the UI uses of the engine module. */
export declare type EngineModule = Pick<typeof LiveMira, 'createEngine' | 'compileTargetImage'>;

declare interface EngineOptions {
    /** Positioned element with a non-zero size. The engine adds its own layers inside it. */
    readonly container: HTMLElement;
    readonly camera?: {
        /** Default 'environment'. */
        readonly facingMode?: 'environment' | 'user';
        /** Overrides facingMode. */
        readonly deviceId?: string;
        /** Default 1280. */
        readonly idealWidthPx?: number;
        /** Default 720. */
        readonly idealHeightPx?: number;
        /** Default 640. */
        readonly processingLongEdge?: ProcessingLongEdge;
        /** How the camera picture fills the container; default 'cover'. */
        readonly fit?: 'contain' | 'cover';
        /** Default 'canvas'. */
        readonly capture?: 'auto' | 'canvas';
        /** Default 'callback'. */
        readonly timestamps?: 'media-time' | 'callback';
    };
    readonly tracking?: {
        /** 0..100, default 100. */
        readonly maxPredictionMs?: number;
        /** Visual hold after a loss, 0..1000, default 200. */
        readonly lossDisplayGraceMs?: number;
    };
    /** Loading mask and reveal on the video plane; false: the video simply appears. */
    readonly presentation?: RevealOptions | false;
    readonly adapters?: {
        readonly previewSurface?: PreviewSurfaceFactory;
        readonly snapshot?: readonly SnapshotStrategy[];
        readonly playbackRecoveries?: readonly PlaybackRecovery[];
        readonly workerFactory?: () => Worker | WorkerEndpoint;
    };
    readonly extensions?: readonly EngineExtension[];
    readonly diagnostics?: TelemetrySink;
}

declare type EngineState = 'idle' | 'starting' | 'running' | 'stopping' | 'disposed';

/** Closed set of engine error codes. Callers branch on `code`, never on the message. */
declare type ErrorCode = 'INVALID_CONFIG' | 'INVALID_TARGET' | 'DISPOSED' | 'ABORTED' | 'START_FAILED' | 'FRAME_FAILED' | 'RESOURCE_FAILED' | 'UNSUPPORTED' | 'CAMERA_UNAVAILABLE' | 'CAMERA_PERMISSION_DENIED' | 'CAMERA_START_FAILED' | 'CAMERA_TRACK_ENDED' | 'CAMERA_FRAME_STALLED' | 'CAMERA_CAPTURE_FAILED' | 'CAMERA_CLOCK_RESET' | 'CAMERA_SUSPENDED' | 'MEDIA_FAILED' | 'PLAYBACK_BLOCKED';

/** Common fields of every engine event. */
declare interface EventContext {
    readonly sessionId: string | null;
    readonly targetId: string | null;
    readonly timestampUs: number;
    /**
     * Clock of `timestampUs`: the camera session clock once the camera reports it, otherwise the engine session clock,
     * and before a session exists the clock of the start attempt.
     */
    readonly timestampDomain: 'attempt' | 'engine-session' | 'source-session';
}

declare interface ExtensionHandle {
    detach(): void;
}

declare interface ExtensionHost {
    /** A layer above the video plane, cleared with it; the extension draws only here. */
    readonly overlayLayer: HTMLElement;
    /**
     * A result was presented. The listener returns true when it now shows something for it; the host then knows which
     * target an extension shows (replacing that target's media clears it).
     */
    onPresented(listener: (result: TrackingResult, geometry: FrameGeometry) => boolean | void): () => void;
    onCleared(listener: (reason: ClearReason) => void): () => void;
    onRecognitionTrace(listener: (trace: RecognitionTrace) => void): () => void;
    onResult(listener: (result: TrackingResult) => void): () => void;
    getTargets(): readonly TargetSize[];
}

/**
 * How one captured frame maps to the standard (processing) image and to the viewport.
 * Input: the camera picture's intrinsic pixels. Standard: the cropped, rotated, mirrored and scaled processing image
 * in which recognition, tracking and `cornersPx` work. Viewport: CSS pixels of the preview container.
 */
declare interface FrameGeometry {
    readonly H_standardFromInput: Mat3;
    readonly H_viewportFromStandard: Mat3;
    /** Region of the input used for processing, in input pixels. */
    readonly crop: RectPx;
    readonly rotationDeg: 0 | 90 | 180 | 270;
    readonly isMirrored: boolean;
    readonly fit: 'contain' | 'cover';
    readonly standardWidthPx: number;
    readonly standardHeightPx: number;
    readonly viewportWidthCss: number;
    readonly viewportHeightCss: number;
    readonly devicePixelRatio: number;
}

/** Session and sequence number of one frame; every asynchronous result is matched against it. */
declare interface FrameIdentity {
    readonly sessionId: string;
    /** Per-session sequence, strictly increasing from 0. */
    readonly frameId: number;
}

/** Scheduling record of one camera frame (numbers and enums only). */
declare interface FrameRecord {
    readonly sessionId: string;
    readonly frameId: number;
    readonly targetId: string | null;
    /** Picture identity of the camera frame. */
    readonly pictureKey: string | null;
    readonly arrivalTimeUs: number | null;
    /** Hand-off to the vision pipeline, on the event clock. */
    readonly submitTimeUs: number | null;
    readonly resultAvailableTimeUs: number | null;
    readonly renderSubmitTimeUs: number | null;
    /** Engine-clock time from acceptance to hand-off. */
    readonly queueWaitDurationUs: number | null;
    /** Why the frame produced no presentation, or null. */
    readonly dropReason: string | null;
}

/** Gray8 image with tight rows. */
declare interface GrayImage {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly data: Uint8Array;
}

declare namespace LiveMira {
    export {
        ENGINE_VERSION,
        engineBuildInfo,
        EngineBuildInfo,
        createEngine,
        CameraChange,
        Engine,
        EngineOptions,
        ProcessingLongEdge,
        EngineState,
        EngineCapability,
        EngineEvents,
        SessionConfig,
        StartupStage,
        TargetFrameExtent,
        TargetLossContext,
        TargetMedia,
        WorkerEndpoint,
        ClearReason,
        EngineExtension,
        ExtensionHandle,
        ExtensionHost,
        compileTargetImage,
        CompileImageOptions,
        compileGrayTarget,
        parseTarget,
        serializeTarget,
        CompileOptions,
        EngineError,
        CoreEvents,
        Corners,
        EngineErrorOptions,
        ErrorCode,
        EventContext,
        FrameGeometry,
        FrameIdentity,
        Mat3,
        MatchedPoints,
        Point2,
        PredictionInfo,
        RectPx,
        TargetBundle,
        TargetDiagnostic,
        TargetFeatures,
        TargetPyramidLevel,
        TrackingQuality,
        TrackingReason,
        TrackingResult,
        TrackingState,
        ViewportTransition,
        ViewportTransitionReason,
        MediaConfig,
        MediaPresentationTelemetry,
        MediaSnapshot,
        MediaState,
        PresentableSignal,
        PresentationFailureReason,
        PRESENTATION_FAILURE_REASONS,
        wechatIosBridgeRecovery,
        PlaybackRecovery,
        RecoveryAttempt,
        RecoveryOutcome,
        RevealOptions,
        TargetSize,
        canvasPreviewSurface,
        videoPreviewSurface,
        PreviewDocument,
        PreviewElement,
        PreviewStyle,
        PreviewSurface,
        PreviewSurfaceFactory,
        PreviewVideo,
        SnapshotEnvironment,
        SnapshotStrategy,
        DiagnosticLog,
        DiagnosticEventRecord,
        DiagnosticExport,
        DiagnosticLevel,
        DiagnosticLogOptions,
        DiagnosticTargetRecord,
        EngineIdentity,
        FrameRecord,
        MetadataValue,
        ResultRecord,
        TelemetrySink,
        WorkerTimingRecord,
        GrayImage,
        RecognitionTrace,
        RecognitionTracePass,
        RecognitionTraceStageMs,
        TargetRejection
    }
}

/**
 * 3×3 matrix, row-major, acting on column vectors: p' = H · p with p = (x, y, 1)ᵀ.
 * Named H_<to>From<from>, e.g. H_imageFromTarget maps target pixels to standard-image pixels.
 */
declare type Mat3 = readonly [
number,
number,
number,
number,
number,
number,
number,
number,
number
];

declare interface MatchedPoints {
    readonly sessionId: string;
    readonly frameId: number;
    readonly targetId: string;
    /** Inlier image points of the observation accepted for exactly this frame, in standard-image pixels. */
    readonly pointsPx: readonly Point2[];
}

/** How one target's video plays. */
declare interface MediaConfig {
    readonly url: string;
    /** Default true. */
    readonly isMuted?: boolean;
    /** Default true. */
    readonly isLooping?: boolean;
    /** How the video fits the target plane; default 'contain'. */
    readonly fit?: 'contain' | 'cover';
    /** On target loss: pause and hide (default), or only hide while playback continues. */
    readonly onLost?: 'pause-and-hide' | 'hide';
    /** When shown again after a pause: continue (default), or restart from the beginning. */
    readonly onResume?: 'resume' | 'restart';
    /** Default 'anonymous'. */
    readonly crossOrigin?: 'anonymous' | 'use-credentials' | null;
    /** 'auto' (default): after a blocked native play(), try the first applicable playback recovery once. */
    readonly playbackRecovery?: 'auto' | 'off';
}

/**
 * Bounded numbers describing ONE media request's loading → first frame → reveal progress (never URLs or pixels). Only
 * transition events carry it. Times are milliseconds on the renderer clock, relative to this request's loading start.
 */
declare interface MediaPresentationTelemetry {
    /** Renderer-wide counter, +1 for every media request (new media element, gesture retry, blocked-playback retry). */
    readonly requestGeneration: number;
    readonly phase: 'loading' | 'revealing' | 'revealed' | 'failed' | 'cancelled';
    /** Readiness evidence of the first frame; null before it. */
    readonly readySignal: PresentableSignal | null;
    readonly elapsedMs: number;
    /** Loading start → first presentable frame; null until then. */
    readonly firstFrameMs: number | null;
    /** Reveal progress at this event (0 at reveal-start); on reveal-end the actual duration. Null before the reveal. */
    readonly revealElapsedMs: number | null;
    /** Configured reveal duration (0 = none); a reduced-motion cross-fade reports its own shorter value. */
    readonly revealDurationMs: number;
    readonly isReducedMotion: boolean;
    /** Only on 'loading-failed'. */
    readonly failureReason?: PresentationFailureReason;
}

/** The media facts carried by each media state event. */
declare interface MediaSnapshot {
    readonly currentTime: number | null;
    readonly decodedFrames: number | null;
    readonly droppedFrames: number | null;
    readonly readyState: number | null;
    readonly isPaused: boolean;
    readonly errorCode: number | null;
    readonly isLooping: boolean;
    readonly duration: number | null;
    readonly isEnded: boolean;
    readonly loopRecoveries: number;
    /** The last issued play attempt ('native' or a playback recovery id), not proof of playback. */
    readonly playbackPath: string | null;
    readonly recoveryAttempts: number;
    /** Loading and reveal progress of the current request; absent when the presentation is disabled. */
    readonly presentation?: MediaPresentationTelemetry;
}

/**
 * Media state transitions. 'loading' … 'loading-failed' describe one media request's loading → first frame → reveal:
 * 'loading' the request began; 'first-frame' its current frame became presentable; 'reveal-start'/'reveal-end' the
 * circular reveal ran ('reveal-end' without 'reveal-start' = completed without animation: the first frame arrived
 * while hidden, or the reveal duration is 0; a hide during a reveal also ends it early with 'reveal-end');
 * 'reveal-cancel' the request was released before it finished; 'loading-failed' it ended in failure and the spinner
 * was cleared.
 */
declare type MediaState = 'shown' | 'hidden' | 'held' | 'hold-recovered' | 'play' | 'pause' | 'waiting' | 'playing' | 'timeupdate' | 'ended' | 'error' | 'loading' | 'first-frame' | 'reveal-start' | 'reveal-end' | 'reveal-cancel' | 'loading-failed';

declare type MetadataValue = string | number | boolean | null;

export declare function mountArCamera(container: HTMLElement, options: ArSessionOptions & ArViewOptions): ArCameraHandle;

export declare function mountArView(container: HTMLElement, session: ArSessionLike, options?: ArViewOptions): ArViewHandle;

/** Parses serialized text, checks its integrity hash and validates the bundle completely. */
declare function parseTarget(text: string): Promise<TargetBundle>;

declare interface PlaybackRecovery {
    /** Reported as the playback path. */
    readonly id: string;
    /** Environment check for this element; must not touch playback. */
    isApplicable(video: HTMLVideoElement): boolean;
    /**
     * Creates the attempt without touching any host object, so the caller can register it (and so make it
     * cancellable) before start(). `isLive` returns false once the attempt is no longer current.
     */
    prepare(video: HTMLVideoElement, isLive: () => boolean): RecoveryAttempt;
}

declare type Point2 = readonly [number, number];

declare interface PredictionInfo {
    /** 0 for a measured result; time since the last measurement for a prediction. */
    readonly ageUs: number;
    /** Observation time of the last measurement this result is based on. */
    readonly lastMeasuredTimeUs: number | null;
    /** Time after which the last measurement may no longer be extrapolated. */
    readonly expiresAtUs: number | null;
}

/** How a presentable first frame was recognised. */
declare type PresentableSignal = 'video-frame-callback' | 'time-progress';

/** Closed set of loading failure reasons; never free text or URLs. */
declare const PRESENTATION_FAILURE_REASONS: readonly ["media-error", "playback-blocked", "loading-timeout"];

declare type PresentationFailureReason = (typeof PRESENTATION_FAILURE_REASONS)[number];

declare interface PreviewDocument {
    createElement(tag: string): PreviewElement;
}

/** The minimal DOM the preview needs; a real document satisfies it. */
declare interface PreviewElement {
    readonly style: Record<string, string>;
    /** The document new elements of the preview are created in. */
    readonly ownerDocument?: PreviewDocument | null;
    setAttribute?(name: string, value: string): void;
    appendChild(child: PreviewElement): unknown;
    remove?(): void;
}

/** CSS properties that place a picture of the camera's intrinsic size exactly where the frame's geometry maps it. */
declare type PreviewStyle = Readonly<Record<string, string>>;

declare interface PreviewSurface {
    /** What shows the picture: 'video' once the surface has been disabled. */
    readonly kind: 'canvas' | 'video';
    /**
     * Applies this frame's preview transform and draws the current picture when the video still has exactly this
     * size. Returns false while the surface holds no picture of this size (it must then stay hidden).
     */
    update(video: PreviewVideo, style: PreviewStyle, widthPx: number, heightPx: number): boolean;
    setVisible(isVisible: boolean): void;
    remove(): void;
}

/** Creates a surface inside the preview layer, or returns null to use the video itself. */
declare type PreviewSurfaceFactory = (layer: PreviewElement, video: PreviewVideo) => PreviewSurface | null;

declare interface PreviewVideo extends PreviewElement {
    readonly videoWidth: number;
    readonly videoHeight: number;
}

declare type ProcessingLongEdge = 480 | 640 | 960 | 'native';

declare interface RecognitionTrace extends FrameIdentity {
    readonly algorithmVersion: string;
    /** Feature count of the last pass, not a sum. */
    readonly featureCount: number;
    readonly candidateCount: number;
    readonly scalePasses: number;
    readonly observationCount: number;
    readonly isAmbiguous: boolean;
    readonly isBudgetExhausted: boolean;
    readonly rejected: readonly TargetRejection[];
    /** Stage times summed over the passes; present only when passes were captured. */
    readonly stageMs?: RecognitionTraceStageMs;
    /** One record per pass, snapshotted before accumulation; present only when passes were captured. */
    readonly passes?: readonly RecognitionTracePass[];
}

declare interface RecognitionTracePass extends RecognitionTraceStageMs {
    /** 1 for the standard image, less than 1 for the half-octave retry. */
    readonly scale: number;
    /** Resampling time of the retry (0 for the first pass); included in the summed `stageMs.featureMs`. */
    readonly prepareMs: number;
    readonly featureCount: number;
    readonly candidateCount: number;
    readonly observationCount: number;
    readonly isAmbiguous: boolean;
    readonly isBudgetExhausted: boolean;
    readonly rejected: readonly TargetRejection[];
}

declare interface RecognitionTraceStageMs {
    readonly featureMs: number;
    readonly retrievalMs: number;
    readonly matchMs: number;
    readonly geometryMs: number;
    readonly totalMs: number;
}

declare interface RecoveryAttempt {
    /** Never rejects. 'played' means play() resolved, not that frames are decoding. */
    readonly result: Promise<RecoveryOutcome>;
    /** Runs host code; it may call back synchronously, including cancelling this attempt. */
    start(): void;
    cancel(): void;
}

declare type RecoveryOutcome = {
    readonly status: 'played';
}
/** `error` is the error of the recovery's own play(), when it got that far. */
| {
    readonly status: 'failed';
    readonly error?: unknown;
} | {
    readonly status: 'cancelled';
};

declare interface RectPx {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** `en-US` → `en`; `zh`, `zh-TW`, `zh-Hans` → `zh-CN`; anything else → the default. */
export declare function resolveLocale(locale: string | null | undefined): 'zh-CN' | 'en';

/** A tracking result without its matched points (display data, never logged). */
declare type ResultRecord = Omit<TrackingResult, 'matchedPoints'>;

declare interface RevealOptions {
    /** 0..2000, default 420. */
    readonly revealMs?: number;
    /** 1..600000, default 15000; counts only while the plane is visible. */
    readonly loadingTimeoutMs?: number;
    /** 0.05..1, default 0.55. */
    readonly overlayOpacity?: number;
}

/** Validates a bundle completely and serializes it with an integrity hash. */
declare function serializeTarget(target: TargetBundle): Promise<string>;

/** Configuration of a session, captured at its start and when camera or capability facts change. */
declare interface SessionConfig {
    readonly targets: readonly {
        readonly targetId: string;
        readonly imageHash: string;
        readonly algorithmVersion: string;
        readonly compilerVersion: string;
        readonly widthPx: number;
        readonly heightPx: number;
    }[];
    readonly media: readonly {
        readonly targetId: string;
        /** SHA-256 of the URL or of the file bytes; never the URL itself. */
        readonly identityHash: string | null;
        readonly identityKind: 'url-sha256' | 'file-sha256' | null;
        readonly fit: 'contain' | 'cover';
    }[];
    readonly maxPredictionMs: number;
    readonly lossDisplayGraceMs: number;
    readonly requestedLongEdge: 480 | 640 | 960 | 'native' | null;
    readonly processingLongEdge: number | null;
    readonly inputWidthPx: number | null;
    readonly inputHeightPx: number | null;
    readonly previewWidthCss: number | null;
    readonly previewHeightCss: number | null;
    readonly previewSurface: 'canvas' | 'video' | null;
    readonly devicePixelRatio: number | null;
    readonly geometry: FrameGeometry | null;
    readonly cameraSettings: Readonly<Record<string, string | number | boolean>>;
    readonly capture: 'auto' | 'canvas' | null;
    readonly timestampSource: 'media-time' | 'callback' | null;
    readonly cameraClockMapping: {
        readonly sourceToSessionOffsetUs: number;
    } | null;
    readonly clockDomain: 'source-session' | null;
}

/** The parts of a window snapshots use. */
declare interface SnapshotEnvironment {
    readonly VideoFrame?: new (source: CanvasImageSource, init: {
        timestamp: number;
    }) => VideoFrame;
    createImageBitmap?(source: CanvasImageSource): Promise<ImageBitmap>;
}

declare interface SnapshotStrategy {
    readonly format: 'video-frame' | 'image-bitmap';
    isAvailable(env: SnapshotEnvironment): boolean;
    /** A synchronous strategy returns the picture directly, so taking it adds no asynchronous step. */
    take(env: SnapshotEnvironment, video: HTMLVideoElement, sourceTimestampUs: number): VideoFrame | ImageBitmap | Promise<ImageBitmap>;
    /** True when a failure should disable this strategy only if the camera run is still current. */
    readonly disablesOnlyWhenCurrent: boolean;
}

declare type StartupStage = 'pipeline-init' | 'renderer-init' | 'camera-init';

/**
 * A compiled target image, schema version 1. The format is unchanged from earlier releases so existing compiled
 * targets of the same algorithm keep loading. Algorithm-specific checks live in the recognition package.
 */
declare interface TargetBundle {
    readonly schemaVersion: 1;
    readonly compilerVersion: string;
    readonly algorithmVersion: string;
    readonly targetId: string;
    /** SHA-256 (hex) of the image the bundle was compiled from; see `imageHashDomain`. */
    readonly imageHash: string;
    readonly imageHashDomain?: 'encoded-image' | 'canonical-gray8';
    readonly widthPx: number;
    readonly heightPx: number;
    readonly physicalWidthMeters: number | null;
    readonly orientation: 'top-left';
    readonly pyramid: readonly TargetPyramidLevel[];
    readonly features: TargetFeatures;
    readonly preprocessing: Readonly<Record<string, string | number | boolean>>;
    readonly diagnostics: readonly TargetDiagnostic[];
}

declare interface TargetDiagnostic {
    readonly code: string;
    readonly severity: 'info' | 'warning' | 'error';
    readonly message: string;
}

declare interface TargetFeatures {
    /** Feature positions in target pixels. */
    readonly points: readonly Point2[];
    readonly descriptorType: string;
    /** Bytes per descriptor. */
    readonly descriptorLength: number;
    /** All descriptors concatenated, `points.length * descriptorLength` bytes. */
    readonly descriptors: readonly number[];
}

/** Engine estimates of where a target was in one camera frame, in captured-input pixels; never image truth. */
declare interface TargetFrameExtent {
    readonly sessionId: string;
    readonly frameId: number;
    readonly pictureKey: string | null;
    readonly observationTimeUs: number;
    readonly arrivalTimeUs: number;
    readonly targetId: string | null;
    readonly state: TrackingState;
    readonly isMeasured: boolean;
    readonly predictionAgeUs: number;
    readonly inputWidthPx: number;
    readonly inputHeightPx: number;
    readonly geometry: FrameGeometry | null;
    readonly cornersStandardPx: Corners | null;
    readonly cornersInputPx: Corners | null;
    readonly boundingBoxInputPx: RectPx | null;
    readonly edgeWidthInputPx: number | null;
    readonly edgeHeightInputPx: number | null;
    readonly widthFraction: number | null;
    readonly heightFraction: number | null;
    readonly areaFraction: number | null;
    readonly isFullyInsideInput: boolean | null;
    readonly unavailableReason: 'no-target-corners' | 'frame-geometry-unavailable' | 'invalid-frame-geometry' | null;
}

declare interface TargetLossContext {
    readonly triggerFrame: TargetFrameExtent | null;
    readonly precedingFrame: TargetFrameExtent | null;
    readonly lastReliableFrame: TargetFrameExtent | null;
    /** Null for a timer or lifecycle loss; false when an input frame before the trigger was skipped. */
    readonly isPrecedingInputFrameRecorded: boolean | null;
}

/** A target's media: a URL or a file, with its playback policy. */
declare type TargetMedia = ({
    readonly url: string;
} | {
    readonly file: Blob;
}) & Omit<MediaConfig, 'url'>;

declare interface TargetPyramidLevel {
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    /** Gray8 pixels, row-major. */
    readonly pixels: readonly number[];
}

declare interface TargetRejection {
    readonly targetId: string;
    /** Diagnostic code(s), e.g. 'NO_ROBUST_MODEL' or 'AMBIGUOUS_TARGETS'. */
    readonly reason: string;
}

/** A target's printed size in target pixels; the video plane has this size. */
declare interface TargetSize {
    readonly targetId: string;
    readonly widthPx: number;
    readonly heightPx: number;
}

/**
 * What the engine reports to a diagnostic observer. All methods are optional and synchronous; the engine isolates
 * them, but a sink must never throw.
 */
declare interface TelemetrySink {
    /** True when the engine should build per-frame records for this session (read after each `attemptStart`). */
    readonly wantsFrameDetail: boolean;
    event?(type: string, payload: unknown): void;
    frame?(record: FrameRecord): void;
    workerTiming?(record: WorkerTimingRecord): void;
    result?(result: TrackingResult): void;
}

declare interface TrackingQuality {
    readonly inlierCount: number;
    readonly inlierRatio: number;
    readonly reprojectionErrorPx: number | null;
    /** Convex hull area of the inlier target points divided by the target area. */
    readonly spatialCoverage: number;
    readonly isDegenerate: boolean;
    /** True for a result measured in its own frame; false for a prediction or a result without a target. */
    readonly isMeasured: boolean;
}

/** Why a result has its state. The values are kept from earlier releases so diagnostic logs stay comparable. */
declare type TrackingReason = 'original-target-measured' | 'confirming-original-match' | 'no-valid-original-match' | 'duplicate-image' | 'prediction-expired';

/** The tracker's verdict for one frame. Pixel quantities are in standard-image pixels. */
declare interface TrackingResult {
    readonly sessionId: string;
    readonly frameId: number;
    readonly observationTimeUs: number;
    readonly state: TrackingState;
    readonly reason: TrackingReason;
    readonly targetId: string | null;
    readonly H_imageFromTarget: Mat3 | null;
    /** Target corners (pixel edges) top-left, top-right, bottom-right, bottom-left. */
    readonly cornersPx: Corners | null;
    readonly quality: TrackingQuality;
    readonly prediction: PredictionInfo;
    /** Present only when matched-point collection was requested and this result was measured. */
    readonly matchedPoints?: MatchedPoints;
}

declare type TrackingState = 'SEARCHING' | 'ACQUIRING' | 'TRACKING' | 'LIMITED' | 'LOST';

export declare interface Translator {
    readonly locale: 'zh-CN' | 'en';
    t(key: string, params?: Readonly<Record<string, string | number>>): string;
}

export declare interface TranslatorOptions {
    readonly locale?: string;
    /** Per-locale additions or replacements, e.g. `{ en: { 'host.expired': '…' } }`. */
    readonly messages?: Readonly<Record<string, ArMessages>>;
    /** Wins whenever it returns a string; return nothing to fall back to the tables. */
    readonly translate?: (key: string, params: Readonly<Record<string, string | number>> | undefined, locale: string) => string | null | undefined | void;
}

/** No extra surface: the native video is the picture. */
declare const videoPreviewSurface: PreviewSurfaceFactory;

declare interface ViewportTransition {
    readonly phase: 'begin' | 'end';
    /** Increases with every trigger; work started under an older epoch is discarded. */
    readonly epoch: number;
    readonly reason: ViewportTransitionReason;
}

/** Raw trigger of a viewport transition, never merged with other triggers. */
declare type ViewportTransitionReason = 'orientation' | 'resize' | 'visual-viewport' | 'container' | 'intrinsic' | 'geometry' | 'frame-view' | 'frame-geometry' | 'empty-container';

/** The default playback recovery: the WeChat bridge on iOS WeChat. */
declare const wechatIosBridgeRecovery: PlaybackRecovery;

/** The parts of a Worker the client uses; injectable for tests and for hosts that create Workers themselves. */
declare interface WorkerEndpoint {
    postMessage(message: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: MessageEvent) => void): void;
}

declare interface WorkerTimingRecord {
    readonly sessionId: string;
    readonly frameId: number;
    /** Worker generation; +1 for every Worker created. */
    readonly generation: number;
    /** Durations in µs and copied byte counts; numbers only. */
    readonly timing: Readonly<Record<string, number | null | Readonly<Record<string, number>>>>;
}

export declare const ZH_CN: ArMessages;

export { }
