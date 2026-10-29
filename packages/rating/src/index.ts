// SPDX-License-Identifier: Apache-2.0
// Public entry of the LiveMira target rating (`@livemira/target-rating`, the single-file
// `livemira-target-rating.min.mjs`): rates a picture for the engine without loading the engine. Importing it creates
// nothing; the first rating starts its Worker.

export type * from './api.ts';
export { RATING_VERSION, ratingBuildInfo } from './build-info.ts';
export { rateTarget, rateTargetImage } from './client.ts';
export { RatingError } from './errors.ts';
