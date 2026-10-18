/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/page-shell. Only re-exports belong here.
export { mountShell, type Shell } from './shell.ts';
export { FloatingDock, type PanelSpec } from './floating-dock.ts';
export { StatusBadge, type BadgeTone } from './status-badge.ts';
export { Toast } from './toast.ts';
export { FullscreenPrompt, type PromptContent } from './fullscreen-prompt.ts';
export {
  DiagnosticsPanel,
  type DiagnosticLogLike,
  type DiagnosticsPanelText,
} from './diagnostics-panel.ts';
export { safeStorage } from './storage.ts';
