/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Capability evidence only: SIMD validates actual bytecode; threads are not enabled.
export function probeWasm(scope = globalThis) {
  const wasm = scope.WebAssembly;
  const simd = Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,22,1,20,0,253,12,...new Array(16).fill(0),11);
  return {
    wasm: typeof wasm?.validate === 'function',
    simd: typeof wasm?.validate === 'function' && wasm.validate(simd),
    threadPrerequisites: scope.crossOriginIsolated === true && typeof scope.SharedArrayBuffer === 'function',
    threadsEnabled: false,
  };
}

// Disposable capability probe, not a shared production device service.
export async function runGrayProbe(gpu, shaderCode, rgba, { warmup = 0, samples = 1 } = {}) {
  if (!gpu) return { status: 'unsupported', reason: 'WebGPU API absent' };
  if (!(rgba instanceof Uint8Array) || rgba.length < 4 || rgba.length % 4 || rgba.length > 4 * 640 * 640) throw new RangeError('Probe expects bounded packed RGBA');
  if (!Number.isInteger(warmup) || warmup < 0 || warmup > 20 || !Number.isInteger(samples) || samples < 1 || samples > 100) throw new RangeError('Invalid probe iterations');
  const deviceStart = performance.now();
  const adapter = await gpu.requestAdapter();
  if (!adapter) return { status: 'unsupported', reason: 'No adapter' };
  const device = await adapter.requestDevice();
  const deviceCreationMs = performance.now() - deviceStart;
  const buffers = [];
  let lost = null;
  device.lost.then(info => { lost = info.message || info.reason; });
  const started = performance.now();
  try {
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ code: shaderCode });
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const compilationMs = performance.now() - started;
    // Numeric flags avoid requiring ambient WebGPU TypeScript types.
    const allocate = usage => {
      const b = device.createBuffer({ size: rgba.length, usage }); buffers.push(b); return b;
    };
    const input = allocate(128 | 8), output = allocate(128 | 4), readback = allocate(1 | 8);
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}] });
    const samplesMs = []; let values;
    for (let iteration = 0; iteration < warmup + samples; iteration++) {
      const start = performance.now(), packed = new Uint32Array(rgba.length / 4);
      for (let i = 0; i < packed.length; i++) packed[i] = (rgba[i*4] | rgba[i*4+1]<<8 | rgba[i*4+2]<<16 | rgba[i*4+3]<<24) >>> 0;
      device.queue.writeBuffer(input, 0, packed);
      const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(packed.length/64)); pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,rgba.length);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1);
      values = Uint8Array.from(new Uint32Array(readback.getMappedRange()));
      readback.unmap();
      if (lost) throw new Error(lost);
      if (iteration >= warmup) samplesMs.push(performance.now() - start);
    }
    const error = await device.popErrorScope();
    if (error || lost) throw new Error(error?.message ?? lost);
    device.destroy();
    const destroyed = await device.lost;
    return { status:'ok', values, deviceCreationMs, compilationMs, warmup, samplesMs,
      adapter: { vendor: adapter.info?.vendor, architecture: adapter.info?.architecture, description: adapter.info?.description },
      destroyLossReason: destroyed.reason,
      timingScope:'per sample packing/allocation + upload + compute + readback + gray8 copy; reused pipeline/buffers; separate device/compile timing; no video or camera',
      maxStorageBufferBindingSize:device.limits.maxStorageBufferBindingSize };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    device.destroy();
  }
}
