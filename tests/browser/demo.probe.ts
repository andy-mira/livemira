/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The built public demo, as a visitor uses it: open the page, tap Start, point the (synthetic) camera at the sample
// picture. The demo loads the minified single-file engine with its embedded Worker.
//
// Chromium only: WebKit's canvas captureStream keeps mediaTime still, so a media-time camera stalls there; the demo
// offers no callback-timestamp option (the engine probe covers WebKit with it).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { buildDemo } from '../../tools/build-demo.ts';
import { serve } from '../../tools/dev-server.ts';
import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { useSyntheticCamera, type SyntheticCameraControl } from './harness/synthetic-camera.ts';

let site: string;
let server: Server;
let origin: string;

before(async () => {
  site = mkdtempSync(path.join(tmpdir(), 'livemira-demo-'));
  await buildDemo(site);
  server = serve(site, 0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(site, { recursive: true, force: true });
});

interface DemoHandle {
  readonly state: string;
  readonly badge: string;
  readonly log: { export(): { events: readonly { type: string }[] } };
}

for (const name of selectedBrowsers().filter((b) => b === 'chromium')) {
  test(`${name}: the demo recognises the sample picture after Start`, async () => {
    const browser = await launchBrowser(name);
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        locale: 'en-US',
      });
      const page = await context.newPage();
      await useSyntheticCamera(page, { widthPx: 1280, heightPx: 720, frameRate: 30 });
      await page.goto(`${origin}/`);
      await page.evaluate(async () => {
        const image = new Image();
        image.src = './assets/forest-03.png';
        await image.decode();
        (
          window as unknown as { __syntheticCamera: SyntheticCameraControl }
        ).__syntheticCamera.setImage(image, 0.7);
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
        true,
      );
      await page.getByRole('button', { name: 'Start' }).click();
      await page.waitForFunction(
        () =>
          (window as unknown as { __livemiraDemo: DemoHandle }).__livemiraDemo.badge === 'Locked',
        undefined,
        { timeout: 20000 },
      );
      await page.getByRole('button', { name: 'Stop' }).click();
      await page.waitForFunction(
        () =>
          (window as unknown as { __livemiraDemo: DemoHandle }).__livemiraDemo.badge === 'Stopped',
        undefined,
        { timeout: 10000 },
      );
      const types = await page.evaluate(() =>
        (window as unknown as { __livemiraDemo: DemoHandle }).__livemiraDemo.log
          .export()
          .events.map((e) => e.type),
      );
      for (const type of ['attemptStart', 'ready', 'targetFound', 'sessionEnded'])
        assert.ok(types.includes(type), `${type} is in the key log`);
      assert.equal(types.includes('error'), false, types.join(' '));
    } finally {
      await browser.close();
    }
  });
}
