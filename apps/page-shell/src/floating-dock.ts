/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Round buttons in the bottom-right corner, each opening one collapsible panel. At most one panel is open; collapsed,
// only the buttons remain, so the recognition area stays free. The open panel is remembered per page.

import { safeStorage } from './storage.ts';

export interface PanelSpec {
  readonly id: string;
  /** Short symbol for the round button. */
  readonly icon: string;
  readonly title: string;
}

export class FloatingDock {
  private readonly root: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly panels = new Map<string, HTMLElement>();
  private readonly storageKey: string;
  private openId: string | null = null;

  constructor(floating: HTMLElement, options: { storageKey: string }) {
    const doc = floating.ownerDocument;
    this.storageKey = options.storageKey;
    this.root = doc.createElement('div');
    this.root.className = 'lm-dock';
    const buttons = doc.createElement('div');
    buttons.className = 'lm-dock-buttons';
    this.root.append(buttons);
    floating.append(this.root);
  }

  /** Adds a panel and returns its content element. */
  addPanel(spec: PanelSpec): HTMLElement {
    const doc = this.root.ownerDocument;
    const panel = doc.createElement('section');
    panel.className = 'lm-panel';
    panel.id = `lm-panel-${spec.id}`;
    panel.hidden = true;
    const heading = doc.createElement('h2');
    heading.textContent = spec.title;
    panel.append(heading);
    const button = doc.createElement('button');
    button.className = 'lm-dock-button';
    button.type = 'button';
    button.textContent = spec.icon;
    button.title = spec.title;
    button.setAttribute('aria-label', spec.title);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => this.toggle(spec.id));
    this.root.insertBefore(panel, this.root.lastElementChild);
    this.root.lastElementChild!.append(button);
    this.buttons.set(spec.id, button);
    this.panels.set(spec.id, panel);
    if (safeStorage.get(this.storageKey) === spec.id) this.open(spec.id);
    return panel;
  }

  /** The open panel, or null when all are collapsed. */
  get openPanel(): string | null {
    return this.openId;
  }

  open(id: string | null): void {
    this.openId = id;
    for (const [key, panel] of this.panels) {
      const isOpen = key === id;
      panel.hidden = !isOpen;
      this.buttons.get(key)?.setAttribute('aria-expanded', String(isOpen));
    }
    safeStorage.set(this.storageKey, id);
  }

  toggle(id: string): void {
    this.open(this.openId === id ? null : id);
  }
}
