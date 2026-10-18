/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The version in the root package.json is the only one edited by hand. This copies it to every workspace package
// (its own version and its dependencies on other workspace packages), to the lock file and to the engine's
// ENGINE_VERSION, and checks that they agree.
// Usage: node tools/sync-version.ts           writes the root version everywhere
//        node tools/sync-version.ts --check   lists every place that differs; writes nothing

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
const BUILD_INFO = 'packages/sdk/src/build-info.ts';
const ENGINE_VERSION = /(export const ENGINE_VERSION = ')([^']*)(';)/;

type Json = Record<string, unknown>;

interface Edit {
  readonly file: string;
  readonly place: string;
  readonly found: string;
}

const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8')) as Json;
const writeJson = (file: string, value: Json): void =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function workspaceManifests(root: string): string[] {
  return ['packages', 'apps'].flatMap((group) =>
    readdirSync(path.join(root, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${group}/${entry.name}`),
  );
}

/** Sets every workspace version in one manifest-shaped object; returns what differed. */
function syncManifest(manifest: Json, version: string, names: ReadonlySet<string>): string[] {
  const places: string[] = [];
  if ('version' in manifest && manifest['version'] !== version) {
    places.push(`version ${String(manifest['version'])}`);
    manifest['version'] = version;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = manifest[field] as Record<string, string> | undefined;
    for (const name of Object.keys(dependencies ?? {})) {
      if (!names.has(name) || dependencies![name] === version) continue;
      places.push(`${field}.${name} ${dependencies![name]}`);
      dependencies![name] = version;
    }
  }
  return places;
}

/** Brings every place in line with the root version; with `isCheck`, only reports. */
export function syncVersion(root: string, isCheck = false): { version: string; edits: Edit[] } {
  const version = readJson(path.join(root, 'package.json'))['version'];
  if (typeof version !== 'string' || !SEMVER.test(version))
    throw new Error(`the root package.json needs a semantic version, found ${String(version)}`);
  const edits: Edit[] = [];
  const dirs = workspaceManifests(root);
  const manifests = dirs.map((dir) => readJson(path.join(root, dir, 'package.json')));
  const names = new Set(manifests.map((manifest) => String(manifest['name'])));
  dirs.forEach((dir, i) => {
    const file = `${dir}/package.json`;
    const places = syncManifest(manifests[i]!, version, names);
    for (const place of places)
      edits.push({ file, place: place.split(' ')[0]!, found: place.split(' ')[1]! });
    if (places.length > 0 && !isCheck) writeJson(path.join(root, file), manifests[i]!);
  });

  const lockFile = path.join(root, 'package-lock.json');
  const lock = readJson(lockFile);
  const entries = (lock['packages'] ?? {}) as Record<string, Json>;
  let isLockChanged = false;
  // The lock file repeats the root version at its top and in its root entry.
  for (const [manifest, place] of [
    [lock, 'version'],
    [entries[''] ?? {}, 'root entry version'],
  ] as const) {
    if (!('version' in manifest) || manifest['version'] === version) continue;
    edits.push({
      file: 'package-lock.json',
      place,
      found: String(manifest['version']),
    });
    manifest['version'] = version;
    isLockChanged = true;
  }
  for (const dir of dirs) {
    const entry = entries[dir];
    if (entry === undefined) continue;
    for (const place of syncManifest(entry, version, names)) {
      edits.push({
        file: 'package-lock.json',
        place: `${dir} ${place.split(' ')[0]!}`,
        found: place.split(' ')[1]!,
      });
      isLockChanged = true;
    }
  }
  if (isLockChanged && !isCheck) writeJson(lockFile, lock);

  const buildInfoFile = path.join(root, BUILD_INFO);
  const source = readFileSync(buildInfoFile, 'utf8');
  const found = ENGINE_VERSION.exec(source)?.[2];
  if (found === undefined) throw new Error(`${BUILD_INFO} no longer declares ENGINE_VERSION`);
  if (found !== version) {
    edits.push({ file: BUILD_INFO, place: 'ENGINE_VERSION', found });
    if (!isCheck) writeFileSync(buildInfoFile, source.replace(ENGINE_VERSION, `$1${version}$3`));
  }
  return { version, edits };
}

if (import.meta.main) {
  const isCheck = process.argv.includes('--check');
  const root = path.resolve(import.meta.dirname, '..');
  const { version, edits } = syncVersion(root, isCheck);
  for (const edit of edits)
    console[isCheck ? 'error' : 'log'](
      `${edit.file}: ${edit.place} is ${edit.found}, expected ${version}`,
    );
  if (isCheck && edits.length > 0) {
    console.error('run npm run version:sync');
    process.exitCode = 1;
  } else if (!isCheck) {
    console.log(edits.length === 0 ? `every place is at ${version}` : `synchronized to ${version}`);
  }
}
