/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Serves probe pages on 127.0.0.1 (a secure context, so camera APIs exist). A probe is a TypeScript module in
// tests/browser/probes; it is bundled with esbuild on request and loaded by a minimal full-viewport page.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '../../..');
const PROBE_NAME = /^\/probes\/([a-z0-9-]+)\.(html|js)$/;
/** The vision Worker, bundled from the engine sources (probes pass a workerFactory that loads it). */
export const WORKER_PATH = '/worker/vision.js';

const page = (name: string): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<title>${name}</title>`,
    '<style>html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }</style>',
    '<body>',
    `<script type="module" src="/probes/${name}.js"></script>`,
    '</html>',
    '',
  ].join('\n');

async function bundleProbe(name: string): Promise<string> {
  return bundle(`tests/browser/probes/${name}.ts`);
}

async function bundle(entry: string): Promise<string> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const [output] = result.outputFiles;
  if (output === undefined) throw new Error(`No bundle for ${entry}`);
  return output.text;
}

export interface ProbeServer {
  /** Address of a probe page, e.g. url('synthetic-camera'). */
  url(probe: string): string;
  close(): Promise<void>;
}

export async function startProbeServer(): Promise<ProbeServer> {
  const server: Server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === WORKER_PATH) {
      bundle('packages/sdk/src/worker/worker-entry.ts').then(
        (text) =>
          response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(text),
        (error: unknown) =>
          response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error)),
      );
      return;
    }
    const match = PROBE_NAME.exec(pathname);
    const [, name, kind] = match ?? [];
    if (name === undefined || kind === undefined) {
      response.writeHead(404).end();
      return;
    }
    if (kind === 'html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(name));
      return;
    }
    bundleProbe(name).then(
      (text) =>
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(text),
      (error: unknown) =>
        response.writeHead(500, { 'content-type': 'text/plain' }).end(String(error)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (probe) => `http://127.0.0.1:${port}/probes/${probe}.html`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
