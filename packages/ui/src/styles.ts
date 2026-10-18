/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The view's style sheet: warm dark controls, terracotta buttons, and a black cover while the view settles. Every rule is scoped under .lm-ar; nothing styles html, body or a bare element. Theme it with the
// CSS variables on .lm-ar (the `theme` option, or the page's own CSS).

export const STYLE_TEXT = `
.lm-ar {
  --lm-ar-bg: #1d1810;
  --lm-ar-fg: #fff8ee;
  --lm-ar-chip-bg: rgba(29, 24, 16, 0.55);
  --lm-ar-notice-bg: rgba(164, 55, 43, 0.85);
  --lm-ar-accent: #c0674a;
  --lm-ar-accent-hover: #a4533a;
  --lm-ar-accent-fg: #fff8ee;
  --lm-ar-focus: #fff8ee;
  --lm-ar-font: inherit;
  --lm-ar-radius: 16px;
  --lm-ar-control-radius: 22px;
  --lm-ar-button-radius: 999px;
  --lm-ar-z: 20;
  position: relative; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box;
  background: var(--lm-ar-bg); color: var(--lm-ar-fg); font-family: var(--lm-ar-font); line-height: 1.4;
  overscroll-behavior: none; touch-action: none;
}
.lm-ar *, .lm-ar *::before, .lm-ar *::after { box-sizing: border-box; }
.lm-ar[hidden], .lm-ar [hidden] { display: none; }

/* Full screen: fixed to the dynamic viewport, never scrolls, controls stay inside the safe areas. */
.lm-ar--fullscreen { position: fixed; inset: 0; width: auto; height: 100vh; height: 100dvh; z-index: var(--lm-ar-z); }
.lm-ar--embedded { position: relative; }

/* The layers get their own stacking contexts so nothing inside the camera or the AR layer can paint over the curtain. */
.lm-ar__stage { position: absolute; inset: 0; z-index: 0; }
/* Pure black on purpose (not the theme background): it matches the camera's own mask while the view is rotating. */
.lm-ar__curtain {
  position: absolute; inset: 0; z-index: 1; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--lm-ar-curtain, #000); color: var(--lm-ar-fg); font-size: 14px;
}

.lm-ar__exit, .lm-ar__sound {
  position: absolute; z-index: 3; top: calc(10px + env(safe-area-inset-top)); display: grid; place-items: center;
  min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: var(--lm-ar-control-radius);
  background: var(--lm-ar-chip-bg); color: var(--lm-ar-fg); font: inherit; text-decoration: none; cursor: pointer;
}
.lm-ar__exit { left: calc(10px + env(safe-area-inset-left)); font-size: 28px; line-height: 1; }
.lm-ar__sound { right: calc(10px + env(safe-area-inset-right)); width: 44px; }
.lm-ar__exit:focus-visible, .lm-ar__sound:focus-visible, .lm-ar__button:focus-visible { outline: 2px solid var(--lm-ar-focus); outline-offset: 2px; }
.lm-ar__icon { display: block; width: 20px; height: 20px; fill: currentColor; }

.lm-ar__hud {
  /* A separate row below the 44px exit/sound row (10px + 44px + 8px), so the status can never collide with them. */
  position: absolute; z-index: 2; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right)); top: calc(62px + env(safe-area-inset-top));
  display: grid; justify-items: center; gap: 6px; pointer-events: none;
}
.lm-ar__status {
  display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 6px 12px; max-width: 100%; border-radius: var(--lm-ar-radius);
  background: var(--lm-ar-chip-bg); font-size: 13px; line-height: 1.4; text-align: center; overflow-wrap: anywhere;
}
.lm-ar__notice { background: var(--lm-ar-notice-bg); }
.lm-ar__spinner {
  display: inline-block; flex: none; width: 16px; height: 16px; border: 2px solid rgba(255, 248, 238, 0.35); border-top-color: var(--lm-ar-fg);
  border-radius: 50%; animation: lm-ar-spin 0.8s linear infinite;
}
@keyframes lm-ar-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .lm-ar__spinner { animation-duration: 2s; } }

.lm-ar__controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  padding: 12px calc(12px + env(safe-area-inset-right)) calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
}
.lm-ar__button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 36px; margin: 0; padding: 0 16px; border: 1px solid transparent;
  border-radius: var(--lm-ar-button-radius); background: var(--lm-ar-accent); color: var(--lm-ar-accent-fg); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
}
.lm-ar__button:hover { background: var(--lm-ar-accent-hover); }
`;
