// SPDX-License-Identifier: Apache-2.0
// Sends one file the way video players expect of a web server: `Range: bytes=…` requests get 206 with that part
// (WebKit plays a network video only so), others the whole file. Optionally at a limited rate, to watch playback
// start before a download ends.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

export async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: string,
  headers: OutgoingHttpHeaders,
  options: { readonly bytesPerSecond?: number; readonly onSent?: (bytes: number) => void } = {},
): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('not a file');
  const size = info.size;
  let start = 0;
  let end = size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
  // Any valid range is answered with 206, even one covering the whole file (as nginx does; WebKit expects it).
  const partial = !!range && !!(range[1] || range[2]);
  if (partial) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(end, Number(range[2]));
    } else start = Math.max(0, size - Number(range[2]));
    if (start > end) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
  }
  response.writeHead(partial ? 206 : 200, {
    ...headers,
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
    ...(partial ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  const rate = options.bytesPerSecond ?? 0;
  try {
    await pipeline(
      createReadStream(file, { start, end, highWaterMark: 16 * 1024 }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          yield chunk;
          options.onSent?.(chunk.length);
          if (rate) await new Promise((r) => setTimeout(r, (1000 * chunk.length) / rate));
        }
      },
      response,
    );
  } catch {
    // The client went away (players cancel requests they no longer need).
  }
}
