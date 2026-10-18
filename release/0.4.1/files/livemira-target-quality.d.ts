/** assessGrayTarget plus the template feature points behind the score, for static display. */
export declare function analyzeGrayTarget(image: GrayImage): TargetAnalysis;

/** assessTargetImage plus the template feature points; every decode resource is released on success, error and abort. */
export declare function analyzeTargetImage(blob: Blob, options?: AssessImageOptions): Promise<TargetAnalysis>;

/**
 * Scores a canonical gray8 image (row-major, widthPx × heightPx bytes). Synchronous and pure. Images with a long edge
 * above 640 are first reduced by exact area averaging; smaller images are never enlarged.
 */
export declare function assessGrayTarget(image: GrayImage): TargetQualityResult;

export declare interface AssessImageOptions {
    readonly signal?: AbortSignal;
    /** Lowers the encoded size limit (never above MAX_IMAGE_BYTES). */
    readonly maxImageBytes?: number;
    /** Lowers the decoded pixel limit (never above MAX_INPUT_PIXELS). */
    readonly maxPixels?: number;
    readonly environment?: DecodeEnvironment;
}

/** Decodes an image file locally (no network, no upload) the way the target compiler does, then scores it. */
export declare function assessTargetImage(blob: Blob, options?: AssessImageOptions): Promise<TargetQualityResult>;

/** Compile blockers cap the score here, so such an image always lands below REPLACE_BELOW. */
export declare const BLOCKER_CAP = 2;

export declare interface CanvasLike {
    width: number;
    height: number;
    getContext(type: '2d', options?: {
        willReadFrequently?: boolean;
    }): ContextLike | null;
}

export declare interface ContextLike {
    drawImage(image: ImageBitmapLike, dx: number, dy: number, dw: number, dh: number): void;
    getImageData(x: number, y: number, w: number, h: number): {
        data: ArrayLike<number>;
    };
}

/** Decode primitives; default the page or Worker globals. */
export declare interface DecodeEnvironment {
    createImageBitmap?: (blob: Blob) => Promise<ImageBitmapLike>;
    OffscreenCanvas?: new (width: number, height: number) => CanvasLike;
    document?: {
        createElement(name: 'canvas'): CanvasLike;
    };
}

export declare const DISCLAIMER = "Heuristic preflight of image suitability only. It is not a calibrated probability of detection, does not guarantee recognition and is not a Vuforia or ARCore rating. A score of 3 or more can still fail on a device.";

/** Clears the box and draws one hollow ring per template feature, scaled to `box`. Returns the rings drawn. */
export declare function drawTemplateFeatures(context: PreviewContext2D, preview: TemplateFeaturePreview, box: {
    readonly widthPx: number;
    readonly heightPx: number;
}, options?: {
    readonly radius?: number;
    readonly color?: string;
    readonly maxPoints?: number;
}): number;

/** Gray8 image with tight rows. */
declare interface GrayImage {
    readonly widthPx: number;
    readonly heightPx: number;
    readonly data: Uint8Array;
}

export declare interface ImageBitmapLike {
    readonly width: number;
    readonly height: number;
    close(): void;
}

export declare const MAX_IMAGE_BYTES = 24000000;

export declare const MAX_INPUT_DIMENSION = 8192;

export declare const MAX_INPUT_PIXELS = 16777216;

export declare const MAX_LONG_EDGE = 640;

export declare const MAX_SCORE = 5;

export declare const MIN_DIMENSION = 32;

/** The size an image is scored at: a long edge of at most 640, never enlarged. */
export declare function normalizedSize(widthPx: number, heightPx: number): {
    widthPx: number;
    heightPx: number;
    scale: number;
};

export declare interface PreviewContext2D {
    save(): void;
    restore(): void;
    beginPath(): void;
    arc(x: number, y: number, r: number, start: number, end: number): void;
    stroke(): void;
    clearRect(x: number, y: number, w: number, h: number): void;
    lineWidth: number;
    strokeStyle: string | CanvasGradient | CanvasPattern;
}

export declare interface QualityMetrics {
    readonly featureCount: number;
    readonly featuresPerLevel: readonly number[];
    readonly hullCoverage: number;
    readonly occupiedCells: number;
    readonly effectiveCells: number;
    readonly nearDuplicateRatio: number;
    readonly ambiguousRatio: number;
    readonly medianNearestDistance: number;
    readonly contrastRange: number;
    /** Target-normalized spread of the features (see the score formula). */
    readonly dispersion: number;
    readonly isotropy: number;
}

export declare interface QualityNormalization {
    readonly id: string;
    readonly grayFormula: string;
    readonly maxLongEdge: number;
    readonly inputWidthPx: number;
    readonly inputHeightPx: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly scale: number;
    readonly resampling: 'none' | 'box-area' | 'canvas-draw-image';
}

export declare interface QualityReason {
    readonly code: ReasonCode;
    readonly severity: ReasonSeverity;
    readonly message: string;
    readonly metric: string;
    readonly value: number;
    readonly threshold: number;
}

/** Each sub-score is a 0..1 ramp. */
export declare interface QualitySubscores {
    readonly support: number;
    readonly coverage: number;
    readonly dispersion: number;
    readonly conditioning: number;
    readonly uniqueness: number;
}

export declare type ReasonCode = 'LOW_FEATURE_COUNT' | 'LOW_COVERAGE' | 'CLUSTERED_FEATURES' | 'DEGENERATE_GEOMETRY' | 'REPETITIVE_PATTERN' | 'LOW_CONTRAST' | 'LOW_RESOLUTION' | 'DOWNSCALED';

export declare type ReasonSeverity = 'blocker' | 'warning' | 'info';

/** Below this published score the advice is to replace the image (decided on the rounded score). */
export declare const REPLACE_BELOW = 3;

export declare const RESULT_SCHEMA = "livemira-target-quality/3";

/** The pure scoring step: metrics → sub-scores and the published score. */
export declare function scoreMetrics(input: ScoringInput): {
    subscores: QualitySubscores;
    score: number;
    rawScore: number;
};

export declare const SCORER_NAME = "webar-target-suitability";

export declare const SCORER_VERSION = "2.0.0";

export declare interface ScoringInput {
    readonly metrics: QualityMetrics;
    readonly blockers: number;
}

export declare interface TargetAnalysis {
    readonly result: TargetQualityResult;
    readonly features: TemplateFeaturePreview;
}

export declare interface TargetQualityResult {
    readonly schema: typeof RESULT_SCHEMA;
    readonly scorer: {
        readonly name: string;
        readonly version: string;
    };
    readonly algorithm: {
        readonly version: string;
        readonly maxFeatures: number;
        readonly levels: number;
    };
    readonly normalization: QualityNormalization;
    /** 0..5, at most one decimal. */
    readonly score: number;
    readonly maxScore: 5;
    /** Unrounded value (3 decimals) for diagnosing near-threshold results; decisions use `score`. */
    readonly rawScore: number;
    /** Exactly `score < 3`. */
    readonly shouldReplace: boolean;
    readonly advice: string;
    readonly metrics: QualityMetrics;
    readonly subscores: QualitySubscores;
    readonly reasons: readonly QualityReason[];
    readonly disclaimer: string;
}

export declare const TEMPLATE_PREVIEW_LABEL = "template features (static, not live matches)";

/** The template feature points behind a score, in normalized-image pixels, for static display; never live matches. */
export declare interface TemplateFeaturePreview {
    readonly algorithmVersion: string;
    readonly maxFeatures: number;
    readonly levels: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly points: readonly {
        readonly x: number;
        readonly y: number;
        readonly level: number;
    }[];
}

export declare const WEIGHT = 0.2;

export { }
