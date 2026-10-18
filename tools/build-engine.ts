/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Builds the single-file engine: one ES module per variant ('readable' and 'minified') with the vision Worker
// bundled into it as source text, plus the same Worker as a standalone file for hosts whose CSP forbids blob: Workers,
// and each optional extension as its own module (they never contain the engine).
// Usage: node tools/build-engine.ts [--out-dir <dir>]   (default: dist)
// The same inputs always give the same bytes: no timestamps or absolute paths are written.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { build, type Metafile } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const MAIN_ENTRY = 'packages/sdk/src/index.ts';
const WORKER_ENTRY = 'packages/sdk/src/worker/worker-entry.ts';
const banner = (name: string): string =>
  `/*! LiveMira ${name} | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */`;
const BANNER = banner('engine');

/** Optional modules (extensions, the target scorer and the camera UI), each built as its own module. */
export const EXTENSIONS = [
  'tracking-visuals',
  'recognition-diagnostics',
  'target-quality',
  'ui',
] as const;
export type ExtensionName = (typeof EXTENSIONS)[number];

export type Variant = 'readable' | 'minified';

export interface EngineOutput {
  readonly variant: Variant;
  readonly buildId: string;
  /** File name to contents. */
  readonly files: Readonly<Record<string, string>>;
}

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

const suffix = (variant: Variant): string => (variant === 'minified' ? '.min' : '');

/** SHA-256 over the sorted repository-relative paths and contents of every bundled input. */
function hashInputs(metafiles: readonly Metafile[]): string {
  // Virtual inputs such as "<define:…>" are covered by the bundle settings, not by files.
  const inputs = new Set(
    metafiles
      .flatMap((metafile) => Object.keys(metafile.inputs))
      .filter((input) => !input.startsWith('<')),
  );
  const hash = createHash('sha256');
  for (const input of [...inputs].sort()) {
    hash.update(`${input}\0`);
    hash.update(readFileSync(path.join(root, input)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function bundle(
  entry: string,
  variant: Variant,
  define: Record<string, string>,
  bannerText = BANNER,
): Promise<{ text: string; metafile: Metafile }> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: variant === 'minified',
    legalComments: 'none',
    banner: { js: bannerText },
    charset: 'utf8',
    define,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined || result.outputFiles.length !== 1)
    throw new Error(`expected one output for ${entry}`);
  return { text: output.text, metafile: result.metafile };
}

/** Builds one variant in memory. */
export async function buildEngineVariant(variant: Variant): Promise<EngineOutput> {
  const worker = await bundle(WORKER_ENTRY, variant, {});
  // The build id covers both bundles' inputs and the variant, and is computed before the main bundle embeds it.
  const probe = await bundle(MAIN_ENTRY, variant, {
    __LIVEMIRA_WORKER_SOURCE__: JSON.stringify(''),
    __LIVEMIRA_BUILD__: JSON.stringify({ variant, buildId: '' }),
  });
  const buildId = sha256(`${variant}\0${hashInputs([worker.metafile, probe.metafile])}`);
  const main = await bundle(MAIN_ENTRY, variant, {
    __LIVEMIRA_WORKER_SOURCE__: JSON.stringify(worker.text),
    __LIVEMIRA_BUILD__: JSON.stringify({ variant, buildId }),
  });
  return {
    variant,
    buildId,
    files: {
      [`livemira-engine${suffix(variant)}.mjs`]: main.text,
      [`livemira-engine-worker${suffix(variant)}.mjs`]: worker.text,
    },
  };
}

/** Builds one extension variant in memory: file name to contents. */
export async function buildExtension(
  name: ExtensionName,
  variant: Variant,
): Promise<Record<string, string>> {
  const { text } = await bundle(`packages/${name}/src/index.ts`, variant, {}, banner(name));
  return { [`livemira-${name}${suffix(variant)}.mjs`]: text };
}

export async function buildEngine(outDir: string): Promise<EngineOutput[]> {
  const outputs = [await buildEngineVariant('readable'), await buildEngineVariant('minified')];
  mkdirSync(outDir, { recursive: true });
  for (const output of outputs) {
    for (const [name, text] of Object.entries(output.files))
      writeFileSync(path.join(outDir, name), text);
  }
  for (const name of EXTENSIONS) {
    for (const variant of ['readable', 'minified'] as const) {
      for (const [file, text] of Object.entries(await buildExtension(name, variant)))
        writeFileSync(path.join(outDir, file), text);
    }
  }
  return outputs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const index = args.indexOf('--out-dir');
  const outDir = path.resolve(root, index >= 0 ? (args[index + 1] ?? 'dist') : 'dist');
  for (const output of await buildEngine(outDir)) {
    const sizes = Object.entries(output.files).map(
      ([name, text]) => `${name} ${Buffer.byteLength(text)} B`,
    );
    console.log(`${output.variant} ${output.buildId.slice(0, 12)}: ${sizes.join(', ')}`);
  }
}

if (import.meta.main) await main();
