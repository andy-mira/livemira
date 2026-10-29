// SPDX-License-Identifier: Apache-2.0
// Device-kit builds only (tools/bundle.ts with `diagnostics`, the kit's prototype builds): per-frame traces, frame
// strips and orientation reports for device reports. Everything behind this flag is compiled out of releases.

declare const __LIVEMIRA_DIAGNOSTICS__: boolean | undefined;

export const DIAGNOSTICS: boolean = typeof __LIVEMIRA_DIAGNOSTICS__ !== 'undefined' && __LIVEMIRA_DIAGNOSTICS__;
