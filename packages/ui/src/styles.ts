// SPDX-License-Identifier: Apache-2.0
// The default view's style sheet, scoped to `.lm-ar`. Colours and wording follow the LiveMorae camera.

export const STYLE_TEXT = `
.lm-ar {
  --lm-ar-bg: #1d1810;
  --lm-ar-fg: #fff8ee;
  --lm-ar-muted: rgba(255, 248, 238, 0.68);
  --lm-ar-chip-bg: rgba(29, 24, 16, 0.58);
  --lm-ar-notice-bg: rgba(164, 55, 43, 0.88);
  --lm-ar-accent: #c0674a;
  --lm-ar-accent-hover: #a4533a;
  --lm-ar-accent-fg: #fff8ee;
  --lm-ar-focus: #fff8ee;
  --lm-ar-guide: rgba(255, 248, 238, 0.92);
  --lm-ar-font: inherit;
  --lm-ar-radius: 16px;
  --lm-ar-control-radius: 22px;
  --lm-ar-button-radius: 999px;
  --lm-ar-z: 20;
  position: relative; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box;
  background: var(--lm-ar-bg); color: var(--lm-ar-fg); font-family: var(--lm-ar-font); line-height: 1.4;
  overscroll-behavior: none; touch-action: none; -webkit-tap-highlight-color: transparent;
  -webkit-user-select: none; user-select: none;
}
.lm-ar *, .lm-ar *::before, .lm-ar *::after { box-sizing: border-box; }
.lm-ar[hidden], .lm-ar [hidden] { display: none !important; }
.lm-ar--fullscreen { position: fixed; inset: 0; width: auto; height: 100vh; height: 100dvh; z-index: var(--lm-ar-z); }
.lm-ar--embedded { position: relative; }

/* Layers, bottom to top: camera stage, scanning guide, loader, curtain, controls. */
.lm-ar__stage { position: absolute; inset: 0; z-index: 0; }

/* Scanning guide: four corners breathing around the spot to aim at, with a soft light sweeping down. */
.lm-ar__guide {
  position: absolute; z-index: 1; left: 50%; top: 50%; width: min(70vmin, 360px); aspect-ratio: 4 / 3;
  transform: translate(-50%, -50%); pointer-events: none;
  opacity: 0; transition: opacity 0.35s ease, transform 0.35s ease;
}
.lm-ar__guide--on { opacity: 1; animation: lm-ar-breathe 2.8s ease-in-out infinite; }
.lm-ar__corner { position: absolute; width: 18%; aspect-ratio: 1; border: 0 solid var(--lm-ar-guide); filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.45)); }
.lm-ar__corner:nth-child(1) { left: 0; top: 0; border-left-width: 3px; border-top-width: 3px; border-top-left-radius: 14px; }
.lm-ar__corner:nth-child(2) { right: 0; top: 0; border-right-width: 3px; border-top-width: 3px; border-top-right-radius: 14px; }
.lm-ar__corner:nth-child(3) { right: 0; bottom: 0; border-right-width: 3px; border-bottom-width: 3px; border-bottom-right-radius: 14px; }
.lm-ar__corner:nth-child(4) { left: 0; bottom: 0; border-left-width: 3px; border-bottom-width: 3px; border-bottom-left-radius: 14px; }
.lm-ar__sweep {
  position: absolute; left: 6%; right: 6%; top: 0; height: 22%; border-radius: 50%;
  background: radial-gradient(ellipse at 50% 100%, rgba(255, 248, 238, 0.34), rgba(192, 103, 74, 0.12) 45%, transparent 70%);
  animation: lm-ar-sweep 2.6s cubic-bezier(0.45, 0, 0.55, 1) infinite;
}
@keyframes lm-ar-breathe { 0%, 100% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(1.035); } }
@keyframes lm-ar-sweep { 0% { transform: translateY(-10%); opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translateY(360%); opacity: 0; } }

/* Loader: a progress ring with the percentage, the current step and a hint. Opaque until the camera shows. */
.lm-ar__loader {
  position: absolute; inset: 0; z-index: 2; display: grid; place-content: center; justify-items: center; gap: 14px;
  padding: 24px; text-align: center; background: var(--lm-ar-bg); transition: opacity 0.45s ease, background-color 0.45s ease;
}
.lm-ar__loader--camera { background: radial-gradient(ellipse at center, rgba(29, 24, 16, 0.78), rgba(29, 24, 16, 0.5)); }
.lm-ar__loader--leaving { opacity: 0; pointer-events: none; }
.lm-ar__ring { position: relative; width: 96px; height: 96px; }
.lm-ar__ring svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.lm-ar__ring-track { fill: none; stroke: rgba(255, 248, 238, 0.16); stroke-width: 5; }
.lm-ar__ring-bar { fill: none; stroke: var(--lm-ar-accent); stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.4s ease; }
.lm-ar__ring-glow { fill: none; stroke: var(--lm-ar-accent); stroke-width: 9; opacity: 0.25; filter: blur(4px); transition: stroke-dashoffset 0.4s ease; }
.lm-ar__percent {
  position: absolute; inset: 0; display: grid; place-items: center; font-size: 20px; font-weight: 600;
  font-variant-numeric: tabular-nums; letter-spacing: 0.02em;
}
.lm-ar__step { margin: 0; font-size: 15px; font-weight: 600; }
.lm-ar__hint { margin: 0; font-size: 13px; color: var(--lm-ar-muted); }

/* Curtain while the view changes shape: pure black, like the camera's own mask. */
.lm-ar__curtain {
  position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--lm-ar-curtain, #000); color: var(--lm-ar-fg); font-size: 14px;
}

.lm-ar__exit, .lm-ar__sound {
  position: absolute; z-index: 5; top: calc(10px + env(safe-area-inset-top)); display: grid; place-items: center;
  min-width: 44px; min-height: 44px; margin: 0; padding: 0; border: 0; border-radius: var(--lm-ar-control-radius);
  background: var(--lm-ar-chip-bg); color: var(--lm-ar-fg); font: inherit; text-decoration: none; cursor: pointer;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); transition: transform 0.15s ease, background-color 0.2s ease;
}
.lm-ar__exit:active, .lm-ar__sound:active { transform: scale(0.94); }
.lm-ar__exit { left: calc(10px + env(safe-area-inset-left)); font-size: 28px; line-height: 1; }
.lm-ar__sound { right: calc(10px + env(safe-area-inset-right)); width: 44px; }
.lm-ar__sound--attention { background: var(--lm-ar-accent); animation: lm-ar-pulse 1.4s ease-in-out infinite; }
@keyframes lm-ar-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(192, 103, 74, 0.55); } 50% { box-shadow: 0 0 0 10px rgba(192, 103, 74, 0); } }
.lm-ar__exit:focus-visible, .lm-ar__sound:focus-visible, .lm-ar__button:focus-visible { outline: 2px solid var(--lm-ar-focus); outline-offset: 2px; }
.lm-ar__icon { display: block; width: 20px; height: 20px; fill: currentColor; }

.lm-ar__hud {
  /* A row below the 44px exit/sound row, so the status never collides with them. */
  position: absolute; z-index: 4; left: calc(12px + env(safe-area-inset-left)); right: calc(12px + env(safe-area-inset-right));
  top: calc(62px + env(safe-area-inset-top)); display: grid; justify-items: center; gap: 6px; pointer-events: none;
}
.lm-ar__status {
  display: inline-flex; align-items: center; gap: 8px; margin: 0; padding: 7px 14px; max-width: 100%; border-radius: var(--lm-ar-radius);
  background: var(--lm-ar-chip-bg); font-size: 13px; line-height: 1.4; text-align: center; overflow-wrap: anywhere;
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); animation: lm-ar-in 0.25s ease;
}
.lm-ar__notice { background: var(--lm-ar-notice-bg); }
@keyframes lm-ar-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.lm-ar__spinner {
  display: inline-block; flex: none; width: 16px; height: 16px; border: 2px solid rgba(255, 248, 238, 0.3); border-top-color: var(--lm-ar-fg);
  border-radius: 50%; animation: lm-ar-spin 0.8s linear infinite;
}
.lm-ar__dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: #7ccf8a; box-shadow: 0 0 8px #7ccf8a; }
@keyframes lm-ar-spin { to { transform: rotate(360deg); } }

.lm-ar__controls {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 4; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
  padding: 12px calc(12px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
}
.lm-ar__button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 40px; margin: 0; padding: 0 20px; border: 1px solid transparent;
  border-radius: var(--lm-ar-button-radius); background: var(--lm-ar-accent); color: var(--lm-ar-accent-fg); font: inherit; font-size: 15px;
  font-weight: 600; cursor: pointer; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28); transition: transform 0.15s ease, background-color 0.2s ease;
}
.lm-ar__button:hover { background: var(--lm-ar-accent-hover); }
.lm-ar__button:active { transform: scale(0.97); }

@media (prefers-reduced-motion: reduce) {
  .lm-ar__guide--on, .lm-ar__sweep, .lm-ar__sound--attention, .lm-ar__status { animation: none; }
  .lm-ar__sweep { display: none; }
  .lm-ar__spinner { animation-duration: 2s; }
  .lm-ar__loader, .lm-ar__guide, .lm-ar__ring-bar, .lm-ar__ring-glow { transition: none; }
}
`;
