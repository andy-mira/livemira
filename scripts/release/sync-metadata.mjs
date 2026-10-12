// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Synchronize npm's required copies of release metadata without installing or upgrading dependencies.
import { readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isReleaseVersion } from './release-version.mjs';

export async function syncMetadata(root, { version, check = false } = {}) {
  const files = new Map();
  async function load(rel) {
    const bytes = await readFile(path.join(root, rel), 'utf8');
    const data = JSON.parse(bytes);
    files.set(rel, { bytes, data });
    return data;
  }
  const pkg = await load('package.json');
  const target = version ?? pkg.version;
  if (!isReleaseVersion(target)) throw new Error(`Invalid SemVer: ${target}`);
  if (check && version !== undefined) throw new Error('--check cannot set a version');
  if (!Array.isArray(pkg.workspaces) || !pkg.workspaces.length || pkg.workspaces.some(value => !/^packages\/(?:[a-z0-9-]+|\*)$/.test(value))) throw new Error('Expected declared packages/<name> workspaces');
  const wildcard = pkg.workspaces.includes('packages/*');
  const workspaces = new Map();
  for (const entry of await readdir(path.join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory() || (!wildcard && !pkg.workspaces.includes(`packages/${entry.name}`))) continue;
    const rel = `packages/${entry.name}/package.json`;
    let workspace;
    try { workspace = await load(rel); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (typeof workspace.name !== 'string' || workspaces.has(workspace.name)) throw new Error(`Invalid or duplicate workspace: ${rel}`);
    workspaces.set(workspace.name, rel);
  }
  if (!wildcard && workspaces.size !== pkg.workspaces.length) throw new Error('A declared workspace manifest is missing');
  const lock = await load('package-lock.json');
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Expected npm lockfile version 3');
  function syncDependencies(data) {
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(data[field] ?? {})) {
        // Local dependencies are exact release pins. Other packages and their resolved integrity remain untouched.
        if (workspaces.has(name)) data[field][name] = target;
      }
    }
  }
  pkg.version = target;
  syncDependencies(pkg);
  lock.name = pkg.name;
  lock.version = target;
  Object.assign(lock.packages[''], { name: pkg.name, version: target, license: pkg.license, workspaces: pkg.workspaces });
  syncDependencies(lock.packages['']);
  for (const rel of workspaces.values()) {
    const workspace = files.get(rel).data;
    Object.assign(workspace, { version: target, author: pkg.author, license: pkg.license });
    syncDependencies(workspace);
    const entry = lock.packages[path.posix.dirname(rel)];
    if (!entry) throw new Error(`Lockfile lacks workspace ${rel}`);
    Object.assign(entry, { version: target, license: pkg.license });
    syncDependencies(entry);
  }
  const changes = [];
  for (const [rel, { bytes, data }] of files) {
    const next = JSON.stringify(data, null, 2) + '\n';
    // Formatting alone does not constitute a metadata mismatch.
    if (JSON.stringify(JSON.parse(bytes)) !== JSON.stringify(data)) changes.push({ rel, next });
  }
  if (check && changes.length) throw new Error(`Release metadata differs from package.json: ${changes.map(c => c.rel).join(', ')}`);
  // Parse and validate every input before the first write. Rename each file atomically on its filesystem.
  if (!check) for (const { rel, next } of changes) {
    const destination = path.join(root, rel), temporary = `${destination}.lm-sync-${process.pid}`;
    await writeFile(temporary, next, { flag: 'wx' });
    await rename(temporary, destination);
  }
  return { version: target, changed: changes.map(c => c.rel), workspaces: workspaces.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0]?.startsWith('-') && args[0] !== '--check')) throw new Error('Usage: npm run version:set -- [SEMVER] | npm run version:check');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const result = await syncMetadata(root, { check: args[0] === '--check', version: args[0] === '--check' ? undefined : args[0] });
  console.log(JSON.stringify(result));
}
