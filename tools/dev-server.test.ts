/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { gunzipSync } from 'node:zlib';

import { serve } from './dev-server.ts';

let dir: string;
let server: ReturnType<typeof serve>;
const lines: string[] = [];

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'livemira-dev-'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  writeFileSync(path.join(dir, 'clip.webm'), Buffer.alloc(1000, 7));
  server = serve(dir, 0, { log: (line) => lines.push(line) });
  await new Promise((resolve) => server.once('listening', resolve));
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const get = (target: string, range?: string, extra: Record<string, string> = {}) =>
  new Promise<{
    status: number;
    length: number;
    body: Buffer;
    headers: Record<string, string | undefined>;
  }>((resolve) => {
    const port = (server.address() as AddressInfo).port;
    const req = request(
      { host: '127.0.0.1', port, path: target, headers: { ...(range ? { range } : {}), ...extra } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            length: body.length,
            body,
            headers: res.headers as Record<string, string | undefined>,
          });
        });
      },
    );
    req.end();
  });

test('the index and byte ranges (needed for video on Safari) are served', async () => {
  assert.equal((await get('/')).status, 200);
  const part = await get('/clip.webm', 'bytes=100-199');
  assert.equal(part.status, 206);
  assert.equal(part.length, 100);
  assert.equal(part.headers['content-range'], 'bytes 100-199/1000');
  const tail = await get('/clip.webm', 'bytes=-10');
  assert.equal(tail.headers['content-range'], 'bytes 990-999/1000');
  assert.equal((await get('/clip.webm', 'bytes=5000-')).status, 416);
});

test('nothing outside the folder is served, and requests are logged', async () => {
  assert.equal((await get('/../package.json')).status, 404);
  assert.equal((await get('/missing.js')).status, 404);
  assert.ok(lines.some((line) => / GET \/clip\.webm 206$/.test(line)));
});

test('a reload only revalidates, and text is compressed for clients that accept it', async () => {
  const first = await get('/index.html');
  assert.equal(first.headers['cache-control'], 'no-cache');
  const etag = first.headers['etag']!;
  const again = await get('/index.html', undefined, { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.length, 0);
  const zipped = await get('/index.html', undefined, { 'accept-encoding': 'gzip, br' });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(zipped.body).toString(), '<!doctype html>');
  // Video stays as it is: byte ranges index the plain file.
  const clip = await get('/clip.webm', undefined, { 'accept-encoding': 'gzip' });
  assert.equal(clip.headers['content-encoding'], undefined);
  assert.equal(clip.length, 1000);
});

test('a request handler answers before the static files', async () => {
  const custom = serve(dir, 0, {
    handle: (request, response) => {
      if (request.url !== '/results') return false;
      response.writeHead(204).end();
      return true;
    },
  });
  await new Promise((resolve) => custom.once('listening', resolve));
  const port = (custom.address() as AddressInfo).port;
  const status = (target: string) =>
    new Promise<number>((resolve) =>
      request({ host: '127.0.0.1', port, path: target }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).end(),
    );
  assert.equal(await status('/results'), 204);
  assert.equal(await status('/'), 200);
  await new Promise((resolve) => custom.close(resolve));
});
