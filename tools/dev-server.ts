/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The development server: a static server for the built demo (or any folder) with Range requests, which video
// playback needs on Safari. 127.0.0.1 is a secure context, so the camera works on this computer; phones reach it
// through a temporary tunnel. Each request is appended to logs/dev-server.log (ignored by Git). A tunnel can be slow, so
// a reload only revalidates (ETag, 304) and text files are sent compressed; a rebuilt file is never served stale.
// Usage: node tools/dev-server.ts [--dir <dir>] [--port <port>]   (default: dist/demo, 5173)

import { appendFileSync, createReadStream, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { createGzip } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const COMPRESSED = new Set(['.html', '.js', '.mjs', '.json', '.md', '.css']);

export function serve(
  dir: string,
  port: number,
  options: {
    log?: (line: string) => void;
    /** Answers a request before the static files (true when it did), e.g. a test page posting its results. */
    handle?: (request: IncomingMessage, response: ServerResponse) => boolean;
  } = {},
): ReturnType<typeof createServer> {
  const base = path.resolve(dir);
  const server = createServer((request, response) => {
    response.on('finish', () =>
      options.log?.(
        `${new Date().toISOString()} ${request.method} ${request.url} ${response.statusCode}`,
      ),
    );
    if (options.handle?.(request, response)) return;
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    const file = path.resolve(
      base,
      `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`,
    );
    if (!file.startsWith(base + path.sep) && file !== base) {
      response.writeHead(403).end();
      return;
    }
    try {
      const stat = statSync(file);
      if (!stat.isFile()) throw new Error('not a file');
      // Weak: the same tag names the plain and the compressed body.
      const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
      const headers = {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'accept-ranges': 'bytes',
        'cache-control': 'no-cache',
        etag,
      };
      const known = (request.headers['if-none-match'] ?? '').split(',').map((tag) => tag.trim());
      if (known.includes(etag)) {
        response.writeHead(304, { 'cache-control': 'no-cache', etag }).end();
        return;
      }
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        // "bytes=a-b", "bytes=a-" or the last n bytes "bytes=-n".
        const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
        const end =
          range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          response.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
          return;
        }
        response.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${stat.size}`,
          'content-length': end - start + 1,
        });
        createReadStream(file, { start, end }).pipe(response);
        return;
      }
      if (
        COMPRESSED.has(path.extname(file)) &&
        /\bgzip\b/.test(request.headers['accept-encoding'] ?? '')
      ) {
        response.writeHead(200, {
          ...headers,
          'content-encoding': 'gzip',
          vary: 'accept-encoding',
        });
        createReadStream(file).pipe(createGzip()).pipe(response);
        return;
      }
      response.writeHead(200, { ...headers, 'content-length': stat.size });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string, fallback: string): string => {
    const index = args.indexOf(flag);
    return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
  };
  const dir = path.resolve(root, value('--dir', 'dist/demo'));
  const port = Number(value('--port', '5173'));
  mkdirSync(path.join(root, 'logs'), { recursive: true });
  const logFile = path.join(root, 'logs/dev-server.log');
  serve(dir, port, { log: (line) => appendFileSync(logFile, `${line}\n`) });
  console.log(`serving ${path.relative(root, dir) || '.'} at http://127.0.0.1:${port}/`);
}
