/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Experimental numerical prototype. Not a shared contract or production estimator.
export function project(h, [x, y]) {
  const w = h[6] * x + h[7] * y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) throw new Error('projective horizon');
  const p = [(h[0]*x+h[1]*y+h[2])/w, (h[3]*x+h[4]*y+h[5])/w];
  if (!p.every(Number.isFinite)) throw new Error('nonfinite projection');
  return p;
}
export function multiply(a,b) {
  return Array.from({length:9},(_,i)=>[0,1,2].reduce((s,k)=>s+a[3*Math.floor(i/3)+k]*b[3*k+i%3],0));
}
function solve(a,b) {
  const m=a.map((r,i)=>[...r,b[i]]), n=b.length;
  for(let i=0;i<n;i++) {
    let p=i;
    for(let j=i+1;j<n;j++) if(Math.abs(m[j][i])>Math.abs(m[p][i])) p=j;
    if(Math.abs(m[p][i])<1e-10) throw new Error('degenerate correspondences');
    [m[i],m[p]]=[m[p],m[i]];
    const d=m[i][i]; for(let k=i;k<=n;k++) m[i][k]/=d;
    for(let j=0;j<n;j++) if(j!==i) {const v=m[j][i];for(let k=i;k<=n;k++)m[j][k]-=v*m[i][k];}
  }
  return m.map(r=>r[n]);
}
function normalization(points) {
  const c=[0,1].map(k=>points.reduce((s,p)=>s+p[k],0)/points.length);
  const radius=Math.sqrt(points.reduce((s,p)=>s+(p[0]-c[0])**2+(p[1]-c[1])**2,0)/points.length);
  if(radius<1e-8)throw new Error('collapsed points');
  const s=Math.SQRT2/radius;
  return {t:[s,0,-s*c[0],0,s,-s*c[1],0,0,1], inv:[1/s,0,c[0],0,1/s,c[1],0,0,1]};
}
export function fit(pairs) {
  if(pairs.length<4 || pairs.some(p=>p.length!==4 || !p.every(Number.isFinite)))throw new Error('invalid pairs');
  const a=normalization(pairs.map(p=>p.slice(0,2))),b=normalization(pairs.map(p=>p.slice(2)));
  const rows=[], rhs=[];
  for(const p of pairs) {
    const [x,y]=project(a.t,p),[u,v]=project(b.t,p.slice(2));
    rows.push([x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]);rhs.push(u,v);
  }
  const ata=Array.from({length:8},(_,i)=>Array.from({length:8},(_,j)=>rows.reduce((s,r)=>s+r[i]*r[j],0)));
  const atb=Array.from({length:8},(_,i)=>rows.reduce((s,r,k)=>s+r[i]*rhs[k],0));
  const h=multiply(multiply(b.inv,[...solve(ata,atb),1]),a.t);
  if(Math.abs(h[8])<1e-10)throw new Error('unsupported homography gauge');
  return h.map(v=>v/h[8]);
}
export function seeded(seed=42) {return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
export function robustFit(pairs, threshold=2, iterations=256) {
  if(pairs.length<4)throw new Error('insufficient matches');
  const rng=seeded();let best=[];
  for(let k=0;k<iterations;k++) {
    const ids=new Set();while(ids.size<4)ids.add(Math.floor(rng()*pairs.length));
    try {
      const h=fit([...ids].map(i=>pairs[i]));
      const inliers=pairs.filter(p=>{const q=project(h,p);return Math.hypot(q[0]-p[2],q[1]-p[3])<=threshold;});
      if(inliers.length>best.length)best=inliers;
    }catch { /* Singular samples are expected in robust estimation. */ }
  }
  if(best.length<4)throw new Error('no consensus');
  const h=fit(best);
  const inliers=pairs.filter(p=>{const q=project(h,p);return Math.hypot(q[0]-p[2],q[1]-p[3])<=threshold;});
  return {h,inliers};
}
export const corners=(w,h)=>[[0,0],[w,0],[w,h],[0,h]];
export function cornerError(a,b,w=400,h=300) {
  return corners(w,h).reduce((s,p)=>{const q=project(a,p),r=project(b,p);return s+Math.hypot(q[0]-r[0],q[1]-r[1]);},0)/4;
}
