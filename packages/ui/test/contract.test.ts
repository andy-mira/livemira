// SPDX-License-Identifier: Apache-2.0
// The UI declares the engine only structurally; the engine of this release must satisfy that (checked by tsc), and
// the wording tables must cover the same keys.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as engineModule from '@livemira-next/engine';

import type { EngineModule } from '../src/api.ts';
import { EN, ZH_CN } from '../src/messages.ts';
import { createTranslator, resolveLocale } from '../src/translator.ts';

// Compile-time: the real engine module is what `loadEngine` may return.
const asUiEngine: EngineModule = engineModule;

test('the engine module offers what the UI calls', () => {
  for (const name of ['createEngine', 'compileTargetImage', 'parseTarget'] as const)
    assert.equal(typeof asUiEngine[name], 'function', name);
  assert.equal(typeof engineModule.ENGINE_VERSION, 'string');
  assert.equal(engineModule.engineBuildInfo.variant, 'development');
});

test('both locales have the same keys', () => {
  assert.deepEqual(Object.keys(EN).sort(), Object.keys(ZH_CN).sort());
});

test('translation: host override, host table, locale table, plural forms, unknown keys', () => {
  assert.equal(resolveLocale('en-GB'), 'en');
  assert.equal(resolveLocale('fr'), 'zh-CN');
  const en = createTranslator({
    locale: 'en',
    messages: { en: { 'host.expired': 'Link expired' } },
    translate: (key) => (key === 'exit' ? 'Leave' : undefined),
  });
  assert.equal(en.t('exit'), 'Leave');
  assert.equal(en.t('host.expired'), 'Link expired');
  assert.equal(en.t('skipped', { count: 1 }), '1 photo is not suitable for scanning and was skipped.');
  assert.equal(en.t('skipped', { count: 3 }), '3 photos are not suitable for scanning and were skipped.');
  assert.equal(en.t('loader.photos', { done: 2, total: 5 }), 'Preparing photos 2/5');
  assert.equal(en.t('no.such.key'), 'no.such.key');
  const zh = createTranslator({
    translate: () => {
      throw new Error('broken host');
    },
  });
  assert.equal(zh.t('notice.unsupported'), '本设备无法进行识别：需要 WebGL2 支持（请换用较新的浏览器或设备）。');
});
