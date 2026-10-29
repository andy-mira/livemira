// SPDX-License-Identifier: Apache-2.0
// Browser probes (test side): the real engine in headless Chromium (file-backed fake camera, Y4M) and WebKit (canvas
// camera), on synthetic sequences whose frames carry their number in a bottom-left strip. Measures capture path,
// main-thread and draw cost, Worker timings, and, for frame-locked composition, the registration of every drawn
// overlay against the ground truth of the very frame drawn behind it.
//   node bench/browser/run.ts [--browsers chromium,webkit] [--sequences T1-static,T3-shake] [--seconds 6]

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

import { build } from 'esbuild';
import { chromium, webkit, type Browser } from 'playwright-core';

import { cornersOf } from '@livemira-next/contracts';
import { compileTarget, encodeTarget } from '@livemira-next/features';

import { cornerError, diagonal, quantile } from '../src/metrics/sequence.ts';
import {
  CAMERA,
  TARGET_GEOMETRY,
  renderSequence,
  sceneTarget,
  sequences,
  type GroundTruthFrame,
} from '../src/scene/suites.ts';
import { installFakeCamera } from './fake-camera.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const OUT = join('bench', 'results', 'browser');
const DIST = join(OUT, 'dist');
const W = CAMERA.width;
const H = CAMERA.height;

/** Burns the frame number into the bottom-left 128×8 strip (16 cells of 8 px, LSB first). */
function stamp(image: Uint8Array, index: number): Uint8Array {
  const out = new Uint8Array(image);
  for (let bit = 0; bit < 16; bit++) {
    const v = (index >> bit) & 1 ? 235 : 16;
    for (let y = H - 8; y < H; y++) for (let x = bit * 8; x < bit * 8 + 8; x++) out[y * W + x] = v;
  }
  return out;
}

function y4m(frames: readonly Uint8Array[]): Buffer {
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const parts: Buffer[] = [header];
  for (const f of frames) parts.push(Buffer.from('FRAME\n'), Buffer.from(f), chroma);
  return Buffer.concat(parts);
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.json': 'application/json',
};

async function bundle(): Promise<void> {
  mkdirSync(DIST, { recursive: true });
  for (const [entry, out] of [
    ['bench/browser/page.ts', 'page.js'],
    ['bench/browser/page-b0.ts', 'page-b0.js'],
    ['bench/prototype/worker-main.ts', 'worker.js'],
    ['bench/prototype/relocalize-main.ts', 'relocalize-worker.js'],
  ] as const) {
    await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      target: 'es2022',
      outfile: join(DIST, out),
      logLevel: 'silent',
      minify: true,
      // The prototype pages read the vision Worker's per-frame diagnostics (compiled out of releases).
      define: { __LIVEMIRA_DIAGNOSTICS__: 'true' },
    });
  }
  const shell = (script: string): string =>
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}#stage{position:relative;width:640px;height:360px;overflow:hidden}</style><div id="stage"></div><script type="module" src="/${script}"></script>`;
  writeFileSync(join(DIST, 'index.html'), shell('page.js'));
  writeFileSync(join(DIST, 'b0.html'), shell('page-b0.js'));
  // The baseline release engine (single file, embedded Worker), served as is.
  writeFileSync(
    join(DIST, 'livemira-engine.mjs'),
    readFileSync(join('..', 'livemira-github', 'release', '0.4.1', 'files', 'livemira-engine.mjs')),
  );
}

interface Run {
  readonly browser: string;
  readonly compositor: string;
  readonly sequence: string;
  readonly info: Record<string, unknown> | null;
  readonly error: string | null;
  readonly stats: Record<string, number> | null;
  readonly processedFps: number;
  readonly presentedFps: number;
  readonly trackErrP50: number | null;
  readonly registrationP50: number | null;
  readonly registrationP95: number | null;
  readonly lumaPaths: string[];
  /** Navigation → engine ready (targets compiled, camera running), and → first pose, ms. */
  readonly readyMs: number | null;
  readonly firstPoseMs: number | null;
  /** Chromium: main-thread task time per camera frame over the window (all page work, any engine), ms. */
  readonly mainPerFrameMs: number | null;
  /** 99th percentile of the gap between consecutive presentations (frame-locked: display hitches), ms. */
  readonly presentGapP99Ms: number | null;
}

function relError(corners: readonly (readonly number[])[], truth: GroundTruthFrame): number | null {
  if (!truth.H || corners.length < 4) return null;
  const t = cornersOf(truth.H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
  const c = corners.slice(0, 4).map((p) => [p[0]!, p[1]!] as const) as unknown as typeof t;
  return cornerError(c, t) / diagonal(t);
}

async function main(): Promise<void> {
  const browsers = (option('browsers') ?? 'chromium,webkit').split(',');
  const wanted = (option('sequences') ?? 'T1-static,T3-shake,T5-roll').split(',');
  const seconds = Number(option('seconds') ?? 6);
  const compositors = (option('compositors') ?? 'frame-locked,css').split(',');
  await bundle();
  const target = sceneTarget('poster');
  const distractor = sceneTarget('graphic');
  mkdirSync(join(DIST, 'targets'), { recursive: true });
  writeFileSync(
    join(DIST, 'targets.json'),
    JSON.stringify([target, distractor].map((t) => ({ id: t.id, width: 640, height: 480 }))),
  );
  mkdirSync(join(DIST, 'assets'), { recursive: true });
  for (const t of [target, distractor]) {
    writeFileSync(join(DIST, 'targets', `${t.id}.gray`), t.gray);
    const info = { id: t.id, width: 640, height: 480, physicalWidthMeters: 0.2 };
    const image = { width: 640, height: 480, stride: 640, data: t.gray };
    writeFileSync(join(DIST, 'assets', `${t.id}.lmt`), await encodeTarget(compileTarget({ info, image }), image));
  }
  const specs = sequences().filter((s) => wanted.includes(s.id));
  const truth = new Map<string, GroundTruthFrame[]>();
  for (const spec of specs) {
    const frames = renderSequence(target, spec);
    truth.set(spec.id, frames);
    const stamped = frames.map((f) => stamp(f.image, f.index));
    writeFileSync(join(DIST, `${spec.id}.y4m`), y4m(stamped));
    writeFileSync(join(DIST, `${spec.id}.gray`), Buffer.concat(stamped.map((f) => Buffer.from(f))));
  }
  const server = createServer((req, res) => {
    const path = join(DIST, decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\/$/, '/index.html')));
    try {
      const body = readFileSync(path);
      res.writeHead(200, {
        'content-type': MIME[extname(path)] ?? 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const runs: Run[] = [];
  for (const name of browsers)
    for (const spec of specs)
      for (const compositor of compositors) {
        const frames = truth.get(spec.id)!;
        let browser: Browser;
        if (name === 'chromium')
          browser = await chromium.launch({
            headless: true,
            args: [
              '--use-fake-ui-for-media-stream',
              '--use-fake-device-for-media-stream',
              `--use-file-for-fake-video-capture=${join(process.cwd(), DIST, `${spec.id}.y4m`)}`,
              '--enable-unsafe-webgpu',
            ],
          });
        else
          browser = await webkit.launch({
            headless: true,
            ...(process.env.LIVEMIRA_WEBKIT_PATH ? { executablePath: process.env.LIVEMIRA_WEBKIT_PATH } : {}),
          });
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
        if (name === 'chromium') await context.grantPermissions(['camera'], { origin: `http://127.0.0.1:${port}` });
        else
          await context.addInitScript(installFakeCamera, {
            url: `/${spec.id}.gray`,
            width: W,
            height: H,
            frames: frames.length,
          });
        const page = await context.newPage();
        const cdp = name === 'chromium' ? await context.newCDPSession(page) : null;
        await cdp?.send('Performance.enable');
        const [kind, variant] = compositor.split(':');
        await page.goto(
          compositor === 'baseline'
            ? `http://127.0.0.1:${port}/b0.html`
            : `http://127.0.0.1:${port}/?compositor=${kind}${variant ? `&variant=${variant}` : ''}`,
        );
        await page.waitForFunction(
          () => {
            const p = (globalThis as unknown as { __probe?: { info: unknown; error: unknown } }).__probe;
            return p && (p.info || p.error);
          },
          null,
          { timeout: 60_000 },
        );
        const taskSeconds = async (): Promise<number> => {
          const metrics =
            ((await cdp?.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] } | undefined)
              ?.metrics ?? [];
          return metrics.find((m) => m.name === 'TaskDuration')?.value ?? NaN;
        };
        await page.waitForTimeout(1500);
        const taskBefore = await taskSeconds();
        await page.waitForTimeout(seconds * 1000);
        const taskAfter = await taskSeconds();
        /** Main-thread task time per camera frame (30 fps), ms; Chromium only. */
        const mainPerFrameMs = ((taskAfter - taskBefore) * 1000) / (seconds * 30);
        const record = (await page.evaluate(() => (globalThis as unknown as { __probe: unknown }).__probe)) as {
          results: { t: number; strip: number[] | null; corners: number[][]; lumaPath: string }[];
          updates?: number;
          presents: { t: number; tag: number[] | null; corners: number[][] }[];
          info: Record<string, unknown> | null;
          error: string | null;
          readyMs: number | null;
          firstPoseMs: number | null;
        };
        const stats = (await page.evaluate(
          () => (globalThis as unknown as { __stats?: () => unknown }).__stats?.() ?? null,
        )) as Record<string, number> | null;
        await browser.close();
        const frameOf = (code: number[] | null): GroundTruthFrame | null =>
          code && code[0]! >= 0 ? frames[code[0]! % frames.length]! : null;
        const track = record.results
          .map((r) => {
            const f = frameOf(r.strip);
            return f && f.visible >= 0.5 ? relError(r.corners, f) : null;
          })
          .filter((e): e is number => e !== null);
        const reg = record.presents
          .map((p) => {
            const f = frameOf(p.tag);
            return f && f.visible >= 0.5 ? relError(p.corners, f) : null;
          })
          .filter((e): e is number => e !== null);
        const span = (list: { t: number }[]): number => (list.length > 1 ? (list.at(-1)!.t - list[0]!.t) / 1000 : 1);
        runs.push({
          browser: name,
          compositor,
          sequence: spec.id,
          info: record.info,
          error: record.error,
          stats,
          processedFps: record.results.length / span(record.results),
          presentedFps: record.presents.length / span(record.presents),
          trackErrP50: quantile(track, 0.5),
          registrationP50: quantile(reg, 0.5),
          registrationP95: quantile(reg, 0.95),
          lumaPaths: [...new Set(record.results.map((r) => r.lumaPath))],
          readyMs: record.readyMs,
          firstPoseMs: record.firstPoseMs,
          mainPerFrameMs: Number.isFinite(mainPerFrameMs) ? mainPerFrameMs : null,
          presentGapP99Ms: quantile(
            record.presents.slice(1).map((p, i) => p.t - record.presents[i]!.t),
            0.99,
          ),
        });
        const last = runs.at(-1)!;
        console.log(
          `${name} ${compositor} ${spec.id}: path=${String(last.info?.capturePath)} fps=${last.processedFps.toFixed(1)} track50=${last.trackErrP50 === null ? '—' : (100 * last.trackErrP50).toFixed(2)}% reg95=${last.registrationP95 === null ? '—' : (100 * last.registrationP95).toFixed(2)}% main=${stats ? (stats.mainThreadUs! / 1000).toFixed(2) : '—'}ms mainTask=${last.mainPerFrameMs?.toFixed(2)}ms/frame gap99=${last.presentGapP99Ms?.toFixed(0)}ms ready=${last.readyMs?.toFixed(0)}ms firstPose=${last.firstPoseMs?.toFixed(0)}ms ${last.error ? `ERROR ${last.error.slice(0, 160)}` : ''}`,
        );
      }
  server.close();
  writeFileSync(join(OUT, 'browser-results.json'), `${JSON.stringify(runs, null, 2)}\n`);
}

await main();
