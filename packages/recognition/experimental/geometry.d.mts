/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { LocalPair } from './features.mjs';
export interface LocalGeometryResult {
  accepted: boolean; reason: string; H: number[] | null; pairs: LocalPair[]; inlierMask: boolean[];
  inlierCount?: number; inlierRatio?: number; coverage?: number; rmsErrorPx?: number; maxErrorPx?: number; degenerate?: boolean;
}
export function project(h: readonly number[], point: readonly number[]): number[];
export function fitHomography(pairs: LocalPair[]): number[] | null;
export function hullArea(points: readonly (readonly number[])[]): number;
export function validateHomography(h: readonly number[] | null, width: number, height: number): boolean;
export function verifyGeometry(pairs: LocalPair[], width: number, height: number, options?: { iterations?: number; threshold?: number; minInliers?: number; minCoverage?: number; seed?: number; adaptive?: boolean }): LocalGeometryResult;
