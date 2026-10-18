declare type ClearReason = 'hide' | 'loss' | 'stop' | 'session' | 'page-hidden' | 'media-failed';

/** Four corners in the order top-left, top-right, bottom-right, bottom-left. */
declare type Corners = readonly [Point2, Point2, Point2, Point2];

export declare function createRecognitionDiagnostics(options?: RecognitionDiagnosticsOptions): RecognitionDiagnostics;

export declare const DIAGNOSTICS_SCHEMA = "livemira-recognition-diagnostics/2";

export declare interface DiagnosticsSnapshot {
    readonly schema: typeof DIAGNOSTICS_SCHEMA;
    readonly isDisposed: boolean;
    readonly sessions: readonly SessionDiagnostics[];
    readonly dropped: {
        readonly stale: number;
        readonly malformed: number;
        readonly closedSession: number;
        readonly sessions: number;
        readonly targets: number;
    };
}

export declare interface DiagnosticsTarget {
    readonly targetId: string;
    readonly widthPx: number;
    readonly heightPx: number;
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

export declare interface PassRejections {
    readonly total: number;
    readonly byReason: Readonly<Record<string, number>>;
}

/** Statistics of one pass position (times in ms) over traces that carry passes. */
export declare interface PassStats {
    readonly n: number;
    readonly prepareMs: RunningStat;
    readonly featureMs: RunningStat;
    readonly retrievalMs: RunningStat;
    readonly matchMs: RunningStat;
    readonly geometryMs: RunningStat;
    readonly totalMs: RunningStat;
    readonly featureCount: RunningStat;
    readonly candidateCount: RunningStat;
    readonly ambiguous: number;
    readonly budgetExhausted: number;
    readonly accepted: number;
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

export declare interface RecognitionDiagnostics extends EngineExtension {
    /** Target sizes in target pixels (max 32), for hosts that feed traces and results themselves. */
    setTargets(targets: readonly DiagnosticsTarget[]): void;
    observeRecognition(trace: RecognitionTrace): void;
    observeResult(result: TrackingResult): void;
    snapshot(): DiagnosticsSnapshot;
    /** Forgets one session (or all); late events of a forgotten session are dropped, not re-counted. */
    reset(sessionId?: string): void;
    /** Releases everything; later calls do nothing and snapshot() reports an empty, disposed state. */
    dispose(): void;
}

export declare interface RecognitionDiagnosticsOptions {
    /** Sessions kept at once; the oldest is evicted. 1..16, default 4. */
    readonly maxSessions?: number;
    /** Targets per session. 1..32, default 16. Further targets are counted in dropped.targets. */
    readonly maxTargets?: number;
    /** Distinct rejection reason codes per target. 1..64, default 24. Further codes are counted as OTHER. */
    readonly maxReasons?: number;
    /** Minimum time between point-distribution computations (ms). 0..60000, default 200. */
    readonly minDispersionIntervalMs?: number;
    /** Clock in ms; default performance.now. */
    readonly nowMs?: () => number;
}

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

declare interface RectPx {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export declare type RejectionStage = 'target-diagnostics' | 'retrieval' | 'matching' | 'geometry' | 'boundary' | 'ambiguity' | 'other';

export declare interface RunningStat {
    readonly n: number;
    readonly mean: number;
    readonly min: number;
    readonly max: number;
}

export declare interface SessionDiagnostics {
    readonly sessionId: string;
    readonly recognition: {
        readonly passes: number;
        readonly ambiguous: number;
        readonly budgetExhausted: number;
        readonly twoScalePasses: number;
        readonly accepted: number;
        readonly featureCount: RunningStat;
    };
    /** Stage times (ms, summed over the passes of a trace) over traces that carry them. */
    readonly stageTiming: {
        readonly traces: number;
        readonly featureMs: RunningStat;
        readonly retrievalMs: RunningStat;
        readonly matchMs: RunningStat;
        readonly geometryMs: RunningStat;
        readonly totalMs: RunningStat;
    };
    readonly passStats: {
        readonly first: PassStats;
        readonly second: PassStats;
    };
    readonly results: {
        readonly observed: number;
        readonly measured: number;
        readonly predictedOrLost: number;
    };
    readonly dispersion: {
        readonly computed: number;
        readonly skippedByRate: number;
        readonly skippedNoTargetSize: number;
        readonly skippedInvalid: number;
    };
    readonly targets: readonly TargetDiagnostics[];
}

export declare interface TargetDiagnostics {
    readonly targetId: string;
    /** Final-pass rejections: one entry per trace rejection record. */
    readonly rejections: {
        readonly total: number;
        readonly byStage: Readonly<Partial<Record<RejectionStage, number>>>;
        readonly byReason: Readonly<Record<string, number>>;
    };
    /** Separate counts by pass from traces that carry passes; never added into `rejections`. */
    readonly passRejections: {
        readonly first: PassRejections;
        readonly second: PassRejections;
    };
    readonly measured: {
        readonly results: number;
        readonly hullCoverage: RunningStat;
        readonly dispersion: RunningStat;
        readonly isotropy: RunningStat;
        readonly pointCount: RunningStat;
    };
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

export { }
