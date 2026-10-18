/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer, type ProbeServer } from './harness/probe-server.ts';
import type { StandardReadbackCase } from './probes/standard-readback.ts';

let server: ProbeServer;
before(async () => {
  server = await startProbeServer();
});
after(async () => {
  await server.close();
});

for (const name of selectedBrowsers()) {
  test(`${name}: the camera's standard readback draws the same standard image as the Worker did from the full picture`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage();
      await page.goto(server.url('standard-readback'));
      const reports = (await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as StandardReadbackCase[];
      if (process.env.LIVEMIRA_PROBE_VERBOSE) console.log(JSON.stringify(reports));
      assert.equal(reports.length, 5);
      for (const report of reports) {
        assert.equal(report.error, undefined, `${report.name}: ${report.error}`);
        // Filtering from the video instead of a full-size copy changes pixels slightly; a wrong transform would not.
        assert.ok(report.meanAbsDiff < 4, `${report.name}: mean ${report.meanAbsDiff}`);
        assert.ok(report.experimentBytes <= report.defaultBytes, report.name);
      }
    } finally {
      await browser.close();
    }
  });
}
