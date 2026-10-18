/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer, type ProbeServer } from './harness/probe-server.ts';
import type { StandardizeCaseReport } from './probes/standardize.ts';

let server: ProbeServer;
before(async () => {
  server = await startProbeServer();
});
after(async () => {
  await server.close();
});

for (const name of selectedBrowsers()) {
  test(`${name}: integer transforms draw the exact standard image for CPU, bitmap and video-frame inputs`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage();
      await page.goto(server.url('standardize'));
      const reports = (await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as StandardizeCaseReport[];
      assert.equal(reports.length, 21);
      for (const report of reports) {
        assert.equal(report.error, undefined, `${report.kind} ${report.name}: ${report.error}`);
        assert.equal(report.mismatches, 0, `${report.kind} ${report.name}`);
      }
    } finally {
      await browser.close();
    }
  });
}
