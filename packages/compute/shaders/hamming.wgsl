// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
struct Parameters { targets: u32, frames: u32, reserved0: u32, reserved1: u32 }
@group(0) @binding(0) var<storage, read> targets: array<u32>;
@group(0) @binding(1) var<storage, read> frames: array<u32>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4<u32>>;
@group(0) @binding(3) var<uniform> params: Parameters;
fn distance(t: u32, f: u32) -> u32 {
  var d = 0u;
  for (var w=0u; w<8u; w++) { d += countOneBits(targets[t*8u+w] ^ frames[f*8u+w]); }
  return d;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i < params.targets) {
    var best = 257u; var second = 257u; var index = 0xffffffffu;
    for (var f=0u; f<params.frames; f++) {
      let d = distance(i,f);
      if (d < best) { second=best; best=d; index=f; }
      else if (d < second) { second=d; }
    }
    results[i] = vec4<u32>(index,best,second,0u);
  } else if (i < params.targets + params.frames) {
    let f = i-params.targets;
    var best = 257u; var index = 0xffffffffu;
    for (var t=0u; t<params.targets; t++) {
      let d = distance(t,f);
      if (d < best) { best=d; index=t; }
      else if (d == best) { index=0xffffffffu; }
    }
    results[i] = vec4<u32>(index,best,0u,0u);
  }
}
