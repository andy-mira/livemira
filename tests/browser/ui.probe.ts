/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer, type ProbeServer } from './harness/probe-server.ts';
import { useSyntheticCamera } from './harness/synthetic-camera.ts';
import type { UiProbeReport } from './probes/ui.ts';

let server: ProbeServer;
before(async () => {
  server = await startProbeServer();
});
after(async () => {
  await server.close();
});

for (const name of selectedBrowsers()) {
  test(`${name}: the camera UI recognizes a photo, plays its video after recognition and leaves nothing behind`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await useSyntheticCamera(page, { widthPx: 1280, heightPx: 720, frameRate: 30 });
      await page.goto(server.url('ui'));
      const report = (await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as UiProbeReport;
      if (process.env.LIVEMIRA_PROBE_VERBOSE) console.log(JSON.stringify(report));
      assert.equal(report.error, null);
      assert.deepEqual(report.phases.slice(0, 4), [
        'preparing',
        'starting',
        'scanning',
        'stopping',
      ]);
      assert.deepEqual(report.requests, ['photo', 'video'], 'one photo, then one video');
      assert.equal(report.requestsBeforeFound, 1, 'the video is requested only after recognition');
      if (report.hasClip) {
        assert.deepEqual(report.views, ['searching', 'loading', 'playing', 'lost']);
        assert.ok(report.statuses.includes('Playing'), report.statuses.join(' | '));
      } else {
        assert.ok(report.views.includes('videoError'), report.views.join(' '));
      }
      assert.ok(report.statuses.includes('Point the camera at a photo to scan.'));
      assert.equal(report.soundShownWhileScanning, true);
      assert.equal(report.engineLayersWhileRunning, 3);
      assert.deepEqual(report.after, {
        roots: 0,
        styles: 0,
        bodyOverflow: 'visible',
        engineLayers: 0,
        isDisposed: true,
      });
    } finally {
      await browser.close();
    }
  });
}
