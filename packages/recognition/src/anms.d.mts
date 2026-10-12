/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const ANMS_ROBUSTNESS: number;
export const ANMS_POOL_LIMIT: number;
export interface AnmsCandidate { x: number; y: number; score: number }
export function anmsRadiiSquared<T extends AnmsCandidate>(sortedByStrengthDescending: readonly T[], robustness?: number): number[];
export function selectAnms<T extends AnmsCandidate>(candidates: readonly T[], count: number, options?: { robustness?: number; poolLimit?: number }): T[];
