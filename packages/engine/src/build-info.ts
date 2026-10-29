// SPDX-License-Identifier: Apache-2.0
// Version and build identity. The release build replaces the `__LIVEMIRA_*__` names (tools/release.ts); run from
// source they are absent and the development values apply.

import type { EngineBuildInfo } from './api.ts';

declare const __LIVEMIRA_VERSION__: string | undefined;
declare const __LIVEMIRA_BUILD_ID__: string | undefined;
declare const __LIVEMIRA_VARIANT__: EngineBuildInfo['variant'] | undefined;

export const ENGINE_VERSION: string = typeof __LIVEMIRA_VERSION__ === 'string' ? __LIVEMIRA_VERSION__ : '0.0.0-dev';

export const engineBuildInfo: EngineBuildInfo = Object.freeze({
  version: ENGINE_VERSION,
  buildId: typeof __LIVEMIRA_BUILD_ID__ === 'string' ? __LIVEMIRA_BUILD_ID__ : 'development',
  variant: typeof __LIVEMIRA_VARIANT__ === 'string' ? __LIVEMIRA_VARIANT__ : 'development',
});
