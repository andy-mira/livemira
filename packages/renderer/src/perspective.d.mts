/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export function project(h: readonly number[], x: number, y: number): [number,number];
export function multiply(a: readonly number[], b: readonly number[]): number[];
export function homographyFromCorners(width: number, height: number, corners: readonly (readonly [number,number])[]): number[];
export function validatePlane(h: readonly number[], width: number, height: number): void;
export function cssMatrix(h: readonly number[]): string;
export function mediaRect(tw:number,th:number,vw:number,vh:number,fit?:'contain'|'cover'): {x:number;y:number;width:number;height:number};
export class PerspectiveVideoRenderer {
  readonly plane: HTMLElement;
  constructor(container:HTMLElement,video:HTMLVideoElement,options:{width:number;height:number;fit?:'contain'|'cover'});
  setGroundTruth(corners:readonly (readonly [number,number])[], viewportFromImage?:readonly number[]):void;
  hide():void;
  show():void;
  dispose():void;
}
