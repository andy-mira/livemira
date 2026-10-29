// SPDX-License-Identifier: Apache-2.0
//
// Per-layer interfaces. Implementations depend only on this package; a pipeline manifest picks one implementation per
// layer, so candidates can be swapped and compared on identical inputs.

import type { FrameHandle } from './frame.ts';
import type { RectPx } from './geometry.ts';
import type { GrayImage, ImagePyramid } from './image.ts';
import type { Module } from './module.ts';
import type { FrameOutput, PoseEstimate } from './pose.ts';

export interface TargetInfo {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly physicalWidthMeters: number | null;
}

/** Keypoints of one image in structure-of-arrays form; positions in level-0 pixels. */
export interface Keypoints {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly level: Uint8Array;
  /** Orientation in radians; 0 for upright descriptors. */
  readonly angle: Float32Array;
  readonly score: Float32Array;
  /** `descriptorBytes` bytes per keypoint. */
  readonly descriptors: Uint8Array;
  readonly descriptorBytes: number;
}

/** A compiled target as the vision modules see it. */
export interface TargetAsset {
  readonly info: TargetInfo;
  /** Template pyramid of the target image (level 0 = target pixels). */
  readonly template: ImagePyramid;
  /** Keypoints in target pixels, when the asset carries any. */
  readonly keypoints: Keypoints | null;
}

/** Putative matches between one target and one frame. */
export interface Correspondences {
  readonly targetId: string;
  readonly count: number;
  /** Interleaved x, y in target pixels. */
  readonly target: Float64Array;
  /** Interleaved x, y in standard-image pixels. */
  readonly image: Float64Array;
  /** Descriptor distance per pair (lower is better); orders sampling. */
  readonly distance: Float64Array;
}

export interface Rejection {
  readonly targetId: string;
  readonly reason: string;
}

export interface PyramidBuilder extends Module {
  build(frame: FrameHandle): ImagePyramid;
}

export interface FeatureExtractor extends Module {
  extract(
    pyramid: ImagePyramid,
    options: { readonly budget: number; readonly roi?: readonly number[] | null },
  ): Keypoints;
}

export interface TargetIndex extends Module {
  load(targets: readonly TargetAsset[]): void;
  match(frame: Keypoints, options?: { readonly restrictTo?: readonly string[] }): readonly Correspondences[];
}

export interface GeometryVerifier extends Module {
  verify(c: Correspondences, target: TargetInfo, prior?: PoseEstimate | null): PoseEstimate | Rejection;
}

/** What a fast-loop tracker gets for one frame of one target. */
export interface TrackInput {
  readonly frame: FrameHandle;
  readonly pyramid: ImagePyramid;
  /** Predicted pose for this frame (from the filter or the motion model). */
  readonly prior: PoseEstimate;
  /** The previous processed frame and the pose accepted in it, when the target was tracked there. */
  readonly previous: { readonly pyramid: ImagePyramid; readonly pose: PoseEstimate } | null;
}

/** Fast-loop tracker: refines a prior pose of one target in a new frame. */
export interface FrameTracker extends Module {
  prepare(targets: readonly TargetImage[]): void;
  track(input: TrackInput): PoseEstimate | Rejection;
}

/** Slow-loop detector: finds targets without a prior, optionally inside a region of interest. */
export interface Detector extends Module {
  load(targets: readonly TargetImage[]): Promise<LoadReport>;
  /** Loads precompiled assets (no compilation at start-up); reports info and template per target. */
  loadEncoded?(assets: readonly Uint8Array[]): Promise<LoadReport>;
  /**
   * `roi` limits the search to a region; `upscale` (with `roi`, 1..3) enlarges that region before its features are
   * taken, for a target small on screen (detectors that cannot enlarge ignore it).
   */
  detect(
    frame: FrameHandle,
    options?: { readonly roi?: RectPx | null; readonly upscale?: number },
  ): Promise<readonly PoseEstimate[]>;
}

export interface PoseFilter extends Module {
  update(measurement: PoseEstimate): PoseEstimate;
  predict(targetId: string, timeUs: number): PoseEstimate | null;
  /** A predictor frozen at the current state; later updates do not change it. */
  snapshot(targetId: string): ((timeUs: number) => PoseEstimate | null) | null;
  reset(targetId?: string): void;
}

/** A target picture before compilation: gray8 pixels and physical size. */
export interface TargetImage {
  readonly info: TargetInfo;
  readonly image: GrayImage;
}

/** What compiling the targets cost and produced; `serialized` is the asset as it would ship. */
export interface LoadReport {
  readonly targets: readonly {
    readonly id: string;
    readonly compileUs: number;
    readonly serialized: Uint8Array;
    /** The template as decoded from `serialized` (target resolution), when it differs from the source picture. */
    readonly template?: GrayImage;
    /** The target's description, when it was read from an encoded asset. */
    readonly info?: TargetInfo;
  }[];
}

/** A complete vision pipeline (orchestrator plus its modules): one frame in, one output out. */
export interface VisionPipeline extends Module {
  /** Compiles and loads the targets (replacing earlier ones). */
  load(targets: readonly TargetImage[]): Promise<LoadReport>;
  /** Starts a new session: all tracking state is cleared. */
  reset(sessionId: string): void;
  process(frame: FrameHandle): Promise<FrameOutput>;
  /** Stateless single-frame recognition (the slow loop alone), for single-frame sweeps. */
  detect(frame: FrameHandle): Promise<readonly PoseEstimate[]>;
  dispose(): void;
}
