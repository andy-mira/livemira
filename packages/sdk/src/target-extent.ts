/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Corners, FrameGeometry, FramePacket, Mat3, TargetFrameExtent, TrackingResult } from '@livemira/contracts';

type CapturedTargetFrame = Pick<TargetFrameExtent, 'sessionId'|'frameId'|'sourceObservationId'|'observationTimeUs'|'arrivalTimeUs'|'targetId'|'state'|'measured'|'predictionAgeUs'|'inputWidth'|'inputHeight'|'geometry'|'cornersStandardPx'>;
const copyCorners = (corners: Corners | null): Corners | null => corners ? corners.map(p=>[p[0],p[1]]) as unknown as Corners : null;
function copyGeometry(g: FrameGeometry | null): FrameGeometry | null {
  return g ? {H_standardFromInput:[...g.H_standardFromInput],H_viewportFromStandard:[...g.H_viewportFromStandard],
    crop:{x:g.crop.x,y:g.crop.y,width:g.crop.width,height:g.crop.height},rotation:g.rotation,mirrored:g.mirrored,
    objectFit:g.objectFit,standardWidth:g.standardWidth,standardHeight:g.standardHeight,cssWidth:g.cssWidth,cssHeight:g.cssHeight,devicePixelRatio:g.devicePixelRatio} : null;
}
/** A bounded numerical cache only: no image handles, pixels, IO or per-frame serialization. */
export function captureTargetFrame(frame: FramePacket, result: TrackingResult, geometry: FrameGeometry | null): CapturedTargetFrame {
  return {sessionId:result.sessionId,frameId:result.frameId,sourceObservationId:frame.imageIdentity??null,
    observationTimeUs:result.observationTimeUs,arrivalTimeUs:frame.arrivalTimeUs,targetId:result.targetId,
    state:result.state,measured:result.quality.measured&&!result.quality.degenerate,predictionAgeUs:result.predictionAgeUs,
    inputWidth:frame.width,inputHeight:frame.height,geometry:copyGeometry(geometry),cornersStandardPx:copyCorners(result.cornersPx)};
}
function inverse(m: Mat3): Mat3 | null {
  if(m.length!==9||!m.every(Number.isFinite))return null;
  const [a,b,c,d,e,f,g,h,i]=m;
  const adj=[e*i-f*h,c*h-b*i,b*f-c*e,f*g-d*i,a*i-c*g,c*d-a*f,d*h-e*g,b*g-a*h,a*e-b*d];
  const det=a*adj[0]+b*adj[3]+c*adj[6];
  const magnitude=Math.max(...adj.map(Math.abs));
  if(!Number.isFinite(det)||!magnitude||Math.abs(det)<1e-12*magnitude)return null;
  return adj.map(v=>v/det) as unknown as Mat3;
}
/** Calculate only at the loss boundary, from that captured frame's own transform. */
export function describeTargetFrame(sample: CapturedTargetFrame | null): TargetFrameExtent | null {
  if(!sample)return null;
  const value:TargetFrameExtent={...sample,geometry:copyGeometry(sample.geometry),cornersStandardPx:copyCorners(sample.cornersStandardPx),
    cornersInputPx:null,boundingBoxInputPx:null,edgeWidthInputPx:null,edgeHeightInputPx:null,
    widthFraction:null,heightFraction:null,areaFraction:null,fullyInsideInput:null,unavailableReason:null};
  if(!sample.cornersStandardPx){value.unavailableReason='no-target-corners';return value;}
  if(!sample.geometry){value.unavailableReason='frame-geometry-unavailable';return value;}
  const m=inverse(sample.geometry.H_standardFromInput);
  if(!m||!Number.isFinite(sample.inputWidth)||!Number.isFinite(sample.inputHeight)||sample.inputWidth<=0||sample.inputHeight<=0){value.unavailableReason='invalid-frame-geometry';return value;}
  const corners=sample.cornersStandardPx.map(([x,y])=>{
    const w=m[6]*x+m[7]*y+m[8];
    return Math.abs(w)>1e-12?[(m[0]*x+m[1]*y+m[2])/w,(m[3]*x+m[4]*y+m[5])/w]:[NaN,NaN];
  });
  if(!corners.flat().every(Number.isFinite)){value.unavailableReason='invalid-frame-geometry';return value;}
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  const x=Math.min(...xs),y=Math.min(...ys),width=Math.max(...xs)-x,height=Math.max(...ys)-y;
  const edge=(a:number,b:number)=>Math.hypot(corners[a][0]-corners[b][0],corners[a][1]-corners[b][1]);
  const area=Math.abs(corners.reduce((sum,p,k)=>{const next=corners[(k+1)%4];return sum+p[0]*next[1]-p[1]*next[0];},0))/2;
  value.cornersInputPx=corners as unknown as Corners;value.boundingBoxInputPx={x,y,width,height};
  value.edgeWidthInputPx=(edge(0,1)+edge(2,3))/2;value.edgeHeightInputPx=(edge(1,2)+edge(3,0))/2;
  value.widthFraction=width/sample.inputWidth;value.heightFraction=height/sample.inputHeight;value.areaFraction=area/(sample.inputWidth*sample.inputHeight);
  // Unclipped target bounds: fractions may exceed 1 for a target crossing frame edges.
  value.fullyInsideInput=corners.every(([cx,cy])=>cx>=0&&cy>=0&&cx<=sample.inputWidth&&cy<=sample.inputHeight);
  return value;
}
