/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Local ExactMatching callback, with a bounded ten-target resident roster. */
export function createExactMatchingAdapter(matcher) {
  let roster=new Map();
  return async(targets,frameDescriptors,signal)=>{
    let changed=false,next=new Map(roster);
    for(const t of targets){if(next.get(t.targetId)!==t.descriptors){changed=true;next.set(t.targetId,t.descriptors);}}
    if(next.size>10){next=new Map(targets.map(t=>[t.targetId,t.descriptors]));changed=true;}
    if(changed){matcher.setTargets([...next].map(([id,descriptors])=>({id,descriptors})));roster=next;}
    return matcher.matchBatch(targets.map(t=>t.targetId),frameDescriptors,signal);
  };
}
/** Opt-in for the legacy BRIEF family: delegates only while the matcher holds a live WebGPU device. Otherwise it resolves null and the
 * recognizer keeps its own CPU matcher instead of the matcher's slower CPU fallback. A device lost during a batch still yields that batch's
 * exact CPU result, reported with backend 'cpu'. */
export function createGpuExactMatchingAdapter(matcher) {
  const exact=createExactMatchingAdapter(matcher);
  return async(targets,frameDescriptors,signal)=>matcher.diagnostics.backend==='webgpu'?exact(targets,frameDescriptors,signal):null;
}
