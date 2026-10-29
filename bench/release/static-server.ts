// SPDX-License-Identifier: Apache-2.0
// A static HTTPS file server on localhost for the release's browser tests (a self-signed certificate made on the
// spot; browsers are launched with `ignoreHTTPSErrors`). WebKit refuses camera-like media on plain HTTP even there.
// Files are sent with range support; matching paths can be slowed down, and the bytes sent per path are counted.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { sendFile } from '../src/send-file.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.lmt': 'application/octet-stream',
};

function certificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'livemira-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Serves `root` on localhost at a free port; resolves with its base URL, the bytes sent per path and a close function. */
export async function serveStatic(
  root: string,
  options: { readonly requireCookie?: string; readonly slow?: { readonly match: RegExp; readonly bytesPerSecond: number } } = {},
): Promise<{ url: string; sent: Map<string, number>; close: () => Promise<void> }> {
  const base = resolve(root);
  const sent = new Map<string, number>();
  const server: Server = createServer(certificate(), async (request, response) => {
    try {
      // Like the device kit (an access cookie on every request), so a client that drops cookies fails here too.
      if (options.requireCookie && !(request.headers.cookie ?? '').split(/;\s*/).includes(options.requireCookie)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname);
      let file = resolve(join(base, normalize(path)));
      if (file !== base && !file.startsWith(base + sep)) throw new Error('outside');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      await sendFile(
        request,
        response,
        file,
        { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' },
        {
          bytesPerSecond: options.slow?.match.test(path) ? options.slow.bytesPerSecond : 0,
          onSent: (bytes) => sent.set(path, (sent.get(path) ?? 0) + bytes),
        },
      );
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  return {
    url: `https://localhost:${address.port}`,
    sent,
    close: () => new Promise((done) => server.close(() => done())),
  };
}
