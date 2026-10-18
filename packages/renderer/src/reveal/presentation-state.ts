/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The state of ONE media request's loading → first frame → reveal, its telemetry and its loading budget. The budget
// counts visible time only: its timer runs while the plane is shown and pauses while hidden.

import type {
  MediaPresentationTelemetry,
  PresentableSignal,
  PresentationFailureReason,
  VideoSession,
} from '@livemira/media';

import type { PlanePresentation } from './plane-presentation.ts';

export interface PresentationRequest {
  readonly generation: number;
  readonly media: VideoSession;
  readonly overlay: PlanePresentation;
  readonly sessionId: string;
  readonly targetId: string;
  phase: MediaPresentationTelemetry['phase'];
  signal: PresentableSignal | null;
  readonly startUs: number;
  firstFrameUs: number | null;
  revealStartUs: number | null;
  revealEndUs: number | null;
  isReduced: boolean;
  revealDurationMs: number;
  isAnnounced: boolean;
  /** Visible loading time left. */
  budgetMs: number;
  clockStartUs: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export function presentationTelemetry(
  request: PresentationRequest,
  nowUs: number,
  failureReason?: PresentationFailureReason,
): MediaPresentationTelemetry {
  const ms = (from: number, to: number): number => Math.max(0, Math.round((to - from) / 100) / 10);
  return {
    requestGeneration: request.generation,
    phase: request.phase,
    readySignal: request.signal,
    elapsedMs: ms(request.startUs, nowUs),
    firstFrameMs: request.firstFrameUs === null ? null : ms(request.startUs, request.firstFrameUs),
    revealElapsedMs:
      request.revealStartUs === null
        ? null
        : ms(request.revealStartUs, request.revealEndUs ?? nowUs),
    revealDurationMs: request.revealDurationMs,
    isReducedMotion: request.isReduced,
    ...(failureReason ? { failureReason } : {}),
  };
}

/** Starts the loading budget timer of a request that is still loading. */
export function startBudget(
  request: PresentationRequest | null,
  nowUs: () => number,
  onTimeout: (request: PresentationRequest) => void,
): void {
  if (!request || request.phase !== 'loading' || request.timer !== null) return;
  request.clockStartUs = nowUs();
  const timer = setTimeout(() => onTimeout(request), Math.max(1, request.budgetMs));
  // A pending budget must not keep a Node host (tests, tooling) alive; browsers return a number and ignore this.
  (timer as unknown as { unref?: () => void }).unref?.();
  request.timer = timer;
}

/** Stops the budget timer and keeps the remaining visible time. */
export function pauseBudget(request: PresentationRequest | null, nowUs: () => number): void {
  if (!request || request.timer === null) return;
  clearTimeout(request.timer);
  request.timer = null;
  const now = nowUs();
  request.budgetMs = Math.max(1, request.budgetMs - (now - (request.clockStartUs ?? now)) / 1000);
}
