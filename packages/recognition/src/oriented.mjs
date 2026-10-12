/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { validateGray } from '../experimental/features.mjs';

export const ORIENTED_ALGORITHM = 'c-oriented-brief256-v2';
export const ORIENTED_LEVELS = 6;
export const SCALE_STEP = 1.2;
let seed = 0x723abc91;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
const sampleOffset = () => { const r = Math.sqrt(random()) * 11, a = random() * Math.PI * 2; return [r * Math.cos(a), r * Math.sin(a)]; };
const pattern = Array.from({ length: 256 }, () => [...sampleOffset(), ...sampleOffset()]);

export function orientedPyramid(image, levels = ORIENTED_LEVELS) {
  validateGray(image);
  if (!Number.isInteger(levels) || levels < 1 || levels > 8) throw new Error('INVALID_LEVELS');
  const layers = [{ ...image, scale: 1 }];
  for (let level = 1; level < levels; level++) {
    const scale = SCALE_STEP ** level, width = Math.floor(image.width / scale), height = Math.floor(image.height / scale);
    if (Math.min(width, height) < 40) break;
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = Math.round(bilinear(image.data, image.width, (x + .5) * scale - .5, (y + .5) * scale - .5));
    layers.push({ width, height, scale, data });
  }
  return layers;
}
function bilinear(data, width, x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, i = iy * width + ix;
  return (1 - fy) * ((1 - fx) * data[i] + fx * data[i + 1]) + fy * ((1 - fx) * data[i + width] + fx * data[i + width + 1]);
}
function smooth(data, w, h) {
  const temp = new Float32Array(w*h), out = new Uint8Array(data);
  for (let y=0;y<h;y++) for(let x=1;x<w-1;x++) temp[y*w+x]=(data[y*w+x-1]+2*data[y*w+x]+data[y*w+x+1])/4;
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) out[y*w+x]=Math.round((temp[(y-1)*w+x]+2*temp[y*w+x]+temp[(y+1)*w+x])/4);
  return out;
}
function corners(data, w, h) {
  const xx=new Float32Array(w*h), yy=new Float32Array(w*h), xy=new Float32Array(w*h), scores=new Float32Array(w*h);
  for(let y=1;y<h-1;y++) for(let x=1;x<w-1;x++) { const i=y*w+x,gx=data[i+1]-data[i-1],gy=data[i+w]-data[i-w];xx[i]=gx*gx;yy[i]=gy*gy;xy[i]=gx*gy; }
  for(let y=15;y<h-15;y++) {
    let a=0,b=0,c=0;
    for(let dy=-1;dy<=1;dy++) for(let x=13;x<=15;x++) {const i=(y+dy)*w+x;a+=xx[i];b+=yy[i];c+=xy[i];}
    for(let x=15;x<w-15;x++) {
      for(let dy=-1;dy<=1;dy++){const i=(y+dy)*w+x;a+=xx[i+1]-xx[i-2];b+=yy[i+1]-yy[i-2];c+=xy[i+1]-xy[i-2];}
      scores[y*w+x]=a*b-c*c-.04*(a+b)**2;
    }
  }
  const candidates=[];
  for(let y=16;y<h-16;y++) for(let x=16;x<w-16;x++) {
    const score=scores[y*w+x]; if(score<1e6)continue;
    let peak=true;
    for(let dy=-1;dy<=1&&peak;dy++)for(let dx=-1;dx<=1;dx++)if((dx||dy)&&scores[(y+dy)*w+x+dx]>=score){peak=false;break;}
    if(peak)candidates.push({x,y,score});
  }
  candidates.sort((a,b)=>b.score-a.score||a.y-b.y||a.x-b.x);
  return candidates;
}
function orientation(data,w,x,y) {
  let mx=0,my=0;
  for(let dy=-12;dy<=12;dy++) for(let dx=-12;dx<=12;dx++) if(dx*dx+dy*dy<=144) {const v=data[(y+dy)*w+x+dx];mx+=dx*v;my+=dy*v;}
  return Math.atan2(my,mx);
}
export function extractOriented(image,{maxFeatures=512,levels=ORIENTED_LEVELS,roi=null}={}) {
  if(!Number.isInteger(maxFeatures)||maxFeatures<16||maxFeatures>512)throw new Error('INVALID_FEATURE_LIMIT');
  if(roi&&(!['x','y','width','height'].every(k=>Number.isFinite(roi[k]))||roi.x<0||roi.y<0||roi.width<=0||roi.height<=0||roi.x+roi.width>image.width||roi.y+roi.height>image.height))throw new Error('INVALID_ROI');
  const layers=orientedPyramid(image,levels),features=[];
  for(let level=0;level<layers.length;level++) {
    const {width:w,height:h,scale}=layers[level],data=smooth(layers[level].data,w,h),selected=[];
    const quota=Math.floor(maxFeatures/layers.length)+(level<maxFeatures%layers.length?1:0);
    for(const p of corners(data,w,h)) {
      const x=(p.x+.5)*scale-.5,y=(p.y+.5)*scale-.5;
      if(roi&&(x<roi.x||y<roi.y||x>=roi.x+roi.width||y>=roi.y+roi.height))continue;
      if(selected.some(q=>(q.x-p.x)**2+(q.y-p.y)**2<36))continue;
      const angle=orientation(data,w,p.x,p.y),c=Math.cos(angle),s=Math.sin(angle),descriptor=Array(32).fill(0);
      for(let bit=0;bit<256;bit++){
        const [ax,ay,bx,by]=pattern[bit];
        if(bilinear(data,w,p.x+c*ax-s*ay,p.y+s*ax+c*ay)<bilinear(data,w,p.x+c*bx-s*by,p.y+s*bx+c*by))descriptor[bit>>3]|=1<<(bit&7);
      }
      features.push({x,y,level,score:p.score,descriptor});selected.push(p);if(selected.length>=quota)break;
    }
  }
  return {features,pyramid:layers.map(({width,height,scale})=>({width,height,scale}))};
}
export function packDescriptors(features) {
  const packed=new Uint32Array(features.length*8);
  for(let i=0;i<features.length;i++)for(let k=0;k<8;k++){const d=features[i].descriptor,j=k*4;packed[i*8+k]=(d[j]|d[j+1]<<8|d[j+2]<<16|d[j+3]<<24)>>>0;}
  return packed;
}
function popcount(v){v=v-((v>>>1)&0x55555555);v=(v&0x33333333)+((v>>>2)&0x33333333);return (((v+(v>>>4))&0x0f0f0f0f)*0x01010101)>>>24;}
export function packedDistance(a,ai,b,bi){let d=0;for(let k=0;k<8;k++)d+=popcount(a[ai*8+k]^b[bi*8+k]);return d;}
// Per-word popcount reduced to 4-bit lanes (each <=4); lanes of two words add without overflow.
function nibbles(x){x=x-((x>>>1)&0x55555555)|0;return ((x&0x33333333)+((x>>>2)&0x33333333))|0;}
function byteLanes(v){return ((v&0x0f0f0f0f)+((v>>>4)&0x0f0f0f0f))|0;}
const isWords=(a,n)=>(a instanceof Uint32Array||a instanceof Int32Array)&&a.length>=n;
export function matchPacked(target,frame,tp=packDescriptors(target),fp=packDescriptors(frame)) {
  const nt=target.length,nf=frame.length;
  // Exact fast path only for in-range word views; every other input keeps the original coercion semantics.
  if(Number.isInteger(nt)&&Number.isInteger(nf)&&nt>=0&&nf>=0&&isWords(tp,nt*8)&&isWords(fp,nf*8))return matchWords(target,frame,tp,fp,nt,nf);
  return matchPackedGeneric(target,frame,tp,fp);
}
function matchWords(target,frame,tp,fp,nt,nf) {
  const reverse=new Int32Array(nf).fill(-1),rd=new Uint16Array(nf).fill(257),bests=new Uint16Array(nt),seconds=new Uint16Array(nt),indices=new Int32Array(nt);
  for(let i=0;i<nt;i++) {
    const o=i*8,t0=tp[o]|0,t1=tp[o+1]|0,t2=tp[o+2]|0,t3=tp[o+3]|0,t4=tp[o+4]|0,t5=tp[o+5]|0,t6=tp[o+6]|0,t7=tp[o+7]|0;
    let best=257,second=257,index=-1;
    for(let j=0,p=0;j<nf;j++,p+=8) {
      const a=nibbles(t0^fp[p])+nibbles(t1^fp[p+1]),b=nibbles(t2^fp[p+2])+nibbles(t3^fp[p+3]),c=nibbles(t4^fp[p+4])+nibbles(t5^fp[p+5]),e=nibbles(t6^fp[p+6])+nibbles(t7^fp[p+7]);
      let s=(byteLanes(a)+byteLanes(b)+byteLanes(c)+byteLanes(e))|0;
      s=((s&0x00ff00ff)+((s>>>8)&0x00ff00ff))|0;
      const d=(s&0xffff)+(s>>>16);
      if(d<best){second=best;best=d;index=j;}else if(d<second)second=d;
      const r=rd[j];
      if(d<r){rd[j]=d;reverse[j]=i;}else if(d===r)reverse[j]=-1;
    }
    bests[i]=best;seconds[i]=second;indices[i]=index;
  }
  const out=[];
  for(let i=0;i<nt;i++){const index=indices[i],best=bests[i];if(index>=0&&best<=64&&4*best<3*seconds[i]&&reverse[index]===i)out.push({target:[target[i].x,target[i].y],image:[frame[index].x,frame[index].y],distance:best});}
  return out;
}
function matchPackedGeneric(target,frame,tp,fp) {
  const reverse=new Int32Array(frame.length).fill(-1),rd=new Uint16Array(frame.length).fill(257),nearest=[];
  for(let i=0;i<target.length;i++) {
    let best=257,second=257,index=-1;
    for(let j=0;j<frame.length;j++) {const d=packedDistance(tp,i,fp,j);if(d<best){second=best;best=d;index=j;}else if(d<second)second=d;if(d<rd[j]){rd[j]=d;reverse[j]=i;}else if(d===rd[j])reverse[j]=-1;}
    nearest.push({best,second,index});
  }
  return nearest.flatMap(({best,second,index},i)=>index>=0&&best<=64&&4*best<3*second&&reverse[index]===i?[{target:[target[i].x,target[i].y],image:[frame[index].x,frame[index].y],distance:best}]:[]);
}

const TABLES=6,BITS=12;
function key(packed,index,table){let key=0;for(let k=0;k<BITS;k++){const bit=(table*41+k*19)%256;key|=((packed[index*8+(bit>>5)]>>>(bit&31))&1)<<k;}return key;}
export class TargetIndex {
  constructor(targets){
    this.targets=targets;this.tables=Array.from({length:TABLES},()=>new Map());this.entries=[];
    for(let t=0;t<targets.length;t++)for(let i=0;i<targets[t].features.length;i++){
      const id=this.entries.length;this.entries.push({t,i});
      for(let table=0;table<TABLES;table++){const k=key(targets[t].packed,i,table),bucket=this.tables[table].get(k)||[];bucket.push(id);this.tables[table].set(k,bucket);}
    }
  }
  query(features,{maxCandidates=3,maxComparisons=40000,maxBucketVisits=150000}={}) {
    if(!Number.isInteger(maxCandidates)||maxCandidates<1||maxCandidates>3||!Number.isInteger(maxComparisons)||maxComparisons<1||maxComparisons>100000||!Number.isInteger(maxBucketVisits)||maxBucketVisits<1||maxBucketVisits>500000)throw new Error('INVALID_RETRIEVAL_BUDGET');
    const packed=packDescriptors(features),votes=Array(this.targets.length).fill(0),seen=new Int32Array(this.entries.length).fill(-1);
    let comparisons=0,bucketVisits=0,exhausted=false,uninformative=0;
    // Stratify the query budget over the complete scale-ordered feature list.
    // Do not spend the entire budget on the first (finest) pyramid level.
    const queryCount=Math.min(128,features.length),perQuery=Math.max(1,Math.floor(maxComparisons/Math.max(1,queryCount)));
    for(let query=0;query<queryCount;query++){
      const j=Math.floor(query*features.length/queryCount),queryStart=comparisons;
      const best=Array(this.targets.length).fill(257);
      outer:for(let probe=-1;probe<BITS;probe++)for(let table=0;table<TABLES;table++){
        const base=key(packed,j,table),bucket=this.tables[table].get(probe<0?base:base^(1<<probe))||[];
        // Evenly sample large buckets so target insertion order cannot monopolize work.
        const samples=Math.min(8,bucket.length),offset=(j*17+table*11+(probe+1)*7)%Math.max(1,bucket.length);
        for(let sample=0;sample<samples;sample++){
          const id=bucket[(offset+Math.floor(sample*bucket.length/samples))%bucket.length];
          if(++bucketVisits>maxBucketVisits){bucketVisits=maxBucketVisits;exhausted=true;break outer;}
          if(seen[id]===j)continue;seen[id]=j;
          if(comparisons>=maxComparisons||comparisons-queryStart>=perQuery){exhausted=true;break outer;}
          const {t,i}=this.entries[id],d=packedDistance(this.targets[t].packed,i,packed,j);comparisons++;
          if(d<best[t])best[t]=d;
        }
      }
      const nearest=Math.min(...best),winners=best.flatMap((d,t)=>d<=48&&d<=nearest+2?[t]:[]);
      if(winners.length>3)uninformative++;
      else for(const t of winners)votes[t]+=(64-best[t])**2/4096;
      if(comparisons>=maxComparisons||bucketVisits>=maxBucketVisits)break;
    }
    const ranked=votes.map((score,index)=>({score,index})).sort((a,b)=>b.score-a.score||a.index-b.index).filter(r=>r.score>=4);
    const ambiguous=(!ranked.length&&uninformative>=4)||(ranked.length>maxCandidates&&ranked[maxCandidates].score>=ranked[0].score*.85);
    return {indices:ambiguous?[]:ranked.slice(0,maxCandidates).map(r=>r.index),votes,packed,comparisons,bucketVisits,exhausted,ambiguous};
  }
}
