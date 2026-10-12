/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, type ComputeBackend, type FramePacket, type Point2 } from '@livemira/contracts';
import type { CpuOperators } from '../../compute/src/cpu-backend.ts';

type Level={pixels: Float32Array; width: number; height: number};
type PointTracks=Awaited<ReturnType<ComputeBackend['trackPoints']>>['value'];
type Gray=Parameters<NonNullable<CpuOperators['trackPoints']>>[0];
function pyramid(image: Gray): Level[] {
  const {width,height,data}=image;
  if(!(data instanceof Uint8Array) || !Number.isInteger(width) || !Number.isInteger(height) || width<16 || height<16 || width*height>1048576 || data.length!==width*height || (image.stride!==undefined && image.stride!==width))
    throw new EngineError('FRAME_FAILED',true,'CPU point experiment requires standard unmirrored gray8 <=1M pixels');
  const levels: Level[]=[{width,height,pixels:Float32Array.from(data)}];
  while(levels.length<3 && levels.at(-1)!.width>=32 && levels.at(-1)!.height>=32) {
    const p=levels.at(-1)!,w=Math.floor(p.width/2),h=Math.floor(p.height/2),pixels=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++) {const i=2*y*p.width+2*x;pixels[y*w+x]=(p.pixels[i]+p.pixels[i+1]+p.pixels[i+p.width]+p.pixels[i+p.width+1])/4;}
    levels.push({width:w,height:h,pixels});
  }
  return levels;
}
const inside=(l: Level,x: number,y: number)=>x>=3 && y>=3 && x<l.width-3 && y<l.height-3;
function oneWay(a: Level[],b: Level[],point: Point2): Point2|null {
  let dx=0,dy=0;
  for(let level=a.length-1;level>=0;level--) {
    if(level<a.length-1){dx*=2;dy*=2;}
    const scale=2**level,source=a[level],target=b[level],x=Math.round(point[0]/scale),y=Math.round(point[1]/scale);
    if(!inside(source,x,y))return null;
    let sum=0,sum2=0;
    for(let v=-3;v<=3;v++)for(let u=-3;u<=3;u++){const value=source.pixels[(y+v)*source.width+x+u];sum+=value;sum2+=value*value;}
    if(sum2/49-(sum/49)**2<25)return null;
    const candidates: {x:number;y:number;cost:number}[]=[];
    for(let v=-3;v<=3;v++)for(let u=-3;u<=3;u++) {
      const tx=x+dx+u,ty=y+dy+v;if(!inside(target,tx,ty))continue;
      let cost=0;
      for(let py=-3;py<=3;py++)for(let px=-3;px<=3;px++)cost+=(source.pixels[(y+py)*source.width+x+px]-target.pixels[(ty+py)*target.width+tx+px])**2;
      candidates.push({x:tx,y:ty,cost:cost/49});
    }
    candidates.sort((l,r)=>l.cost-r.cost);const best=candidates[0];if(!best || best.cost>900)return null;
    const competitor=candidates.find(c=>Math.hypot(c.x-best.x,c.y-best.y)>1.5);
    if(competitor && best.cost>=.9*competitor.cost)return null;
    dx=best.x-x;dy=best.y-y;
  }
  return [Math.round(point[0])+dx,Math.round(point[1])+dy];
}
// Bounded integer-pixel template search, not Lucas-Kanade or the native preprocessing ABI.
// Uses the existing ComputeBackend result payload type; owns no frame handles.
export function trackGrayPoints(previous: FramePacket,current: FramePacket,points: readonly Point2[]): PointTracks {
  if(previous.sessionId!==current.sessionId || previous.frameId>=current.frameId || [previous,current].some(frame=>frame.pixelFormat!=='gray8' || frame.imageHandle.kind!=='gray8' || frame.imageHandle.released || frame.rotation!==0 || frame.mirrored))
    throw new EngineError('FRAME_FAILED',true,'Incompatible frames or point budget exceeded');
  return trackImages({...previous,data:previous.imageHandle.data as Uint8Array},{...current,data:current.imageHandle.data as Uint8Array},points);
}
function trackImages(previous: Gray,current: Gray,points: readonly Point2[]): PointTracks {
  if(previous.width!==current.width || previous.height!==current.height || points.length>256 || points.some(p=>p.length!==2 || !p.every(Number.isFinite)))throw new EngineError('FRAME_FAILED',true,'Incompatible dimensions or point budget exceeded');
  const a=pyramid(previous),b=pyramid(current),tracked: Point2[]=[],valid: boolean[]=[];
  for(const point of points) {
    const forward=oneWay(a,b,point),backward=forward?oneWay(b,a,forward):null;
    const good=backward!==null && Math.hypot(backward[0]-point[0],backward[1]-point[1])<=1;
    tracked.push(good?forward!:point);valid.push(good);
  }
  return {points:tracked,valid};
}

export const CPU_POINT_ALGORITHM='d-box2-integer-patch7-fb/0.1.0';
// The compute backend supplies owned level-zero gray copies. Its Gaussian pyramid is not consumed.
export const cpuPointOperator: NonNullable<CpuOperators['trackPoints']>=(previous,current,points,signal)=>{
  if(signal?.aborted)throw new EngineError('ABORTED',true,'CPU point operation cancelled');
  const result=trackImages(previous,current,points);
  if(signal?.aborted)throw new EngineError('ABORTED',true,'CPU point operation cancelled');
  return result;
};
