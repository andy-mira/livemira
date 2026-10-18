/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The shell's stylesheet. The page never scrolls; floating controls stay inside the safe area in every orientation.

export const SHELL_CSS = `
html, body { position: fixed; inset: 0; margin: 0; overflow: hidden; overscroll-behavior: none;
  background: #000; color: #f2f2f2; font: 15px/1.4 system-ui, -apple-system, "PingFang SC", sans-serif;
  -webkit-text-size-adjust: 100%; }
.lm-stage { position: fixed; inset: 0; touch-action: none; overflow: hidden; background: #000; }
.lm-float { position: fixed; inset: 0; pointer-events: none; z-index: 10;
  --lm-gap: 12px;
  --lm-top: calc(env(safe-area-inset-top, 0px) + var(--lm-gap));
  --lm-right: calc(env(safe-area-inset-right, 0px) + var(--lm-gap));
  --lm-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--lm-gap));
  --lm-left: calc(env(safe-area-inset-left, 0px) + var(--lm-gap)); }
.lm-float > * { pointer-events: auto; }
.lm-dock { position: absolute; right: var(--lm-right); bottom: var(--lm-bottom); display: flex; flex-direction: column;
  gap: 10px; align-items: flex-end; }
.lm-dock-buttons { display: flex; gap: 10px; }
.lm-dock-button { width: 48px; height: 48px; border-radius: 50%; border: 0; background: rgba(20,20,20,.72);
  color: #fff; font-size: 20px; backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor: pointer; }
.lm-dock-button[aria-expanded="true"] { background: #2f7cf6; }
.lm-panel { box-sizing: border-box; width: min(360px, calc(100vw - var(--lm-gap) * 2 - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: calc(100dvh - var(--lm-top) - var(--lm-bottom) - 70px); overflow: auto; overscroll-behavior: contain;
  background: rgba(20,20,20,.86); border-radius: 14px; padding: 14px; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
.lm-panel h2 { margin: 0 0 10px; font-size: 16px; }
.lm-panel label { display: block; margin: 8px 0; }
.lm-panel select, .lm-panel input[type="url"], .lm-panel input[type="file"] { display: block; width: 100%; margin-top: 4px;
  font-size: 16px; box-sizing: border-box; }
.lm-panel button { font-size: 15px; margin: 4px 6px 4px 0; padding: 8px 12px; border-radius: 8px; border: 0;
  background: #3a3a3c; color: #fff; }
.lm-panel button.lm-primary { background: #2f7cf6; }
.lm-panel button:disabled { opacity: .45; }
.lm-hint { color: #b5b5b5; font-size: 13px; margin: 6px 0; }
.lm-badge { position: absolute; top: var(--lm-top); left: 50%; transform: translateX(-50%); padding: 6px 14px;
  border-radius: 999px; background: rgba(20,20,20,.72); font-size: 14px; white-space: nowrap; pointer-events: none; }
.lm-badge[data-tone="good"] { background: rgba(28,140,70,.85); }
.lm-badge[data-tone="warn"] { background: rgba(190,120,20,.85); }
.lm-badge[data-tone="bad"] { background: rgba(170,40,40,.85); }
.lm-toast { position: absolute; left: 50%; bottom: calc(var(--lm-bottom) + 70px); transform: translateX(-50%);
  max-width: calc(100vw - 48px); padding: 10px 16px; border-radius: 10px; background: rgba(20,20,20,.9);
  font-size: 14px; pointer-events: none; transition: opacity .2s; }
.lm-prompt { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  pointer-events: none; text-align: center; padding: var(--lm-top) var(--lm-right) var(--lm-bottom) var(--lm-left); }
.lm-prompt-card { max-width: 420px; padding: 16px 24px; border-radius: 16px; background: rgba(0,0,0,.45);
  text-shadow: 0 1px 3px rgba(0,0,0,.8); }
.lm-prompt-icon { font-size: 64px; }
.lm-prompt-title { font-size: 26px; font-weight: 600; margin: 12px 0; }
.lm-prompt-text { font-size: 17px; color: #ddd; }
.lm-prompt-progress { margin-top: 16px; font-size: 15px; color: #9cc3ff; }
[hidden] { display: none !important; }
`;
