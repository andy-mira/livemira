// SPDX-License-Identifier: Apache-2.0
// End-to-end browser test of the release: the demo (camera UI over the single-file engine) in headless Chromium and
// WebKit with a scripted camera. Checks the whole flow and the error paths, and saves screenshots of each stage to
// bench/results/release/ for a visual check.
//
//   node bench/release/e2e.ts [<release>/demo]   (WebKit from LIVEMIRA_WEBKIT_PATH when set)

import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, webkit, type Browser, type Page } from 'playwright-core';

import { buildDemoSite } from './demo-site.ts';
import { fakeCameraScript } from './fake-camera.ts';
import { serveStatic } from './static-server.ts';

const SHOTS = 'bench/results/release';
mkdirSync(SHOTS, { recursive: true });
// A built release's demo directory may be given; otherwise the demo is built from source.
const given = process.argv[2];
const site = given ?? mkdtempSync(join(tmpdir(), 'livemira-demo-'));
if (!given) await buildDemoSite(site);
// Every request must carry this cookie, as on the device kit and behind a login. The video comes at about twice its
// bitrate (~160 KB/s; a full download takes ~3 s), so playback must start while it is still arriving. Below its
// bitrate WebKit, like iOS, waits until it expects to play through.
const COOKIE = { name: 'lmk', value: 'e2e-access' };
const VIDEO_RATE = 320 * 1024;
const server = await serveStatic(site, {
  requireCookie: `${COOKIE.name}=${COOKIE.value}`,
  slow: { match: /demo-video\./, bytesPerSecond: VIDEO_RATE },
});
const videoSent = (): { bytes: number; size: number } => {
  const [path, bytes] = [...server.sent].find(([p]) => /demo-video\./.test(p)) ?? ['', 0];
  return { bytes, size: path ? statSync(join(site, path)).size : 0 };
};
const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures.push(what);
};

const state = (page: Page): Promise<{ phase?: string; view?: string; text: string }> =>
  page.evaluate(() => {
    const root = document.querySelector('.lm-ar') as HTMLElement | null;
    const visible = [...document.querySelectorAll('.lm-ar__status, .lm-ar__step, .lm-ar__curtain')]
      .filter((n) => !(n as HTMLElement).hidden && !n.closest('[hidden]'))
      .map((n) => n.textContent)
      .join(' | ');
    return { phase: root?.dataset.phase, view: root?.dataset.view, text: visible };
  });

async function until(
  page: Page,
  predicate: (s: Awaited<ReturnType<typeof state>>) => boolean,
  ms: number,
): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate(await state(page))) return true;
    await page.waitForTimeout(40);
  }
  return false;
}

async function open(
  browser: Browser,
  setup: (page: Page) => Promise<void>,
  path = '/index.html?autostart',
): Promise<Page> {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  await context.addCookies([{ ...COOKIE, url: server.url }]);
  const page = await context.newPage();
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  await setup(page);
  await page.goto(server.url + path);
  return page;
}

for (const [name, launcher] of [
  ['chromium', chromium],
  ['webkit', webkit],
] as const) {
  console.log(`\n${name}`);
  const browser = await launcher.launch({
    headless: true,
    ...(name === 'webkit' && process.env.LIVEMIRA_WEBKIT_PATH
      ? { executablePath: process.env.LIVEMIRA_WEBKIT_PATH }
      : {}),
  });
  const shot = (page: Page, label: string): Promise<Buffer> =>
    page.screenshot({ path: `${SHOTS}/${name}-${label}.png` });

  // 1. The whole flow: loader, scanning guide, recognition, the video region while the (slow) video starts streaming,
  //    reveal, playing.
  {
    server.sent.clear();
    const page = await open(browser, (p) =>
      p.addInitScript(...fakeCameraScript({ photo: '/assets/forest-03.png', enterAfterS: 3 })),
    );
    check(await until(page, (s) => s.phase === 'preparing' || s.phase === 'starting', 3000), 'loader while preparing');
    await shot(page, '1-loader');
    check(await until(page, (s) => s.phase === 'scanning', 8000), 'scanning after preparation');
    await page.waitForTimeout(500);
    await shot(page, '2-scanning');
    check((await state(page)).text.includes('请把相机对准'), 'hint while searching');
    check(await until(page, (s) => s.view === 'loading', 6000), 'photo recognised: loading its video');
    await page.waitForTimeout(300);
    await shot(page, '3-loading');
    check(await until(page, (s) => s.view === 'playing', 6000), 'video playing');
    const sent = videoSent();
    // Playwright's macOS WebKit hands a response's data to its video player only once the response is complete (no
    // 'progress' while it arrives, whatever the size, rate or protocol), so there this is left to the phone test.
    const kb = `${Math.round(sent.bytes / 1024)} of ${Math.round(sent.size / 1024)} KB`;
    if (name === 'webkit') console.log(`  – streaming start not checked in this WebKit (${kb} sent)`);
    else check(sent.size > 0 && sent.bytes < sent.size, `playback started while the video was still arriving (${kb})`);
    await page.waitForTimeout(150);
    await shot(page, '4-reveal');
    await page.waitForTimeout(1200);
    await shot(page, '5-playing');
    const sound = page.locator('.lm-ar__sound');
    check(await sound.isVisible(), 'sound control while scanning');
    await sound.click();
    check((await sound.getAttribute('aria-pressed')) === 'true', 'sound turned on from a tap');
    await page.locator('.lm-ar__exit').click();
    check(await until(page, (s) => s.phase === undefined, 3000), 'exit removes the camera');
    check(await page.locator('#landing').isVisible(), 'back on the demo page');
    await page.context().close();
  }

  // 2. The photo leaves the view: lost, then the hint to point at it again.
  {
    const page = await open(browser, (p) =>
      p.addInitScript(...fakeCameraScript({ photo: '/assets/bird-01.png', enterAfterS: 1, leaveAfterS: 5 })),
    );
    check(await until(page, (s) => s.view === 'playing', 9000), 'second photo plays');
    check(await until(page, (s) => s.view === 'lost', 6000), 'loss reported when the photo leaves');
    check((await state(page)).text.includes('照片移开了'), 'lost hint');
    await shot(page, '6-lost');
    await page.context().close();
  }

  // 3. No WebGL2: refused with the WebGL2 notice, no recognition.
  {
    const page = await open(browser, (p) =>
      p.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
          return type === 'webgl2' ? null : (original as (...a: unknown[]) => unknown).call(this, type, ...rest);
        } as typeof original;
      }),
    );
    check(await until(page, (s) => s.phase === 'idle', 6000), 'unsupported device ends the run');
    const notice = await page.locator('.lm-ar__notice').textContent();
    check(!!notice?.includes('需要 WebGL2 支持'), `WebGL2 notice (${notice})`);
    await shot(page, '7-unsupported');
    await page.context().close();
  }

  // 4. Camera refused: the notice and "Start again".
  {
    const page = await open(browser, (p) =>
      p.addInitScript(() => {
        Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
          configurable: true,
        });
      }),
    );
    check(await until(page, (s) => s.phase === 'idle', 6000), 'refused camera ends the run');
    check(!!(await page.locator('.lm-ar__notice').textContent())?.includes('没有相机权限'), 'camera notice');
    check(await page.locator('.lm-ar__button', { hasText: '重新开始' }).isVisible(), '"Start again" shown');
    await shot(page, '8-denied');
    await page.context().close();
  }
  // 5. Target rating page: the 0.4.1 samples rated, the forest (detail all over) above the ship (hard to find).
  {
    const page = await open(browser, async () => {}, '/rate.html');
    check(
      await page
        .waitForFunction(() => document.querySelectorAll('.sample[data-stars]').length === 4, null, { timeout: 30_000 })
        .then(
          () => true,
          () => false,
        ),
      'rating page rates the four 0.4.1 samples',
    );
    const stars = await page.$$eval('.sample[data-stars]', (cards) =>
      cards.map((c) => `${(c as HTMLElement).dataset.id}:${(c as HTMLElement).dataset.stars}`),
    );
    const of = (id: string): number => Number(stars.find((s) => s.startsWith(`${id}:`))?.split(':')[1] ?? NaN);
    check(of('forest-03') >= 4 && of('ship-01') <= 3, `sample ratings ${stars.join(' ')}`);
    await shot(page, '9-rating');
    await page.context().close();
  }
  await browser.close();
}

await server.close();
if (!given) rmSync(site, { recursive: true, force: true });
console.log(failures.length ? `\n${failures.length} failure(s):\n- ${failures.join('\n- ')}` : '\nall passed');
process.exit(failures.length ? 1 : 0);
