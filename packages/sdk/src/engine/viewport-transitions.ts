/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Viewport transition state. The epoch makes older in-flight work irrelevant; while gated no frame is accepted; the
// ready promise is the tracker-reset barrier after the view settles, and `work` chains the resets in order. A begin
// goes through the loss path as a hard loss: the overlay hides at once, without the visual grace.

export class ViewportTransitions {
  epoch = 0;
  isGated = false;
  ready: Promise<void> | null = null;
  work: Promise<void> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;

  /** A new session subscription; the previous one (if any) is dropped. */
  subscribe(unsubscribe: (() => void) | null): void {
    this.unsubscribe?.();
    this.isGated = false;
    this.ready = null;
    this.unsubscribe = unsubscribe;
  }

  /** Ends the subscription; throws what the source's unsubscribe threw (after clearing the state). */
  close(): void {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    this.isGated = false;
    this.ready = null;
    unsubscribe?.();
  }
}
