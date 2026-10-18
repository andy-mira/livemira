/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Assembles one publishable directory per package from the build output: the engine and each optional extension,
// with their bundled modules, merged declarations, both READMEs, LICENSE, NOTICE and CHANGELOG. The workspace
// manifests keep pointing at the TypeScript sources for development; the published manifests point at dist/.
// Needs `node tools/build-engine.ts` and `node tools/build-types.ts` first (npm run build runs all of them).
// Usage: node tools/pack.ts [--build-dir <dir>] [--out-dir <dir>]   (defaults: dist, dist/packages)

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EXTENSIONS } from './build-engine.ts';

const root = path.resolve(import.meta.dirname, '..');

interface PackageSpec {
  /** Workspace directory under packages/. */
  readonly dir: string;
  /** Base name of the built files. */
  readonly file: string;
  /** Repository documents copied next to the README (the migration notes it links to). */
  readonly documents: readonly string[];
  readonly hasWorker: boolean;
}

export const PACKAGES: readonly PackageSpec[] = [
  {
    dir: 'sdk',
    file: 'livemira-engine',
    documents: [
      'documentation/migration-0.2-to-0.3.md',
      'documentation/migration-0.2-to-0.3.zh-CN.md',
    ],
    hasWorker: true,
  },
  ...EXTENSIONS.map((name) => ({
    dir: name,
    file: `livemira-${name}`,
    documents: [
      'documentation/migration-0.2-to-0.3.md',
      'documentation/migration-0.2-to-0.3.zh-CN.md',
    ],
    hasWorker: false,
  })),
];

const COMMON_FILES = ['LICENSE', 'NOTICE', 'CHANGELOG.md'] as const;

/** Built files a package ships, from the build directory. */
const builtFiles = (spec: PackageSpec): string[] => [
  `${spec.file}.min.mjs`,
  `${spec.file}.mjs`,
  `${spec.file}.d.ts`,
  ...(spec.hasWorker ? ['livemira-engine-worker.min.mjs'] : []),
];

type Json = Record<string, unknown>;

function manifest(spec: PackageSpec): Json {
  const source = JSON.parse(
    readFileSync(path.join(root, 'packages', spec.dir, 'package.json'), 'utf8'),
  ) as Json;
  const types = `./dist/${spec.file}.d.ts`;
  return {
    name: source['name'],
    version: source['version'],
    description: source['description'],
    license: source['license'],
    author: source['author'],
    type: 'module',
    sideEffects: false,
    types,
    exports: {
      '.': { types, default: `./dist/${spec.file}.min.mjs` },
      './readable': { types, default: `./dist/${spec.file}.mjs` },
      ...(spec.hasWorker ? { './worker': './dist/livemira-engine-worker.min.mjs' } : {}),
      './package.json': './package.json',
    },
    // Everything is bundled: the published packages have no dependencies. Extensions keep their peer engine.
    ...(source['peerDependencies'] === undefined
      ? {}
      : { peerDependencies: source['peerDependencies'] }),
    ...(source['peerDependenciesMeta'] === undefined
      ? {}
      : { peerDependenciesMeta: source['peerDependenciesMeta'] }),
  };
}

/** Repository-relative links of a README become package-relative; links to sibling packages stay as they are. */
const relink = (markdown: string): string => markdown.replaceAll('](../../', '](');

export function pack(buildDir: string, outDir: string): string[] {
  const missing = PACKAGES.flatMap(builtFiles).filter(
    (file) => !existsSync(path.join(buildDir, file)),
  );
  if (missing.length > 0)
    throw new Error(`missing build output (run npm run build): ${missing.join(', ')}`);
  rmSync(outDir, { recursive: true, force: true });
  return PACKAGES.map((spec) => {
    const target = path.join(outDir, spec.dir === 'sdk' ? 'engine' : spec.dir);
    mkdirSync(path.join(target, 'dist'), { recursive: true });
    writeFileSync(
      path.join(target, 'package.json'),
      `${JSON.stringify(manifest(spec), null, 2)}\n`,
    );
    for (const file of builtFiles(spec))
      copyFileSync(path.join(buildDir, file), path.join(target, 'dist', file));
    for (const readme of ['README.md', 'README.zh-CN.md'])
      writeFileSync(
        path.join(target, readme),
        relink(readFileSync(path.join(root, 'packages', spec.dir, readme), 'utf8')),
      );
    for (const file of [...COMMON_FILES, ...spec.documents]) {
      mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
      copyFileSync(path.join(root, file), path.join(target, file));
    }
    return target;
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    return path.resolve(root, index >= 0 ? (args[index + 1] ?? fallback) : fallback);
  };
  for (const dir of pack(option('--build-dir', 'dist'), option('--out-dir', 'dist/packages')))
    console.log(path.relative(root, dir));
}
