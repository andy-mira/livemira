/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer, type ProbeServer } from './harness/probe-server.ts';
import { useSyntheticCamera } from './harness/synthetic-camera.ts';
import type { SyntheticCameraReport } from './probes/synthetic-camera.ts';

let server: ProbeServer;
before(async () => {
  server = await startProbeServer();
});
after(async () => {
  await server.close();
});

for (const name of selectedBrowsers()) {
  test(`${name}: the synthetic camera delivers numbered frames and size changes`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage();
      await useSyntheticCamera(page, { widthPx: 640, heightPx: 480, frameRate: 30 });
      await page.goto(server.url('synthetic-camera'));
      const report = await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      );
      const {
        initialSize,
        presentedFramesAdvanced,
        decodedFrameNumber,
        frameNumberAtDecode,
        resizedSize,
      } = report as SyntheticCameraReport;
      assert.deepEqual(initialSize, [640, 480]);
      assert.equal(presentedFramesAdvanced, true);
      // The picture on screen lags the canvas by at most a few frames.
      assert.ok(
        decodedFrameNumber >= 1 && decodedFrameNumber <= frameNumberAtDecode,
        `decoded ${decodedFrameNumber}`,
      );
      assert.ok(
        frameNumberAtDecode - decodedFrameNumber <= 5,
        `lag ${frameNumberAtDecode - decodedFrameNumber}`,
      );
      assert.deepEqual(resizedSize, [480, 640]);
    } finally {
      await browser.close();
    }
  });
}
