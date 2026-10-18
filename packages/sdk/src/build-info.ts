/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

/** Engine version; kept equal to the package version by the release checks. */
export const ENGINE_VERSION = '0.4.1';

/** Which engine build is running, so diagnostic logs can prove what ran. */
export interface EngineBuildInfo {
  readonly version: string;
  /** 'single': the bundled single-file engine; 'modules': the workspace sources (development and tests). */
  readonly format: 'single' | 'modules';
  /** Text variant of the single-file engine; both variants behave identically. Null for 'modules'. */
  readonly variant: 'readable' | 'minified' | null;
  /** SHA-256 of the build inputs; null for 'modules'. */
  readonly buildId: string | null;
}

// Defined only by the single-file build (tools/build-engine.ts).
declare const __LIVEMIRA_BUILD__:
  { readonly variant: 'readable' | 'minified'; readonly buildId: string } | undefined;

export const engineBuildInfo: EngineBuildInfo = Object.freeze(
  typeof __LIVEMIRA_BUILD__ === 'undefined'
    ? { version: ENGINE_VERSION, format: 'modules', variant: null, buildId: null }
    : {
        version: ENGINE_VERSION,
        format: 'single',
        variant: __LIVEMIRA_BUILD__.variant,
        buildId: __LIVEMIRA_BUILD__.buildId,
      },
);
