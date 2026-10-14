/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const ALGORITHM: string;
export const ANMS_ALGORITHM: string;
export const SELECTIONS: readonly string[];
export const LIMITS: Readonly<{ pixels: number; dimension: number; features: number; levels: number; targets: number; bundleBytes: number }>;
export interface GrayImage { width: number; height: number; data: Uint8Array }
export interface LocalFeature { x: number; y: number; level: number; score: number; descriptor: number[] }
export interface LocalPair { target: [number, number]; image: [number, number]; distance?: number }
export interface LocalRoi { x: number; y: number; width: number; height: number }
export function validateGray(image: GrayImage): void;
export function pyramid(image: GrayImage, levels?: number): Array<GrayImage & { scale: number }>;
export function extractFeatures(image: GrayImage, options?: { maxFeatures?: number; levels?: number; roi?: LocalRoi | null; selection?: 'greedy-min-distance' | 'anms'; /** Default false: precomputed per-layer BRIEF sample offsets; bit-identical output. */ briefOffsets?: boolean }): { features: LocalFeature[]; pyramid: Array<{ width: number; height: number; scale: number }> };
export function hamming(a: readonly number[], b: readonly number[]): number;
export function matchFeatures(target: LocalFeature[], frame: LocalFeature[]): LocalPair[];
