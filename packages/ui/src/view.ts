/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The default camera view: the engine's stage, an exit control (top left), a sound
// control (top right, while scanning), a status line with notices below them, a black cover with "adjusting the view"
// while a view change settles, and at the bottom only the buttons a stopped run or a failed video needs. There is no
// extra "tap to play": a blocked autoplay is a notice, and a tap on the sound control resumes playback. The view
// renders a session's state and calls its methods; it never disposes a session it did not create.

import { createTranslator, type TranslatorOptions } from './messages.ts';
import { STYLE_TEXT } from './styles.ts';
import type { ArNotice, ArSession, ArState } from './types.ts';

export interface ArViewOptions extends TranslatorOptions {
  /** 'fullscreen' (default): fixed to the viewport, page scrolling locked. 'embedded': fills the container you size. */
  readonly mode?: 'fullscreen' | 'embedded';
  /** Called by the exit control; with `exitHref` it is a link and this runs on its activation. */
  readonly onExit?: (event: Event) => void;
  /** Renders the exit control as a link. Fixed at mount. */
  readonly exitHref?: string;
  /** Start once the stage has a size (default true). Otherwise call `start()`, best from a tap. */
  readonly isAutoStart?: boolean;
  /** Stop the run when the page is hidden or left (default true); "Start again" resumes it. */
  readonly isStoppedWhenHidden?: boolean;
  /** CSS variables on the root, e.g. `{ accent: '#c0674a' }` sets `--lm-ar-accent`. */
  readonly theme?: Readonly<Record<string, string>>;
}

export type ArViewUpdate = Pick<
  ArViewOptions,
  'locale' | 'messages' | 'translate' | 'onExit' | 'theme'
>;

export interface ArViewHandle {
  readonly element: HTMLElement;
  /** Changes wording, callbacks or theme in place; never restarts the session or the camera. */
  update(change: ArViewUpdate): void;
  /** Starts a run in this view's stage. */
  start(): void;
  /** Removes this view's nodes, listeners, style and scroll lock. Does not stop or dispose the session. */
  destroy(): void;
}

/** What the view needs of a session. */
export type ArSessionLike = Pick<
  ArSession,
  'getState' | 'subscribe' | 'start' | 'stop' | 'setMuted' | 'retryVideo'
>;

const SOUND_ON =
  '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>';
const SOUND_OFF =
  '<svg class="lm-ar__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27l4.73 4.73H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>';

/** One shared <style> and one scroll lock per document, released with the last view that holds them. */
const styles = new Map<Document, { count: number; element: HTMLElement }>();
const scrollLocks = new Map<Document, { count: number; overflow: string }>();

function acquireStyle(doc: Document): () => void {
  let entry = styles.get(doc);
  if (!entry) {
    const element = doc.createElement('style');
    element.setAttribute('data-livemira-ui', '');
    element.textContent = STYLE_TEXT;
    (doc.head ?? doc.documentElement).appendChild(element);
    entry = { count: 0, element };
    styles.set(doc, entry);
  }
  entry.count += 1;
  const held = entry;
  return () => {
    held.count -= 1;
    if (held.count === 0) {
      held.element.remove();
      styles.delete(doc);
    }
  };
}

function lockScroll(doc: Document): () => void {
  const body = doc.body;
  if (!body) return () => {};
  let entry = scrollLocks.get(doc);
  if (!entry) {
    entry = { count: 0, overflow: body.style.overflow };
    scrollLocks.set(doc, entry);
    body.style.overflow = 'hidden';
  }
  entry.count += 1;
  const held = entry;
  return () => {
    held.count -= 1;
    if (held.count === 0) {
      body.style.overflow = held.overflow;
      scrollLocks.delete(doc);
    }
  };
}

const variableName = (name: string): string =>
  name.startsWith('--') ? name : `--lm-ar-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** The status line of a state; null shows none (a blocked autoplay shows only its notice). */
function statusLine(state: ArState): ArNotice | null {
  if (state.notice?.key === 'notice.autoplayBlocked') return null;
  switch (state.phase) {
    case 'preparing':
      return state.progress
        ? {
            key: 'status.preparingProgress',
            params: {
              done: Math.min(state.progress.done + 1, state.progress.total),
              total: state.progress.total,
            },
          }
        : { key: 'status.preparing' };
    case 'starting':
      return { key: 'status.starting' };
    case 'stopping':
      return { key: 'status.stopping' };
    case 'idle':
      return state.notice ? null : { key: 'status.preparing' };
    default:
  }
  switch (state.view) {
    case 'loading':
      return { key: 'status.loading' };
    case 'playing':
      return { key: 'status.playing' };
    case 'lost':
      return { key: 'status.lost' };
    case 'videoError':
      return { key: 'status.videoError' };
    default:
      return { key: 'status.searching' };
  }
}

export function mountArView(
  container: HTMLElement,
  session: ArSessionLike,
  options: ArViewOptions = {},
): ArViewHandle {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  let settings: ArViewOptions = { ...options };
  let translator = createTranslator(settings);
  let isDestroyed = false;
  let hasStarted = false;

  const element = (tag: string, className: string): HTMLElement => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };

  const root = element('div', 'lm-ar');
  root.classList.add(settings.mode === 'embedded' ? 'lm-ar--embedded' : 'lm-ar--fullscreen');
  root.setAttribute('role', 'region');
  const stage = element('div', 'lm-ar__stage');
  // Opaque cover over the camera and the video while the view settles; exit, sound and buttons stay above it.
  const curtain = element('div', 'lm-ar__curtain');
  const curtainSpinner = element('span', 'lm-ar__spinner');
  const curtainText = element('span', 'lm-ar__curtain-text');
  curtainText.setAttribute('role', 'status');
  curtain.append(curtainSpinner, curtainText);
  curtain.hidden = true;

  const exitIsLink = settings.exitHref !== undefined;
  const exit = element(exitIsLink ? 'a' : 'button', 'lm-ar__exit');
  if (exitIsLink) exit.setAttribute('href', settings.exitHref!);
  else exit.setAttribute('type', 'button');
  exit.textContent = '×';
  exit.addEventListener('click', (event) => settings.onExit?.(event));

  const sound = element('button', 'lm-ar__sound');
  sound.setAttribute('type', 'button');
  // The engine must see the tap in its own call stack: setMuted is called directly in the handler.
  sound.addEventListener('click', () => void session.setMuted(!session.getState().isMuted));

  const hud = element('div', 'lm-ar__hud');
  const status = element('p', 'lm-ar__status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const spinner = element('span', 'lm-ar__spinner');
  const statusText = element('span', 'lm-ar__text');
  status.append(spinner, statusText);
  const noticeLine = element('p', 'lm-ar__status lm-ar__notice');
  noticeLine.setAttribute('role', 'alert');
  const skippedLine = element('p', 'lm-ar__status');
  hud.append(status, noticeLine, skippedLine);

  const controls = element('div', 'lm-ar__controls');
  const button = (key: string, onClick: () => void): HTMLElement => {
    const node = element('button', 'lm-ar__button');
    node.setAttribute('type', 'button');
    node.dataset['label'] = key;
    node.addEventListener('click', onClick);
    return node;
  };
  const restart = button('restart', () => start());
  const reload = button('reloadVideo', () => void session.retryVideo());
  controls.append(restart, reload);

  root.append(stage, curtain, exit, sound, hud, controls);

  const applyTheme = (theme: ArViewOptions['theme']): void => {
    for (const [name, value] of Object.entries(theme ?? {}))
      root.style.setProperty(variableName(name), value);
  };
  applyTheme(settings.theme);

  const render = (): void => {
    if (isDestroyed) return;
    const state = session.getState();
    const t = translator.t;
    const isScanning = state.phase === 'scanning';
    root.setAttribute('aria-label', t('title'));
    root.lang = translator.locale;

    exit.hidden = settings.onExit === undefined && !exitIsLink;
    exit.setAttribute('aria-label', t('exit'));
    exit.setAttribute('title', t('exit'));

    sound.hidden = !isScanning;
    sound.innerHTML = state.isMuted ? SOUND_OFF : SOUND_ON;
    const soundLabel = t(state.isMuted ? 'soundOn' : 'soundOff');
    sound.setAttribute('aria-label', soundLabel);
    sound.setAttribute('title', soundLabel);
    sound.setAttribute('aria-pressed', String(!state.isMuted));

    const isCovered = state.isAdjusting && state.phase !== 'idle' && state.phase !== 'stopping';
    curtain.hidden = !isCovered;
    if (isCovered) curtainText.textContent = t('status.viewport');

    const line = isCovered ? null : statusLine(state);
    status.hidden = line === null;
    if (line) {
      statusText.textContent = t(line.key, line.params);
      spinner.hidden = !(
        state.phase === 'preparing' ||
        state.phase === 'starting' ||
        state.phase === 'stopping' ||
        (isScanning && state.view === 'loading') ||
        (state.phase === 'idle' && !state.notice)
      );
    }
    noticeLine.hidden = state.notice === null;
    noticeLine.textContent = state.notice
      ? (state.notice.text ?? t(state.notice.key, state.notice.params))
      : '';
    skippedLine.hidden = state.skippedCount === 0 || state.phase === 'idle';
    skippedLine.textContent = t('skipped', { count: state.skippedCount });

    restart.hidden = !(state.phase === 'idle' && state.notice !== null && !state.isDisposed);
    reload.hidden = !(isScanning && state.view === 'videoError');
    for (const node of [restart, reload]) node.textContent = t(node.dataset['label']!);
  };

  const start = (): void => {
    if (isDestroyed) return;
    hasStarted = true;
    void session.start(stage);
  };

  // A hidden or left page ends the run with a notice; the engine also ends its session when the page is hidden.
  const onHidden = (reason: string): void => {
    if (settings.isStoppedWhenHidden === false || session.getState().phase === 'idle') return;
    void session.stop({ reason, notice: { key: 'notice.backgrounded' } });
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === 'hidden') onHidden('hidden');
  };
  const onPageHide = (): void => onHidden('pagehide');

  const releaseStyle = acquireStyle(doc);
  const releaseScroll = settings.mode === 'embedded' ? () => {} : lockScroll(doc);
  const unsubscribe = session.subscribe(render);
  doc.addEventListener('visibilitychange', onVisibility);
  win?.addEventListener('pagehide', onPageHide);
  container.appendChild(root);
  render();

  // The engine needs a stage with a size: start once it has one.
  let observer: ResizeObserver | null = null;
  let frame: number | null = null;
  const hasSize = (): boolean => stage.clientWidth > 0 && stage.clientHeight > 0;
  const startWhenSized = (): void => {
    if (isDestroyed || hasStarted) return;
    if (hasSize()) {
      observer?.disconnect();
      observer = null;
      start();
      return;
    }
    if (!observer && win && 'ResizeObserver' in win) {
      observer = new win.ResizeObserver(() => startWhenSized());
      observer.observe(stage);
    } else if (!observer && win) {
      frame = win.requestAnimationFrame(() => {
        frame = null;
        startWhenSized();
      });
    }
  };
  if (settings.isAutoStart !== false) startWhenSized();

  return {
    element: root,
    update(change) {
      if (isDestroyed) return;
      settings = { ...settings, ...change };
      translator = createTranslator(settings);
      if (change.theme) applyTheme(change.theme);
      render();
    },
    start,
    destroy() {
      if (isDestroyed) return;
      isDestroyed = true;
      observer?.disconnect();
      if (frame !== null) win?.cancelAnimationFrame(frame);
      unsubscribe();
      doc.removeEventListener('visibilitychange', onVisibility);
      win?.removeEventListener('pagehide', onPageHide);
      root.remove();
      releaseScroll();
      releaseStyle();
    },
  };
}
