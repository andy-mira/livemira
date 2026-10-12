/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { normalizeHomography, type Corners, type Point2, type RecognitionObservation, type TargetBundle, type TrackingQuality, type Mat3 } from '@livemira/contracts';

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]);
}
function hullArea(points: readonly Point2[]): number {
  const sorted=[...points].sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const half=(p: readonly Point2[])=>{
    const result: Point2[]=[];
    for(const v of p) {while(result.length>=2 && cross(result.at(-2)!,result.at(-1)!,v)<=0)result.pop();result.push(v);}
    result.pop();return result;
  };
  const hull=[...half(sorted),...half([...sorted].reverse())];
  return Math.abs(hull.reduce((sum,p,i)=>{const q=hull[(i+1)%hull.length];return sum+p[0]*q[1]-p[1]*q[0];},0))/2;
}
function project(h: Mat3,p: Point2): Point2 {
  const z=h[6]*p[0]+h[7]*p[1]+h[8];
  if(Math.abs(z)<1e-9)throw new Error('target-crosses-horizon');
  const result: Point2=[(h[0]*p[0]+h[1]*p[1]+h[2])/z,(h[3]*p[0]+h[4]*p[1]+h[5])/z];
  if(!result.every(Number.isFinite))throw new Error('nonfinite-projection');
  return result;
}
export function validateObservation(o: RecognitionObservation,t: TargetBundle,allowPreviousFrame=false): {h: Mat3; corners: Corners; quality: TrackingQuality} {
  if(o.degenerate || !(o.correspondenceOrigin==='original-target' || (allowPreviousFrame && o.correspondenceOrigin==='previous-frame')) || o.algorithmVersion!==t.algorithmVersion)throw new Error('incompatible-observation');
  const n=o.targetPoints.length;
  if(n<8 || n>100000 || o.imagePoints.length!==n || o.inliers.length!==n)throw new Error('invalid-correspondence-lengths');
  const h=normalizeHomography(o.H_imageFromTarget);
  const edges: Corners=[[0,0],[t.widthPx,0],[t.widthPx,t.heightPx],[0,t.heightPx]];
  const denominators=edges.map(p=>h[6]*p[0]+h[7]*p[1]+h[8]);
  if(denominators.some(v=>Math.abs(v)<1e-9 || Math.sign(v)!==Math.sign(denominators[0])))throw new Error('target-crosses-horizon');
  const corners=edges.map(p=>project(h,p)) as unknown as Corners;
  if(hullArea(corners)<16)throw new Error('collapsed-projection');
  const inliers: Point2[]=[];let sum=0;
  for(let i=0;i<n;i++) {
    const p=o.targetPoints[i],q=o.imagePoints[i];
    if(p.length!==2 || q.length!==2 || ![...p,...q].every(Number.isFinite) || typeof o.inliers[i]!=='boolean')throw new Error('invalid-correspondence');
    if(p[0]<0 || p[1]<0 || p[0]>t.widthPx-1 || p[1]>t.heightPx-1)throw new Error('feature-outside-target');
    if(o.inliers[i]) {const r=project(h,p);sum+=(q[0]-r[0])**2+(q[1]-r[1])**2;inliers.push(p);}
  }
  const spatialCoverage=hullArea(inliers)/(t.widthPx*t.heightPx), error=Math.sqrt(sum/inliers.length);
  if(inliers.length<8 || inliers.length/n<.6 || spatialCoverage<.2 || !Number.isFinite(error) || error>2)throw new Error('quality-gate');
  return {h,corners,quality:{inlierCount:inliers.length,inlierRatio:inliers.length/n,reprojectionErrorPx:error,spatialCoverage,degenerate:false,measured:true}};
}
