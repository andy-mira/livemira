/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export interface PresentationOptions {
  /** Circular reveal duration, 0..2000 ms (0 = no animation). Default 420. */
  revealMs?: number;
  /** Visible-loading budget before the request fails with reason 'media-loading-timeout', 1..600000 ms. Default 15000. */
  loadingTimeoutMs?: number;
  /** Opacity of the black layer over the plane while loading, .05..1. Default .55. */
  overlayOpacity?: number;
}
export const REVEAL_DEFAULTS: Readonly<Required<PresentationOptions>>;
export const REDUCED_REVEAL_MS: 120;
/** Returns null for `false` (disabled); throws RangeError for invalid values. */
export function normalizePresentationOptions(options: PresentationOptions | boolean | undefined): Required<PresentationOptions> | null;
export class PlanePresentation {
  constructor(plane: HTMLElement, video: HTMLVideoElement, options: { width: number; height: number; overlayOpacity?: number; now?: () => number; document?: Document });
  static prefersReducedMotion(view: Window | null | undefined): boolean;
  readonly reducedMotion: boolean;
  readonly phase: 'idle' | 'loading' | 'revealing' | 'revealed' | 'disposed';
  showLoading(reduced?: boolean): void;
  reveal(options: { durationMs: number; reduced?: boolean; onEnd?: (completed: boolean) => void }): void;
  finish(): void;
  cancel(): void;
  restoreVideo(): void;
  dispose(): void;
}
