// SPDX-License-Identifier: Apache-2.0
// The default view against a minimal DOM: the language control and the sound control.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ArSessionLike, ArState, ArViewOptions } from '../src/api.ts';
import { mountArView } from '../src/view.ts';

class FakeNode {
  parent: FakeElement | null = null;
  text: string;
  constructor(text = '') {
    this.text = text;
  }
  get textContent(): string {
    return this.text;
  }
}

class FakeElement extends FakeNode {
  children: FakeNode[] = [];
  className = '';
  hidden = false;
  lang = '';
  type = '';
  href = '';
  innerHTML = '';
  clientWidth = 320;
  clientHeight = 480;
  dataset: Record<string, string> = {};
  style = { overflow: '', setProperty() {} };
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: unknown) => void>>();
  classList = {
    add: (name: string) => this.classList.toggle(name, true),
    remove: (name: string) => this.classList.toggle(name, false),
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (name: string, on: boolean) => {
      const names = this.className.split(' ').filter((n) => n && n !== name);
      this.className = (on ? [...names, name] : names).join(' ');
    },
  };
  tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  override get textContent(): string {
    return this.children.map((child) => child.textContent).join('');
  }
  override set textContent(value: string) {
    this.children = value ? [new FakeNode(value)] : [];
  }
  append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  click(): void {
    for (const listener of this.listeners.get('click') ?? []) listener({ type: 'click' });
  }
  querySelectorAll(): FakeElement[] {
    return [];
  }
  /** The first descendant with the class. */
  find(name: string): FakeElement | null {
    for (const child of this.children) {
      if (!(child instanceof FakeElement)) continue;
      if (child.classList.contains(name)) return child;
      const found = child.find(name);
      if (found) return found;
    }
    return null;
  }
}

function fakeDocument() {
  const handlers = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void): void => {
    handlers.set(type, (handlers.get(type) ?? new Set()).add(listener));
  };
  const off = (type: string, listener: () => void): void => void handlers.get(type)?.delete(listener);
  const doc = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    visibilityState: 'visible',
    defaultView: { navigator: {}, addEventListener: on, removeEventListener: off },
    createElement: (tag: string) => Object.assign(new FakeElement(tag), { ownerDocument: doc }),
    createTextNode: (text: string) => new FakeNode(text),
    addEventListener: on,
    removeEventListener: off,
    /** Page visibility changes and window events, as the browser fires them. */
    fire(type: string) {
      for (const listener of [...(handlers.get(type) ?? [])]) listener();
    },
    hide() {
      doc.visibilityState = 'hidden';
      doc.fire('visibilitychange');
    },
    show() {
      doc.visibilityState = 'visible';
      doc.fire('visibilitychange');
    },
  };
  return doc;
}

Object.assign(globalThis, {
  HTMLAnchorElement: class {},
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

const BASE: ArState = {
  phase: 'idle',
  view: 'searching',
  progress: null,
  readiness: null,
  isCameraOn: false,
  isSuspended: false,
  videoProgress: null,
  notice: null,
  isMuted: true,
  isAdjusting: false,
  isPlaybackBlocked: false,
  isStale: false,
  skippedCount: 0,
  activeTargetId: null,
  isDisposed: false,
};

function mount(
  options: ArViewOptions = {},
  extras: { hasNoSuspend?: boolean; initial?: Partial<ArState>; initiallyHidden?: boolean } = {},
) {
  let state: ArState = { ...BASE, ...extras.initial };
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
    async stop(stop) {
      calls.push(`stop:${stop?.reason ?? ''}`);
    },
    setMuted(isMuted) {
      calls.push(`setMuted:${isMuted}`);
      return Promise.resolve(true);
    },
    async retryVideo() {
      calls.push('retryVideo');
    },
    ...(extras.hasNoSuspend
      ? {}
      : {
          suspend() {
            calls.push('suspend');
            return true;
          },
          resume() {
            calls.push('resume');
          },
        }),
  };
  const set = (change: Partial<ArState>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const doc = fakeDocument();
  if (extras.initiallyHidden) doc.visibilityState = 'hidden';
  const container = doc.createElement('div');
  const view = mountArView(container as unknown as HTMLElement, session, options);
  const root = container.children[0] as FakeElement;
  return { root, view, set, calls, starts, doc };
}

const shown = (node: FakeElement | null): string | null => (node && !node.hidden ? node.textContent : null);

test('the language control switches Chinese and English in place without touching the session', () => {
  const { root, set, calls, starts } = mount({ onExit: () => {} });
  const language = root.find('lm-ar__language')!;
  const label = language.children[0] as FakeElement;
  set({ phase: 'scanning', view: 'videoError', skippedCount: 2, notice: { key: 'notice.videoPlayFailed' } });
  assert.equal(root.lang, 'zh-CN', 'Chinese by default');
  assert.equal(language.hidden, false);
  assert.equal(language.textContent, 'EN', 'labelled with the language it switches to');
  assert.equal(label.lang, 'en');
  assert.equal(language.getAttribute('aria-label'), '切换到英文');

  language.click();
  assert.equal(root.lang, 'en');
  assert.equal(shown(root.find('lm-ar__status')), 'The video cannot play right now.');
  assert.equal(shown(root.find('lm-ar__notice')), 'The video cannot play. Choose “Reload video” to try again.');
  assert.equal(
    root.find('lm-ar__hud')!.children[2]!.textContent,
    '2 photos are not suitable for scanning and were skipped.',
  );
  assert.equal(root.find('lm-ar__controls')!.children[1]!.textContent, 'Reload video');
  assert.equal(root.find('lm-ar__exit')!.getAttribute('aria-label'), 'Close camera');
  assert.equal(root.find('lm-ar__sound')!.getAttribute('aria-label'), 'Turn sound on');
  assert.equal(language.textContent, '中');
  assert.equal(label.lang, 'zh-CN');
  assert.equal(language.getAttribute('aria-label'), 'Switch to Chinese');

  set({ view: 'playing', notice: null });
  assert.equal(shown(root.find('lm-ar__status')), 'Playing', 'later states keep the new language');

  language.click();
  assert.equal(root.lang, 'zh-CN');
  assert.equal(shown(root.find('lm-ar__status')), '正在播放');
  assert.equal(language.textContent, 'EN');
  assert.equal(starts.length, 1, 'never restarted');
  assert.deepEqual(calls, [], 'never stopped or otherwise called');
});

test('the mount locale decides the start language; host wording still applies after a switch', () => {
  const { root, set } = mount({
    locale: 'en-GB',
    messages: { en: { 'host.expired': 'Link expired' }, 'zh-CN': { 'host.expired': '链接已过期' } },
  });
  set({ notice: { key: 'host.expired' } });
  assert.equal(root.lang, 'en');
  assert.equal(shown(root.find('lm-ar__notice')), 'Link expired');
  root.find('lm-ar__language')!.click();
  assert.equal(shown(root.find('lm-ar__notice')), '链接已过期');
});

test('the language control does nothing after destroy; update({ locale }) still works', () => {
  const { root, view } = mount();
  view.update({ locale: 'en' });
  assert.equal(root.lang, 'en');
  view.destroy();
  root.find('lm-ar__language')!.click();
  assert.equal(root.lang, 'en');
});

test('the sound control shows only while scanning and calls setMuted directly', () => {
  const { root, set, calls } = mount();
  const sound = root.find('lm-ar__sound')!;
  assert.equal(sound.hidden, true);
  set({ phase: 'scanning' });
  assert.equal(sound.hidden, false);
  assert.equal(sound.getAttribute('aria-pressed'), 'false');
  sound.click();
  assert.deepEqual(calls, ['setMuted:false']);
  set({ isMuted: false });
  assert.equal(sound.getAttribute('aria-pressed'), 'true');
  assert.equal(sound.getAttribute('aria-label'), '关闭声音');
});

test('the loader fills only for photos prepared; the scanner and the camera permission are turning waits with no percentage', () => {
  const { root, set } = mount({ locale: 'en' });
  const loader = root.find('lm-ar__loader')!;
  const ring = root.find('lm-ar__ring')!;
  const step = root.find('lm-ar__step')!;
  const hint = root.find('lm-ar__camera-hint')!;
  assert.equal(hint.hidden, true);

  // Loading the scanner: no measure yet.
  set({ phase: 'preparing', progress: { done: 0, total: 3 }, readiness: null });
  assert.equal(loader.hidden, false);
  assert.equal(step.textContent, 'Loading the scanner…');
  assert.equal(ring.classList.contains('lm-ar__ring--busy'), true);
  assert.equal(loader.getAttribute('aria-valuenow'), null);
  assert.equal(root.find('lm-ar__percent'), null, 'no percentage anywhere');
  assert.equal(shown(hint), 'Allow camera access', 'the hint is up while the camera is not open');

  // Photos: a real count, a filling ring.
  set({ progress: { done: 1, total: 3 }, readiness: 1 / 3 });
  assert.equal(step.textContent, 'Preparing photos 1/3');
  assert.equal(ring.classList.contains('lm-ar__ring--busy'), false);
  assert.equal(loader.getAttribute('aria-valuenow'), '33');

  // All photos done, the permission still open: a turning ring, not 70% or 100%.
  set({ phase: 'starting', progress: { done: 3, total: 3 }, readiness: 1 });
  assert.equal(step.textContent, 'Opening the camera…');
  assert.equal(ring.classList.contains('lm-ar__ring--busy'), true);
  assert.equal(loader.getAttribute('aria-valuenow'), null);
  assert.equal(loader.getAttribute('aria-label'), 'Opening the camera…');
  assert.equal(shown(hint), 'Allow camera access');
  assert.doesNotMatch(loader.textContent, /%/);

  // The camera is open: the hint goes away.
  set({ isCameraOn: true });
  assert.equal(hint.hidden, true);
  assert.equal(step.textContent, 'Getting ready…');
});

test('the camera hint follows the language and goes away once the run is scanning or ended', () => {
  const { root, set } = mount();
  const hint = root.find('lm-ar__camera-hint')!;
  set({ phase: 'preparing', readiness: 0 });
  assert.equal(shown(hint), '请允许使用相机');
  root.find('lm-ar__language')!.click();
  assert.equal(shown(hint), 'Allow camera access');
  set({ phase: 'idle', notice: { key: 'notice.cameraDenied' } });
  assert.equal(hint.hidden, true);
  assert.equal(
    shown(root.find('lm-ar__notice')),
    'Camera access was not granted. Allow it in your browser settings, then start again.',
  );
});

test('a hidden page suspends the run by default and resumes it when visible; nothing is stopped', () => {
  const { set, calls, doc } = mount();
  set({ phase: 'scanning' });
  doc.hide();
  assert.deepEqual(calls, ['suspend']);
  doc.show();
  assert.deepEqual(calls, ['suspend', 'resume']);
  doc.fire('pagehide');
  doc.fire('pageshow');
  assert.deepEqual(calls, ['suspend', 'resume', 'suspend', 'resume']);
});

test('a hidden page with nothing running does nothing; isStoppedWhenHidden: false leaves the run alone', () => {
  const idle = mount();
  idle.doc.hide();
  assert.deepEqual(idle.calls, []);
  const left = mount({ isStoppedWhenHidden: false });
  left.set({ phase: 'scanning' });
  left.doc.hide();
  left.doc.show();
  assert.deepEqual(left.calls, []);
});

test('isStoppedWhenHidden: true keeps the 0.5 behaviour: the run is stopped, never suspended', () => {
  const { set, calls, doc } = mount({ isStoppedWhenHidden: true });
  set({ phase: 'preparing' });
  doc.hide();
  assert.deepEqual(calls, ['stop:page-hidden']);
  doc.show();
  assert.deepEqual(calls, ['stop:page-hidden'], 'no resume');
});

test('a session that cannot suspend is stopped when the page is hidden', () => {
  const { set, calls, doc } = mount({}, { hasNoSuspend: true });
  set({ phase: 'scanning' });
  doc.hide();
  assert.deepEqual(calls, ['stop:page-hidden']);
  doc.show();
});

test('a destroyed view no longer reacts to the page being hidden', () => {
  const { set, calls, doc, view } = mount();
  set({ phase: 'scanning' });
  view.destroy();
  doc.hide();
  doc.fire('pageshow');
  assert.deepEqual(calls, []);
});

test('a page initially hidden suspends its automatic start without needing a visibility event', async () => {
  const mounted = mount({}, { initiallyHidden: true, initial: { phase: 'preparing' } });
  await Promise.resolve();
  assert.equal(mounted.starts.length, 1);
  assert.deepEqual(mounted.calls, ['suspend']);
  mounted.doc.show();
  assert.deepEqual(mounted.calls, ['suspend', 'resume']);
  mounted.view.destroy();
});

test('a hidden programmatic restart suspends, but destroying before the queued check prevents further calls', async () => {
  const mounted = mount({ isAutoStart: false });
  mounted.doc.visibilityState = 'hidden';
  mounted.set({ phase: 'preparing' });
  mounted.view.start();
  await Promise.resolve();
  assert.deepEqual(mounted.calls, ['suspend']);
  mounted.view.start();
  mounted.view.destroy();
  await Promise.resolve();
  assert.deepEqual(mounted.calls, ['suspend']);
});
