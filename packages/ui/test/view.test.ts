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
  const doc = {
    head: new FakeElement('head'),
    body: new FakeElement('body'),
    documentElement: new FakeElement('html'),
    visibilityState: 'visible',
    defaultView: { navigator: {}, addEventListener() {}, removeEventListener() {} },
    createElement: (tag: string) => Object.assign(new FakeElement(tag), { ownerDocument: doc }),
    createTextNode: (text: string) => new FakeNode(text),
    addEventListener() {},
    removeEventListener() {},
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

function mount(options: ArViewOptions = {}) {
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
  };
  const set = (change: Partial<ArState>): void => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const doc = fakeDocument();
  const container = doc.createElement('div');
  const view = mountArView(container as unknown as HTMLElement, session, options);
  const root = container.children[0] as FakeElement;
  return { root, view, set, calls, starts };
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
