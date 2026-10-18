/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { chromium, webkit, type Browser } from 'playwright-core';

export type BrowserName = 'chromium' | 'webkit';

const ALL: readonly BrowserName[] = ['chromium', 'webkit'];

/**
 * Browsers to probe: LIVEMIRA_BROWSERS="chromium,webkit" (default both).
 * LIVEMIRA_WEBKIT_PATH points at a WebKit build when the one matching playwright-core is not installed.
 */
export function selectedBrowsers(env: NodeJS.ProcessEnv = process.env): BrowserName[] {
  const requested = env.LIVEMIRA_BROWSERS?.split(',').map((name) => name.trim()) ?? ALL;
  const unknown = requested.filter((name) => !ALL.includes(name as BrowserName));
  if (unknown.length > 0)
    throw new Error(`Unknown browsers in LIVEMIRA_BROWSERS: ${unknown.join(', ')}`);
  return requested as BrowserName[];
}

/** Headless only: hidden or throttled windows distort frame-callback timing. */
export async function launchBrowser(
  name: BrowserName,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Browser> {
  if (name === 'chromium') return chromium.launch({ headless: true });
  const executablePath = env.LIVEMIRA_WEBKIT_PATH;
  return webkit.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}
