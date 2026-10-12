// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncMetadata } from '../../scripts/release/sync-metadata.mjs';
import { isReleaseVersion, isPreviewVersion, materializeVersionLabels, RELEASE_VERSION, ROOT_METADATA, ENGINE_NAME, ENGINE_PACKAGE_NAME } from '../../scripts/release/release-version.mjs';
import { AUTHOR, COPYRIGHT_NOTICE, SPDX_LICENSE_ID } from '../../scripts/release/legal.mjs';
const read = async (root, rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lm-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'packages/a'), { recursive: true });
  await mkdir(path.join(root, 'packages/b'), { recursive: true });
  const entries = {
    'package.json': { name: 'livemira', version: '0.2.0', author: AUTHOR, license: SPDX_LICENSE_ID, workspaces: ['packages/*'] },
    'packages/a/package.json': { name: '@livemira/a', version: '0.2.0', dependencies: { '@livemira/b': '0.2.0', external: '^3.1.0' } },
    'packages/b/package.json': { name: '@livemira/b', version: '0.2.0' },
    'package-lock.json': { name: 'livemira', version: '0.2.0', lockfileVersion: 3, packages: {
      '': { name: 'livemira', version: '0.2.0' }, 'packages/a': { version: '0.2.0', dependencies: { '@livemira/b': '0.2.0', external: '^3.1.0' } },
      'packages/b': { version: '0.2.0' }, 'node_modules/external': { version: '3.1.8', resolved: 'https://example.test/pkg.tgz', integrity: 'sha512-preserve' },
      'node_modules/@livemira/a': { resolved: 'packages/a', link: true } } }
  };
  for (const [rel, data] of Object.entries(entries)) await writeFile(path.join(root, rel), JSON.stringify(data, null, 2) + '\n');
  return root;
}
test('release and attribution derive from the canonical root metadata', () => {
  assert.equal(RELEASE_VERSION, ROOT_METADATA.version); assert.equal(AUTHOR, ROOT_METADATA.author);
  assert.equal(SPDX_LICENSE_ID, ROOT_METADATA.license);
  assert.equal(COPYRIGHT_NOTICE, `Copyright ${ROOT_METADATA.livemira.copyrightYear} ${AUTHOR}`);
  assert.equal(ENGINE_NAME, ROOT_METADATA.livemira.displayName); assert.equal(ENGINE_PACKAGE_NAME, ROOT_METADATA.livemira.enginePackageName);
});
test('version synchronization updates local pins, preserves external dependencies, and is idempotent', async t => {
  const root = await fixture(t);
  const external = (await read(root, 'package-lock.json')).packages['node_modules/external'];
  const result = await syncMetadata(root, { version: '0.2.1-rc.1+build.7' });
  assert.equal(result.workspaces, 2);
  assert.equal((await read(root, 'packages/a/package.json')).dependencies['@livemira/b'], result.version);
  assert.equal((await read(root, 'packages/a/package.json')).dependencies.external, '^3.1.0');
  assert.equal((await read(root, 'packages/b/package.json')).author, AUTHOR);
  const lock = await read(root, 'package-lock.json');
  assert.equal(lock.packages['packages/a'].dependencies['@livemira/b'], result.version);
  assert.deepEqual(lock.packages['node_modules/external'], external);
  assert.deepEqual(lock.packages['node_modules/@livemira/a'], { resolved: 'packages/a', link: true });
  assert.deepEqual((await syncMetadata(root, { check: true })).changed, []);
  assert.deepEqual((await syncMetadata(root)).changed, []);
});
test('check reports drift without writing, invalid version or lockfile fails before any writes', async t => {
  const root = await fixture(t), before = await readFile(path.join(root, 'package.json'), 'utf8');
  await assert.rejects(syncMetadata(root, { check: true }), /differs/);
  await assert.rejects(syncMetadata(root, { version: '01.2.0' }), /Invalid SemVer/);
  await writeFile(path.join(root, 'package-lock.json'), '{invalid');
  await assert.rejects(syncMetadata(root, { version: '0.3.0' }), SyntaxError);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
});
test('SemVer accepts stable, prerelease and build metadata, rejects ambiguous forms', () => {
  for (const value of ['0.2.0', '1.2.3-rc.1', '1.2.3+build.9', '1.2.3-rc.1+build.9']) assert.ok(isReleaseVersion(value), value);
  for (const value of ['01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+', 'v1.2.3', '1.2', '1.2.3-rc..1', null]) assert.equal(isReleaseVersion(value), false, value);
});

test('page templates materialize stable and preview labels without stale versions or duplicate build metadata', () => {
  const page = '<p>{{ENGINE_NAME}} {{RELEASE_VERSION}} / STABLE</p><p>{{ENGINE_NAME}} {{RELEASE_VERSION}} 稳定版：</p>';
  const output = materializeVersionLabels(page, '1.2.3+build-test.9');
  assert.ok(output.includes('LiveMira 1.2.3+build-test.9 / STABLE'));
  assert.equal(materializeVersionLabels(output, '1.2.3+build-test.9'), output);
  assert.equal(isPreviewVersion('1.2.3+build-test.9'), false);
  assert.ok(materializeVersionLabels(page, '1.2.3-rc.1').includes('候选版：'));
});

test('only declared release workspaces are synchronized; unrelated local packages stay untouched', async t => {
  const root = await fixture(t), pkg = await read(root, 'package.json');
  pkg.workspaces = ['packages/a'];
  await writeFile(path.join(root, 'package.json'), JSON.stringify(pkg));
  const untouched = await readFile(path.join(root, 'packages/b/package.json'), 'utf8');
  const result = await syncMetadata(root, { version: '0.3.0' });
  assert.equal(result.workspaces, 1);
  assert.equal(await readFile(path.join(root, 'packages/b/package.json'), 'utf8'), untouched);
  assert.deepEqual((await read(root, 'package-lock.json')).packages[''].workspaces, pkg.workspaces);
  assert.equal((await read(root, 'packages/a/package.json')).dependencies['@livemira/b'], '0.2.0');
});
