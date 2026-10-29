// SPDX-License-Identifier: Apache-2.0
// B2 feasibility probe page: WebGPU availability, adapter, features and limits; then a compute front end (two exact
// [1 3 3 1] pyramid levels and FAST-9 on three levels, corners compacted through an atomic list) checked bit-exactly
// against the CPU references, and timed per frame (upload → dispatch → readback), with GPU timestamps when offered.

import { fastScore } from '@livemira-next/features';
import { PyramidWorkspace } from '@livemira-next/imaging';

interface ProbeOut {
  available: boolean;
  adapter?: Record<string, unknown>;
  features?: string[];
  limits?: Record<string, number>;
  pipelineMs?: number;
  exact?: { pyramid: boolean; fast: boolean; corners: number[] };
  roundTripMs?: { p50: number; p95: number };
  gpuMs?: { p50: number; p95: number } | null;
  error?: string;
}

const out: ProbeOut = { available: false };
(globalThis as unknown as { __webgpu: ProbeOut | null }).__webgpu = null;

/** WebGPU flag values (the TypeScript DOM library declares the interfaces but not these globals). */
const BUFFER = {
  MAP_READ: 0x1,
  COPY_SRC: 0x4,
  COPY_DST: 0x8,
  UNIFORM: 0x40,
  STORAGE: 0x80,
  QUERY_RESOLVE: 0x200,
} as const;
const MAP_READ = 0x1;

const LEVELS = 3;
const THRESHOLD = 16;
const MAX_CORNERS = 65536;

const PYRAMID_WGSL = /* wgsl */ `
struct Level { sw: u32, sh: u32, sstride: u32, w: u32, h: u32, stride: u32 }
@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> L: Level;
fn at(x: u32, y: u32) -> u32 { let i = y * L.sstride + x; return (src[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu; }
// Each invocation writes one word: four horizontally adjacent output pixels.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let words = L.stride / 4u;
  if (id.x >= words * L.h) { return; }
  let y = id.x / words;
  let x0 = (id.x % words) * 4u;
  let wts = array<u32, 4>(1u, 3u, 3u, 1u);
  var rows = array<u32, 4>(u32(max(i32(2u * y) - 1, 0)), 2u * y, min(2u * y + 1u, L.sh - 1u), min(2u * y + 2u, L.sh - 1u));
  var word = 0u;
  for (var k = 0u; k < 4u; k++) {
    let x = x0 + k;
    if (x >= L.w) { break; }
    var cols = array<u32, 4>(u32(max(i32(2u * x) - 1, 0)), 2u * x, min(2u * x + 1u, L.sw - 1u), min(2u * x + 2u, L.sw - 1u));
    var sum = 0u;
    for (var i = 0u; i < 4u; i++) {
      for (var j = 0u; j < 4u; j++) { sum += wts[i] * wts[j] * at(cols[j], rows[i]); }
    }
    word |= ((sum + 32u) >> 6u) << (8u * k);
  }
  dst[id.x] = word;
}`;

const FAST_WGSL = /* wgsl */ `
struct Params { w: u32, h: u32, stride: u32, t: u32 }
@group(0) @binding(0) var<storage, read> img: array<u32>;
@group(0) @binding(1) var<uniform> P: Params;
@group(0) @binding(2) var<storage, read_write> count: atomic<u32>;
@group(0) @binding(3) var<storage, read_write> corners: array<vec2<u32>>;
var<private> CX: array<i32, 16> = array<i32, 16>(0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3, -3, -3, -2, -1);
var<private> CY: array<i32, 16> = array<i32, 16>(-3, -3, -2, -1, 0, 1, 2, 3, 3, 3, 2, 1, 0, -1, -2, -3);
fn px(x: i32, y: i32) -> i32 { let i = u32(y) * P.stride + u32(x); return i32((img[i >> 2u] >> ((i & 3u) * 8u)) & 0xffu); }
fn arc9(mask: u32) -> bool {
  if (mask == 0u) { return false; }
  let m = mask | (mask << 16u);
  var acc = m;
  for (var s = 1u; s < 9u; s++) { acc &= m >> s; }
  return acc != 0u;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = i32(id.x) + 3;
  let y = i32(id.y) + 3;
  if (x >= i32(P.w) - 3 || y >= i32(P.h) - 3) { return; }
  let c = px(x, y);
  let hi = c + i32(P.t);
  let lo = c - i32(P.t);
  var bright = 0u;
  var dark = 0u;
  var sb = 0;
  var sd = 0;
  for (var i = 0; i < 16; i++) {
    let p = px(x + CX[i], y + CY[i]);
    if (p > hi) { bright |= 1u << u32(i); sb += p - hi; } else if (p < lo) { dark |= 1u << u32(i); sd += lo - p; }
  }
  var score = 0;
  if (arc9(bright)) { score = sb + 1; } else if (arc9(dark)) { score = sd + 1; }
  if (score > 0) {
    let k = atomicAdd(&count, 1u);
    if (k < arrayLength(&corners)) { corners[k] = vec2<u32>(u32(y) * P.w + u32(x), u32(score)); }
  }
}`;

const quantiles = (v: number[]): { p50: number; p95: number } => {
  const s = [...v].sort((a, b) => a - b);
  return { p50: s[Math.floor(0.5 * (s.length - 1))]!, p95: s[Math.floor(0.95 * (s.length - 1))]! };
};

async function run(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const width = Number(params.get('w') ?? 640);
  const height = Number(params.get('h') ?? 360);
  const gray = new Uint8Array(await (await fetch('/frame.gray')).arrayBuffer());
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  if (!gpu) return;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return;
  out.available = true;
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  out.adapter = info
    ? {
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description,
        isFallbackAdapter: (info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter ?? null,
      }
    : {};
  out.features = [...adapter.features].sort();
  const L = adapter.limits;
  out.limits = {
    maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
    maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
    maxBufferSize: L.maxBufferSize,
  };
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });

  // Level geometry (strides padded to whole words) and CPU references.
  const dims: { w: number; h: number; stride: number }[] = [{ w: width, h: height, stride: Math.ceil(width / 4) * 4 }];
  for (let l = 1; l < LEVELS; l++) {
    const w = dims[l - 1]!.w >> 1;
    const h = dims[l - 1]!.h >> 1;
    dims.push({ w, h, stride: Math.ceil(w / 4) * 4 });
  }
  const reference = new PyramidWorkspace().build({ width, height, stride: width, data: gray }, LEVELS, 8).levels;
  const cpuCorners = reference.map((level) => {
    const offsets = Int32Array.from(
      [
        [0, -3],
        [1, -3],
        [2, -2],
        [3, -1],
        [3, 0],
        [3, 1],
        [2, 2],
        [1, 3],
        [0, 3],
        [-1, 3],
        [-2, 2],
        [-3, 1],
        [-3, 0],
        [-3, -1],
        [-2, -2],
        [-1, -3],
      ].map(([dx, dy]) => dy! * level.stride + dx!),
    );
    const list: [number, number][] = [];
    for (let y = 3; y < level.height - 3; y++)
      for (let x = 3; x < level.width - 3; x++) {
        const s = fastScore(level.data, y * level.stride + x, offsets, THRESHOLD);
        if (s) list.push([y * level.width + x, s]);
      }
    return list;
  });

  const started = performance.now();
  const [pyramidPipeline, fastPipeline] = await Promise.all([
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: PYRAMID_WGSL }), entryPoint: 'main' },
    }),
    device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: FAST_WGSL }), entryPoint: 'main' },
    }),
  ]);
  out.pipelineMs = performance.now() - started;

  const storage = BUFFER.STORAGE | BUFFER.COPY_SRC | BUFFER.COPY_DST;
  const levels = dims.map((d) => device.createBuffer({ size: d.stride * d.h, usage: storage }));
  const counts = dims.map(() => device.createBuffer({ size: 4, usage: storage }));
  const lists = dims.map(() => device.createBuffer({ size: 8 * MAX_CORNERS, usage: storage }));
  const uniform = (values: number[]): GPUBuffer => {
    const b = device.createBuffer({
      size: Math.ceil((4 * values.length) / 16) * 16,
      usage: BUFFER.UNIFORM | BUFFER.COPY_DST,
    });
    device.queue.writeBuffer(b, 0, Uint32Array.from(values));
    return b;
  };
  const pyramidGroups = dims.slice(1).map((d, i) =>
    device.createBindGroup({
      layout: pyramidPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: levels[i]! } },
        { binding: 1, resource: { buffer: levels[i + 1]! } },
        { binding: 2, resource: { buffer: uniform([dims[i]!.w, dims[i]!.h, dims[i]!.stride, d.w, d.h, d.stride]) } },
      ],
    }),
  );
  const fastGroups = dims.map((d, i) =>
    device.createBindGroup({
      layout: fastPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: levels[i]! } },
        { binding: 1, resource: { buffer: uniform([d.w, d.h, d.stride, THRESHOLD]) } },
        { binding: 2, resource: { buffer: counts[i]! } },
        { binding: 3, resource: { buffer: lists[i]! } },
      ],
    }),
  );
  const readCounts = device.createBuffer({ size: 4 * LEVELS, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
  const readLists = device.createBuffer({ size: 8 * MAX_CORNERS * LEVELS, usage: BUFFER.MAP_READ | BUFFER.COPY_DST });
  const readLevels = device.createBuffer({
    size: dims.reduce((s, d) => s + d.stride * d.h, 0),
    usage: BUFFER.MAP_READ | BUFFER.COPY_DST,
  });
  const querySet = timestamps ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
  const queryBuffer = timestamps
    ? device.createBuffer({ size: 16, usage: BUFFER.QUERY_RESOLVE | BUFFER.COPY_SRC })
    : null;
  const queryRead = timestamps ? device.createBuffer({ size: 16, usage: BUFFER.MAP_READ | BUFFER.COPY_DST }) : null;

  const padded = new Uint8Array(dims[0]!.stride * height);
  for (let y = 0; y < height; y++) padded.set(gray.subarray(y * width, (y + 1) * width), y * dims[0]!.stride);
  const zero = new Uint32Array(1);

  /** One frame: upload, two pyramid levels, FAST on three, compact readback; with `levelsToo` also the levels. */
  const frame = async (
    levelsToo: boolean,
  ): Promise<{ counts: Uint32Array; lists: Uint32Array; levels: Uint8Array | null; gpuNs: number | null }> => {
    device.queue.writeBuffer(levels[0]!, 0, padded);
    for (const c of counts) device.queue.writeBuffer(c, 0, zero);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass(
      querySet ? { timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {},
    );
    pass.setPipeline(pyramidPipeline);
    dims.slice(1).forEach((d, i) => {
      pass.setBindGroup(0, pyramidGroups[i]!);
      pass.dispatchWorkgroups(Math.ceil(((d.stride / 4) * d.h) / 64));
    });
    pass.setPipeline(fastPipeline);
    dims.forEach((d, i) => {
      pass.setBindGroup(0, fastGroups[i]!);
      pass.dispatchWorkgroups(Math.ceil((d.w - 6) / 16), Math.ceil((d.h - 6) / 16));
    });
    pass.end();
    dims.forEach((_, i) => {
      encoder.copyBufferToBuffer(counts[i]!, 0, readCounts, 4 * i, 4);
      encoder.copyBufferToBuffer(lists[i]!, 0, readLists, 8 * MAX_CORNERS * i, 8 * MAX_CORNERS);
    });
    if (levelsToo) {
      let o = 0;
      dims.forEach((d, i) => {
        encoder.copyBufferToBuffer(levels[i]!, 0, readLevels, o, d.stride * d.h);
        o += d.stride * d.h;
      });
    }
    if (querySet && queryBuffer && queryRead) {
      encoder.resolveQuerySet(querySet, 0, 2, queryBuffer, 0);
      encoder.copyBufferToBuffer(queryBuffer, 0, queryRead, 0, 16);
    }
    device.queue.submit([encoder.finish()]);
    await Promise.all([
      readCounts.mapAsync(MAP_READ),
      readLists.mapAsync(MAP_READ),
      ...(levelsToo ? [readLevels.mapAsync(MAP_READ)] : []),
      ...(queryRead ? [queryRead.mapAsync(MAP_READ)] : []),
    ]);
    const result = {
      counts: new Uint32Array(readCounts.getMappedRange().slice(0)),
      lists: new Uint32Array(readLists.getMappedRange().slice(0)),
      levels: levelsToo ? new Uint8Array(readLevels.getMappedRange().slice(0)) : null,
      gpuNs: null as number | null,
    };
    if (queryRead) {
      const t = new BigUint64Array(queryRead.getMappedRange().slice(0));
      result.gpuNs = Number(t[1]! - t[0]!);
      queryRead.unmap();
    }
    readCounts.unmap();
    readLists.unmap();
    if (levelsToo) readLevels.unmap();
    return result;
  };

  const first = await frame(true);
  let pyramidExact = true;
  let o = 0;
  dims.forEach((d, i) => {
    const ref = reference[i]!;
    for (let y = 0; y < d.h; y++)
      for (let x = 0; x < d.w; x++)
        if (first.levels![o + y * d.stride + x] !== ref.data[y * ref.stride + x]) pyramidExact = false;
    o += d.stride * d.h;
  });
  let fastExact = true;
  const corners: number[] = [];
  dims.forEach((_, i) => {
    const n = first.counts[i]!;
    corners.push(n);
    const got = Array.from(
      { length: Math.min(n, MAX_CORNERS) },
      (_, k) =>
        [first.lists[2 * (MAX_CORNERS * i + k)]!, first.lists[2 * (MAX_CORNERS * i + k) + 1]!] as [number, number],
    ).sort((a, b) => a[0] - b[0]);
    const want = cpuCorners[i]!;
    if (got.length !== want.length || got.some((g, k) => g[0] !== want[k]![0] || g[1] !== want[k]![1]))
      fastExact = false;
  });
  out.exact = { pyramid: pyramidExact, fast: fastExact, corners };
  const round: number[] = [];
  const gpu$: number[] = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    const r = await frame(false);
    round.push(performance.now() - t0);
    if (r.gpuNs !== null) gpu$.push(r.gpuNs / 1e6);
  }
  out.roundTripMs = quantiles(round.slice(10));
  out.gpuMs = gpu$.length ? quantiles(gpu$.slice(10)) : null;
}

run()
  .catch((e: unknown) => {
    out.error = String(e instanceof Error ? e.message : e);
  })
  .finally(() => {
    (globalThis as unknown as { __webgpu: ProbeOut }).__webgpu = out;
  });
