/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import {EngineError, type FramePacket, type Point2} from '@livemira/contracts';
import type {CpuOperators} from '../../compute/src/cpu-backend.ts';

type Gray=Parameters<NonNullable<CpuOperators['trackPoints']>>[0];
type Level={data:Float32Array;width:number;height:number};
export const SUBPIXEL_POINT_ALGORITHM='d-gauss5-znlk13-fb/0.2.0';
const RADIUS=6, SIZE=169;
function validate(image:Gray) {
  if(!(image.data instanceof Uint8Array) || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width<24 || image.height<24 || image.width*image.height>1048576 || image.data.length!==image.width*image.height || (image.stride!==undefined && image.stride!==image.width))throw new EngineError('FRAME_FAILED',true,'Subpixel tracker requires packed gray8 <=1M pixels');
}
function pyramid(image:Gray):Level[] {
  validate(image);
  const result:Level[]=[{data:Float32Array.from(image.data),width:image.width,height:image.height}];
  const weights=[1,4,6,4,1];
  // Smooth level zero too: reduces repeated bilinear-resampling bias at sharp edges.
  const base=result[0],temp=new Float32Array(base.data.length),smooth=new Float32Array(base.data.length);
  for(let y=0;y<base.height;y++)for(let x=0;x<base.width;x++){let sum=0;for(let k=-2;k<=2;k++)sum+=weights[k+2]*base.data[y*base.width+Math.max(0,Math.min(base.width-1,x+k))];temp[y*base.width+x]=sum/16;}
  for(let y=0;y<base.height;y++)for(let x=0;x<base.width;x++){let sum=0;for(let k=-2;k<=2;k++)sum+=weights[k+2]*temp[Math.max(0,Math.min(base.height-1,y+k))*base.width+x];smooth[y*base.width+x]=sum/16;}
  result[0]={...base,data:smooth};
  while(result.length<4 && Math.min(result.at(-1)!.width,result.at(-1)!.height)>=48) {
    const a=result.at(-1)!,width=Math.ceil(a.width/2),height=Math.ceil(a.height/2),horizontal=new Float32Array(width*a.height),data=new Float32Array(width*height);
    for(let y=0;y<a.height;y++)for(let x=0;x<width;x++){let sum=0;for(let k=-2;k<=2;k++)sum+=weights[k+2]*a.data[y*a.width+Math.max(0,Math.min(a.width-1,2*x+k))];horizontal[y*width+x]=sum/16;}
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){let sum=0;for(let k=-2;k<=2;k++)sum+=weights[k+2]*horizontal[Math.max(0,Math.min(a.height-1,2*y+k))*width+x];data[y*width+x]=sum/16;}
    result.push({data,width,height});
  }
  return result;
}
function sample(a:Level,x:number,y:number):number {
  const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,i=iy*a.width+ix;
  return (1-fy)*((1-fx)*a.data[i]+fx*a.data[i+1])+fy*((1-fx)*a.data[i+a.width]+fx*a.data[i+a.width+1]);
}
const inside=(a:Level,x:number,y:number)=>x>=RADIUS+1 && y>=RADIUS+1 && x<a.width-RADIUS-2 && y<a.height-RADIUS-2;
function patch(a:Level,x:number,y:number) {
  if(!inside(a,x,y))return null;
  const values=new Float64Array(SIZE),gx=new Float64Array(SIZE),gy=new Float64Array(SIZE);let mean=0,mx=0,my=0,i=0;
  for(let v=-RADIUS;v<=RADIUS;v++)for(let u=-RADIUS;u<=RADIUS;u++,i++) {
    values[i]=sample(a,x+u,y+v);mean+=values[i];
    gx[i]=(sample(a,x+u+1,y+v)-sample(a,x+u-1,y+v))/2;gy[i]=(sample(a,x+u,y+v+1)-sample(a,x+u,y+v-1))/2;mx+=gx[i];my+=gy[i];
  }
  mean/=SIZE;mx/=SIZE;my/=SIZE;let variance=0,xx=0,xy=0,yy=0,vx=0,vy=0;
  for(let j=0;j<SIZE;j++){values[j]-=mean;variance+=values[j]**2;gx[j]-=mx;gy[j]-=my;vx+=values[j]*gx[j];vy+=values[j]*gy[j];}
  if(variance/SIZE<9)return null;
  // Project out gain as well as offset from the normalized patch Jacobian.
  for(let j=0;j<SIZE;j++){gx[j]-=values[j]*vx/variance;gy[j]-=values[j]*vy/variance;xx+=gx[j]**2;xy+=gx[j]*gy[j];yy+=gy[j]**2;}
  const det=xx*yy-xy*xy,trace=xx+yy;
  if(variance/SIZE<9 || trace<1 || det/(trace*trace)<.005 || (trace-Math.sqrt((xx-yy)**2+4*xy*xy))/(2*SIZE)<.15)return null;
  return {values,gx,gy,sigma:Math.sqrt(variance/SIZE),xx,xy,yy,det};
}
function oneWay(a:Level[],b:Level[],p:Point2):{point:Point2;residual:number}|null {
  let dx=0,dy=0,started=false,residual=Infinity;
  const values=new Float64Array(SIZE);
  for(let level=a.length-1;level>=0;level--) {
    if(started){dx*=2;dy*=2;}
    const scale=2**level,x=p[0]/scale,y=p[1]/scale,reference=patch(a[level],x,y);
    if(!reference){if(level===0)return null;continue;}
    started=true;let qx=x+dx,qy=y+dy;
    for(let iteration=0;iteration<20;iteration++) {
      if(!inside(b[level],qx,qy))return null;
      let mean=0,i=0;
      for(let v=-RADIUS;v<=RADIUS;v++)for(let u=-RADIUS;u<=RADIUS;u++,i++){values[i]=sample(b[level],qx+u,qy+v);mean+=values[i];}
      mean/=SIZE;let variance=0;
      for(let j=0;j<SIZE;j++)variance+=(values[j]-mean)**2;
      const sigma=Math.sqrt(variance/SIZE);if(sigma<3)return null;
      const gain=reference.sigma/sigma;let bx=0,by=0,error=0;
      for(let j=0;j<SIZE;j++){const e=reference.values[j]-(values[j]-mean)*gain;bx+=reference.gx[j]*e;by+=reference.gy[j]*e;error+=e*e;}
      const ux=(reference.yy*bx-reference.xy*by)/reference.det,uy=(reference.xx*by-reference.xy*bx)/reference.det;
      if(!Number.isFinite(ux+uy) || Math.hypot(ux,uy)>5)return null;
      qx+=ux;qy+=uy;residual=Math.sqrt(error/SIZE)/reference.sigma;
      if(ux*ux+uy*uy<.0001)break;
    }
    dx=qx-x;dy=qy-y;
    if(Math.hypot(dx,dy)*scale>48)return null;
  }
  if(!started || residual>.45)return null;
  return {point:[p[0]+dx,p[1]+dy],residual};
}
export function trackSubpixelImages(previous:Gray,current:Gray,points:readonly Point2[],signal?:AbortSignal) {
  if(signal?.aborted)throw new EngineError('ABORTED',true,'Subpixel tracking cancelled');
  if(previous.width!==current.width || previous.height!==current.height || points.length>256 || points.some(p=>p.length!==2 || !p.every(Number.isFinite)))throw new EngineError('FRAME_FAILED',true,'Invalid subpixel input or point budget');
  const a=pyramid(previous),b=pyramid(current),tracked:Point2[]=[],valid:boolean[]=[],forwardBackwardPx:number[]=[],normalizedResidual:number[]=[];
  for(const point of points) {
    if(signal?.aborted)throw new EngineError('ABORTED',true,'Subpixel tracking cancelled');
    const forward=oneWay(a,b,point),backward=forward?oneWay(b,a,forward.point):null;
    const fb=backward?Math.hypot(backward.point[0]-point[0],backward.point[1]-point[1]):Infinity;
    const good=forward!==null && fb<=.75;
    tracked.push(good?forward!.point:point);valid.push(good);forwardBackwardPx.push(fb);normalizedResidual.push(forward?.residual??Infinity);
  }
  return {points:tracked,valid,forwardBackwardPx,normalizedResidual};
}
export const subpixelPointOperator:NonNullable<CpuOperators['trackPoints']>=(a,b,points,signal)=>{
  const {points:tracked,valid}=trackSubpixelImages(a,b,points,signal);return {points:tracked,valid};
};
export function trackSubpixelGrayPoints(previous:FramePacket,current:FramePacket,points:readonly Point2[],signal?:AbortSignal) {
  if(previous.sessionId!==current.sessionId || previous.frameId>=current.frameId || [previous,current].some(f=>f.pixelFormat!=='gray8' || f.imageHandle.kind!=='gray8' || f.imageHandle.released || f.rotation!==0 || f.mirrored))throw new EngineError('FRAME_FAILED',true,'Require standard live gray frames');
  return trackSubpixelImages({...previous,data:previous.imageHandle.data as Uint8Array},{...current,data:current.imageHandle.data as Uint8Array},points,signal);
}
