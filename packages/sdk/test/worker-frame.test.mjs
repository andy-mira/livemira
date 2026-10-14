import test from 'node:test';
import assert from 'node:assert/strict';
import {createVisionWorkerRuntime,standardFrame,FrameCache} from '../../../dist/sdk/src/worker-runtime.js';
import {createCpuPipeline} from '../../../dist/sdk/src/cpu.js';
import {rgbaToGray} from '../../../dist/compute/src/reference.mjs';
import {mockFrame} from '../../../dist/sdk/src/mock.js';
import {createGeometry,toFrameGeometry,prepareWorkerFrame} from '../../camera/src/index.mjs';
import {compileGrayTarget} from '../../target-compiler/index.mjs';
import {texture} from '../../../tests/recognition/fixtures.mjs';

// Node has no OffscreenCanvas. This fake keeps real RGBA pixels and maps them with the supplied affine transform
// (nearest neighbour), so these tests check the worker's cache/clear/stride/limit logic, not browser resampling.
class FakeImageData {
  constructor(data,width,height,log){if(!(data instanceof Uint8ClampedArray)||data.length!==width*height*4)throw new RangeError('ImageData size');Object.assign(this,{data,width,height});log.imageData++;}
}
function installCanvas(flags={}) {
  const log={canvases:[],contexts:0,resizes:0,clears:0,draws:0,imageData:0,contextOptions:[],flags:{noContext:false,ctorThrows:false,...flags}};
  class Context {
    constructor(canvas){this.canvas=canvas;this.t=[1,0,0,1,0,0];}
    setTransform(a,b,c,d,e,f){this.t=[a,b,c,d,e,f];}
    resetTransform(){this.t=[1,0,0,1,0,0];}
    clearRect(x,y,w,h){log.clears++;const c=this.canvas;for(let j=y;j<y+h;j++)c.pixels.fill(0,(j*c.width+x)*4,(j*c.width+x+w)*4);}
    putImageData(image,x,y){const c=this.canvas;for(let j=0;j<image.height;j++)c.pixels.set(image.data.subarray(j*image.width*4,(j+1)*image.width*4),((y+j)*c.width+x)*4);}
    getImageData(x,y,w,h){const c=this.canvas,data=new Uint8ClampedArray(w*h*4);for(let j=0;j<h;j++)data.set(c.pixels.subarray(((y+j)*c.width+x)*4,((y+j)*c.width+x+w)*4),j*w*4);return new FakeImageData(data,w,h,log);}
    drawImage(source){
      log.draws++;const c=this.canvas,[a,b,cc,d,e,f]=this.t,det=a*d-b*cc,sw=source.displayWidth??source.width,sh=source.displayHeight??source.height;
      if(!det)return;
      for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){
        const X=x+.5-e,Y=y+.5-f,sx=Math.floor((d*X-cc*Y)/det),sy=Math.floor((-b*X+a*Y)/det);
        if(sx>=0&&sy>=0&&sx<sw&&sy<sh){const s=(sy*sw+sx)*4,t=(y*c.width+x)*4;c.pixels[t]=source.pixels[s];c.pixels[t+1]=source.pixels[s+1];c.pixels[t+2]=source.pixels[s+2];c.pixels[t+3]=source.pixels[s+3];}
      }
    }
  }
  class Canvas {
    #w;#h;
    constructor(w,h){if(log.flags.ctorThrows)throw new Error('canvas allocation failed');this.#w=w;this.#h=h;this.pixels=new Uint8ClampedArray(w*h*4);log.canvases.push(this);}
    // resizes counts effective size changes; assigning the same value is a no-op here (a real canvas would also clear).
    get width(){return this.#w;}set width(v){if(v!==this.#w)log.resizes++;this.#w=v;this.pixels=new Uint8ClampedArray(v*this.#h*4);}
    get height(){return this.#h;}set height(v){if(v!==this.#h)log.resizes++;this.#h=v;this.pixels=new Uint8ClampedArray(this.#w*v*4);}
    getContext(type,options){log.contexts++;log.contextOptions.push(options);if(log.flags.noContext)return null;return this.context??=new Context(this);}
  }
  globalThis.OffscreenCanvas=Canvas;globalThis.ImageData=class extends FakeImageData{constructor(d,w,h){super(d,w,h,log);}};
  return log;
}
function uninstallCanvas(){delete globalThis.OffscreenCanvas;delete globalThis.ImageData;}
async function withCanvas(flagsOrFn,maybeFn) {
  const flags=typeof flagsOrFn==='function'?{}:flagsOrFn,fn=typeof flagsOrFn==='function'?flagsOrFn:maybeFn,log=installCanvas(flags);
  try{return await fn(log);}finally{uninstallCanvas();}
}
const metadata=(id,width,height,pixelFormat='rgba8',rotation=0,mirrored=false)=>{const {imageHandle:_,...m}={...mockFrame('s',id),width,height,pixelFormat,rotation,mirrored,mappedObservationTimeUs:id*33333,imageIdentity:`image-${id}`};return m;};
const rgbaPattern=(w,h,seed=0)=>{const d=new Uint8Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;d[i]=(x*7+y*3+seed)&255;d[i+1]=(x*5+y*11+40+seed)&255;d[i+2]=(x*13+y*2+90)&255;d[i+3]=255;}return d;};
const rawFrame=(id,pixels,width,height,geometry,{kind='rgba8',strideBytes=width*(kind==='gray8'?1:4),rotation=0,mirrored=false}={})=>({metadata:metadata(id,width,height,kind,rotation,mirrored),image:{kind,buffer:pixels.buffer.slice(pixels.byteOffset,pixels.byteOffset+pixels.byteLength),width,height,strideBytes},geometry});
const handGeometry=(standardWidth,standardHeight,H)=>({H_standardFromInput:H,H_viewportFromStandard:[1,0,0,0,1,0,0,0,1],crop:{x:0,y:0,width:1,height:1},rotation:0,mirrored:false,objectFit:'contain',standardWidth,standardHeight,cssWidth:standardWidth,cssHeight:standardHeight,devicePixelRatio:1});
const IDENT=[1,0,0,0,1,0,0,0,1],HALF=[.5,0,0,0,.5,0,0,0,1];
const failsWith=(code,log)=>e=>{assert.equal(e.code,code);if(log)assert.equal(log.canvases.length,0,'canvas allocated before validation');assert.equal(log?.imageData??0,0);return true;};

test('canvas and context are cached per runtime, resized only when dimensions change and drawn with a cleared output',()=>withCanvas(log=>{
  const cache=new FrameCache(),H=HALF;
  for(let i=0;i<3;i++)standardFrame(rawFrame(i+1,rgbaPattern(8,6,i),8,6,handGeometry(4,3,H)),cache);
  assert.equal(log.canvases.length,2);assert.equal(log.contexts,2);assert.equal(log.resizes,0);assert.equal(log.clears,3);
  assert.deepEqual(log.contextOptions,[undefined,{willReadFrequently:true}]);
  standardFrame(rawFrame(4,rgbaPattern(10,6),10,6,handGeometry(4,3,H)),cache);
  assert.equal(log.canvases.length,2);assert.equal(log.resizes,1,'only the input width changed');
  standardFrame(rawFrame(5,rgbaPattern(10,6),10,6,handGeometry(5,3,H)),cache);
  assert.equal(log.canvases.length,2);assert.equal(log.resizes,2,'only the output width changed');
  standardFrame(rawFrame(6,rgbaPattern(10,6),10,6,handGeometry(5,3,H)),cache);
  assert.equal(log.resizes,2);assert.equal(log.contexts,2);
  const [input,output]=log.canvases;cache.dispose();
  for(const canvas of [input,output]){assert.equal(canvas.width,0);assert.equal(canvas.height,0);}
  standardFrame(rawFrame(7,rgbaPattern(8,6),8,6,handGeometry(4,3,H)),cache);assert.equal(log.canvases.length,4,'dispose drops the cache; a later frame builds fresh canvases');
}));

test('two runtimes never share canvases and each releases only its own on dispose',()=>withCanvas(async log=>{
  const outputs=[],runtimes=[0,1].map(()=>{const sink=[];outputs.push(sink);return createVisionWorkerRuntime(m=>sink.push(m));});
  let id=0;const send=(i,message)=>runtimes[i]({protocol:1,requestId:++id,generation:1,...message});
  for(const i of [0,1])await send(i,{type:'init',options:{trackingMode:'absolute',backendPreference:'cpu'}});
  for(const i of [0,1])await send(i,{type:'frame',frame:rawFrame(1,rgbaPattern(8,6),8,6,handGeometry(4,3,HALF))});
  assert.equal(log.canvases.length,4);assert.deepEqual(outputs.map(o=>o.at(-1).type),['error','error'],'no targets are loaded, but preparation already ran');
  await send(0,{type:'dispose'});assert.equal(outputs[0].at(-1).type,'ack');
  assert.deepEqual(log.canvases.map(c=>c.width===0&&c.height===0),[true,true,false,false]);
  await send(1,{type:'dispose'});assert.ok(log.canvases.every(c=>c.width===0&&c.height===0));
}));

test('output is cleared each frame: uncovered transparent pixels never keep the previous frame, and equal a fresh cache',()=>withCanvas(()=>{
  const cache=new FrameCache(),white=new Uint8Array(8*6*4).fill(255),half=handGeometry(8,6,HALF),full=handGeometry(8,6,IDENT);
  const first=standardFrame(rawFrame(1,white,8,6,full),cache).imageHandle.data;
  assert.ok(first.every(v=>v===255));
  const second=standardFrame(rawFrame(2,white,8,6,half),cache).imageHandle.data;
  const fresh=standardFrame(rawFrame(2,white,8,6,half),new FrameCache()).imageHandle.data;
  assert.deepEqual([...second],[...fresh]);
  for(let y=0;y<6;y++)for(let x=0;x<8;x++)assert.equal(second[y*8+x],x<4&&y<3?255:0,`pixel ${x},${y}`);
  // The transform is reset after every draw, so a following identity draw is unaffected.
  assert.ok(standardFrame(rawFrame(3,white,8,6,full),cache).imageHandle.data.every(v=>v===255));
}));

test('gray, stride and orientation results match an independent expectation and never touch the source bytes',()=>withCanvas(()=>{
  const cache=new FrameCache(),w=6,h=4,rgba=rgbaPattern(w,h),expected=rgbaToGray(rgba,w,h).data;
  // Strided RGBA with poisoned padding.
  const stride=w*4+12,padded=new Uint8Array(stride*h).fill(0xaa);for(let y=0;y<h;y++)padded.set(rgba.subarray(y*w*4,(y+1)*w*4),y*stride);
  for(const geometry of [null,handGeometry(w,h,IDENT)]){
    const frame=rawFrame(1,padded,w,h,geometry,{strideBytes:stride}),before=new Uint8Array(frame.image.buffer).slice();
    const out=standardFrame(frame,cache);assert.equal(out.width,w);assert.equal(out.height,h);assert.equal(out.pixelFormat,'gray8');
    assert.deepEqual([...out.imageHandle.data],[...expected]);assert.deepEqual(new Uint8Array(frame.image.buffer),before);assert.equal(frame.image.buffer.byteLength,before.byteLength);
  }
  // Gray8 with and without stride, with and without geometry.
  const gray=new Uint8Array(w*h).map((_,i)=>(i*37+5)&255),grayStride=w+3,grayPadded=new Uint8Array(grayStride*h).fill(0xbb);for(let y=0;y<h;y++)grayPadded.set(gray.subarray(y*w,(y+1)*w),y*grayStride);
  for(const [pixels,strideBytes] of [[gray,w],[grayPadded,grayStride]])for(const geometry of [null,handGeometry(w,h,IDENT)]){
    const out=standardFrame(rawFrame(2,pixels,w,h,geometry,{kind:'gray8',strideBytes}),cache);assert.deepEqual([...out.imageHandle.data],[...gray]);assert.equal(out.imageHandle.data.length,w*h);
  }
  // Rotation 90 + real createGeometry: source (x,y) lands on column h-1-y, row x.
  const rotated=toFrameGeometry(createGeometry({width:w,height:h,rotation:90,longEdge:'native'})),turned=standardFrame(rawFrame(3,rgba,w,h,rotated,{rotation:90}),cache);
  assert.equal(turned.width,h);assert.equal(turned.height,w);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)assert.equal(turned.imageHandle.data[x*h+(h-1-y)],expected[y*w+x],`rotated ${x},${y}`);
  const mirroredGeometry=toFrameGeometry(createGeometry({width:w,height:h,mirrored:true,longEdge:'native'})),flipped=standardFrame(rawFrame(4,rgba,w,h,mirroredGeometry,{mirrored:true}),cache);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)assert.equal(flipped.imageHandle.data[y*w+(w-1-x)],expected[y*w+x],`mirrored ${x},${y}`);
  // Different sizes in sequence never leak earlier pixels.
  const small=standardFrame(rawFrame(5,rgbaPattern(3,2,9),3,2,handGeometry(3,2,IDENT)),cache).imageHandle.data;
  assert.deepEqual([...small],[...rgbaToGray(rgbaPattern(3,2,9),3,2).data]);
}));

test('layout, geometry and size limits fail explicitly before any canvas or ImageData allocation',()=>withCanvas(log=>{
  const cache=new FrameCache(),ok=rgbaPattern(4,4),good=handGeometry(4,4,IDENT);
  const bad=(frame,code)=>assert.throws(()=>standardFrame(frame,cache),failsWith(code,log));
  // Malformed raw layouts.
  const f=(over={})=>({...rawFrame(1,ok,4,4,good),...over});
  bad(f({image:{...f().image,strideBytes:15}}),'FRAME_FAILED');
  bad(f({image:{...f().image,buffer:new ArrayBuffer(60)}}),'FRAME_FAILED');
  bad(f({image:{...f().image,width:0}}),'FRAME_FAILED');
  bad(f({image:{...f().image,height:2.5}}),'FRAME_FAILED');
  bad(f({image:{...f().image,width:NaN}}),'FRAME_FAILED');
  bad(f({image:{...f().image,kind:'bgra8'}}),'FRAME_FAILED');
  bad(f({image:{...f().image,strideBytes:Number.MAX_SAFE_INTEGER}}),'FRAME_FAILED');
  bad(f({geometry:null,metadata:metadata(1,4,4,'rgba8',90)}),'UNSUPPORTED');
  // Malformed geometry.
  for(const H of [[1,0,0,0,1,0,0,0],[1,0,0,0,1,0,0,0,2],[1,0,0,0,1,0,.5,0,1],[1,0,0,0,1,0,0,.1,1],[NaN,0,0,0,1,0,0,0,1],[1,0,Infinity,0,1,0,0,0,1],[1,0,0,0,'1',0,0,0,1],null])bad(f({geometry:handGeometry(4,4,H)}),'FRAME_FAILED');
  for(const [w,h] of [[0,4],[4,0],[3.5,4],[NaN,4],[-4,4]])bad(f({geometry:handGeometry(w,h,IDENT)}),'FRAME_FAILED');
  // Standard (processing) cap: 4096 per edge and 4,194,304 pixels; frames are never resized silently.
  for(const [w,h] of [[4097,10],[10,4097],[4096,1025],[2049,2049]])bad(f({geometry:handGeometry(w,h,IDENT)}),'UNSUPPORTED');
  bad({metadata:metadata(1,4097,1,'gray8'),image:{kind:'gray8',buffer:new ArrayBuffer(4097),width:4097,height:1,strideBytes:4097},geometry:null},'UNSUPPORTED');
  // Native image over the raw source cap, and a native image with an oversized standard image.
  const native={displayWidth:1920,displayHeight:1080,pixels:rgbaPattern(1,1),close(){}};
  bad({metadata:metadata(1,1920,1080,'video-frame'),image:{kind:'video-frame',image:native},geometry:handGeometry(5000,10,IDENT)},'UNSUPPORTED');
  bad({metadata:metadata(1,16385,1,'video-frame'),image:{kind:'video-frame',image:{...native,displayWidth:16385,displayHeight:1}},geometry:good},'UNSUPPORTED');
  bad({metadata:metadata(1,1920,1080,'video-frame'),image:{kind:'video-frame',image:native},geometry:null},'UNSUPPORTED');
  assert.equal(log.draws,0);
  // Raw source over 16,777,216 pixels (a real 4097x4097 buffer) is rejected even though the standard image would be small.
  const huge=new ArrayBuffer(4097*4097);
  bad({metadata:metadata(1,4097,4097,'gray8'),image:{kind:'gray8',buffer:huge,width:4097,height:4097,strideBytes:4097},geometry:handGeometry(100,100,IDENT)},'UNSUPPORTED');
  bad({metadata:metadata(1,16385,1,'gray8'),image:{kind:'gray8',buffer:new ArrayBuffer(16385),width:16385,height:1,strideBytes:16385},geometry:handGeometry(100,100,IDENT)},'UNSUPPORTED');
  assert.equal(huge.byteLength,4097*4097,'source buffer not detached');
}));

test('raw sources above 4,194,304 pixels downsample to a valid standard image; 4,194,304 standard pixels is the cap',()=>withCanvas(log=>{
  const cache=new FrameCache(),w=2400,h=1800,gray=new Uint8Array(w*h).map((_,i)=>(i*13)&255);
  const out=standardFrame(rawFrame(1,gray,w,h,handGeometry(1200,900,HALF),{kind:'gray8'}),cache);
  assert.equal(out.width,1200);assert.equal(out.height,900);assert.equal(out.imageHandle.data.length,1200*900);
  // Pixel centres: destination (x,y) samples source (2x+1,2y+1).
  assert.equal(out.imageHandle.data[0],gray[w+1]);assert.equal(out.imageHandle.data[1],gray[w+3]);assert.equal(out.imageHandle.data[1200],gray[3*w+1]);
  assert.equal(log.canvases[0].width,w);assert.equal(log.canvases[1].width,1200);
}));

test('no OffscreenCanvas, no 2D context, constructor failure and missing ImageData are explicit and leave no cached resources',()=>{
  const frame=()=>rawFrame(1,rgbaPattern(4,4),4,4,handGeometry(4,4,IDENT));
  assert.throws(()=>standardFrame(frame(),new FrameCache()),e=>e.code==='UNSUPPORTED');
  return withCanvas({noContext:true},log=>{
    const cache=new FrameCache();
    assert.throws(()=>standardFrame(frame(),cache),e=>e.code==='UNSUPPORTED');
    assert.equal(log.canvases.length,1);assert.equal(log.canvases[0].width,0,'a canvas without a context is released');
    log.flags.noContext=false;const out=standardFrame(frame(),cache);assert.equal(out.width,4);assert.equal(log.canvases.length,3,'failed surface was not cached');
    log.flags.ctorThrows=true;const fresh=new FrameCache();assert.throws(()=>standardFrame(frame(),fresh),e=>e.code==='UNSUPPORTED');
    log.flags.noContext=true;log.flags.ctorThrows=false;
    // Output context unavailable after the input surface exists: the input stays owned by the cache and is released by dispose.
    const partial=new FrameCache(),opened=log.canvases.length;log.flags.noContext=false;
    const original=globalThis.OffscreenCanvas;let calls=0;globalThis.OffscreenCanvas=class extends original{getContext(...a){return ++calls===2?null:super.getContext(...a);}};
    assert.throws(()=>standardFrame(frame(),partial),e=>e.code==='UNSUPPORTED');
    const created=log.canvases.slice(opened);assert.equal(created.length,2);assert.equal(created[1].width,0);
    partial.dispose();assert.ok(created.every(c=>c.width===0&&c.height===0));
  }).then(()=>{
    globalThis.OffscreenCanvas=class{};
    try{assert.throws(()=>standardFrame(frame(),new FrameCache()),e=>e.code==='UNSUPPORTED');}finally{delete globalThis.OffscreenCanvas;}
  });
});

test('optional WASM preprocessing is capped at 1,048,576 pixels; larger frames fall back to the CPU kernel and say so',async t=>{
  const messages=[],handle=createVisionWorkerRuntime(m=>messages.push(m));let id=0;const send=message=>handle({protocol:1,requestId:++id,generation:1,...message});
  await send({type:'init',options:{trackingMode:'absolute',backendPreference:'wasm'}});
  const capability=()=>messages.at(-1).capability;
  if(capability().fallbackReason==='WASM_INIT_FAILED')return t.skip('WASM preprocessor unavailable in this environment');
  assert.equal(capability().operators.preprocessing,'wasm-scalar');assert.match(capability().operators.preprocessingLimit,/1048576/);
  const small=rgbaPattern(1024,1024),large=rgbaPattern(1025,1024),target=await compileGrayTarget(texture(),{targetId:'wasm-cap'});
  await send({type:'frame',frame:rawFrame(1,small,1024,1024,null)});
  assert.equal(messages.at(-1).type,'error','no targets yet; the frame still converted through WASM');
  await send({type:'load-targets',targets:[target]});await send({type:'reset',sessionId:'s'});
  assert.equal(capability().fallbackReason,null);assert.equal(capability().operators.preprocessing,'wasm-scalar');
  // The announcement rides on the first successful result after the real fallback, once only.
  const results=[];
  for(const [n,pixels,w] of [[2,small,1024],[3,small,1024],[4,large,1025],[5,large,1025],[6,small,1024]]){
    await send({type:'frame',frame:rawFrame(n,pixels,w,1024,null)});assert.equal(messages.at(-1).type,'result');results.push(messages.at(-1));
  }
  assert.deepEqual(results.map(r=>r.capability!==undefined),[false,false,true,false,false]);
  assert.equal(results[2].capability.fallbackReason,'WASM_PIXEL_LIMIT_CPU_FALLBACK');assert.equal(results[2].capability.operators.preprocessing,'wasm-scalar+cpu-fallback');assert.match(results[2].capability.operators.preprocessingLimit,/1048576/);
  await send({type:'dispose'});
  // A failed frame keeps the announcement pending; a ready that already carries the fallback clears it.
  const later=[],second=createVisionWorkerRuntime(m=>later.push(m));let id2=0;const send2=message=>second({protocol:1,requestId:++id2,generation:1,...message});
  await send2({type:'init',options:{trackingMode:'absolute',backendPreference:'wasm'}});
  await send2({type:'frame',frame:rawFrame(1,large,1025,1024,null)});assert.equal(later.at(-1).type,'error');assert.equal(later.at(-1).capability,undefined);
  await send2({type:'load-targets',targets:[target]});await send2({type:'reset',sessionId:'s'});
  assert.equal(later.at(-1).capability.fallbackReason,'WASM_PIXEL_LIMIT_CPU_FALLBACK','ready announces the fallback that a failed frame had caused');
  await send2({type:'frame',frame:rawFrame(2,large,1025,1024,null)});assert.equal(later.at(-1).type,'result');assert.equal(later.at(-1).capability,undefined,'already announced');
  await send2({type:'dispose'});
});

test('size-limit errors carry a stable safe reason; other failures stay generic and never leak exception text',()=>withCanvas(async log=>{
  const messages=[],handle=createVisionWorkerRuntime(m=>messages.push(m));let id=0;const send=message=>handle({protocol:1,requestId:++id,generation:1,...message});
  await send({type:'init',options:{trackingMode:'absolute',backendPreference:'cpu'}});
  await send({type:'frame',frame:rawFrame(1,new Uint8Array(4097),4097,1,null,{kind:'gray8'})});
  const oversize=messages.at(-1);assert.equal(oversize.code,'UNSUPPORTED');assert.match(oversize.reason,/Standard image exceeds processing limit/);
  await send({type:'frame',frame:rawFrame(2,new Uint8Array(4*4*4),4,4,handGeometry(4097,1,IDENT))});assert.equal(messages.at(-1).reason,oversize.reason);
  log.flags.noContext=true;
  await send({type:'frame',frame:rawFrame(3,new Uint8Array(4*4*4),4,4,handGeometry(4,4,IDENT))});
  const noCanvas=messages.at(-1);assert.equal(noCanvas.code,'UNSUPPORTED');assert.equal(noCanvas.reason,'Worker operation failed');assert.notEqual(noCanvas.reason,oversize.reason);
  // Hostile exception text from a lower layer is not forwarded.
  globalThis.OffscreenCanvas=class{constructor(){throw new Error('secret https://example.invalid/?token=1');}};
  await send({type:'frame',frame:rawFrame(4,new Uint8Array(4*4*4),4,4,handGeometry(4,4,IDENT))});
  assert.equal(messages.at(-1).reason,'Worker operation failed');assert.ok(!JSON.stringify(messages).includes('secret'));
}));

test('dispose releases canvases and wasm even when the pipeline disposer rejects, and still reports the failure',()=>withCanvas(async log=>{
  const messages=[];let failDispose=true;
  const handle=createVisionWorkerRuntime(m=>messages.push(m),options=>{const real=createCpuPipeline(options);return {...real,async dispose(){await real.dispose();if(failDispose)throw new Error('private disposer detail');}};});
  let id=0;const send=message=>handle({protocol:1,requestId:++id,generation:1,...message});
  await send({type:'init',options:{trackingMode:'absolute',backendPreference:'cpu'}});
  await send({type:'frame',frame:rawFrame(1,rgbaPattern(4,4),4,4,handGeometry(4,4,IDENT))});assert.equal(log.canvases.length,2);
  await send({type:'dispose'});
  assert.equal(messages.at(-1).type,'error','failure is still reported');assert.equal(messages.at(-1).reason,'Worker operation failed');assert.ok(!JSON.stringify(messages.at(-1)).includes('private'));
  assert.ok(log.canvases.every(c=>c.width===0&&c.height===0),'caches released despite the failed disposer');
  // The runtime can be initialized again and builds fresh canvases.
  failDispose=false;
  await send({type:'init',options:{trackingMode:'absolute',backendPreference:'cpu'}});assert.equal(messages.at(-1).type,'ready');
  await send({type:'frame',frame:rawFrame(2,rgbaPattern(4,4),4,4,handGeometry(4,4,IDENT))});assert.equal(log.canvases.length,4);
  await send({type:'dispose'});assert.equal(messages.at(-1).type,'ack');
}));

test('real 720p and 1080p portrait and landscape frames pass through prepareWorkerFrame, transfer and CPU Worker conversion',()=>withCanvas(async log=>{
  const cache=new FrameCache();
  for(const [w,h] of [[720,1280],[1280,720],[1080,1920],[1920,1080]]){
    const rgba=rgbaPattern(w,h,w),source=rgba.slice(),geometry=toFrameGeometry(createGeometry({width:w,height:h,longEdge:'native'}));
    assert.equal(geometry.standardWidth,w);assert.equal(geometry.standardHeight,h);
    const packet={...mockFrame('s',1),width:w,height:h,pixelFormat:'rgba8',imageHandle:{kind:'rgba8',data:rgba,released:false,release(){throw new Error('Borrowed original');}}};
    const lease=await prepareWorkerFrame(packet,geometry),cloned=structuredClone(lease.frame,{transfer:lease.transfer});lease.markTransferred();
    assert.equal(lease.transfer[0].byteLength,0,'copy transferred');assert.deepEqual(rgba,source,'borrowed original untouched');
    const out=standardFrame(cloned,cache);assert.equal(out.width,w);assert.equal(out.height,h);
    assert.deepEqual(out.imageHandle.data,rgbaToGray(source,w,h).data);
  }
  assert.equal(log.canvases.length,2,'one input and one output canvas serve every size');
  // Landscape camera pixels rotated into portrait standard orientation.
  const w=1920,h=1080,rgba=rgbaPattern(w,h),expected=rgbaToGray(rgba,w,h).data,geometry=toFrameGeometry(createGeometry({width:w,height:h,rotation:90,longEdge:'native'}));
  const out=standardFrame(rawFrame(2,rgba,w,h,geometry,{rotation:90}),cache);assert.equal(out.width,h);assert.equal(out.height,w);
  for(const [x,y] of [[0,0],[1919,0],[0,1079],[1919,1079],[960,540],[17,903]])assert.equal(out.imageHandle.data[x*h+(h-1-y)],expected[y*w+x]);
}));

test('Worker runtime end to end: result for real frames, 1080p accepted, oversize reported, resources released on dispose',()=>withCanvas(async log=>{
  const messages=[],handle=createVisionWorkerRuntime(m=>messages.push(m));let id=0;const send=message=>handle({protocol:1,requestId:++id,generation:1,...message});
  const image=texture(),target=await compileGrayTarget(image,{targetId:'worker-frame'});
  await send({type:'init',options:{trackingMode:'absolute',backendPreference:'cpu'}});assert.equal(messages.at(-1).capability.fallbackReason,null);
  await send({type:'load-targets',targets:[target]});await send({type:'reset',sessionId:'s'});
  const rgba=new Uint8Array(image.width*image.height*4);for(let i=0;i<image.data.length;i++){rgba.fill(image.data[i],i*4,i*4+3);rgba[i*4+3]=255;}
  let result;
  for(let i=0;i<3;i++){await send({type:'frame',frame:rawFrame(i+1,rgba,image.width,image.height,handGeometry(image.width,image.height,IDENT))});result=messages.at(-1);assert.equal(result.type,'result');}
  assert.equal(result.result.state,'TRACKING');assert.equal(result.result.targetId,'worker-frame');assert.equal(result.timing.copiedBytes,null,'browser-internal copy total is unobservable, not a fabricated width*height');
  assert.equal(log.canvases.length,2);
  // Tracking pixels equal the no-canvas path for the same bytes.
  const direct=standardFrame(rawFrame(9,rgba,image.width,image.height,null),new FrameCache());assert.deepEqual([...direct.imageHandle.data],[...image.data]);
  const gray=new Uint8Array(1920*1080).map((_,i)=>(i*7+(i>>8))&255);
  await send({type:'frame',frame:rawFrame(4,gray,1920,1080,handGeometry(1920,1080,IDENT),{kind:'gray8'})});assert.equal(messages.at(-1).type,'result','1080p lands in the Worker');
  await send({type:'frame',frame:rawFrame(5,gray.subarray(0,4097),4097,1,null,{kind:'gray8'})});assert.equal(messages.at(-1).type,'error');assert.equal(messages.at(-1).code,'UNSUPPORTED');
  await send({type:'dispose'});assert.equal(messages.at(-1).type,'ack');assert.ok(log.canvases.every(c=>c.width===0&&c.height===0));
}));

test('optional preparation profiling separates canvas/gray stages with identical pixels and zero additional clock reads when off',()=>withCanvas(()=>{
  const frame=rawFrame(1,rgbaPattern(8,6),8,6,handGeometry(4,3,HALF)),desc=Object.getOwnPropertyDescriptor(globalThis,'performance');let ticks=0;
  Object.defineProperty(globalThis,'performance',{configurable:true,value:{now:()=>++ticks}});
  try{
    const off=standardFrame(frame,new FrameCache());assert.equal(ticks,0);
    const stages={inputPackingDurationUs:0,inputUploadDurationUs:0,standardDrawDurationUs:0,readbackDurationUs:0,grayscaleDurationUs:0},on=standardFrame(frame,new FrameCache(),rgbaToGray,stages);
    assert.deepEqual(on.imageHandle.data,off.imageHandle.data);assert.ok(ticks>0);for(const value of Object.values(stages))assert.ok(Number.isFinite(value)&&value>=0);
    assert.ok(stages.standardDrawDurationUs>0&&stages.readbackDurationUs>0&&stages.grayscaleDurationUs>0);
  }finally{Object.defineProperty(globalThis,'performance',desc);}
}));

test('observed and unobserved CPU Worker paths return identical measured/negative/recovery results; only observation includes preparation stages',()=>withCanvas(async()=>{
  const image=texture(),target=await compileGrayTarget(image,{targetId:'forest-03'}),rgba=new Uint8Array(image.width*image.height*4);
  for(let i=0;i<image.data.length;i++){rgba.fill(image.data[i],i*4,i*4+3);rgba[i*4+3]=255;}
  const results=[];
  for(const observeRecognition of [false,true]){
    const messages=[],handle=createVisionWorkerRuntime(m=>messages.push(m));let id=0;const send=async m=>{await handle({protocol:1,requestId:++id,generation:1,...m});return messages.at(-1);};
    await send({type:'init',options:{trackingMode:'absolute',backendPreference:'cpu',observeRecognition}});await send({type:'load-targets',targets:[target]});await send({type:'reset',sessionId:'s'});
    const route=[];
    for(let i=0;i<7;i++){
      const pixels=i===3?new Uint8Array(rgba.length).fill(20):rgba,m=await send({type:'frame',frame:rawFrame(i,pixels,image.width,image.height,handGeometry(image.width,image.height,IDENT))});
      assert.equal(m.type,'result');assert.equal('prepareStages' in m.timing,observeRecognition);assert.equal('trace' in m,observeRecognition);if(observeRecognition)for(const value of Object.values(m.timing.prepareStages))assert.ok(Number.isFinite(value)&&value>=0);route.push(m.result);
    }
    await send({type:'dispose'});results.push(route);
  }
  assert.deepEqual(results[0],results[1]);assert.ok(results[0].some(r=>r.state==='TRACKING'&&r.quality.measured));
}));
