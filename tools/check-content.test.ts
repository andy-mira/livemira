/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BILINGUAL_DOCUMENTS,
  examples,
  findBilingualViolations,
  findContentViolations,
} from './check-content.ts';

const messages = (files: { path: string; text: string }[]) =>
  findContentViolations(files).map((v) => `${v.where}: ${v.message}`);

test('local paths, attributions, the old name and secrets are found anywhere', () => {
  assert.deepEqual(
    messages([
      { path: 'a.ts', text: "const dir = '/Users/someone/project';" },
      { path: 'b.md', text: 'Written with Claude.' },
      { path: 'c.ts', text: '// Ported from WebAREngine.' },
      { path: 'd.json', text: '"key": "-----BEGIN RSA PRIVATE KEY-----"' },
      { path: 'e.ts', text: `const t = 'ghp_${'a'.repeat(36)}';` },
      { path: 'f.png', text: '/Users/binary' },
    ]),
    [
      'a.ts: a local absolute path',
      'b.md: an assistant or tool attribution',
      'c.ts: the superseded project name',
      'd.json: a private key',
      'e.ts: a credential',
    ],
  );
});

test('the approved Made-with-AI credits section of the two top-level READMEs is exempt, not the rest', () => {
  const credits =
    '## Made with AI\n\nBuilt with **Nova** (GLM), **Codex** (GPT) and **Claude**.\n\n## License\n';
  assert.deepEqual(
    messages([
      { path: 'README.md', text: '[English](README.md) | [简体中文](README.zh-CN.md)\n' + credits },
      {
        path: 'README.zh-CN.md',
        text: '[English](README.md) | [简体中文](README.zh-CN.md)\n' + credits,
      },
      { path: 'packages/sdk/README.md', text: credits },
      { path: 'README.md', text: 'Ported with Claude.\n' + credits },
    ]),
    [
      'packages/sdk/README.md: an assistant or tool attribution',
      'README.md: an assistant or tool attribution',
    ],
  );
});

test('round labels and the notes folder count only in prose, and the ignore lists may name the folder', () => {
  assert.deepEqual(
    messages([
      { path: 'g.ts', text: 'const r2 = row + 2; // second row' },
      { path: 'h.ts', text: '// Found in round 6 on a phone.' },
      { path: 'i.md', text: 'As measured in r6.' },
      { path: 'j.ts', text: '/* see Docs/design */' },
      { path: '.gitignore', text: '/Docs/' },
      { path: 'k.md', text: '第 6 轮真机' },
    ]),
    [
      'h.ts: an internal round label',
      'i.md: an internal round label',
      'j.ts: a reference to the internal notes',
      'k.md: an internal round label',
    ],
  );
});

test('bundled source strings and regular expressions are not prose, but inline comments are', () => {
  assert.deepEqual(
    messages([
      { path: 'worker.mjs', text: 'const worker = "// module\\nconst r2 = 2;";' },
      { path: 'pattern.ts', text: 'const pattern = /https?:\\/\\/r2/;' },
      { path: 'inline.ts', text: 'const value = /* round 7 */ 1;' },
      { path: 'trailing.ts', text: 'const value = 1; // round 7' },
    ]),
    ['inline.ts: an internal round label', 'trailing.ts: an internal round label'],
  );
});

test('examples keep their code but drop comments, string contents and HTML text', () => {
  const en =
    "```js\nengine.on('targetFound', (e) => log('found')); // found\n```\n```html\n<button id=\"start\">Start</button>\n```\n";
  const zh =
    "```js\nengine.on('targetFound', (e) => log('识别到')); // 识别到\n```\n```html\n<button id=\"start\">开始</button>\n```\n";
  assert.deepEqual(examples(en), examples(zh));
  assert.notDeepEqual(examples(en), examples(zh.replace('engine.on', 'engine.once')));
});

test('every public document exists in both languages with navigation and the same examples', () => {
  const nav = (file: string) => {
    const base = file.split('/').pop()!;
    return `[English](${base}) | [简体中文](${base.replace('.md', '.zh-CN.md')})`;
  };
  const files = new Map<string, string>();
  for (const english of BILINGUAL_DOCUMENTS) {
    files.set(english, `${nav(english)}\n\`\`\`sh\nnpm ci\n\`\`\`\n`);
    files.set(english.replace('.md', '.zh-CN.md'), `${nav(english)}\n\`\`\`sh\nnpm ci\n\`\`\`\n`);
  }
  assert.deepEqual(findBilingualViolations(files), []);
  files.set('SECURITY.zh-CN.md', '```sh\nnpm install\n```\n');
  files.delete('CONTRIBUTING.zh-CN.md');
  assert.deepEqual(
    findBilingualViolations(files).map((v) => `${v.where}: ${v.message}`),
    [
      'CONTRIBUTING.md: needs both CONTRIBUTING.md and CONTRIBUTING.zh-CN.md',
      'SECURITY.zh-CN.md: missing the language navigation line',
      'SECURITY.zh-CN.md: code example 1 differs from the English one',
    ],
  );
});
