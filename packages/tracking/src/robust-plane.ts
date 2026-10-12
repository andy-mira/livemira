/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import {normalizeHomography,type Mat3,type Point2} from '@livemira/contracts';
type Pair=readonly [number,number,number,number];
function multiply(a:readonly number[],b:readonly number[]) {return Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+a[3*Math.floor(i/3)+k]*b[3*k+i%3],0));}
function normalization(points:readonly Point2[]) {
  const x=points.reduce((s,p)=>s+p[0],0)/points.length,y=points.reduce((s,p)=>s+p[1],0)/points.length;
  const radius=Math.sqrt(points.reduce((s,p)=>s+(p[0]-x)**2+(p[1]-y)**2,0)/points.length);if(radius<1e-8)throw new Error('collapsed-points');
  const scale=Math.SQRT2/radius;return {x,y,scale,t:[scale,0,-scale*x,0,scale,-scale*y,0,0,1],inverse:[1/scale,0,x,0,1/scale,y,0,0,1]};
}
// Reorthogonalized QR avoids squaring conditioning through normal equations.
function leastSquares(rows:readonly number[][],rhs:readonly number[]):number[] {
  const q:number[][]=[],r=Array.from({length:8},()=>Array(8).fill(0));
  for(let j=0;j<8;j++) {
    const v=rows.map(row=>row[j]);
    for(let pass=0;pass<2;pass++)for(let k=0;k<j;k++){const dot=q[k].reduce((sum,value,i)=>sum+value*v[i],0);r[k][j]+=dot;for(let i=0;i<v.length;i++)v[i]-=dot*q[k][i];}
    const norm=Math.hypot(...v);if(norm<1e-8)throw new Error('rank-deficient-plane');r[j][j]=norm;q.push(v.map(value=>value/norm));
  }
  const answer=q.map(column=>column.reduce((sum,value,i)=>sum+value*rhs[i],0));
  for(let j=7;j>=0;j--){for(let k=j+1;k<8;k++)answer[j]-=r[j][k]*answer[k];answer[j]/=r[j][j];}
  return answer;
}
export function fitPlane(pairs:readonly Pair[]):Mat3 {
  if(pairs.length<4 || pairs.length>256 || pairs.some(p=>p.length!==4 || !p.every(Number.isFinite)))throw new Error('invalid-plane-pairs');
  const a=normalization(pairs.map(p=>[p[0],p[1]])),b=normalization(pairs.map(p=>[p[2],p[3]])),rows:number[][]=[],rhs:number[]=[];
  for(const p of pairs) {
    const x=(p[0]-a.x)*a.scale,y=(p[1]-a.y)*a.scale,u=(p[2]-b.x)*b.scale,v=(p[3]-b.y)*b.scale;
    rows.push([x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]);rhs.push(u,v);
  }
  return normalizeHomography(multiply(multiply(b.inverse,[...leastSquares(rows,rhs),1]),a.t));
}
export function planeError(h:Mat3,p:Pair):number {
  const z=h[6]*p[0]+h[7]*p[1]+h[8];if(Math.abs(z)<1e-10)return Infinity;
  return Math.hypot((h[0]*p[0]+h[1]*p[1]+h[2])/z-p[2],(h[3]*p[0]+h[4]*p[1]+h[5])/z-p[3]);
}
export function robustPlane(pairs:readonly Pair[],threshold=1.5) {
  if(pairs.length<8 || pairs.length>256)throw new Error('insufficient-plane-support');
  let state=42,best:Pair[]=[],bestCost=Infinity;
  const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
  for(let iteration=0;iteration<96;iteration++) {
    const ids=new Set<number>();while(ids.size<4)ids.add(Math.floor(random()*pairs.length));
    try {
      const h=fitPlane([...ids].map(i=>pairs[i])),inliers:Pair[]=[];let cost=0;
      for(const p of pairs){const e=planeError(h,p);cost+=Math.min(e*e,threshold*threshold);if(e<=threshold)inliers.push(p);}
      if(inliers.length>best.length || (inliers.length===best.length && cost<bestCost)){best=inliers;bestCost=cost;}
    }catch { /* Degenerate sampled supports do not produce a model. */ }
  }
  if(best.length<8)throw new Error('no-plane-consensus');
  let h=fitPlane(best);
  for(let iteration=0;iteration<2;iteration++){const accepted=pairs.filter(p=>planeError(h,p)<=threshold);if(accepted.length<8)throw new Error('refit-lost-consensus');h=fitPlane(accepted);}
  return {h,inliers:pairs.map(p=>planeError(h,p)<=threshold)};
}
