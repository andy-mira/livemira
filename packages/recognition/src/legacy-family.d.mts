/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GrayImage, LocalFeature, LocalRoi } from '../experimental/features.mjs';
export const LEGACY_FAMILY: readonly string[];
export const ANMS_SELECTION_ID: string;
export function isLegacyFamily(version: unknown): boolean;
export function selectionFor(version: string): 'greedy-min-distance' | 'anms';
export function extractLegacyFamily(image: GrayImage, version: string, options?: { maxFeatures?: number; levels?: number; roi?: LocalRoi | null }): { features: LocalFeature[]; pyramid: Array<{ width: number; height: number; scale: number }> };
