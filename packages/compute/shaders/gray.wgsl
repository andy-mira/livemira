// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
@group(0) @binding(0) var<storage, read> rgba: array<u32>;
@group(0) @binding(1) var<storage, read_write> gray: array<u32>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= arrayLength(&rgba)) { return; }
  let p = rgba[i];
  gray[i] = (77u * (p & 255u) + 150u * ((p >> 8u) & 255u) +
             29u * ((p >> 16u) & 255u) + 128u) >> 8u;
}
