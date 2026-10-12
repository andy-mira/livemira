/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import {copyCanonicalFrame} from './canonical-frame.ts';
import {algorithmVersion} from './reference.mjs';
/** Fixed-heap scalar/SIMD native operators; no pointer or mutable heap view escapes. */
export class WasmPreprocessor {
  #module;
  constructor(module){
    if(!(module?.HEAPU8 instanceof Uint8Array)||typeof module._e_rgba_gray!=='function'||typeof module._e_pyr_down!=='function')throw new Error('Invalid WASM preprocessing module');
    this.#module=module;
  }
  /** @returns {'wasm'} */
  get kind(){return 'wasm';}
  get algorithmVersion(){return algorithmVersion;}
  #run(data,width,height,stride,channels,down){
    const m=this.#module;if(!m)throw new Error('WASM preprocessor disposed');
    if(!(data instanceof Uint8Array)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>1048576||
      !Number.isSafeInteger(stride)||stride<width*channels||(height-1)*stride+width*channels>data.length||data.length>8*1048576)throw new RangeError('Invalid or oversized WASM image');
    const w=down?Math.ceil(width/2):width,h=down?Math.ceil(height/2):height;
    let src=0,dst=0;
    try{
      src=m._malloc(data.length);dst=m._malloc(w*h);if(!src||!dst)throw new Error('WASM allocation failed');
      m.HEAPU8.set(data,src);
      const rc=(down?m._e_pyr_down:m._e_rgba_gray)(src,data.length,width,height,stride,dst,w*h);
      if(rc)throw new RangeError('Native image validation failed');
      return {data:m.HEAPU8.slice(dst,dst+w*h),width:w,height:h,stride:w};
    }finally{if(src)m._free(src);if(dst)m._free(dst);}
  }
  rgbaToGray=(data,width,height,stride=width*4)=>this.#run(data,width,height,stride,4,false);
  buildPyramid=(image,levels=4)=>{
    if(!this.#module)throw new Error('WASM preprocessor disposed');
    if(!Number.isInteger(levels)||levels<1||levels>16)throw new RangeError('Invalid pyramid levels');
    const {data,width,height,stride=width}=image;
    if(!(data instanceof Uint8Array)||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>1048576||!Number.isSafeInteger(stride)||stride<width||(height-1)*stride+width>data.length)throw new RangeError('Invalid gray image');
    const base=new Uint8Array(width*height);for(let y=0;y<height;y++)base.set(data.subarray(y*stride,y*stride+width),y*width);
    const result=[{data:base,width,height,stride:width}];
    while(result.length<levels){const p=result.at(-1);if(p.width===1&&p.height===1)break;result.push(this.#run(p.data,p.width,p.height,p.stride,1,true));}
    return result;
  };
  copyFrame=(frame,signal)=>copyCanonicalFrame(frame,signal,{rgbaToGray:this.rgbaToGray,buildPyramid:this.buildPyramid});
  dispose(){this.#module=null;}
}
/**
 * @param {{ moduleUrl?: string, variant?: 'scalar' | 'simd', signal?: AbortSignal, moduleFactory?: () => Promise<unknown> | unknown }} [options]
 *   moduleUrl overrides the packaged artifact URL; variant selects the scalar or SIMD build; signal aborts initialization.
 *   moduleFactory supplies an already-loaded (for example embedded) Emscripten instance and bypasses all file loading; variant is still validated.
 * @returns {Promise<WasmPreprocessor>}
 */
export async function createWasmPreprocessor({moduleUrl,variant='scalar',signal,moduleFactory}={}){
  signal?.throwIfAborted();
  if(!['scalar','simd'].includes(variant))throw new RangeError('Unknown WASM variant');
  if(moduleFactory!==undefined){
    if(typeof moduleFactory!=='function')throw new TypeError('moduleFactory must be a function');
    const instance=await moduleFactory();signal?.throwIfAborted();return new WasmPreprocessor(instance);
  }
  // The single-file build defines __LM_EMBEDDED__ so this file-backed loader is removed from the bundle rather than shipped unreachable.
  return typeof __LM_EMBEDDED__!=='undefined'&&__LM_EMBEDDED__?Promise.reject(new TypeError('Embedded builds require moduleFactory')):loadFileBacked(moduleUrl,variant,signal);
}
async function loadFileBacked(moduleUrl,variant,signal){
  const url=moduleUrl??new URL(`../artifacts/${variant}/compute.mjs`,import.meta.url).href;
  const {default:factory}=await import(url);signal?.throwIfAborted();
  const instance=await factory();signal?.throwIfAborted();return new WasmPreprocessor(instance);
}
