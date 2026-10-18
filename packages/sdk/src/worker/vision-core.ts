/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Recognition and tracking of standard gray frames: the work the vision Worker does per frame, independent of how
// frames arrive.

import type { FrameIdentity, TargetBundle, TrackingResult } from '@livemira/contracts';
import { Recognizer, type ExactMatcher, type RecognitionBatch } from '@livemira/recognition';
import { Tracker, type GrayFrame } from '@livemira/tracking';

export interface VisionCoreOptions {
  readonly exactMatcher?: ExactMatcher;
  readonly collectMatchedPoints: boolean;
  readonly scaleRetry: boolean;
  /** Called synchronously with each completed recognition and the frame it belongs to; nothing is kept without it. */
  readonly onRecognition?: (batch: RecognitionBatch, frame: FrameIdentity) => void;
}

export class VisionCore {
  private readonly recognizer: Recognizer;
  private readonly tracker: Tracker;

  constructor(options: VisionCoreOptions) {
    const observe = options.onRecognition;
    this.recognizer = new Recognizer({
      ...(options.exactMatcher ? { exactMatcher: options.exactMatcher } : {}),
      scaleRetry: options.scaleRetry,
      capturePasses: observe !== undefined,
    });
    this.tracker = new Tracker({
      recognize: async (frame, _targets, signal) => {
        const batch = await this.recognizer.recognize(frame.image, frame, { signal });
        if (observe) observe(batch, { sessionId: frame.sessionId, frameId: frame.frameId });
        return batch.observations;
      },
      collectMatchedPoints: options.collectMatchedPoints,
    });
  }

  async loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    await this.recognizer.loadTargets(targets);
    await this.tracker.loadTargets(targets);
  }

  reset(sessionId: string): Promise<void> {
    return this.tracker.reset(sessionId);
  }

  process(frame: GrayFrame, signal: AbortSignal): Promise<TrackingResult> {
    return this.tracker.process(frame, signal);
  }

  async dispose(): Promise<void> {
    await this.tracker.dispose();
    this.recognizer.dispose();
  }
}
