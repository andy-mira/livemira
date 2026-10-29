// SPDX-License-Identifier: Apache-2.0
// Version and build identity. The release build replaces the `__LIVEMIRA_*__` names (tools/release.ts); run from
// source they are absent and the development values apply.

import type { RatingBuildInfo } from './api.ts';

declare const __LIVEMIRA_VERSION__: string | undefined;
declare const __LIVEMIRA_BUILD_ID__: string | undefined;
declare const __LIVEMIRA_VARIANT__: RatingBuildInfo['variant'] | undefined;

export const RATING_VERSION: string = typeof __LIVEMIRA_VERSION__ === 'string' ? __LIVEMIRA_VERSION__ : '0.0.0-dev';

export const ratingBuildInfo: RatingBuildInfo = Object.freeze({
  version: RATING_VERSION,
  buildId: typeof __LIVEMIRA_BUILD_ID__ === 'string' ? __LIVEMIRA_BUILD_ID__ : 'development',
  variant: typeof __LIVEMIRA_VARIANT__ === 'string' ? __LIVEMIRA_VARIANT__ : 'development',
});
