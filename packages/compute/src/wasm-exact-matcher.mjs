/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import {MATCHING_VERSION,matchHamming32} from './hamming-matcher.mjs';
import {EXACT_MATCHING_WASM} from './exact-matching-wasm-binaries.mjs';

// ABI 1 layout of packages/compute/exact-matching-wasm/*.wat: one non-growable 4-page memory, ten resident target slots, one frame slot,
// u16 {targetIndex, frameIndex, distance} output triples per batch entry. Nothing is allocated per call.
const ABI=1,MEMORY_BYTES=4*65536,SLOT_BYTES=512*32,FRAME=163840,OUT=194560,OUT_SLOT=512*6,MAX_TARGETS=10;
/** Selection order: SIMD only when the engine validates it and it passes the self-test, then scalar; otherwise the caller keeps JS. */
export const WASM_EXACT_MATCHING_VARIANTS=Object.freeze(['simd','scalar']);
function abort(signal){if(signal?.aborted)throw Object.assign(new Error('Matching aborted'),{code:'ABORTED'});}
/** Descriptor count of packed 32-byte descriptors within one slot, or -1. */
function descriptorCount(bytes){return bytes instanceof Uint8Array&&bytes.length%32===0&&bytes.length<=SLOT_BYTES?bytes.length/32:-1;}
function decode(base64){const text=atob(base64),bytes=new Uint8Array(text.length);for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);return bytes;}

/** Exact matcher over one instantiated ABI-1 module. Synchronous; targets stay resident in WASM memory until replaced. */
export class WasmExactMatcher {
  #match;#u8;#u16;#variant;#targets=new Map();#failure=null;
  constructor(instance,variant){
    const e=instance?.exports;
    if(!WASM_EXACT_MATCHING_VARIANTS.includes(variant)||!(e?.memory instanceof WebAssembly.Memory)||e.memory.buffer.byteLength!==MEMORY_BYTES||typeof e.match!=='function'||typeof e.abi!=='function'||e.abi()!==ABI)throw new Error('Invalid exact matching module');
    this.#match=e.match;this.#variant=variant;
    // The memory cannot grow (min = max), so these views never detach.
    this.#u8=new Uint8Array(e.memory.buffer);this.#u16=new Uint16Array(e.memory.buffer);
  }
  get variant(){return this.#variant;}
  get available(){return this.#match!==null;}
  get diagnostics(){return {matchingVersion:MATCHING_VERSION,backend:this.#match?'wasm':'cpu',variant:this.#variant,fallbackReason:this.#failure,targetCount:this.#targets.size};}
  #live(){if(!this.#match)throw new Error('WASM exact matcher unavailable');}
  /** Replaces the resident roster: at most ten unique targets of at most 512 descriptors; validated completely before any byte is written. */
  setTargets(targets){
    this.#live();
    if(!Array.isArray(targets)||targets.length>MAX_TARGETS||new Set(targets.map(t=>t?.id)).size!==targets.length)throw new RangeError('Expected at most ten unique targets');
    const counts=targets.map(t=>{if(typeof t.id!=='string'||!t.id||t.id.length>256)throw new RangeError('Invalid target ID');const n=descriptorCount(t.descriptors);if(n<0)throw new RangeError('Expected at most 512 packed 32-byte descriptors');return n;});
    const next=new Map();
    targets.forEach((t,slot)=>{this.#u8.set(t.descriptors,slot*SLOT_BYTES);next.set(t.id,{offset:slot*SLOT_BYTES,count:counts[slot]});});
    this.#targets=next;
  }
  /** One frame upload, then one exact pass per requested resident target; pairs are in ascending target index. */
  matchBatch(targetIds,frame,signal){
    this.#live();abort(signal);
    if(!Array.isArray(targetIds)||targetIds.length>MAX_TARGETS||new Set(targetIds).size!==targetIds.length||targetIds.some(id=>!this.#targets.has(id)))throw new RangeError('Expected at most ten loaded targets');
    const m=descriptorCount(frame);if(m<0)throw new RangeError('Expected at most 512 packed 32-byte descriptors');
    const start=performance.now(),match=this.#match,u16=this.#u16,matches=[];
    this.#u8.set(frame,FRAME);
    for(let k=0;k<targetIds.length;k++){
      abort(signal);
      const target=this.#targets.get(targetIds[k]),out=OUT+k*OUT_SLOT,count=match(target.offset,target.count,out,m);
      if(!Number.isInteger(count)||count<0||count>Math.min(target.count,m))throw new Error('WASM exact matching failed');
      const pairs=new Array(count);
      for(let q=0,p=out>>>1;q<count;q++,p+=3)pairs[q]={targetIndex:u16[p],frameIndex:u16[p+1],distance:u16[p+2]};
      matches.push({targetId:targetIds[k],pairs});
    }
    abort(signal);
    return {backend:'wasm',variant:this.#variant,matchingVersion:MATCHING_VERSION,matches,timing:{totalMs:performance.now()-start}};
  }
  /** Permanently disables this instance (the caller then keeps the JavaScript matcher) and records why. */
  fail(reason){this.#failure=reason;this.dispose();}
  /** Drops every reference to the instance and its memory; later calls reject. */
  dispose(){this.#match=this.#u8=this.#u16=null;this.#targets.clear();}
}

// Deterministic self-test cases checked against the independent matchHamming32 before a variant is selected: random planted
// matches (including m and n not multiples of 4), duplicate targets (reverse tie), identical descriptors, distance 64/65 and ratio
// equality boundaries, a single frame descriptor, and full 512 x 512 capacity.
function selfTestCases(){
  let seed=0x2545f491;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;};
  const random=n=>{const b=new Uint8Array(n*32);for(let i=0;i<b.length;i++)b[i]=rnd()&255;return b;};
  const flip=(src,i,bits)=>{const d=src.slice(i*32,i*32+32);for(let k=0;k<bits;k++)d[k%32]^=1<<(k>>5);return d;};
  const join=list=>{const out=new Uint8Array(list.reduce((s,d)=>s+d.length,0));let o=0;for(const d of list){out.set(d,o);o+=d.length;}return out;};
  const target=random(37),frameList=[];
  for(let j=0;j<41;j++)frameList.push(j%3===0?flip(target,(j*7)%37,j%70):random(1));
  const zero=new Uint8Array(32),ones=bits=>{const d=new Uint8Array(32);for(let k=0;k<bits;k++)d[k>>3]|=1<<(k&7);return d;};
  const big=random(512);
  return [
    [target,join(frameList)],
    [join([target.slice(0,32),target.slice(0,32),target.slice(32,64)]),join([target.slice(0,32),target.slice(32,96)])],
    [join([zero,ones(256)]),join([ones(64),ones(65)])],
    [join([zero]),join([ones(64)])],[join([zero]),join([ones(65)])],
    [join([zero]),join([ones(30),ones(40)])],[join([zero]),join([ones(30),ones(41)])],[join([zero]),join([ones(30),ones(39),ones(200)])],
    [big,join([big.slice(0,32*300),random(212)])],
  ];
}
function selfTest(matcher){
  try{
    for(const [target,frame] of selfTestCases()){
      matcher.setTargets([{id:'self-test',descriptors:target}]);
      const got=matcher.matchBatch(['self-test'],frame).matches[0].pairs,want=matchHamming32(target,frame);
      if(got.length!==want.length||got.some((p,i)=>p.targetIndex!==want[i].targetIndex||p.frameIndex!==want[i].frameIndex||p.distance!==want[i].distance))return false;
    }
    matcher.setTargets([]);return true;
  }catch{return false;}
}

/**
 * Selects the first variant that the engine validates, instantiates and that reproduces the JavaScript reference on the self-test.
 * Never throws for an unsupported engine; rejects only when `signal` aborts.
 * @param {{variants?: readonly ('simd'|'scalar')[], signal?: AbortSignal, webAssembly?: typeof WebAssembly, binaries?: typeof EXACT_MATCHING_WASM}} [options]
 *   webAssembly and binaries are injection points for tests (null = no WebAssembly API; a corrupt module).
 * @returns {Promise<{matcher: WasmExactMatcher|null, variant: 'simd'|'scalar'|null, fallbackReason: string|null, attempts: {variant: string, outcome: string}[]}>}
 *   fallbackReason is null when the first requested variant was selected; it names the first rejection otherwise (with matcher null, JS stays).
 */
export async function selectWasmExactMatcher({variants=WASM_EXACT_MATCHING_VARIANTS,signal,webAssembly=globalThis.WebAssembly,binaries=EXACT_MATCHING_WASM}={}){
  abort(signal);
  if(!Array.isArray(variants)||!variants.length||variants.some(v=>!WASM_EXACT_MATCHING_VARIANTS.includes(v)))throw new RangeError('Unknown WASM exact matching variant');
  const attempts=[];
  if(typeof webAssembly?.instantiate!=='function'||typeof webAssembly.validate!=='function')return {matcher:null,variant:null,fallbackReason:'WASM_UNAVAILABLE',attempts:[{variant:'*',outcome:'WASM_UNAVAILABLE'}]};
  for(const variant of variants){
    let bytes;
    try{bytes=decode(binaries[variant].base64);}catch{attempts.push({variant,outcome:'WASM_MODULE_MISSING'});continue;}
    if(!webAssembly.validate(bytes)){attempts.push({variant,outcome:variant==='simd'?'WASM_SIMD_UNSUPPORTED':'WASM_MODULE_INVALID'});continue;}
    let matcher=null;
    try{const {instance}=await webAssembly.instantiate(bytes,{});abort(signal);matcher=new WasmExactMatcher(instance,variant);}
    catch(error){if(error?.code==='ABORTED')throw error;attempts.push({variant,outcome:'WASM_INIT_FAILED'});continue;}
    if(!selfTest(matcher)){matcher.dispose();attempts.push({variant,outcome:'WASM_SELFTEST_MISMATCH'});continue;}
    attempts.push({variant,outcome:'selected'});
    return {matcher,variant,fallbackReason:attempts.length>1?attempts[0].outcome:null,attempts};
  }
  return {matcher:null,variant:null,fallbackReason:attempts[0]?.outcome??'WASM_UNAVAILABLE',attempts};
}

/**
 * LegacyExactMatchingOperator over a WasmExactMatcher with a bounded resident roster (identity of each target's descriptor bytes).
 * Resolves null, so the recognizer runs its own JavaScript matchPacked for that frame, when the matcher is unavailable or a request
 * exceeds the fixed capacity. A WASM failure disables the matcher permanently (reported once through onFailure) and also resolves null:
 * the same frame is then matched in JavaScript, with identical results. Aborts reject.
 * @param {WasmExactMatcher} matcher
 * @param {{onFailure?: (reason: string) => void}} [options]
 */
export function createWasmExactMatchingAdapter(matcher,{onFailure}={}){
  let roster=new Map();
  return async(targets,frameDescriptors,signal)=>{
    if(!matcher.available)return null;
    abort(signal);
    if(targets.length>MAX_TARGETS||descriptorCount(frameDescriptors)<0||targets.some(t=>descriptorCount(t.descriptors)<0))return null;
    try{
      let changed=false,next=new Map(roster);
      for(const t of targets)if(next.get(t.targetId)!==t.descriptors){changed=true;next.set(t.targetId,t.descriptors);}
      if(next.size>MAX_TARGETS){next=new Map(targets.map(t=>[t.targetId,t.descriptors]));changed=true;}
      if(changed){roster=new Map();matcher.setTargets([...next].map(([id,descriptors])=>({id,descriptors})));roster=next;}
      return matcher.matchBatch(targets.map(t=>t.targetId),frameDescriptors,signal);
    }catch(error){
      if(error?.code==='ABORTED'||signal?.aborted)throw error;
      roster=new Map();matcher.fail('WASM_EXECUTION_FAILED');
      try{onFailure?.('WASM_EXECUTION_FAILED');}catch{/* Observers cannot block the JavaScript fallback. */}
      return null;
    }
  };
}
