// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadLayout } from '../../scripts/release/release-layout.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const snippet = text => text.match(/^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$)/gm) ?? [];
test('each public module and release guide has bilingual navigation and identical executable examples', async () => {
  const { layout } = await loadLayout();
  const englishFiles = [...layout.devRuntime.packages.map(name => `packages/${name}/README.md`), 'native/recognition/README.md', 'docs/release/livemira-release.md', 'docs/release/livemira-naming.md'];
  for (const rel of englishFiles) {
    const zh = rel.replace(/\.md$/, '.zh-CN.md');
    const [a, b] = await Promise.all([readFile(path.join(root, rel), 'utf8'), readFile(path.join(root, zh), 'utf8')]);
    assert.ok(a.includes(`[简体中文](${path.basename(zh)})`), rel);
    assert.ok(b.includes(`[English](${path.basename(rel)})`), zh);
    assert.match(b, /[\u4e00-\u9fff]/);
    assert.deepEqual(snippet(b), snippet(a), rel);
  }
});
