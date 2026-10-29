// SPDX-License-Identifier: Apache-2.0
// Shipped size of a pipeline: an esbuild bundle (ESM, es2022, minified) of the product exports it uses, gzipped.

import { gzipSync } from 'node:zlib';

import { build } from 'esbuild';

const cache = new Map<string, number>();

/** Gzip bytes of a minified bundle of `source` (an entry module of re-exports), resolved from the workspace root. */
export async function bundleGzipBytes(source: string): Promise<number> {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  const result = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'entry.ts' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    platform: 'browser',
    logLevel: 'silent',
  });
  const bytes = gzipSync(result.outputFiles[0]!.contents, { level: 9 }).length;
  cache.set(source, bytes);
  return bytes;
}
