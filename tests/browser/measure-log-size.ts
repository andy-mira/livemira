/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Measures the diagnostic log size of a real engine session (see probes/log-size.ts) at both levels in headless
// Chromium (or the browser in LIVEMIRA_BROWSERS). Not part of the test suite; run by hand:
//   node tests/browser/measure-log-size.ts [seconds]   (default 60)

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer } from './harness/probe-server.ts';
import { useSyntheticCamera } from './harness/synthetic-camera.ts';
import type { LogSizeReport } from './probes/log-size.ts';

const seconds = Number(process.argv[2] ?? '60');
const server = await startProbeServer();
try {
  for (const name of selectedBrowsers()) {
    for (const level of ['key', 'full']) {
      const browser = await launchBrowser(name);
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
        await useSyntheticCamera(page, { widthPx: 1280, heightPx: 720, frameRate: 30 });
        const query = `?level=${level}&seconds=${seconds}${name === 'webkit' ? '&timestamps=callback' : ''}`;
        await page.goto(`${server.url('log-size')}${query}`);
        page.setDefaultTimeout((seconds + 60) * 1000);
        const report = (await page.evaluate(
          () => (window as unknown as { __probe: Promise<unknown> }).__probe,
        )) as LogSizeReport;
        const perMinute = (n: number): number => Math.round((n * 60) / report.seconds);
        console.log(
          JSON.stringify({
            browser: name,
            ...report,
            perMinute: {
              bytes: perMinute(report.bytes),
              events: perMinute(report.events),
              frames: perMinute(report.frames),
              results: perMinute(report.results),
              workerTimings: perMinute(report.workerTimings),
            },
          }),
        );
      } finally {
        await browser.close();
      }
    }
  }
} finally {
  await server.close();
}
