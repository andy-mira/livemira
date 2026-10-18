/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Builds the public demo as a static site: the page, its bundled script, the minified single-file engine (loaded by
// the script at run time, so the demo uses exactly the public build) and the sample assets.
// Usage: node tools/build-demo.ts [--out-dir <dir>]   (default: dist/demo)

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

import { buildEngineVariant, buildExtension } from './build-engine.ts';

const root = path.resolve(import.meta.dirname, '..');
const DEMO = path.join(root, 'apps/demo');
const ENGINE_FILE = 'livemira-engine.mjs';
const VISUALS_FILE = 'livemira-tracking-visuals.mjs';

export async function buildDemo(outDir: string): Promise<void> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  const engine = await buildEngineVariant('minified');
  writeFileSync(path.join(outDir, ENGINE_FILE), engine.files['livemira-engine.min.mjs']!);
  const visuals = await buildExtension('tracking-visuals', 'minified');
  writeFileSync(path.join(outDir, VISUALS_FILE), visuals['livemira-tracking-visuals.min.mjs']!);
  await build({
    absWorkingDir: root,
    entryPoints: ['apps/demo/src/main.ts'],
    outfile: path.join(outDir, 'demo.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    legalComments: 'inline',
    logLevel: 'silent',
    plugins: [
      {
        name: 'public-engine',
        setup(context) {
          // The demo imports the public engine; at run time that is the single-file build next to the page.
          context.onResolve({ filter: /^@livemira\/engine$/ }, () => ({
            path: `./${ENGINE_FILE}`,
            external: true,
          }));
          // The optional drawing extension is its own module, loaded by the demo only when wanted.
          context.onResolve({ filter: /^@livemira\/tracking-visuals$/ }, () => ({
            path: `./${VISUALS_FILE}`,
            external: true,
          }));
        },
      },
    ],
  });
  copyFileSync(path.join(DEMO, 'index.html'), path.join(outDir, 'index.html'));
  for (const name of readdirSync(path.join(DEMO, 'assets')))
    copyFileSync(path.join(DEMO, 'assets', name), path.join(outDir, 'assets', name));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--out-dir');
  const outDir = path.resolve(root, index >= 0 ? (args[index + 1] ?? 'dist/demo') : 'dist/demo');
  await buildDemo(outDir);
  console.log(`demo built in ${path.relative(root, outDir)}`);
}
