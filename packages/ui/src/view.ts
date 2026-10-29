// SPDX-License-Identifier: Apache-2.0
// The default full-screen camera view. Layout and wording follow the LiveMorae camera (exit top left, sound top right
// while scanning, status below them, actions at the bottom only when needed); the loader shows real progress (engine,
// photos, camera) and stays translucent once the camera picture is there; a scanning guide shows where to aim.
// Everything is derived from the session state; the view keeps no state of its own besides its DOM.

import type { ArSessionLike, ArState, ArViewHandle, ArViewOptions, ArViewUpdate, Translator } from './api.ts';
import { STYLE_TEXT } from './styles.ts';
import { createTranslator } from './translator.ts';

const SOUND_ON =
  '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const SOUND_OFF =
  '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';
const RING_LENGTH = 2 * Math.PI * 42;

const styles = new Map<Document, { element: HTMLStyleElement; count: number }>();
const scrollLocks = new Map<Document, { count: number; html: string; body: string }>();

function acquireStyle(doc: Document): () => void {
  let entry = styles.get(doc);
  if (!entry) {
    const element = doc.createElement('style');
    element.setAttribute('data-livemira-ui', '');
    element.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement).append(element);
    styles.set(doc, (entry = { element, count: 0 }));
  }
  entry.count++;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.count === 0) {
      held.element.remove();
      styles.delete(doc);
    }
  };
}

function lockScroll(doc: Document): () => void {
  let entry = scrollLocks.get(doc);
  if (!entry) {
    entry = { count: 0, html: doc.documentElement.style.overflow, body: doc.body?.style.overflow ?? '' };
    doc.documentElement.style.overflow = 'hidden';
    if (doc.body) doc.body.style.overflow = 'hidden';
    scrollLocks.set(doc, entry);
  }
  entry.count++;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.count === 0) {
      doc.documentElement.style.overflow = held.html;
      if (doc.body) doc.body.style.overflow = held.body;
      scrollLocks.delete(doc);
    }
  };
}

const el = <K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] => {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
};

export function mountArView(container: HTMLElement, session: ArSessionLike, options: ArViewOptions = {}): ArViewHandle {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let current: ArViewOptions = { ...options };
  let t: Translator = createTranslator(current);
  const releaseStyle = acquireStyle(doc);
  const mode = current.mode ?? 'fullscreen';
  const releaseScroll = mode === 'fullscreen' ? lockScroll(doc) : () => {};

  const root = el(doc, 'div', `lm-ar lm-ar--${mode}`);
  const stage = el(doc, 'div', 'lm-ar__stage');
  const guide = el(doc, 'div', 'lm-ar__guide');
  guide.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 4; i++) guide.append(el(doc, 'span', 'lm-ar__corner'));
  guide.append(el(doc, 'span', 'lm-ar__sweep'));

  const loader = el(doc, 'div', 'lm-ar__loader');
  loader.setAttribute('role', 'progressbar');
  loader.setAttribute('aria-valuemin', '0');
  loader.setAttribute('aria-valuemax', '100');
  const ring = el(doc, 'div', 'lm-ar__ring');
  ring.innerHTML =
    `<svg viewBox="0 0 96 96" aria-hidden="true"><circle class="lm-ar__ring-track" cx="48" cy="48" r="42"/>` +
    `<circle class="lm-ar__ring-glow" cx="48" cy="48" r="42" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"/>` +
    `<circle class="lm-ar__ring-bar" cx="48" cy="48" r="42" stroke-dasharray="${RING_LENGTH}" stroke-dashoffset="${RING_LENGTH}"/></svg>`;
  const percent = el(doc, 'span', 'lm-ar__percent');
  ring.append(percent);
  const step = el(doc, 'p', 'lm-ar__step');
  const hint = el(doc, 'p', 'lm-ar__hint');
  loader.append(ring, step, hint);

  const curtain = el(doc, 'div', 'lm-ar__curtain');
  curtain.setAttribute('role', 'status');
  const curtainText = el(doc, 'span', '');
  curtain.append(el(doc, 'span', 'lm-ar__spinner'), curtainText);

  const exit = current.exitHref ? el(doc, 'a', 'lm-ar__exit') : el(doc, 'button', 'lm-ar__exit');
  if (exit instanceof HTMLAnchorElement) exit.href = current.exitHref!;
  else exit.type = 'button';
  exit.textContent = '×';
  const sound = el(doc, 'button', 'lm-ar__sound');
  sound.type = 'button';

  const hud = el(doc, 'div', 'lm-ar__hud');
  const status = el(doc, 'p', 'lm-ar__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const notice = el(doc, 'p', 'lm-ar__status lm-ar__notice');
  notice.setAttribute('role', 'alert');
  const info = el(doc, 'p', 'lm-ar__status');
  hud.append(status, notice, info);

  const controls = el(doc, 'div', 'lm-ar__controls');
  const restart = el(doc, 'button', 'lm-ar__button');
  restart.type = 'button';
  const reload = el(doc, 'button', 'lm-ar__button');
  reload.type = 'button';
  controls.append(restart, reload);

  root.append(stage, guide, loader, curtain, exit, sound, hud, controls);
  container.append(root);

  const applyTheme = (): void => {
    for (const [name, value] of Object.entries(current.theme ?? {})) root.style.setProperty(`--lm-ar-${name}`, value);
  };
  applyTheme();

  // ---- Actions ----
  let started = false;
  const start = (): void => {
    started = true;
    void session.start(stage);
  };
  restart.addEventListener('click', start);
  reload.addEventListener('click', () => void session.retryVideo());
  sound.addEventListener('click', () => void session.setMuted(!session.getState().isMuted));
  exit.addEventListener('click', (event) => current.onExit?.(event));

  // ---- Rendering ----
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActive: string | null = null;

  const setText = (node: HTMLElement, text: string | null, spinner = false, dot = false): void => {
    node.hidden = !text;
    if (!text) return;
    const key = `${spinner}|${dot}|${text}`;
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.textContent = '';
    if (spinner) node.append(el(doc, 'span', 'lm-ar__spinner'));
    if (dot) node.append(el(doc, 'span', 'lm-ar__dot'));
    node.append(doc.createTextNode(text));
  };

  const render = (): void => {
    const s: ArState = session.getState();
    root.dataset.phase = s.phase;
    root.dataset.view = s.view;
    const preparing = s.phase === 'preparing' || s.phase === 'starting';
    const scanning = s.phase === 'scanning';

    // Loader.
    if (preparing) {
      if (leaveTimer) clearTimeout(leaveTimer);
      leaveTimer = null;
      loader.hidden = false;
      loader.classList.remove('lm-ar__loader--leaving');
      loader.classList.toggle('lm-ar__loader--camera', s.isCameraOn);
      const value = Math.round(100 * (s.readiness ?? 0));
      percent.textContent = `${value}%`;
      loader.setAttribute('aria-valuenow', String(value));
      const offset = String(RING_LENGTH * (1 - (s.readiness ?? 0)));
      for (const bar of loader.querySelectorAll('circle:not(.lm-ar__ring-track)'))
        bar.setAttribute('stroke-dashoffset', offset);
      const p = s.progress;
      step.textContent =
        (s.readiness ?? 0) < 0.1
          ? t.t('loader.engine')
          : p && p.done < p.total
            ? t.t('loader.photos', { done: p.done, total: p.total })
            : t.t('loader.camera');
      loader.setAttribute('aria-label', step.textContent);
      hint.textContent = t.t('loader.hint');
      hint.hidden = s.isCameraOn;
    } else if (!loader.hidden && !leaveTimer) {
      if (scanning) {
        // Fade out to the camera; gone after the transition.
        percent.textContent = '100%';
        for (const bar of loader.querySelectorAll('circle:not(.lm-ar__ring-track)'))
          bar.setAttribute('stroke-dashoffset', '0');
        loader.classList.add('lm-ar__loader--leaving');
        leaveTimer = setTimeout(() => {
          leaveTimer = null;
          loader.hidden = true;
        }, 480);
      } else loader.hidden = true;
    }

    // Guide: while scanning with nothing recognised.
    guide.classList.toggle('lm-ar__guide--on', scanning && !s.activeTargetId && !s.isAdjusting);

    // Curtain.
    curtain.hidden = !(scanning && s.isAdjusting);
    curtainText.textContent = t.t('status.viewport');

    // Status line.
    let statusText: string | null = null;
    let spinner = false;
    let dot = false;
    if (s.phase === 'stopping') {
      statusText = t.t('status.stopping');
      spinner = true;
    } else if (scanning && !s.isAdjusting) {
      if (s.isPlaybackBlocked) statusText = t.t('status.blocked');
      else if (s.view === 'searching') statusText = t.t('status.searching');
      else if (s.view === 'lost') statusText = t.t('status.lost');
      else if (s.view === 'videoError') statusText = t.t('status.videoError');
      else if (s.view === 'playing') {
        statusText = t.t('status.playing');
        dot = true;
      } else {
        const progress = s.videoProgress;
        statusText =
          progress !== null && Number.isFinite(progress)
            ? t.t('status.loadingProgress', { percent: Math.round(progress * 100) })
            : t.t('status.loading');
        spinner = true;
      }
    }
    setText(status, statusText, spinner, dot);
    setText(notice, s.notice ? (s.notice.text ?? t.t(s.notice.key, s.notice.params)) : null);
    setText(info, scanning && s.skippedCount > 0 ? t.t('skipped', { count: s.skippedCount }) : null);

    // Controls.
    exit.hidden = !current.onExit && !current.exitHref;
    exit.setAttribute('aria-label', t.t('exit'));
    sound.hidden = !scanning;
    if (sound.dataset.muted !== String(s.isMuted)) {
      sound.dataset.muted = String(s.isMuted);
      sound.innerHTML = s.isMuted ? SOUND_OFF : SOUND_ON;
    }
    sound.setAttribute('aria-label', t.t(s.isMuted ? 'soundOn' : 'soundOff'));
    sound.setAttribute('aria-pressed', String(!s.isMuted));
    sound.classList.toggle('lm-ar__sound--attention', s.isPlaybackBlocked);
    // Starting again cannot help a device that lacks what the engine needs.
    const isFinal = s.notice?.key === 'notice.unsupported' || s.notice?.key === 'notice.insecure';
    restart.hidden = !(s.phase === 'idle' && started && !s.isDisposed && !isFinal);
    restart.textContent = t.t('restart');
    reload.hidden = !(scanning && s.view === 'videoError');
    reload.textContent = t.t('reloadVideo');

    // A short tick when a photo is recognised.
    if (s.activeTargetId && s.activeTargetId !== lastActive && current.isHapticEnabled !== false)
      try {
        (win?.navigator as Navigator | undefined)?.vibrate?.(12);
      } catch {
        // No vibration here.
      }
    lastActive = s.activeTargetId;
  };

  const unsubscribe = session.subscribe(render);
  render();

  // ---- Automatic start, and stop when hidden ----
  let observer: ResizeObserver | null = null;
  if (current.isAutoStart !== false) {
    const tryStart = (): void => {
      if (started || stage.clientWidth === 0 || stage.clientHeight === 0) return;
      observer?.disconnect();
      observer = null;
      start();
    };
    observer = new ResizeObserver(tryStart);
    observer.observe(stage);
    tryStart();
  }
  const onHidden = (): void => {
    if (current.isStoppedWhenHidden === false) return;
    const phase = session.getState().phase;
    if (phase === 'idle' || phase === 'stopping') return;
    void session.stop({ reason: 'page-hidden', notice: { key: 'notice.backgrounded' } });
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onHidden();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onHidden);

  let destroyed = false;
  return {
    element: root,
    update(change: ArViewUpdate) {
      if (destroyed) return;
      current = { ...current, ...change };
      t = createTranslator(current);
      applyTheme();
      render();
    },
    start() {
      if (!destroyed) start();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (leaveTimer) clearTimeout(leaveTimer);
      observer?.disconnect();
      unsubscribe();
      doc.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('pagehide', onHidden);
      root.remove();
      releaseScroll();
      releaseStyle();
    },
  };
}
