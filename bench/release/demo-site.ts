// SPDX-License-Identifier: Apache-2.0
// The demo as served by the browser tests: built from source into a directory (the release copies the same files).

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildEngine, buildRating, buildUi } from '../../tools/bundle.ts';

export async function buildDemoSite(dir: string, version = '0.0.0-test'): Promise<void> {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const engine = await buildEngine(version);
  writeFileSync(join(dir, 'livemira-engine.min.mjs'), engine.minified.code);
  writeFileSync(join(dir, 'livemira-ui.min.mjs'), await buildUi(version, 'minified'));
  writeFileSync(join(dir, 'livemira-target-rating.min.mjs'), (await buildRating(version)).minified.code);
  for (const f of ['index.html', 'demo.js', 'targets.html', 'rate.html', 'rate.js']) copyFileSync(join('demo', f), join(dir, f));
  for (const f of readdirSync('bench/release/assets'))
    copyFileSync(join('bench/release/assets', f), join(dir, 'assets', f));
}
