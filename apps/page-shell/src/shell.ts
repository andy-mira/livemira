/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { SHELL_CSS } from './styles.ts';

export interface Shell {
  /** Full-screen element for the engine's container. */
  readonly stage: HTMLElement;
  /** Layer above the stage for floating controls, bounded by the safe area. */
  readonly floating: HTMLElement;
}

/**
 * Fixes the page to the viewport and creates the stage and the floating layer. The viewport meta tag must allow
 * `viewport-fit=cover` so the safe-area insets are reported. Size changes of the stage (address bar, rotation) are
 * handled by the engine's viewport gate; the shell does not listen for them.
 */
export function mountShell(doc: Document = document): Shell {
  if (!doc.getElementById('lm-shell-style')) {
    const style = doc.createElement('style');
    style.id = 'lm-shell-style';
    style.textContent = SHELL_CSS;
    doc.head.append(style);
  }
  const stage = doc.createElement('div');
  stage.className = 'lm-stage';
  const floating = doc.createElement('div');
  floating.className = 'lm-float';
  doc.body.append(stage, floating);
  return { stage, floating };
}
