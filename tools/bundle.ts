// SPDX-License-Identifier: Apache-2.0
// Bundles of the product: the engine's one Worker script, the single-file engine with that Worker embedded, the camera
// UI, and the target rating with its own Worker embedded. Used by the release (tools/release.ts) and by the browser
// tests.

import { createHash } from 'node:crypto';

import { build } from 'esbuild';

export type Variant = 'minified' | 'readable';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

async function bundle(options: {
  entry: string;
  format: 'esm' | 'iife';
  minify: boolean;
  define?: Record<string, string>;
}): Promise<string> {
  const result = await build({
    entryPoints: [options.entry],
    bundle: true,
    write: false,
    format: options.format,
    platform: 'browser',
    // Safari 15 / Chrome 94: module Workers, top-level await not needed, class fields.
    target: ['es2021', 'safari15', 'chrome94'],
    minify: options.minify,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'silent',
    define: options.define ?? {},
  });
  return result.outputFiles[0]!.text;
}

/** A module with its Worker embedded, that Worker script on its own (for strict CSPs), and the build id. */
export interface WorkerModuleBundle {
  readonly code: string;
  readonly workerCode: string;
  readonly buildId: string;
}

const PLACEHOLDER_ID = '0'.repeat(64);

/**
 * The engine module with its Worker embedded. The build id is the SHA-256 of the minified Worker and the minified
 * engine built with a placeholder id; both variants carry the same id (they are the same build).
 */
export async function buildEngine(
  version: string,
  options: { readonly diagnostics?: boolean } = {},
): Promise<Record<Variant, WorkerModuleBundle>> {
  // Device-kit builds only: per-frame traces and orientation reports (packages/web/src/vision-worker.ts,
  // packages/engine/src/session.ts); releases compile them out.
  const diagnostics = { __LIVEMIRA_DIAGNOSTICS__: JSON.stringify(!!options.diagnostics) };
  const worker = {
    minified: await bundle({
      entry: 'packages/engine/src/worker-entry.ts',
      format: 'iife',
      minify: true,
      define: diagnostics,
    }),
    readable: await bundle({
      entry: 'packages/engine/src/worker-entry.ts',
      format: 'iife',
      minify: false,
      define: diagnostics,
    }),
  };
  const engineWith = (variant: Variant, buildId: string): Promise<string> =>
    bundle({
      entry: 'packages/engine/src/index.ts',
      format: 'esm',
      minify: variant === 'minified',
      define: {
        __LIVEMIRA_WORKER_CODE__: JSON.stringify(worker.minified),
        __LIVEMIRA_VERSION__: JSON.stringify(version),
        __LIVEMIRA_BUILD_ID__: JSON.stringify(buildId),
        __LIVEMIRA_VARIANT__: JSON.stringify(variant),
        ...diagnostics,
      },
    });
  const probe = await engineWith('minified', PLACEHOLDER_ID);
  const buildId = sha256(worker.minified + probe);
  return {
    minified: { code: await engineWith('minified', buildId), workerCode: worker.minified, buildId },
    readable: { code: await engineWith('readable', buildId), workerCode: worker.readable, buildId },
  };
}

/**
 * The target rating module with its Worker embedded; independent of the engine (its own build id), so a page can rate
 * pictures without loading the engine.
 */
export async function buildRating(version: string): Promise<Record<Variant, WorkerModuleBundle>> {
  const worker = {
    minified: await bundle({ entry: 'packages/rating/src/worker-entry.ts', format: 'iife', minify: true }),
    readable: await bundle({ entry: 'packages/rating/src/worker-entry.ts', format: 'iife', minify: false }),
  };
  const ratingWith = (variant: Variant, buildId: string): Promise<string> =>
    bundle({
      entry: 'packages/rating/src/index.ts',
      format: 'esm',
      minify: variant === 'minified',
      define: {
        __LIVEMIRA_RATING_WORKER_CODE__: JSON.stringify(worker.minified),
        __LIVEMIRA_VERSION__: JSON.stringify(version),
        __LIVEMIRA_BUILD_ID__: JSON.stringify(buildId),
        __LIVEMIRA_VARIANT__: JSON.stringify(variant),
      },
    });
  const buildId = sha256(worker.minified + (await ratingWith('minified', PLACEHOLDER_ID)));
  return {
    minified: { code: await ratingWith('minified', buildId), workerCode: worker.minified, buildId },
    readable: { code: await ratingWith('readable', buildId), workerCode: worker.readable, buildId },
  };
}

/** The camera UI module (no engine code inside: the page passes the engine module in). */
export async function buildUi(version: string, variant: Variant): Promise<string> {
  return bundle({
    entry: 'packages/ui/src/index.ts',
    format: 'esm',
    minify: variant === 'minified',
    define: { __LIVEMIRA_UI_VERSION__: JSON.stringify(version) },
  });
}
