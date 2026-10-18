/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The publishable package directories: what each one contains, where its exports point, and that every link of
// its documentation resolves inside the installed packages.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { PACKAGES, pack } from '../../tools/pack.ts';

const root = path.resolve(import.meta.dirname, '../..');
let work: string;
let outDir: string;
let dirs: string[];

// Stand-in build output: packing copies files, so their contents do not matter.
const BUILT = PACKAGES.flatMap((spec) => [
  `${spec.file}.min.mjs`,
  `${spec.file}.mjs`,
  `${spec.file}.d.ts`,
]).concat(['livemira-engine-worker.min.mjs', 'livemira-engine-worker.mjs']);

before(() => {
  work = mkdtempSync(path.join(tmpdir(), 'livemira-pack-'));
  const buildDir = path.join(work, 'build');
  mkdirSync(buildDir);
  for (const file of BUILT) writeFileSync(path.join(buildDir, file), `// ${file}\n`);
  // Laid out as installed: node_modules/@livemira/<package>.
  outDir = path.join(work, 'node_modules', '@livemira');
  dirs = pack(buildDir, outDir);
});
after(() => rmSync(work, { recursive: true, force: true }));

const read = (dir: string, file: string): string => readFileSync(path.join(dir, file), 'utf8');
const manifest = (dir: string) => JSON.parse(read(dir, 'package.json'));

test('each package is published under its own name with the repository version', () => {
  const version = JSON.parse(read(root, 'package.json')).version;
  assert.deepEqual(
    dirs.map((dir) => [path.basename(dir), manifest(dir).name, manifest(dir).version]),
    [
      ['engine', '@livemira/engine', version],
      ['tracking-visuals', '@livemira/tracking-visuals', version],
      ['recognition-diagnostics', '@livemira/recognition-diagnostics', version],
      ['target-quality', '@livemira/target-quality', version],
      ['ui', '@livemira/ui', version],
    ],
  );
  for (const dir of dirs) {
    assert.equal(manifest(dir).private, undefined);
    assert.equal(manifest(dir).dependencies, undefined, 'everything is bundled');
    assert.equal(read(dir, 'LICENSE'), read(root, 'LICENSE'));
  }
  // Extensions hosted by the engine and the camera UI name it as a peer; the target scorer stands alone.
  assert.deepEqual(
    dirs.map((dir) => manifest(dir).peerDependencies),
    [
      undefined,
      { '@livemira/engine': version },
      { '@livemira/engine': version },
      undefined,
      { '@livemira/engine': version },
    ],
  );
  // The UI is handed the engine module at run time and never imports it: installing it pulls no engine.
  assert.deepEqual(
    dirs.map((dir) => manifest(dir).peerDependenciesMeta),
    [undefined, undefined, undefined, undefined, { '@livemira/engine': { optional: true } }],
  );
});

test('the engine exports the minified module, the readable one, the Worker file and the merged declarations', () => {
  const engine = dirs[0]!;
  assert.deepEqual(manifest(engine).exports, {
    '.': { types: './dist/livemira-engine.d.ts', default: './dist/livemira-engine.min.mjs' },
    './readable': { types: './dist/livemira-engine.d.ts', default: './dist/livemira-engine.mjs' },
    './worker': './dist/livemira-engine-worker.min.mjs',
    './package.json': './package.json',
  });
  for (const dir of dirs) {
    const targets = Object.values(manifest(dir).exports as Record<string, unknown>).flatMap(
      (value) => (typeof value === 'string' ? [value] : Object.values(value as object)),
    );
    for (const target of [...targets, manifest(dir).types])
      assert.ok(existsSync(path.join(dir, target)), `${path.basename(dir)}: ${target}`);
  }
});

test('npm publishes exactly the assembled files', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dirs[0]!,
    encoding: 'utf8',
  });
  const [{ files }] = JSON.parse(output) as [{ files: { path: string }[] }];
  assert.deepEqual(files.map((file) => file.path).sort(), [
    'CHANGELOG.md',
    'LICENSE',
    'NOTICE',
    'README.md',
    'README.zh-CN.md',
    'dist/livemira-engine-worker.min.mjs',
    'dist/livemira-engine.d.ts',
    'dist/livemira-engine.min.mjs',
    'dist/livemira-engine.mjs',
    'documentation/migration-0.2-to-0.3.md',
    'documentation/migration-0.2-to-0.3.zh-CN.md',
    'package.json',
  ]);
});

test('every relative link of the documentation resolves among the installed packages', () => {
  for (const dir of dirs) {
    const documents = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.md'));
    for (const readme of documents) {
      for (const [, href] of read(dir, readme).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(href!)) continue;
        assert.ok(
          existsSync(path.join(dir, path.dirname(readme), href!)),
          `${path.basename(dir)}/${readme} links to ${href}`,
        );
      }
    }
  }
});

test('packing without a complete build names the missing files', () => {
  const empty = path.join(work, 'empty');
  mkdirSync(empty);
  assert.throws(
    () => pack(empty, path.join(work, 'none')),
    /missing build output .*livemira-engine\.min\.mjs/,
  );
});
