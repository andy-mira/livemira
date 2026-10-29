// SPDX-License-Identifier: Apache-2.0
// Messages between the engine (main thread) and its vision Worker.

import type { Corners, PoseEstimate, TargetInfo, TrackState } from '@livemira-next/contracts';

import type { LumaPath } from './luma.ts';

export interface WorkerTarget {
  readonly info: TargetInfo;
  /** Gray8 picture, tight rows. */
  readonly gray: ArrayBuffer;
}

export type ToWorker =
  | {
      readonly type: 'init';
      /** Pictures compiled at start-up, or compiled target assets (preferred: no compilation on the device). */
      readonly targets: readonly WorkerTarget[];
      readonly assets?: readonly ArrayBuffer[];
      readonly width: number;
      readonly height: number;
      readonly returnFrames: boolean;
      /** Device-kit builds only: a frame strip and a trace with every result. */
      readonly probe: boolean;
      /** Port to a relocalisation Worker: periodic relocalisation then runs concurrently with tracking. */
      readonly relocalizer?: MessagePort;
      /** Modules of the vision pipeline; defaults: the Swift profile's ({@link DEFAULT_PIPELINE}). */
      readonly pipeline?: Partial<PipelineConfig>;
    }
  /** Chromium: the track processor's stream, transferred. */
  | { readonly type: 'stream'; readonly readable: ReadableStream<VideoFrame> }
  /** WebKit: the track itself, transferred; the Worker creates its own processor. */
  | { readonly type: 'track'; readonly track: MediaStreamTrack }
  /** Fallback: one frame from the main thread (rVFC + new VideoFrame(video)). */
  | { readonly type: 'frame'; readonly frame: VideoFrame; readonly captureUs: number }
  /** Last resort: gray pixels read back on the main thread. */
  | { readonly type: 'gray'; readonly gray: ArrayBuffer; readonly captureUs: number }
  /** Replace the pipeline's modules (an engine profile stepping down); targets are reloaded, tracking restarts. */
  | { readonly type: 'reconfigure'; readonly pipeline: Partial<PipelineConfig> }
  /** The shown picture changed shape (the device turned): new standard size; tracking starts over. */
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  /** Replace the targets with these target assets (answered by 'targets'); tracking starts over. */
  | { readonly type: 'targets'; readonly assets: readonly ArrayBuffer[] }
  | { readonly type: 'stop' };

export interface DisplayPose {
  readonly targetId: string;
  readonly corners: Corners;
  /** Corner velocities, standard px/s (x0, y0, …, y3), for display-time extrapolation. */
  readonly velocity: readonly number[];
  readonly timeUs: number;
}

export interface WorkerStats {
  readonly lumaUs: number;
  readonly processUs: number;
  /** Worker receipt time minus the frame's capture timestamp (same clock), µs; null when the clocks differ. */
  readonly arrivalUs: number | null;
  readonly lumaPath: LumaPath | 'gray';
  /** Shown orientation applied to the camera planes and where it came from (e.g. 'r90/detected'). */
  readonly orientation?: string;
  /** The last orientation detection's frame format, raw size and scores per reference. */
  readonly orientationDetail?: string;
}

/** Diagnostics only (init `probe`): what the pipeline measured in one frame, for device reports. */
export interface FrameTrace {
  /** Poses measured in this frame (before display filtering), with where they came from and how well they fit. */
  readonly measured: readonly {
    readonly targetId: string;
    readonly origin: string;
    readonly support: number;
    readonly ratio: number;
    readonly residual: number;
    readonly coverage: number;
  }[];
  /** Pipeline stage times, µs (pyramid, track, detect, total). */
  readonly timings: Readonly<Record<string, number>>;
}

export type FromWorker =
  | {
      readonly type: 'ready';
      readonly matcher: string;
      readonly compileMs: number;
      readonly targets: readonly TargetInfo[];
    }
  | {
      readonly type: 'result';
      readonly sequence: number;
      readonly captureUs: number;
      readonly state: TrackState;
      /** Standard image size the poses are in (a result from before a resize no longer fits the view). */
      readonly size: readonly [number, number];
      readonly poses: readonly DisplayPose[];
      readonly stats: WorkerStats;
      /** The processed frame, transferred back for frame-locked composition. */
      readonly frame?: VideoFrame;
      /** Once, with the first camera-orientation detection: its report (scores, thumbnails), for device diagnostics. */
      readonly diagnostics?: unknown;
      /** Diagnostics only (init `probe`): the processed picture's bottom-left 128×8 gray strip, for frame identification. */
      readonly strip?: Uint8Array;
      /** Diagnostics only (init `probe`). */
      readonly trace?: FrameTrace;
    }
  /** The targets loaded after a 'targets' message. */
  | { readonly type: 'targets'; readonly targets: readonly TargetInfo[] }
  | { readonly type: 'error'; readonly message: string };

/** Messages on the port between the vision Worker and the relocalisation Worker. */
export type RelocalizerRequest = {
  readonly type: 'relocalize';
  readonly id: number;
  readonly gray: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly frameId: number;
  readonly captureUs: number;
  readonly roi: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly tracked: PoseEstimate;
};

export type RelocalizerResponse = {
  readonly type: 'relocalized';
  readonly id: number;
  readonly detected: PoseEstimate | null;
  readonly tracked: PoseEstimate;
  readonly detectUs: number;
};

/** Main thread → relocalisation Worker. */
export type ToRelocalizer =
  | {
      readonly type: 'init';
      readonly targets: readonly WorkerTarget[];
      readonly assets?: readonly ArrayBuffer[];
      readonly port: MessagePort;
      /** WASM SIMD kernels (default true). */
      readonly wasm?: boolean;
    }
  /** Replace the targets with these target assets. */
  | { readonly type: 'targets'; readonly assets: readonly ArrayBuffer[] };

/** The swappable modules of the Worker's vision pipeline (the engine profiles pick them; the ids in brackets name the
 * modules in the code and the device reports). */
export interface PipelineConfig {
  /** Fast-loop tracker: ESM [D2], KLT [D1], KLT prior + ESM [D1+D2], target-anchored NCC patches [D3]. */
  readonly tracker: 'esm' | 'klt' | 'klt+esm' | 'ncc';
  /** ESM iterations per pyramid level, finest last (the default schedule is [8, 6, 5]). */
  readonly esmIterations?: readonly number[];
  /** Pose filter: corner-space Kalman [E2] or One Euro [E1]. */
  readonly filter: 'E2' | 'E1';
  /** Slow loop [D4]: relocalise every this many processed frames (concurrently when a relocaliser port is given). */
  readonly relocalizeEvery: number;
  /** WASM SIMD kernels [B1]; false runs the JavaScript references (identical results, slower). */
  readonly wasm: boolean;
}

/** The Swift profile's pipeline, the default. */
export const DEFAULT_PIPELINE: PipelineConfig = { tracker: 'esm', filter: 'E2', relocalizeEvery: 60, wasm: true };
