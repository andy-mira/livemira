/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { GrayImage, LocalFeature, LocalPair, LocalRoi } from '../experimental/features.mjs';
export const ORIENTED_ALGORITHM: string;
export const ORIENTED_LEVELS: number;
export const SCALE_STEP: number;
export function orientedPyramid(image: GrayImage, levels?: number): Array<GrayImage & {scale:number}>;
export function extractOriented(image: GrayImage, options?: {maxFeatures?:number;levels?:number;roi?:LocalRoi|null}): {features:LocalFeature[];pyramid:Array<{width:number;height:number;scale:number}>};
export function packDescriptors(features: readonly LocalFeature[]): Uint32Array;
export function packedDistance(a:Uint32Array,ai:number,b:Uint32Array,bi:number):number;
export function matchPacked(target:LocalFeature[],frame:LocalFeature[],tp?:Uint32Array,fp?:Uint32Array):LocalPair[];
export interface IndexedTarget {features:LocalFeature[];packed:Uint32Array}
export class TargetIndex {
 constructor(targets:IndexedTarget[]);
 query(features:LocalFeature[],options?:{maxCandidates?:number;maxComparisons?:number;maxBucketVisits?:number}):{indices:number[];votes:number[];packed:Uint32Array;comparisons:number;bucketVisits:number;exhausted:boolean;ambiguous:boolean};
}
