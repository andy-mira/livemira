/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findAppViolations,
  findHeaderViolations,
  findImports,
  findPackageViolations,
  SOURCE_HEADER,
  type PackageSnapshot,
} from './check-structure.ts';

const pkg = (overrides: Partial<PackageSnapshot> & { dir: string }): PackageSnapshot => ({
  name: overrides.dir === 'sdk' ? '@livemira/engine' : `@livemira/${overrides.dir}`,
  dependencies: {},
  files: [],
  ...overrides,
});

const messages = (packages: PackageSnapshot[]): string[] =>
  findPackageViolations(packages).map((violation) => violation.message);

test('findImports reports static, re-export, side-effect and dynamic specifiers', () => {
  const text = [
    "import { a } from './a.ts';",
    "import type { B } from '@livemira/contracts';",
    "export * from './c.ts';",
    "export type { D } from './d.ts';",
    "import './e.ts';",
    "const f = await import('./f.ts');",
  ].join('\n');
  assert.deepEqual(findImports(text), [
    { specifier: './a.ts', isTypeOnly: false },
    { specifier: '@livemira/contracts', isTypeOnly: true },
    { specifier: './c.ts', isTypeOnly: false },
    { specifier: './d.ts', isTypeOnly: true },
    { specifier: './e.ts', isTypeOnly: false },
    { specifier: './f.ts', isTypeOnly: false },
  ]);
});

test('a package that follows the layering has no violations', () => {
  const tracking = pkg({
    dir: 'tracking',
    dependencies: { '@livemira/contracts': '0.3.0', '@livemira/recognition': '0.3.0' },
    files: [
      {
        path: 'src/index.ts',
        text: "import { x } from '@livemira/recognition';\nimport './a.ts';",
      },
    ],
  });
  assert.deepEqual(messages([tracking]), []);
});

test('tests may import their own package entry, runtime sources may not', () => {
  const camera = pkg({
    dir: 'camera',
    files: [
      { path: 'test/a.test.ts', text: "import { x } from '@livemira/camera';" },
      { path: 'src/b.ts', text: "import { y } from '@livemira/camera';" },
    ],
  });
  assert.deepEqual(messages([camera]), ['runtime source imports its own entry @livemira/camera']);
});

test('upward and sideways dependencies are rejected', () => {
  const recognition = pkg({
    dir: 'recognition',
    dependencies: { '@livemira/tracking': '0.3.0' },
    files: [{ path: 'src/index.ts', text: "import { x } from '@livemira/tracking';" }],
  });
  assert.deepEqual(messages([recognition]), [
    'dependency @livemira/tracking is not allowed by the layering',
    'import @livemira/tracking is not a declared, allowed dependency',
  ]);
});

test('an allowed package must still be declared before it is imported', () => {
  const tracking = pkg({
    dir: 'tracking',
    files: [{ path: 'src/index.ts', text: "import { x } from '@livemira/contracts';" }],
  });
  assert.deepEqual(messages([tracking]), [
    'import @livemira/contracts is not a declared, allowed dependency',
  ]);
});

test('deep imports, escaping relative imports and extensionless relative imports are rejected', () => {
  const camera = pkg({
    dir: 'camera',
    dependencies: { '@livemira/contracts': '0.3.0' },
    files: [
      {
        path: 'src/a/b.ts',
        text: [
          "import { x } from '@livemira/contracts/src/frame.ts';",
          "import { y } from '../../../media/src/index.ts';",
          "import { z } from './c';",
        ].join('\n'),
      },
    ],
  });
  assert.deepEqual(messages([camera]), [
    'deep import @livemira/contracts/src/frame.ts; use the package entry',
    'relative import ../../../media/src/index.ts leaves the package',
    'relative import ./c must name its .ts file',
  ]);
});

test('runtime sources cannot import third-party or Node modules, tests can', () => {
  const media = pkg({
    dir: 'media',
    files: [
      { path: 'src/index.ts', text: "import { readFile } from 'node:fs';" },
      { path: 'test/index.test.ts', text: "import { test } from 'node:test';" },
    ],
  });
  assert.deepEqual(messages([media]), [
    'runtime source imports node:fs; packages have no runtime dependencies',
  ]);
});

test('extensions may import the engine only as types', () => {
  const visuals = pkg({
    dir: 'tracking-visuals',
    files: [
      { path: 'src/a.ts', text: "import type { EngineExtension } from '@livemira/engine';" },
      { path: 'src/b.ts', text: "import { createEngine } from '@livemira/engine';" },
    ],
  });
  assert.deepEqual(messages([visuals]), ['@livemira/engine may only be imported as types']);
});

test('only extensions may name the engine as a dependency', () => {
  const visuals = pkg({ dir: 'tracking-visuals', dependencies: { '@livemira/engine': '0.3.0' } });
  const camera = pkg({ dir: 'camera', dependencies: { '@livemira/engine': '0.3.0' } });
  assert.deepEqual(messages([visuals, camera]), [
    'dependency @livemira/engine is not allowed by the layering',
  ]);
});

test('package names and unknown packages are checked', () => {
  const misnamed = pkg({ dir: 'sdk', name: '@livemira/sdk' });
  const unknown = pkg({ dir: 'benchmark' });
  assert.deepEqual(messages([misnamed, unknown]), [
    'name must be @livemira/engine',
    'package is missing from the layering table',
  ]);
});

test('files without the project header are reported', () => {
  const violations = findHeaderViolations([
    { where: 'a.ts', text: `${SOURCE_HEADER}\nexport {};\n` },
    { where: 'b.ts', text: '// Copyright someone else\n' },
  ]);
  assert.deepEqual(violations, [
    { where: 'b.ts', message: 'missing copyright and license header' },
  ]);
});

test('the demo may use only public entries and the page shell; the page shell uses nothing', () => {
  const demo = pkg({
    area: 'apps',
    dir: 'demo',
    name: '@livemira/demo',
    dependencies: { '@livemira/engine': '0.3.0', '@livemira/page-shell': '0.3.0' },
    files: [
      { path: 'src/a.ts', text: "import { createEngine } from '@livemira/engine';" },
      { path: 'src/b.ts', text: "import { mountShell } from '@livemira/page-shell';" },
      { path: 'src/c.ts', text: "import { CameraSource } from '@livemira/camera';" },
      { path: 'src/d.ts', text: "import x from '@livemira/engine/src/engine/engine-core.ts';" },
      { path: 'src/e.ts', text: "import { readFileSync } from 'node:fs';" },
    ],
  });
  const shell = pkg({
    area: 'apps',
    dir: 'page-shell',
    name: '@livemira/page-shell',
    files: [{ path: 'src/a.ts', text: "import { EngineError } from '@livemira/engine';" }],
  });
  assert.deepEqual(
    findAppViolations([demo, shell]).map((v) => `${v.where}: ${v.message}`),
    [
      'apps/demo/src/c.ts: import @livemira/camera is not a declared, allowed dependency',
      'apps/demo/src/d.ts: deep import @livemira/engine/src/engine/engine-core.ts; use the package entry',
      'apps/demo/src/e.ts: runtime source imports node:fs; applications have no runtime dependencies',
      'apps/page-shell/src/a.ts: import @livemira/engine is not a declared, allowed dependency',
    ],
  );
});
