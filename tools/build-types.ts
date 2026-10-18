/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Merges the declarations of the engine and of each optional extension into one .d.ts per published module (API
// Extractor), and keeps an API report per module in api/ so every change of the public API shows in review.
// Needs the declarations emitted by `tsc -b`.
// Usage: node tools/build-types.ts [--out-dir <dir>]   writes the .d.ts files (default: dist) and updates api/
//        node tools/build-types.ts --check             fails when an API report is out of date; writes nothing
// Tests use the 'rollup' mode: the .d.ts files only, and a failure when a report is out of date (api/ is never
// written by a test).

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';

const root = path.resolve(import.meta.dirname, '..');

/** Published modules: the declaration file name and the package whose entry it describes. */
export const MODULES = [
  { file: 'livemira-engine', dir: 'sdk', name: '@livemira/engine' },
  {
    file: 'livemira-tracking-visuals',
    dir: 'tracking-visuals',
    name: '@livemira/tracking-visuals',
  },
  {
    file: 'livemira-recognition-diagnostics',
    dir: 'recognition-diagnostics',
    name: '@livemira/recognition-diagnostics',
  },
  { file: 'livemira-target-quality', dir: 'target-quality', name: '@livemira/target-quality' },
  { file: 'livemira-ui', dir: 'ui', name: '@livemira/ui' },
] as const;

const packageDirs = (): string[] =>
  readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

const nameOf = (dir: string): string => (dir === 'sdk' ? '@livemira/engine' : `@livemira/${dir}`);

/** Workspace packages resolve to their emitted declarations, not to their TypeScript sources. */
function paths(): Record<string, string[]> {
  return Object.fromEntries(
    packageDirs().map((dir) => [
      nameOf(dir),
      [path.join(root, `packages/${dir}/dist/src/index.d.ts`)],
    ]),
  );
}

export interface TypesOutcome {
  readonly module: string;
  readonly succeeded: boolean;
  readonly apiReportChanged: boolean;
  readonly messages: readonly string[];
}

/** 'write': declarations and updated reports; 'check': nothing written; 'rollup': declarations, reports left alone. */
export type TypesMode = 'write' | 'check' | 'rollup';

function extract(module: (typeof MODULES)[number], outDir: string, mode: TypesMode): TypesOutcome {
  const isCheck = mode === 'check';
  // Each module's declarations are self-contained: workspace packages are inlined.
  const bundled = packageDirs()
    .map(nameOf)
    .filter((name) => name !== module.name);
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: root,
      mainEntryPointFilePath: path.join(root, `packages/${module.dir}/dist/src/index.d.ts`),
      bundledPackages: bundled,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'Bundler',
            lib: ['ES2022', 'DOM', 'DOM.Iterable', 'WebWorker.ImportScripts'],
            allowImportingTsExtensions: true,
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            types: [],
            paths: paths(),
          },
          files: [`packages/${module.dir}/dist/src/index.d.ts`],
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: `${module.file}.api.md`,
        reportFolder: path.join(root, 'api'),
        reportTempFolder: path.join(tmpdir(), 'livemira-api-temp'),
      },
      docModel: { enabled: false },
      tsdocMetadata: { enabled: false },
      dtsRollup: {
        enabled: !isCheck,
        untrimmedFilePath: path.join(outDir, `${module.file}.d.ts`),
      },
      messages: {
        compilerMessageReporting: { default: { logLevel: ExtractorLogLevel.Warning } },
        extractorMessageReporting: {
          default: { logLevel: ExtractorLogLevel.Warning },
          // The packages do not use release tags (@public, @beta): everything exported is public.
          'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
          // Field-level documentation is reviewed in the API report rather than required for every member.
          'ae-undocumented': { logLevel: ExtractorLogLevel.None },
          // An extension's declarations include the engine and contract types it uses; users name them from the
          // engine. The engine itself must export every type of its public API.
          ...(module.dir === 'sdk'
            ? {}
            : { 'ae-forgotten-export': { logLevel: ExtractorLogLevel.None } }),
        },
        tsdocMessageReporting: { default: { logLevel: ExtractorLogLevel.None } },
      },
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: path.join(root, `packages/${module.dir}/package.json`),
  });
  const messages: string[] = [];
  const result = Extractor.invoke(config, {
    localBuild: mode === 'write',
    showVerboseMessages: false,
    messageCallback: (message) => {
      if (
        message.logLevel === ExtractorLogLevel.Warning ||
        message.logLevel === ExtractorLogLevel.Error
      )
        messages.push(`${message.messageId}: ${message.text}`);
      message.handled = true;
    },
  });
  return {
    module: module.file,
    succeeded: result.succeeded && result.warningCount === 0,
    apiReportChanged: result.apiReportChanged,
    messages,
  };
}

export function buildTypes(outDir: string, mode: TypesMode = 'write'): TypesOutcome[] {
  if (mode !== 'check') mkdirSync(outDir, { recursive: true });
  mkdirSync(path.join(root, 'api'), { recursive: true });
  try {
    return MODULES.map((module) => extract(module, outDir, mode));
  } finally {
    rmSync(path.join(tmpdir(), 'livemira-api-temp'), { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const isCheck = args.includes('--check');
  const index = args.indexOf('--out-dir');
  const outDir = path.resolve(root, index >= 0 ? (args[index + 1] ?? 'dist') : 'dist');
  let isFailed = false;
  for (const outcome of buildTypes(outDir, isCheck ? 'check' : 'write')) {
    for (const message of outcome.messages) console.error(`${outcome.module}: ${message}`);
    if (!outcome.succeeded) isFailed = true;
    if (isCheck && outcome.apiReportChanged) {
      console.error(
        `${outcome.module}: the API report in api/ is out of date; run npm run build:types and review it`,
      );
      isFailed = true;
    }
    if (!isCheck)
      console.log(
        `${outcome.module}: ${outcome.succeeded ? 'ok' : 'failed'}${outcome.apiReportChanged ? ' (API report updated)' : ''}`,
      );
  }
  if (isFailed) process.exitCode = 1;
}
