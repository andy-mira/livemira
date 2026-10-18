/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Test doubles: an engine module that records calls and lets a test emit engine events, and a small DOM that
// supports what the view uses. Neither proves the real engine or a browser; the browser probe does that.

import type * as LiveMira from '@livemira/engine';

import type { EngineModule } from '@livemira/ui';

type Listener = (event: unknown) => void;

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending promise callbacks run. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

export const engineError = (code: string): Error =>
  Object.assign(new Error(code), { name: 'EngineError', code });

export class FakeEngine {
  readonly calls: string[] = [];
  readonly media: { setMuted(isMuted: boolean): Promise<boolean>; retry(): Promise<boolean> };
  readonly camera = { list: async () => [], configure: () => {} };
  readonly listeners = new Map<string, Set<Listener>>();
  readonly bindings = new Map<string, LiveMira.TargetMedia>();
  state: 'idle' | 'running' | 'disposed' = 'idle';
  targets: string[] = [];
  /** Replace to control `start()`; default resolves at once. */
  startResult: () => Promise<void> = async () => {};
  muteResult = true;
  readonly options: LiveMira.EngineOptions;

  constructor(options: LiveMira.EngineOptions) {
    this.options = options;
    this.media = {
      setMuted: (isMuted) => {
        this.calls.push(`setMuted:${isMuted}`);
        return Promise.resolve(isMuted || this.muteResult);
      },
      retry: () => {
        this.calls.push('retry');
        return Promise.resolve(true);
      },
    };
  }

  on(type: string, listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => void set.delete(listener);
  }

  emit(type: string, payload: Record<string, unknown> = {}): void {
    const event = {
      sessionId: 's',
      targetId: null,
      timestampUs: 0,
      timestampDomain: 'page',
      ...payload,
    };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  async setTargets(entries: readonly { target: LiveMira.TargetBundle }[]): Promise<void> {
    this.targets = entries.map((e) => e.target.targetId);
    this.calls.push(`setTargets:${this.targets.join(',')}`);
  }

  setTargetMedia(targetId: string, media: LiveMira.TargetMedia | null): void {
    this.calls.push(`media:${targetId}:${media ? `muted=${String(media.isMuted)}` : 'null'}`);
    if (media) this.bindings.set(targetId, media);
    else this.bindings.delete(targetId);
  }

  async start(): Promise<void> {
    this.calls.push('start');
    await this.startResult();
    this.state = 'running';
  }

  async stop(reason = 'stopped'): Promise<void> {
    this.calls.push(`stop:${reason}`);
    const wasRunning = this.state === 'running';
    this.state = 'idle';
    if (wasRunning) this.emit('sessionEnded', { reason });
  }

  async dispose(): Promise<void> {
    this.calls.push('dispose');
    this.state = 'disposed';
  }

  getEventContext(): never {
    throw new Error('unused');
  }

  getDiagnostics(): Record<string, unknown> {
    return {};
  }

  /** Engine events of a recognized target and its playing video. */
  found(targetId: string): void {
    this.emit('targetFound', { targetId, result: { targetId } });
  }

  mediaState(targetId: string, state: string, failureReason?: string): void {
    this.emit('mediaState', {
      targetId,
      state,
      media: failureReason ? { presentation: { failureReason } } : {},
    });
  }
}

export interface FakeModule {
  readonly module: EngineModule;
  readonly engines: FakeEngine[];
  readonly compiled: string[];
  /** Per target id: replace to control its compile. */
  readonly compileResults: Map<string, () => Promise<LiveMira.TargetBundle>>;
  readonly compileOptions: unknown[];
}

export function fakeModule(): FakeModule {
  const engines: FakeEngine[] = [];
  const compiled: string[] = [];
  const compileResults = new Map<string, () => Promise<LiveMira.TargetBundle>>();
  const compileOptions: unknown[] = [];
  const module = {
    createEngine: (options: LiveMira.EngineOptions) => {
      const engine = new FakeEngine(options);
      engines.push(engine);
      return engine as unknown as LiveMira.Engine;
    },
    compileTargetImage: async (_image: Blob, options: LiveMira.CompileImageOptions) => {
      compiled.push(options.targetId);
      compileOptions.push(options);
      const result = compileResults.get(options.targetId);
      if (result) return result();
      return { targetId: options.targetId } as unknown as LiveMira.TargetBundle;
    },
  } as unknown as EngineModule;
  return { module, engines, compiled, compileResults, compileOptions };
}

// --- DOM ---------------------------------------------------------------------------------------------------------

export class FakeElement {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { setProperty(name: string, value: string): void };
  readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  className = '';
  textContent = '';
  innerHTML = '';
  hidden = false;
  lang = '';
  clientWidth = 0;
  clientHeight = 0;

  constructor(tagName: string, doc: FakeDocument) {
    this.tagName = tagName;
    this.ownerDocument = doc;
    const style: Record<string, string> = { overflow: '' };
    Object.defineProperty(style, 'setProperty', {
      value: (name: string, value: string) => void (style[name] = value),
    });
    this.style = style as FakeElement['style'];
  }

  get classList() {
    return {
      add: (name: string) => void (this.className = `${this.className} ${name}`.trim()),
      contains: (name: string) => this.className.split(' ').includes(name),
    };
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  appendChild(node: FakeElement): FakeElement {
    node.parent = this;
    this.children.push(node);
    return node;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  click(): void {
    const event = { type: 'click', defaultPrevented: false, preventDefault() {} };
    for (const listener of this.listeners.get('click') ?? []) listener(event);
  }

  /** Depth-first search by class name. */
  find(className: string): FakeElement | null {
    for (const child of this.children) {
      if (child.className.split(' ').includes(className)) return child;
      const found = child.find(className);
      if (found) return found;
    }
    return null;
  }

  findAll(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.className.split(' ').includes(className) ? [child] : []),
      ...child.findAll(className),
    ]);
  }
}

function add(map: Map<string, Set<() => void>>, type: string, listener: () => void): void {
  let set = map.get(type);
  if (!set) map.set(type, (set = new Set()));
  set.add(listener);
}

export class FakeDocument {
  readonly head: FakeElement;
  readonly body: FakeElement;
  readonly documentElement: FakeElement;
  readonly frames: (() => void)[] = [];
  readonly listeners = new Map<string, Set<() => void>>();
  readonly windowListeners = new Map<string, Set<() => void>>();
  visibilityState: 'visible' | 'hidden' = 'visible';
  readonly defaultView = {
    requestAnimationFrame: (callback: () => void) => this.frames.push(callback),
    cancelAnimationFrame: (id: number) => void (this.frames[id - 1] = () => {}),
    addEventListener: (type: string, listener: () => void) =>
      add(this.windowListeners, type, listener),
    removeEventListener: (type: string, listener: () => void) =>
      void this.windowListeners.get(type)?.delete(listener),
  };

  addEventListener(type: string, listener: () => void): void {
    add(this.listeners, type, listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Fires a document event ('visibilitychange') or, with `onWindow`, a window event ('pagehide'). */
  fire(type: string, onWindow = false): void {
    for (const listener of [
      ...((onWindow ? this.windowListeners : this.listeners).get(type) ?? []),
    ])
      listener();
  }

  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    this.documentElement.append(this.head, this.body);
  }

  createElement(tag: string): FakeElement {
    return new FakeElement(tag, this);
  }

  /** Runs the queued animation frames once. */
  runFrames(): void {
    for (const frame of this.frames.splice(0)) frame();
  }
}

/** A container of the given size; the view's stage takes the same size. */
export function fakeContainer(
  widthPx = 390,
  heightPx = 844,
): { doc: FakeDocument; container: FakeElement } {
  const doc = new FakeDocument();
  const container = doc.createElement('div');
  doc.body.appendChild(container);
  const appendChild = container.appendChild.bind(container);
  container.appendChild = (node: FakeElement) => {
    const stage = node.find('lm-ar__stage');
    if (stage) {
      stage.clientWidth = widthPx;
      stage.clientHeight = heightPx;
    }
    return appendChild(node);
  };
  return { doc, container };
}
