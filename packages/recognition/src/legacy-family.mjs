/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Routing for the legacy descriptor family: one Harris detector + BRIEF-256 descriptor + matcher, two spatial selection strategies.
// The algorithm identity decides the selection, so a bundle, its live extraction, the scorer and the preview can never disagree about it.
import { ALGORITHM, ANMS_ALGORITHM, extractFeatures } from '../experimental/features.mjs';
import { ANMS_POOL_LIMIT, ANMS_ROBUSTNESS } from './anms.mjs';

export const LEGACY_FAMILY = Object.freeze([ALGORITHM, ANMS_ALGORITHM]);
export const isLegacyFamily = version => LEGACY_FAMILY.includes(version);
/** Recorded in ANMS bundles (preprocessing.selection) so the exact variant is part of the bundle identity. */
export const ANMS_SELECTION_ID = `anms-c${ANMS_ROBUSTNESS}-pool${ANMS_POOL_LIMIT}-per-level`;
export function selectionFor(version) {
  if (!isLegacyFamily(version)) throw new Error('UNSUPPORTED_ALGORITHM');
  return version === ANMS_ALGORITHM ? 'anms' : 'greedy-min-distance';
}
/** extractFeatures for a legacy-family algorithm identity; the budget, level and briefOffsets options are the caller's (template 384, live 512, 3 levels). */
export function extractLegacyFamily(image, version, options = {}) {
  return extractFeatures(image, { ...options, selection: selectionFor(version) });
}
