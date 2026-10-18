/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** One-off notices; a newer notice replaces the current one. */
export class Toast {
  private readonly element: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(floating: HTMLElement) {
    this.element = floating.ownerDocument.createElement('div');
    this.element.className = 'lm-toast';
    this.element.setAttribute('role', 'status');
    this.element.hidden = true;
    floating.append(this.element);
  }

  show(text: string, durationMs = 2600): void {
    if (this.timer) clearTimeout(this.timer);
    this.element.textContent = text;
    this.element.hidden = false;
    this.timer = setTimeout(() => {
      this.element.hidden = true;
      this.timer = null;
    }, durationMs);
  }
}
