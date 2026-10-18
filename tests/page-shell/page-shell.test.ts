/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The page shell with a stand-in document: the stage and floating layer, panels that open one at a time and are
// remembered, storage that may fail, and the badge, toast, prompt and diagnostics panel.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  DiagnosticsPanel,
  FloatingDock,
  FullscreenPrompt,
  mountShell,
  safeStorage,
  StatusBadge,
  Toast,
} from '@livemira/page-shell';

import { FakeDocument, type FakeElement } from './fake-dom.ts';

const globals = globalThis as { localStorage?: unknown };
afterEach(() => {
  delete globals.localStorage;
});

function memoryStorage(): Map<string, string> {
  const values = new Map<string, string>();
  globals.localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
  return values;
}

function shell() {
  const doc = new FakeDocument();
  const { stage, floating } = mountShell(doc as unknown as Document);
  return {
    doc,
    stage: stage as unknown as FakeElement,
    floating: floating as unknown as FakeElement,
  };
}

test('the shell adds its stylesheet once, a full-screen stage and a floating layer', () => {
  const { doc, stage, floating } = shell();
  mountShell(doc as unknown as Document);
  assert.equal(doc.head.children.filter((e) => e.id === 'lm-shell-style').length, 1);
  assert.equal(stage.className, 'lm-stage');
  assert.equal(floating.className, 'lm-float');
  assert.deepEqual(
    doc.body.children.slice(0, 2).map((e) => e.className),
    ['lm-stage', 'lm-float'],
  );
});

test('panels open one at a time, the open one is remembered, and the buttons say so', () => {
  const values = memoryStorage();
  const { floating } = shell();
  const dock = new FloatingDock(floating as unknown as HTMLElement, { storageKey: 'demo' });
  const run = dock.addPanel({ id: 'run', icon: '▶', title: 'Run' }) as unknown as FakeElement;
  const options = dock.addPanel({
    id: 'options',
    icon: '⚙',
    title: 'Options',
  }) as unknown as FakeElement;
  const buttons = floating.all().filter((e) => e.className === 'lm-dock-button');
  assert.deepEqual([run.hidden, options.hidden, dock.openPanel], [true, true, null]);
  buttons[0]!.click();
  assert.deepEqual([run.hidden, options.hidden, dock.openPanel], [false, true, 'run']);
  assert.equal(buttons[0]!.getAttribute('aria-expanded'), 'true');
  buttons[1]!.click();
  assert.deepEqual([run.hidden, options.hidden], [true, false]);
  assert.equal(values.get('demo'), 'options');
  buttons[1]!.click();
  assert.equal(dock.openPanel, null);
  assert.equal(values.has('demo'), false, 'collapsing forgets the panel');
  values.set('demo', 'options');
  const again = shell();
  const restored = new FloatingDock(again.floating as unknown as HTMLElement, {
    storageKey: 'demo',
  });
  restored.addPanel({ id: 'run', icon: '▶', title: 'Run' });
  restored.addPanel({ id: 'options', icon: '⚙', title: 'Options' });
  assert.equal(restored.openPanel, 'options', 'the remembered panel opens again');
});

test('failing or missing storage only loses the remembered value', () => {
  globals.localStorage = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
    removeItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(safeStorage.get('k'), null);
  assert.doesNotThrow(() => safeStorage.set('k', 'v'));
  assert.doesNotThrow(() => safeStorage.set('k', null));
  delete globals.localStorage;
  assert.equal(safeStorage.get('k'), null);
  const { floating } = shell();
  const dock = new FloatingDock(floating as unknown as HTMLElement, { storageKey: 'x' });
  dock.addPanel({ id: 'a', icon: 'a', title: 'A' });
  assert.doesNotThrow(() => dock.toggle('a'));
});

test('the badge, the prompt and the toast show and hide their text', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { floating } = shell();
  const badge = new StatusBadge(floating as unknown as HTMLElement);
  assert.equal(badge.text, '');
  badge.show('Locked', 'good');
  const badgeElement = floating.all().find((e) => e.className === 'lm-badge')!;
  assert.deepEqual([badge.text, badgeElement.dataset['tone']], ['Locked', 'good']);
  badge.hide();
  assert.equal(badge.text, '');
  const prompt = new FullscreenPrompt(floating as unknown as HTMLElement);
  prompt.show({ title: 'Turn the phone', progress: '1 / 3' });
  assert.equal(prompt.isOpen, true);
  assert.equal(
    floating.all().find((e) => e.className === 'lm-prompt-progress')!.textContent,
    '1 / 3',
  );
  prompt.close();
  assert.equal(prompt.isOpen, false);
  const toast = new Toast(floating as unknown as HTMLElement);
  const toastElement = floating.all().find((e) => e.className === 'lm-toast')!;
  toast.show('Saved', 1000);
  toast.show('Applies at the next start', 1000);
  assert.deepEqual(
    [toastElement.hidden, toastElement.textContent],
    [false, 'Applies at the next start'],
  );
  t.mock.timers.tick(999);
  assert.equal(toastElement.hidden, false, 'a newer message restarts the timer');
  t.mock.timers.tick(1);
  assert.equal(toastElement.hidden, true);
});

test('the diagnostics panel switches the level for the next start and saves an export named after the run', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { doc, floating } = shell();
  const panel = doc.createElement('section');
  floating.append(panel);
  let level: 'key' | 'full' = 'key';
  const log = {
    get level() {
      return level;
    },
    setLevel: (next: 'key' | 'full') => void (level = next),
    getCapacity: () => ({ capacity: 10000, records: 12, dropped: 0 }),
    export: () => ({ runId: '0123456789abcdef', createdAt: '2026-10-15T08:30:00.000Z' }),
  };
  const notes: string[] = [];
  const urls: string[] = [];
  const originals = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => {
    urls.push('blob:export');
    return 'blob:export';
  };
  URL.revokeObjectURL = () => {};
  try {
    new DiagnosticsPanel(
      panel as unknown as HTMLElement,
      log,
      {
        fullLog: 'Full log',
        appliesNextStart: 'Applies at the next start',
        capacity: (records, capacity, dropped) => `${records}/${capacity}, ${dropped} dropped`,
        export: 'Export',
      },
      (message) => notes.push(message),
    );
    const toggle = panel.all().find((e) => e.tagName === 'INPUT')!;
    toggle.checked = true;
    toggle.dispatch('change');
    assert.equal(level, 'full');
    assert.deepEqual(notes, ['Applies at the next start']);
    assert.equal(
      panel.all().find((e) => e.className === 'lm-hint')!.textContent,
      '12/10000, 0 dropped',
    );
    panel
      .all()
      .find((e) => e.tagName === 'BUTTON')!
      .click();
    assert.deepEqual(doc.downloads, [
      { href: 'blob:export', name: 'livemira-01234567-2026-10-15T08-30-00-000Z.json' },
    ]);
  } finally {
    URL.createObjectURL = originals.create;
    URL.revokeObjectURL = originals.revoke;
  }
});
