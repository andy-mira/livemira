declare type ClearReason = 'hide' | 'loss' | 'stop' | 'session' | 'page-hidden' | 'media-failed';

/** Four corners in the order top-left, top-right, bottom-right, bottom-left. */
declare type Corners = readonly [Point2, Point2, Point2, Point2];

/** The extension. `points` needs matched points from the Worker, which is decided when the engine is created. */
export declare function createTrackingVisuals(options?: TrackingVisualization): TrackingVisuals;

/**
 * The current measured inlier points of this result, or null: only for a measured, non-degenerate TRACKING/LIMITED
 * result whose matched points carry the same session, frame and target and at most MAX_MATCHED_POINTS finite pairs.
 */
export declare function currentMatchedPoints(result: TrackingResult): readonly Point2[] | null;

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

declare type Point2 = readonly [number, number];

declare interface PredictionInfo {
    /** 0 for a measured result; time since the last measurement for a prediction. */
    readonly ageUs: number;
    /** Observation time of the last measurement this result is based on. */
    readonly lastMeasuredTimeUs: number | null;
    /** Time after which the last measurement may no longer be extrapolated. */
    readonly expiresAtUs: number | null;
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

export declare interface TrackingVisualization {
    /** Recognized target quadrilateral. Default false. */
    readonly boundary?: boolean;
    /** Current matched inlier points. Default false. */
    readonly points?: boolean;
}

export declare interface TrackingVisuals extends EngineExtension {
    /** Replaces the switches. Turning one off clears it now; turning one on draws from the next presented result. */
    setVisualization(options: TrackingVisualization): void;
    getVisualization(): Readonly<Required<TrackingVisualization>>;
    /** Counts only, never coordinates. */
    getDiagnostics(): TrackingVisualsDiagnostics;
}

export declare interface TrackingVisualsDiagnostics {
    readonly boundary: boolean;
    readonly points: boolean;
    readonly isBoundaryShown: boolean;
    readonly shownPoints: number;
    readonly isLayerAttached: boolean;
}

export { }
