/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PromptContent {
  readonly icon?: string;
  readonly title: string;
  readonly text?: string;
  /** e.g. "2 / 3" or an automatically detected result. */
  readonly progress?: string;
}

/**
 * A full-screen instruction layer (large text, an icon, progress); closed by the page once the action is detected.
 * Only the card behind the text is shaded: the camera picture keeps its real brightness, and touches pass through.
 */
export class FullscreenPrompt {
  private readonly element: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly title: HTMLElement;
  private readonly text: HTMLElement;
  private readonly progress: HTMLElement;

  constructor(floating: HTMLElement) {
    const doc = floating.ownerDocument;
    const make = (className: string): HTMLElement => {
      const element = doc.createElement('div');
      element.className = className;
      return element;
    };
    this.element = make('lm-prompt');
    this.element.hidden = true;
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-live', 'polite');
    const card = make('lm-prompt-card');
    this.icon = make('lm-prompt-icon');
    this.title = make('lm-prompt-title');
    this.text = make('lm-prompt-text');
    this.progress = make('lm-prompt-progress');
    card.append(this.icon, this.title, this.text, this.progress);
    this.element.append(card);
    floating.append(this.element);
  }

  show(content: PromptContent): void {
    this.icon.textContent = content.icon ?? '';
    this.title.textContent = content.title;
    this.text.textContent = content.text ?? '';
    this.progress.textContent = content.progress ?? '';
    this.element.hidden = false;
  }

  close(): void {
    this.element.hidden = true;
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }
}
