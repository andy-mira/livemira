// SPDX-License-Identifier: Apache-2.0
// Checks a release against LiveMorae's integration without touching the LiveMorae repository: its own sync script
// installs the release into a temporary tree, its scan host files (copied) are type-checked against the installed
// UI package with its compiler settings, and the installed engine is imported the way its release test does.
//
//   node bench/release/livemorae-compat.ts <absolute release dir> [<LiveMorae web dir>, default $LIVEMORAE_WEB]

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = resolve(process.argv[2] ?? '');
const web = resolve(process.argv[3] ?? process.env.LIVEMORAE_WEB ?? '');
const manifest = JSON.parse(readFileSync(join(release, 'release-manifest.json'), 'utf8')) as {
  version: string;
  buildId: string;
};
const tmp = mkdtempSync(join(tmpdir(), 'livemorae-compat-'));
let failed = false;
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  failed ||= !ok;
};

try {
  // 1. LiveMorae's own installer, into a scratch tree.
  const sync = (await import(pathToFileURL(join(web, 'scripts/sync-livemira.mjs')).href)) as {
    syncLiveMira(options: { from: string; assets: string; vendor: string }): Promise<{
      engine: { version: string; buildId: string; runtime: string };
      ui: { name: string; version: string };
    }>;
  };
  const assets = join(tmp, 'public/assets/livemira');
  const vendor = join(tmp, 'vendor/livemira-ui');
  const installed = await sync.syncLiveMira({ from: release, assets, vendor });
  check(installed.engine.version === manifest.version, `sync installs engine ${installed.engine.version}`);
  check(installed.ui.name === '@livemira/ui' && installed.ui.version === manifest.version, 'sync installs @livemira/ui');

  // 2. The installed engine, imported like tests/liveMiraRelease.test.ts does.
  const engine = (await import(pathToFileURL(join(assets, manifest.version, installed.engine.runtime)).href)) as Record<
    string,
    unknown
  > & { engineBuildInfo: { buildId: string; variant: string } };
  check(engine.ENGINE_VERSION === manifest.version, 'ENGINE_VERSION matches the manifest');
  check(engine.engineBuildInfo.buildId === manifest.buildId, 'buildId matches the manifest');
  check(engine.engineBuildInfo.variant === 'minified', "variant is 'minified'");
  for (const name of ['createEngine', 'compileTargetImage', 'parseTarget'])
    check(typeof engine[name] === 'function', `engine exports ${name}`);

  // 3. The host files, type-checked against the installed UI with LiveMorae's settings (version bumped as the
  //    upgrade notes say).
  const src = join(tmp, 'src');
  for (const file of [
    'types.ts',
    'i18n/locale.ts',
    'i18n/translate.ts',
    'i18n/messages',
    'features/scan/mountScanCamera.ts',
    'features/scan/ScanController.ts',
    'features/scan/scanConfig.ts',
    'features/scan/scanTargets.ts',
    'features/scan/scanMessages.ts',
    'features/scan/scanEngine.ts',
    'features/scan/publicMedia.ts',
  ])
    cpSync(join(web, 'src', file), join(src, file), { recursive: true });
  const engineFile = join(src, 'features/scan/scanEngine.ts');
  writeFileSync(
    engineFile,
    readFileSync(engineFile, 'utf8').replace(/ENGINE_VERSION = '[^']+'/, `ENGINE_VERSION = '${manifest.version}'`),
  );
  mkdirSync(join(tmp, 'node_modules/@livemira'), { recursive: true });
  symlinkSync(vendor, join(tmp, 'node_modules/@livemira/ui'));
  const tsconfig = JSON.parse(readFileSync(join(web, 'tsconfig.json'), 'utf8')) as {
    compilerOptions: Record<string, unknown>;
  };
  writeFileSync(
    join(tmp, 'tsconfig.json'),
    JSON.stringify({
      // The UI's declarations are checked too (LiveMorae itself skips library checks).
      compilerOptions: { ...tsconfig.compilerOptions, skipLibCheck: false, types: [] },
      include: ['src/features/scan', 'src/types.ts'],
    }),
  );
  let typeErrors = '';
  try {
    execFileSync(join(process.cwd(), 'node_modules/.bin/tsc'), ['-p', join(tmp, 'tsconfig.json')], { stdio: 'pipe' });
  } catch (error) {
    typeErrors = String((error as { stdout?: Buffer }).stdout ?? error);
  }
  check(!typeErrors, `LiveMorae's scan host type-checks against the new UI${typeErrors ? `:\n${typeErrors}` : ''}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? 'FAILED' : 'compatible');
process.exit(failed ? 1 : 0);
