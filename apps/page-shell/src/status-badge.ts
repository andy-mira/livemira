/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

export type BadgeTone = 'neutral' | 'good' | 'warn' | 'bad';

/** A short status at the top centre, inside the safe area, not covering the middle of the picture. */
export class StatusBadge {
  private readonly element: HTMLElement;

  constructor(floating: HTMLElement) {
    this.element = floating.ownerDocument.createElement('div');
    this.element.className = 'lm-badge';
    this.element.setAttribute('role', 'status');
    this.element.hidden = true;
    floating.append(this.element);
  }

  show(text: string, tone: BadgeTone = 'neutral'): void {
    this.element.textContent = text;
    this.element.dataset.tone = tone;
    this.element.hidden = false;
  }

  hide(): void {
    this.element.hidden = true;
  }

  get text(): string {
    return this.element.hidden ? '' : (this.element.textContent ?? '');
  }
}
