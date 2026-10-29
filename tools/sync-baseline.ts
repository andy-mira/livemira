// SPDX-License-Identifier: Apache-2.0
//
// Copies the baseline (LiveMira 0.4.1) packages the benchmark compares against into bench/baseline/ as read-only
// workspace packages, and records a manifest of their hashes. `--check` verifies the copy against the manifest and,
// when the sibling repository is present, against its sources. The baseline repository itself is never modified.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.env.LIVEMIRA_BASELINE ?? join(ROOT, '..', 'livemira-github');
const TARGET = join(ROOT, 'bench', 'baseline');
const MANIFEST = join(TARGET, 'manifest.json');
const PACKAGES = ['contracts', 'compute', 'recognition', 'target-compiler', 'tracking'] as const;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function digest(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PACKAGES) {
    for (const path of [join(base, name, 'package.json'), ...files(join(base, name, 'src'))]) {
      out[relative(base, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function sync(): void {
  if (!existsSync(SOURCE)) throw new Error(`Baseline repository not found at ${SOURCE}`);
  for (const name of PACKAGES) {
    rmSync(join(TARGET, name), { recursive: true, force: true });
    cpSync(join(SOURCE, 'packages', name, 'src'), join(TARGET, name, 'src'), { recursive: true });
    cpSync(join(SOURCE, 'packages', name, 'package.json'), join(TARGET, name, 'package.json'));
  }
  const version = JSON.parse(readFileSync(join(SOURCE, 'package.json'), 'utf8')).version as string;
  writeFileSync(MANIFEST, `${JSON.stringify({ version, files: digest(TARGET) }, null, 2)}\n`);
  console.log(`baseline ${version}: ${PACKAGES.length} packages copied to ${relative(ROOT, TARGET)}`);
}

function check(): void {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { files: Record<string, string> };
  const copy = digest(TARGET);
  if (JSON.stringify(copy) !== JSON.stringify(manifest.files))
    throw new Error('bench/baseline differs from its manifest; run npm run sync:baseline');
  if (existsSync(SOURCE)) {
    const source = digest(join(SOURCE, 'packages'));
    if (JSON.stringify(source) !== JSON.stringify(copy))
      throw new Error('Baseline repository changed since the last sync; run npm run sync:baseline');
  }
  console.log('baseline copy matches its manifest');
}

if (process.argv.includes('--check')) check();
else sync();
