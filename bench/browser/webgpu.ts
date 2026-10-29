// SPDX-License-Identifier: Apache-2.0
// B2 feasibility probe (test side): runs bench/browser/page-webgpu.ts in headless Chromium and WebKit on one S2
// frame and records availability, adapter, exactness against the CPU references, and per-frame timings. Headless
// adapters may be software (SwiftShader) or the host GPU; either way the timings say nothing about phones.
//   node bench/browser/webgpu.ts [--browsers chromium,webkit]

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { build } from 'esbuild';
import { chromium, webkit, type Browser } from 'playwright-core';

import { CAMERA, renderSequence, sceneTarget, sequences } from '../src/scene/suites.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const OUT = join('bench', 'results', 'browser');
const DIST = join(OUT, 'dist-webgpu');
const MIME: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html' };

mkdirSync(DIST, { recursive: true });
await build({
  entryPoints: ['bench/browser/page-webgpu.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(DIST, 'page.js'),
  logLevel: 'silent',
});
writeFileSync(
  join(DIST, 'index.html'),
  '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>',
);
const frame = renderSequence(
  sceneTarget('poster'),
  sequences().find((s) => s.id === 'T3-shake')!,
)[0]!;
writeFileSync(join(DIST, 'frame.gray'), frame.image);

const server = createServer((req, res) => {
  const path = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\/$/, '/index.html')));
  try {
    const body = readFileSync(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const results: Record<string, unknown>[] = [];
for (const name of (option('browsers') ?? 'chromium,webkit').split(',')) {
  let browser: Browser;
  try {
    browser =
      name === 'chromium'
        ? await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu'] })
        : await webkit.launch({
            headless: true,
            ...(process.env.LIVEMIRA_WEBKIT_PATH ? { executablePath: process.env.LIVEMIRA_WEBKIT_PATH } : {}),
          });
  } catch (e) {
    results.push({ browser: name, error: `launch: ${String(e).slice(0, 200)}` });
    continue;
  }
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/?w=${CAMERA.width}&h=${CAMERA.height}`);
  await page.waitForFunction(() => (globalThis as unknown as { __webgpu: unknown }).__webgpu !== null, null, {
    timeout: 120_000,
  });
  const result = (await page.evaluate(() => (globalThis as unknown as { __webgpu: unknown }).__webgpu)) as Record<
    string,
    unknown
  >;
  const version = browser.version();
  await browser.close();
  results.push({ browser: name, version, ...result });
  console.log(JSON.stringify(results.at(-1)));
}
server.close();
writeFileSync(join(OUT, 'webgpu-results.json'), `${JSON.stringify(results, null, 2)}\n`);
