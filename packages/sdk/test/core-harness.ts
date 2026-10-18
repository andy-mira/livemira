/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// A scripted engine core: a frame source the test pushes frames into, a pipeline whose results the test chooses and
// an overlay that records what it was asked to show.

import { createGeometry } from '@livemira/camera';
import type {
  Corners,
  Frame,
  FrameGeometry,
  TrackingResult,
  TrackingState,
} from '@livemira/contracts';

import { EngineCore, type EngineCoreConfig } from '../src/engine/engine-core.ts';

/** Lets queued promise callbacks and immediates run. */
export async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export const CORNERS: Corners = [
  [30, 80],
  [120, 80],
  [120, 130],
  [30, 130],
];

/** Portrait camera geometry with a 320-pixel processing long edge (standard image 180 × 320 for 720 × 1280). */
export const portraitGeometry = (widthPx = 720, heightPx = 1280): FrameGeometry =>
  createGeometry({ widthPx, heightPx, longEdge: 320 });

export function makeFrame(
  sessionId: string,
  frameId: number,
  options: {
    widthPx?: number;
    heightPx?: number;
    geometry?: FrameGeometry | null;
    onRelease?: () => void;
  } = {},
): Frame {
  const widthPx = options.widthPx ?? 720;
  const heightPx = options.heightPx ?? 1280;
  return {
    sessionId,
    frameId,
    pictureKey: `${sessionId}:${frameId}`,
    timing: {
      sourceTimestampUs: frameId * 1000,
      timestampSource: 'replay',
      arrivalTimeUs: frameId * 1000,
      observationTimeUs: frameId * 1000,
    },
    widthPx,
    heightPx,
    geometry:
      options.geometry === undefined ? portraitGeometry(widthPx, heightPx) : options.geometry,
    image: {
      format: 'gray8',
      isReleased: false,
      data: () => new Uint8Array(1),
      release: () => options.onRelease?.(),
    },
  } as unknown as Frame;
}

export function makeResult(
  frame: Pick<Frame, 'sessionId' | 'frameId' | 'timing'>,
  targetId: string,
  state: TrackingState = 'TRACKING',
): TrackingResult {
  const isMeasured = state === 'TRACKING';
  const hasTarget = state === 'TRACKING' || state === 'LIMITED';
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    observationTimeUs: frame.timing.observationTimeUs,
    state,
    reason: hasTarget ? 'original-target-measured' : 'no-valid-original-match',
    targetId: hasTarget ? targetId : null,
    H_imageFromTarget: hasTarget ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : null,
    cornersPx: hasTarget ? (CORNERS.map((p) => [p[0], p[1]]) as unknown as Corners) : null,
    quality: {
      inlierCount: 20,
      inlierRatio: 0.8,
      reprojectionErrorPx: 1,
      spatialCoverage: 0.5,
      isDegenerate: false,
      isMeasured,
    },
    prediction: {
      ageUs: state === 'LIMITED' ? 33000 : 0,
      lastMeasuredTimeUs: frame.timing.observationTimeUs,
      expiresAtUs: frame.timing.observationTimeUs + 100000,
    },
  };
}

export interface Harness {
  readonly core: EngineCore;
  /** Every overlay update's target, in order. */
  readonly updates: (string | null)[];
  /** Whether the overlay shows something (after an update, until hide or stop). */
  readonly isVisible: boolean;
  /** Whether the source still delivers frames. */
  readonly isSourceActive: boolean;
  push(frame: Frame): Promise<void>;
  /** The pipeline's answer for each frame; default: target 'bird-01' tracked. */
  respond: (frame: Frame) => TrackingResult | Promise<TrackingResult>;
}

export function harness(config: Partial<EngineCoreConfig> = {}): Harness {
  let deliver: ((frame: Frame) => void) | null = null;
  let isVisible = false;
  const updates: (string | null)[] = [];
  const state: { respond: Harness['respond'] } = {
    respond: (frame) => makeResult(frame, 'bird-01'),
  };
  const core = new EngineCore({
    source: {
      start: async (_session, onFrame) => {
        deliver = onFrame;
      },
      stop: async () => {
        deliver = null;
      },
      dispose: async () => {
        deliver = null;
      },
    },
    pipeline: {
      loadTargets: async () => {},
      reset: async () => {},
      process: async (frame) => state.respond(frame),
      dispose: async () => {},
    },
    overlay: {
      start: async () => {},
      update: async (result) => {
        updates.push(result.targetId);
        isVisible = true;
      },
      hide: () => {
        isVisible = false;
      },
      stop: async () => {
        isVisible = false;
      },
      dispose: async () => {
        isVisible = false;
      },
    },
    capability: () => ({}) as never,
    ...config,
  });
  return {
    core,
    updates,
    get isVisible() {
      return isVisible;
    },
    get isSourceActive() {
      return deliver !== null;
    },
    async push(frame) {
      deliver?.(frame);
      await flush();
    },
    get respond() {
      return state.respond;
    },
    set respond(value) {
      state.respond = value;
    },
  };
}
