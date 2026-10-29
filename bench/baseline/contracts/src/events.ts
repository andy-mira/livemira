/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EngineError, ErrorCode } from './errors.ts';
import type { TrackingResult } from './tracking-result.ts';

/** Common fields of every engine event. */
export interface EventContext {
  readonly sessionId: string | null;
  readonly targetId: string | null;
  readonly timestampUs: number;
  /**
   * Clock of `timestampUs`: the camera session clock once the camera reports it, otherwise the engine session clock,
   * and before a session exists the clock of the start attempt.
   */
  readonly timestampDomain: 'attempt' | 'engine-session' | 'source-session';
}

/** Raw trigger of a viewport transition, never merged with other triggers. */
export type ViewportTransitionReason =
  | 'orientation'
  | 'resize'
  | 'visual-viewport'
  | 'container'
  | 'intrinsic'
  | 'geometry'
  | 'frame-view'
  | 'frame-geometry'
  | 'empty-container';

export interface ViewportTransition {
  readonly phase: 'begin' | 'end';
  /** Increases with every trigger; work started under an older epoch is discarded. */
  readonly epoch: number;
  readonly reason: ViewportTransitionReason;
}

/** Events defined by the core contracts; the engine adds media, capability and diagnostic events. */
export interface CoreEvents {
  attemptStart: EventContext;
  ready: EventContext;
  sessionStartFailed: EventContext & { readonly code: ErrorCode; readonly attemptTimeUs: number };
  sessionEnded: EventContext & { readonly reason: string };
  viewportTransition: EventContext & ViewportTransition;
  targetFound: EventContext & { readonly result: TrackingResult };
  targetUpdated: EventContext & { readonly result: TrackingResult };
  targetLost: EventContext & { readonly reason: string };
  error: EventContext & { readonly error: EngineError };
}
