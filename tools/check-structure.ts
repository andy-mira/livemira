/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Enforces the package layering, import hygiene and source headers of the workspace.
// Usage: node tools/check-structure.ts   (exits with status 1 and prints every violation)

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const SOURCE_HEADER =
  '/*! Copyright 2026 Andy\n * SPDX-License-Identifier: Apache-2.0\n */\n';

const ENGINE = '@livemira/engine';

/** Allowed runtime dependencies per package directory (the layering of the design). */
export const LAYERS: Readonly<Record<string, readonly string[]>> = {
  contracts: [],
  compute: ['contracts'],
  recognition: ['contracts'],
  camera: ['contracts'],
  media: ['contracts'],
  diagnostics: ['contracts'],
  tracking: ['contracts', 'recognition'],
  'target-compiler': ['contracts', 'recognition'],
  renderer: ['contracts', 'media'],
  sdk: [
    'contracts',
    'compute',
    'recognition',
    'tracking',
    'target-compiler',
    'camera',
    'media',
    'renderer',
    'diagnostics',
  ],
  'tracking-visuals': ['contracts'],
  'recognition-diagnostics': ['contracts'],
  'target-quality': ['contracts', 'recognition'],
  ui: [],
};

/**
 * Allowed workspace packages per application: the demo uses only public entries (the engine, the optional extensions)
 * and the page shell; the page shell uses nothing.
 */
export const APPS: Readonly<Record<string, readonly string[]>> = {
  'page-shell': [],
  demo: [
    ENGINE,
    '@livemira/tracking-visuals',
    '@livemira/recognition-diagnostics',
    '@livemira/target-quality',
    '@livemira/page-shell',
  ],
};

/** Extensions may describe the engine they plug into, but never load it. */
const TYPE_ONLY_ENGINE = new Set(['tracking-visuals', 'recognition-diagnostics', 'ui']);

export const packageNameOf = (dir: string): string => (dir === 'sdk' ? ENGINE : `@livemira/${dir}`);

export interface SourceFile {
  /** Path relative to the package directory, POSIX separators. */
  readonly path: string;
  readonly text: string;
}

export interface PackageSnapshot {
  /** 'packages' (default) or 'apps'. */
  readonly area?: 'packages' | 'apps';
  readonly dir: string;
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly files: readonly SourceFile[];
}

export interface Violation {
  readonly where: string;
  readonly message: string;
}

export interface ImportReference {
  readonly specifier: string;
  readonly isTypeOnly: boolean;
}

const IMPORT_PATTERN =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Static and dynamic module specifiers of a TypeScript source, with whether the statement is type-only. */
export function findImports(text: string): ImportReference[] {
  const found: ImportReference[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const specifier = match[2] ?? match[3];
    if (specifier !== undefined) found.push({ specifier, isTypeOnly: match[1] !== undefined });
  }
  return found;
}

const expectedName = (pkg: PackageSnapshot): string =>
  pkg.area === 'apps' ? `@livemira/${pkg.dir}` : packageNameOf(pkg.dir);

function checkPackageManifest(pkg: PackageSnapshot, allowed: ReadonlySet<string>): Violation[] {
  const where = `${pkg.area ?? 'packages'}/${pkg.dir}/package.json`;
  const violations: Violation[] = [];
  if (pkg.name !== expectedName(pkg)) {
    violations.push({ where, message: `name must be ${expectedName(pkg)}` });
  }
  for (const dependency of Object.keys(pkg.dependencies)) {
    // An extension names the engine it plugs into (for its types) without loading it.
    const isEnginePeer = dependency === ENGINE && TYPE_ONLY_ENGINE.has(pkg.dir);
    if (!allowed.has(dependency) && !isEnginePeer) {
      violations.push({
        where,
        message: `dependency ${dependency} is not allowed by the layering`,
      });
    }
  }
  return violations;
}

function checkSourceImports(
  pkg: PackageSnapshot,
  file: SourceFile,
  allowed: ReadonlySet<string>,
): Violation[] {
  const where = `${pkg.area ?? 'packages'}/${pkg.dir}/${file.path}`;
  const isRuntimeSource = file.path.startsWith('src/');
  const violations: Violation[] = [];
  for (const { specifier, isTypeOnly } of findImports(file.text)) {
    if (specifier.startsWith('.')) {
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), specifier),
      );
      if (resolved.startsWith('..')) {
        violations.push({ where, message: `relative import ${specifier} leaves the package` });
      } else if (!specifier.endsWith('.ts')) {
        violations.push({ where, message: `relative import ${specifier} must name its .ts file` });
      }
      continue;
    }
    if (specifier.startsWith('@livemira/')) {
      const name = specifier.split('/').slice(0, 2).join('/');
      if (name !== specifier) {
        violations.push({ where, message: `deep import ${specifier}; use the package entry` });
      } else if (name === pkg.name) {
        // A package may use its own entry, typically from its tests.
        if (isRuntimeSource)
          violations.push({ where, message: `runtime source imports its own entry ${name}` });
      } else if (name === ENGINE && pkg.area !== 'apps' && TYPE_ONLY_ENGINE.has(pkg.dir)) {
        if (!isTypeOnly)
          violations.push({ where, message: `${ENGINE} may only be imported as types` });
      } else if (!allowed.has(name) || !(name in pkg.dependencies)) {
        violations.push({ where, message: `import ${name} is not a declared, allowed dependency` });
      }
      continue;
    }
    if (isRuntimeSource) {
      violations.push({
        where,
        message: `runtime source imports ${specifier}; ${pkg.area === 'apps' ? 'applications' : 'packages'} have no runtime dependencies`,
      });
    }
  }
  return violations;
}

/** All layering and import violations of the given packages. */
export function findPackageViolations(packages: readonly PackageSnapshot[]): Violation[] {
  const violations: Violation[] = [];
  for (const pkg of packages) {
    const layer = LAYERS[pkg.dir];
    if (layer === undefined) {
      violations.push({
        where: `packages/${pkg.dir}`,
        message: 'package is missing from the layering table',
      });
      continue;
    }
    const allowed = new Set(layer.map(packageNameOf));
    violations.push(...checkPackageManifest(pkg, allowed));
    for (const file of pkg.files) violations.push(...checkSourceImports(pkg, file, allowed));
  }
  return violations;
}

/** Import and dependency violations of the applications (apps/). */
export function findAppViolations(apps: readonly PackageSnapshot[]): Violation[] {
  const violations: Violation[] = [];
  for (const app of apps) {
    const rule = APPS[app.dir];
    if (rule === undefined) {
      violations.push({
        where: `apps/${app.dir}`,
        message: 'application is missing from the apps table',
      });
      continue;
    }
    const allowed = new Set(rule);
    violations.push(...checkPackageManifest(app, allowed));
    for (const file of app.files) violations.push(...checkSourceImports(app, file, allowed));
  }
  return violations;
}

/** Source files whose first lines are not the project header. */
export function findHeaderViolations(
  files: readonly { where: string; text: string }[],
): Violation[] {
  return files
    .filter((file) => !file.text.startsWith(SOURCE_HEADER))
    .map((file) => ({ where: file.where, message: 'missing copyright and license header' }));
}

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'generated']);

function listSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry)) found.push(...listSources(full));
    } else if (/\.(?:ts|mts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

function exists(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function readArea(root: string, area: 'packages' | 'apps'): PackageSnapshot[] {
  const snapshots: PackageSnapshot[] = [];
  if (!exists(path.join(root, area))) return snapshots;
  const dirs = readdirSync(path.join(root, area), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of dirs) {
    const base = path.join(root, area, dir);
    const manifest = JSON.parse(readFileSync(path.join(base, 'package.json'), 'utf8')) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const files = listSources(base).map((file) => ({
      path: path.relative(base, file).split(path.sep).join('/'),
      text: readFileSync(file, 'utf8'),
    }));
    snapshots.push({
      area,
      dir,
      name: manifest.name,
      dependencies: { ...manifest.dependencies, ...manifest.peerDependencies },
      files,
    });
  }
  return snapshots;
}

function readWorkspace(root: string): {
  packages: PackageSnapshot[];
  apps: PackageSnapshot[];
  headerFiles: { where: string; text: string }[];
} {
  const packages = readArea(root, 'packages');
  const apps = readArea(root, 'apps');
  const headerFiles = ['packages', 'tools', 'tests', 'apps']
    .map((top) => path.join(root, top))
    .filter(exists)
    .flatMap(listSources)
    .map((file) => ({ where: path.relative(root, file), text: readFileSync(file, 'utf8') }));
  return { packages, apps, headerFiles };
}

function main(): void {
  const root = path.resolve(import.meta.dirname, '..');
  const { packages, apps, headerFiles } = readWorkspace(root);
  const violations = [
    ...findPackageViolations(packages),
    ...findAppViolations(apps),
    ...findHeaderViolations(headerFiles),
  ];
  for (const violation of violations) console.error(`${violation.where}: ${violation.message}`);
  if (violations.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
