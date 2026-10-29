// SPDX-License-Identifier: Apache-2.0
// LiveMira 0.5.0

/**
 * Why a picture rated as it did, most important first:
 * - `'HARD_TO_FIND'`: the detector misses the picture, or finds it narrowly, in most synthetic views;
 * - `'CONCENTRATED'`: the detail sits in part of the picture;
 * - `'WEAK_QUARTER'`: one quarter has almost no detail (`metrics.weakestQuarter`);
 * - `'FEW_DETAILS'`: few points the engine finds again from other angles;
 * - `'REPETITIVE'`: repeating patterns, points that look alike;
 * - `'FAILS_SMALL'`, `'FAILS_TILTED'`, `'FAILS_BLURRED'`, `'FAILS_DIM'`, `'FAILS_COVERED'`: that recognition test
 *   (`metrics.tests`) clearly weaker than for most photos: small, tilted, blurred by motion, in dim light, partly
 *   covered.
 */
export type RatingAdvice = 'HARD_TO_FIND' | 'CONCENTRATED' | 'WEAK_QUARTER' | 'FEW_DETAILS' | 'REPETITIVE' | 'FAILS_SMALL' | 'FAILS_TILTED' | 'FAILS_BLURRED' | 'FAILS_DIM' | 'FAILS_COVERED';
/** The recognition tests, each a ladder of synthetic views from easy to hard. */
export type RecognitionTest = 'size' | 'tilt' | 'blur' | 'dim' | 'covered';
/**
 * How well the engine will find and keep a picture. Four factors, each 0..1: `detail` (points found again from other
 * angles), `spread` (those points over the whole picture: grid cells, evenness, the weakest quarter),
 * `distinctiveness` (no look-alikes far apart) and `recognition` (the engine's detector on synthetic views: smaller,
 * tilted, motion-blurred, dimmer, partly covered). The stars weigh them and are capped by the weaker of spread and
 * recognition, so detail crowded in one place cannot rate high.
 */
export interface TargetRating {
    /** 0.5 … 5 in halves: 5 near the best on every count, 4–4.5 good, 3–3.5 usable, 2–2.5 better replaced. */
    readonly stars: number;
    /** 0 … 100 before rounding to stars. */
    readonly score: number;
    readonly factors: {
        readonly detail: number;
        readonly spread: number;
        readonly distinctiveness: number;
        readonly recognition: number;
    };
    readonly metrics: {
        readonly robustPoints: number;
        readonly grid: {
            readonly columns: number;
            readonly rows: number;
            readonly counts: readonly number[];
        };
        readonly populatedCells: number;
        /** Effective share of cells holding the points (1: even, 1/cells: all in one). */
        readonly evenness: number;
        /** 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right, and its share of the points. */
        readonly weakestQuarter: {
            readonly index: number;
            readonly share: number;
        };
        readonly distinctShare: number;
        /** Each recognition test's views found, counted by their margin (0..1). */
        readonly tests: Readonly<Record<RecognitionTest, number>>;
        readonly views: readonly {
            readonly name: string;
            readonly test: RecognitionTest;
            readonly found: boolean;
        }[];
    };
    readonly advice: readonly RatingAdvice[];
    /** The points counted as detail, in target pixels (x, y interleaved), for drawing over the picture. */
    readonly points: Float32Array;
    /** Size of the compiled picture (target pixels). */
    readonly width: number;
    readonly height: number;
}
export interface RateOptions {
    readonly signal?: AbortSignal;
    /** The rating Worker file, for pages whose CSP forbids `blob:` Workers. */
    readonly workerUrl?: string | URL;
}
export interface RateImageOptions extends RateOptions {
    /** Long edge the picture is compiled at; keep it equal to the engine's `compileTargetImage` (default 640). */
    readonly maxEdgePx?: number;
}
export type RatingErrorCode = 
/** Not a picture file or target bytes, or an option out of range. */
'INVALID_INPUT' | 'DECODE_FAILED'
/** The engine would refuse this picture: too small, or too little detail to track. */
 | 'UNSUITABLE_TARGET'
/** Damaged target bytes. */
 | 'INVALID_TARGET' | 'WORKER_FAILED' | 'ABORTED';
export interface RatingErrorShape extends Error {
    readonly name: 'RatingError';
    readonly code: RatingErrorCode;
}
export interface RatingBuildInfo {
    readonly version: string;
    readonly buildId: string;
    readonly variant: 'minified' | 'readable' | 'development';
}

export declare const RATING_VERSION: string;
export declare const ratingBuildInfo: RatingBuildInfo;
/** Rates a picture file as a target (decoded and compiled as the engine's `compileTargetImage` would), in a Worker. */
export declare function rateTargetImage(image: Blob, options?: RateImageOptions): Promise<TargetRating>;
/** Rates an already compiled target: the engine's target bundle or its bytes. */
export declare function rateTarget(target: { readonly bytes: Uint8Array } | Uint8Array, options?: RateOptions): Promise<TargetRating>;
export declare class RatingError extends Error implements RatingErrorShape {
  readonly name: 'RatingError';
  readonly code: RatingErrorCode;
  constructor(code: RatingErrorCode, message: string, options?: { cause?: unknown });
}

export {};
