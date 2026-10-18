/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { syncVersion } from './sync-version.ts';

function fixture(rootVersion: unknown): string {
  const root = mkdtempSync(path.join(tmpdir(), 'livemira-version-'));
  const write = (file: string, value: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(
      path.join(root, file),
      typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
  };
  write('package.json', { name: 'livemira', version: rootVersion, private: true });
  write('packages/sdk/package.json', {
    name: '@livemira/engine',
    version: '0.3.0',
    dependencies: { '@livemira/contracts': '0.3.0', other: '1.0.0' },
  });
  write('packages/contracts/package.json', { name: '@livemira/contracts', version: '0.3.0' });
  write('packages/tracking-visuals/package.json', {
    name: '@livemira/tracking-visuals',
    version: '0.3.0',
    peerDependencies: { '@livemira/engine': '0.3.0' },
  });
  write('apps/demo/package.json', {
    name: '@livemira/demo',
    version: '0.3.0',
    dependencies: { '@livemira/engine': '0.3.0' },
  });
  write('package-lock.json', {
    name: 'livemira',
    version: rootVersion === '0.3.1' ? '0.3.0' : rootVersion,
    lockfileVersion: 3,
    packages: {
      '': { name: 'livemira', version: rootVersion === '0.3.1' ? '0.3.0' : rootVersion },
      'packages/sdk': {
        name: '@livemira/engine',
        version: '0.3.0',
        dependencies: { '@livemira/contracts': '0.3.0' },
      },
      'node_modules/@livemira/engine': { resolved: 'packages/sdk', link: true },
    },
  });
  write('packages/sdk/src/build-info.ts', "export const ENGINE_VERSION = '0.3.0';\n");
  return root;
}

test('a consistent repository has nothing to synchronize', () => {
  const root = fixture('0.3.0');
  try {
    assert.deepEqual(syncVersion(root, true), { version: '0.3.0', edits: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new root version is reported by the check and written everywhere by the sync', () => {
  const root = fixture('0.3.1');
  try {
    const before = readFileSync(path.join(root, 'packages/sdk/package.json'), 'utf8');
    const checked = syncVersion(root, true);
    assert.equal(readFileSync(path.join(root, 'packages/sdk/package.json'), 'utf8'), before);
    assert.deepEqual(
      checked.edits.map((e) => `${e.file}: ${e.place}`),
      [
        'packages/contracts/package.json: version',
        'packages/sdk/package.json: version',
        'packages/sdk/package.json: dependencies.@livemira/contracts',
        'packages/tracking-visuals/package.json: version',
        'packages/tracking-visuals/package.json: peerDependencies.@livemira/engine',
        'apps/demo/package.json: version',
        'apps/demo/package.json: dependencies.@livemira/engine',
        'package-lock.json: version',
        'package-lock.json: root entry version',
        'package-lock.json: packages/sdk version',
        'package-lock.json: packages/sdk dependencies.@livemira/contracts',
        'packages/sdk/src/build-info.ts: ENGINE_VERSION',
      ],
    );
    assert.equal(syncVersion(root).edits.length, checked.edits.length);
    assert.deepEqual(syncVersion(root, true).edits, []);
    const sdk = JSON.parse(readFileSync(path.join(root, 'packages/sdk/package.json'), 'utf8'));
    assert.deepEqual(sdk.dependencies, { '@livemira/contracts': '0.3.1', other: '1.0.0' });
    assert.match(
      readFileSync(path.join(root, 'packages/sdk/src/build-info.ts'), 'utf8'),
      /ENGINE_VERSION = '0\.3\.1'/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the root version must be a semantic version', () => {
  for (const version of [undefined, '0.3', 'v0.3.0']) {
    const root = fixture(version);
    try {
      assert.throws(() => syncVersion(root, true), /semantic version/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
