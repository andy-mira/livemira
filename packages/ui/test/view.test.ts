/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTranslator,
  mountArCamera,
  mountArView,
  resolveLocale,
  type ArSessionLike,
  type ArState,
} from '@livemira/ui';

import { fakeContainer, fakeModule, settle, type FakeElement } from './fakes.ts';

const BASE: ArState = {
  phase: 'idle',
  view: 'searching',
  progress: null,
  notice: null,
  isMuted: true,
  isAdjusting: false,
  isPlaybackBlocked: false,
  isStale: false,
  skippedCount: 0,
  activeTargetId: null,
  isDisposed: false,
};

/** A controlled session: the test sets the state; calls are recorded. */
function controlledSession() {
  let state = BASE;
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const starts: unknown[] = [];
  const session: ArSessionLike = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async start(stage) {
      starts.push(stage);
    },
    async stop(options) {
      calls.push(`stop:${options?.reason ?? ''}:${options?.notice?.key ?? ''}`);
    },
    setMuted(isMuted) {
      calls.push(`setMuted:${isMuted}`);
      return Promise.resolve(true);
    },
    async retryVideo() {
      calls.push('retryVideo');
    },
  };
  const set = (change: Partial<ArState>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  return { session, set, calls, starts, listeners };
}

const asElement = (node: unknown): HTMLElement => node as HTMLElement;
const text = (node: FakeElement | null): string | null =>
  node && !node.hidden ? node.textContent : null;

function mount(options: Parameters<typeof mountArView>[2] = {}) {
  const { doc, container } = fakeContainer();
  const controlled = controlledSession();
  const view = mountArView(asElement(container), controlled.session, options);
  const root = container.children[0]!;
  return { doc, container, root, view, ...controlled };
}

test('the view mounts one root with the stage and starts once the stage has a size', () => {
  const { doc, root, starts } = mount();
  assert.ok(root.classList.contains('lm-ar--fullscreen'));
  assert.equal(starts.length, 1);
  assert.equal(starts[0], root.find('lm-ar__stage'));
  assert.equal(doc.head.children.filter((n) => n.tagName === 'style').length, 1);
  assert.equal(doc.body.style.overflow, 'hidden');
});

test('without a size the view waits; without auto start it never starts by itself', () => {
  const { doc, container } = fakeContainer(0, 0);
  const controlled = controlledSession();
  mountArView(asElement(container), controlled.session);
  doc.runFrames();
  assert.equal(controlled.starts.length, 0);
  container.find('lm-ar__stage')!.clientWidth = 300;
  container.find('lm-ar__stage')!.clientHeight = 500;
  doc.runFrames();
  assert.equal(controlled.starts.length, 1);

  const manual = mount({ isAutoStart: false });
  assert.equal(manual.starts.length, 0);
  manual.view.start();
  assert.equal(manual.starts.length, 1);
});

test('the status line follows the state', () => {
  const { root, set } = mount();
  const status = (): string | null =>
    root.find('lm-ar__status')!.hidden ? null : root.find('lm-ar__text')!.textContent;
  assert.equal(status(), '正在准备…', 'before the first run');
  set({ phase: 'preparing', progress: { done: 1, total: 3 } });
  assert.equal(status(), '正在准备照片（2/3）…', 'the photo being prepared');
  set({ phase: 'scanning', progress: null, view: 'searching' });
  assert.equal(status(), '请把相机对准要识别的照片。');
  set({ view: 'loading', activeTargetId: 'a' });
  assert.equal(status(), '找到照片了，正在加载视频…');
  set({ view: 'playing' });
  assert.equal(status(), '正在播放');
  set({ phase: 'idle', notice: { key: 'notice.cameraInterrupted' } });
  assert.equal(root.find('lm-ar__status')!.hidden, true, 'a stopped run shows only its notice');
});

test('a locale change re-renders in place, and host messages and translate win', () => {
  const { root, set, view, starts } = mount({
    messages: { 'zh-CN': { 'host.expired': '链接已过期' } },
  });
  set({ phase: 'idle', notice: { key: 'host.expired' } });
  assert.equal(text(root.find('lm-ar__notice')), '链接已过期');
  view.update({ locale: 'en-US', messages: { en: { 'host.expired': 'Link expired' } } });
  assert.equal(text(root.find('lm-ar__notice')), 'Link expired');
  view.update({ translate: (key) => (key === 'host.expired' ? 'Own text' : undefined) });
  assert.equal(text(root.find('lm-ar__notice')), 'Own text');
  set({ notice: { key: 'any', text: 'Literal' } });
  assert.equal(text(root.find('lm-ar__notice')), 'Literal');
  assert.equal(root.lang, 'en');
  assert.equal(starts.length, 1, 'never restarted');
});

test('buttons appear only when their state needs them and call the session', () => {
  const { root, set, calls, starts } = mount();
  const buttons = (): Record<string, FakeElement> =>
    Object.fromEntries(root.findAll('lm-ar__button').map((b) => [b.dataset['label']!, b]));
  const visible = (): string[] =>
    Object.entries(buttons())
      .filter(([, b]) => !b.hidden)
      .map(([k]) => k);
  set({ phase: 'scanning', view: 'searching' });
  assert.deepEqual(visible(), []);
  set({ view: 'videoError' });
  assert.deepEqual(visible(), ['reloadVideo']);
  assert.equal(buttons()['reloadVideo']!.textContent, '重新加载视频');
  buttons()['reloadVideo']!.click();
  assert.deepEqual(calls, ['retryVideo']);
  set({ view: 'loading', isPlaybackBlocked: true, notice: { key: 'notice.autoplayBlocked' } });
  assert.deepEqual(visible(), [], 'no extra "tap to play": a blocked autoplay is only a notice');
  assert.equal(root.find('lm-ar__status')!.hidden, true, 'the notice replaces the status line');
  assert.equal(text(root.find('lm-ar__notice')), '浏览器阻止了视频自动播放。');
  set({ phase: 'idle', isPlaybackBlocked: false, notice: null });
  assert.deepEqual(visible(), [], 'a stop without a notice offers nothing to restart');
  set({ notice: { key: 'notice.cameraInterrupted' } });
  assert.deepEqual(visible(), ['restart']);
  buttons()['restart']!.click();
  assert.equal(starts.length, 2);
});

test('a view change covers camera and video with a black curtain and its own text; the status line steps aside', () => {
  const { root, set } = mount();
  set({ phase: 'scanning', view: 'playing', isAdjusting: true });
  const curtain = root.find('lm-ar__curtain')!;
  assert.equal(curtain.hidden, false);
  assert.equal(curtain.find('lm-ar__curtain-text')!.textContent, '正在调整画面…');
  assert.equal(root.find('lm-ar__status')!.hidden, true);
  assert.equal(root.find('lm-ar__sound')!.hidden, false, 'the controls stay above the curtain');
  set({ isAdjusting: false });
  assert.equal(curtain.hidden, true);
  assert.equal(root.find('lm-ar__text')!.textContent, '正在播放');
});

test('a hidden or left page stops the run with the background notice', () => {
  const { doc, set, calls } = mount();
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  assert.deepEqual(calls, [], 'nothing runs yet');
  set({ phase: 'scanning' });
  doc.fire('visibilitychange');
  doc.fire('pagehide', true);
  assert.deepEqual(calls, ['stop:hidden:notice.backgrounded', 'stop:pagehide:notice.backgrounded']);
  const manual = mount({ isStoppedWhenHidden: false });
  manual.set({ phase: 'scanning' });
  manual.doc.fire('pagehide', true);
  assert.deepEqual(manual.calls, []);
});

test('the sound control shows while scanning and calls the session in the tap', () => {
  const { root, set, calls } = mount();
  const sound = root.find('lm-ar__sound')!;
  assert.equal(sound.hidden, true);
  set({ phase: 'scanning' });
  assert.equal(sound.hidden, false);
  assert.equal(sound.getAttribute('aria-label'), '开启声音');
  sound.click();
  assert.deepEqual(calls, ['setMuted:false']);
  set({ isMuted: false });
  assert.equal(sound.getAttribute('aria-label'), '关闭声音');
  assert.equal(sound.getAttribute('aria-pressed'), 'true');
});

test('the exit control is a link with exitHref, a button with onExit, and absent otherwise', () => {
  const exits: unknown[] = [];
  const link = mount({ exitHref: '/creator', onExit: (event) => exits.push(event) });
  const exit = link.root.find('lm-ar__exit')!;
  assert.equal(exit.tagName, 'a');
  assert.equal(exit.getAttribute('href'), '/creator');
  assert.equal(exit.getAttribute('aria-label'), '关闭相机');
  exit.click();
  assert.equal(exits.length, 1);
  assert.equal(mount().root.find('lm-ar__exit')!.hidden, true);
  assert.equal(mount({ onExit: () => {} }).root.find('lm-ar__exit')!.tagName, 'button');
});

test('destroy removes the view, its listener, the shared style with the last view and the scroll lock', () => {
  const { doc, container } = fakeContainer();
  doc.body.style.overflow = 'auto';
  const first = controlledSession();
  const second = controlledSession();
  const a = mountArView(asElement(container), first.session);
  const b = mountArView(asElement(container), second.session, { mode: 'embedded' });
  assert.equal(doc.head.children.length, 1);
  a.destroy();
  a.destroy();
  assert.equal(first.listeners.size, 0);
  assert.equal(doc.body.style.overflow, 'auto', 'the only fullscreen view restored the page');
  assert.equal(doc.head.children.length, 1, 'the style stays while a view uses it');
  b.destroy();
  assert.equal(doc.head.children.length, 0);
  assert.equal(container.children.length, 0);
});

test('mountArCamera owns its session: destroy removes the view and then disposes the engine', async () => {
  const { container } = fakeContainer();
  const fake = fakeModule();
  const camera = mountArCamera(asElement(container), {
    loadEngine: () => fake.module,
    targets: [{ id: 'a', photo: new Blob(['p']), video: new Blob(['v']) }],
  });
  await settle();
  await settle();
  assert.equal(camera.session.getState().phase, 'scanning');
  await Promise.all([camera.destroy(), camera.destroy()]);
  assert.equal(container.children.length, 0);
  assert.equal(fake.engines[0]!.state, 'disposed');
  assert.equal(camera.session.getState().isDisposed, true);
});

test('locales resolve to Chinese or English, with Chinese for anything else', () => {
  assert.equal(resolveLocale('en-GB'), 'en');
  assert.equal(resolveLocale('zh-TW'), 'zh-CN');
  assert.equal(resolveLocale('fr'), 'zh-CN');
  assert.equal(resolveLocale(undefined), 'zh-CN');
  assert.equal(createTranslator({ locale: 'en' }).t('missing.key'), 'missing.key');
  const english = createTranslator({ locale: 'en' });
  assert.equal(
    english.t('skipped', { count: 1 }),
    '1 photo is not suitable for scanning and was skipped.',
  );
  assert.equal(
    english.t('skipped', { count: 2 }),
    '2 photos are not suitable for scanning and were skipped.',
  );
  assert.equal(createTranslator().t('skipped', { count: 2 }), '有 2 张照片不适合扫描，已跳过。');
  assert.equal(
    createTranslator().t('notice.tooMany', { max: 10 }),
    '一次最多扫描 10 组照片与视频。',
  );
});
