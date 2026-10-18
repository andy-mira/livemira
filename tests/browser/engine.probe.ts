/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { launchBrowser, selectedBrowsers } from './harness/browsers.ts';
import { startProbeServer, type ProbeServer } from './harness/probe-server.ts';
import { useSyntheticCamera } from './harness/synthetic-camera.ts';
import type { EngineProbeReport } from './probes/engine.ts';

let server: ProbeServer;
before(async () => {
  server = await startProbeServer();
});
after(async () => {
  await server.close();
});

for (const name of selectedBrowsers()) {
  test(`${name}: an engine recognises a target from the camera and releases everything`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await useSyntheticCamera(page, { widthPx: 1280, heightPx: 720, frameRate: 30 });
      await page.goto(server.url('engine'));
      const report = (await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as EngineProbeReport;
      if (process.env.LIVEMIRA_PROBE_VERBOSE) console.log(JSON.stringify(report));
      assert.equal(report.error, null, `events: ${report.events.join(' ')}`);
      const order = ['attemptStart', 'sessionConfig', 'stageTiming', 'capabilityChanged', 'ready'];
      for (const [i, event] of order.entries())
        assert.ok(report.events.indexOf(event) >= 0, `missing ${event} (${i})`);
      assert.ok(report.events.indexOf('cameraPermission') < report.events.indexOf('ready'));
      assert.deepEqual(report.found, { targetId: 'probe-target', state: 'TRACKING' });
      assert.equal(report.capability?.execution, 'worker');
      assert.ok(['wasm-simd', 'wasm-scalar', 'cpu'].includes(String(report.capability?.matching)));
      assert.ok(['canvas', 'video'].includes(String(report.capability?.previewSurface)));
      assert.equal(report.layersWhileRunning, 3);
      assert.ok(
        report.events.includes('targetLost'),
        'the target is lost when the picture goes away',
      );
      assert.equal(report.events.at(-1), 'sessionEnded');
      assert.equal(report.layersAfterDispose, 0);
      // The defaults: canvas readback of the standard image, timed by the frame callback.
      const camera = report.camera as {
        timestampFallback: string | null;
        lastFrame: { format: string } | null;
        stats: { cpuReadbackBytes: number; snapshots: number };
      };
      assert.equal(camera.timestampFallback, null);
      assert.equal(camera.lastFrame?.format, 'standard-rgba8');
      // 1280 × 720 read back as its 640 × 360 standard image: a quarter of the bytes per frame.
      assert.equal(camera.stats.cpuReadbackBytes, camera.stats.snapshots * 640 * 360 * 4);
      assert.deepEqual(report.experiments, { motionAdaptiveHold: true, reconfirmAfterHide: true });
      assert.deepEqual(report.graces, [200, 200], 'the default loss display grace');
      assert.equal(report.clockMappings.length, 2);
      for (const mapping of report.clockMappings) {
        assert.equal(mapping.initial, null, 'a session starts without a clock mapping');
        assert.notEqual(mapping.latest, null, 'its first frame maps the camera clock');
      }
      assert.equal(report.diagnostics.level, 'full');
      assert.ok(
        report.diagnostics.frames > 0 &&
          report.diagnostics.results > 0 &&
          report.diagnostics.timings > 0,
      );
      if (report.mediaStates.length) {
        assert.ok(report.mediaStates.includes('shown'), report.mediaStates.join(' '));
        assert.ok(report.mediaStates.includes('loading'), report.mediaStates.join(' '));
        assert.equal(report.planeShown, true);
      }
    } finally {
      await browser.close();
    }
  });
}

for (const name of selectedBrowsers()) {
  test(`${name}: with native pictures and media-time timestamps the target is recognised; a still media time falls back`, async () => {
    const browser = await launchBrowser(name);
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await useSyntheticCamera(page, { widthPx: 1280, heightPx: 720, frameRate: 30 });
      await page.goto(`${server.url('engine')}?capture=auto&timestamps=media-time`);
      const report = (await page.evaluate(
        () => (window as unknown as { __probe: Promise<unknown> }).__probe,
      )) as EngineProbeReport;
      assert.equal(report.error, null, `events: ${report.events.join(' ')}`);
      assert.deepEqual(report.found, { targetId: 'probe-target', state: 'TRACKING' });
      // WebKit's canvas captureStream keeps its media time still, and the camera switches to callback timestamps.
      const { timestampFallback } = report.camera as { timestampFallback: string | null };
      if (name === 'webkit') assert.equal(timestampFallback, 'MEDIA_TIME_FROZEN');
      else assert.equal(timestampFallback, null);
      assert.equal(report.layersAfterDispose, 0);
    } finally {
      await browser.close();
    }
  });
}
