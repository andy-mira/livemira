/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const UNIFORM_AXIS_VARIANCE: number;
export interface PointDistribution { count: number; hullCoverage: number; dispersion: number; isotropy: number }
export function pointDistribution(points: readonly (readonly [number, number])[], width: number, height: number): PointDistribution;
