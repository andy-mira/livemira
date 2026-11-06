// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { brokenLinks, linkTargets } from './release-links.ts';

test('links in code fences and code spans are not links', () => {
  const md = ['[a](one.md) and `[b](two.md)`', '```', '[c](three.md)', '```', '![img](p.png "title")'].join('\n');
  assert.deepEqual(linkTargets(md), ['one.md', 'p.png']);
});

test('only relative links that do not resolve inside the tree are broken', () => {
  const root = mkdtempSync(join(tmpdir(), 'livemira-links-'));
  try {
    mkdirSync(join(root, 'documentation'));
    writeFileSync(join(root, 'NOTICE'), '');
    writeFileSync(join(root, 'documentation/ui.md'), '[back](../README.md#top) [up](../../outside.md)\n');
    writeFileSync(
      join(root, 'README.md'),
      '[ok](documentation/ui.md#x) [n](NOTICE) [web](https://example.com/x) [here](#a) [gone](missing.md)\n',
    );
    assert.deepEqual(brokenLinks(root), ['README.md → missing.md', 'documentation/ui.md → ../../outside.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
