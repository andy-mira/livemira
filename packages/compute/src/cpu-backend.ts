/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, type ComputeBackend, type PreparedFrame, type FramePacket, type ComputeResult, type Point2, type TargetBundle, type RecognitionObservation } from '@livemira/contracts';
import { copyCanonicalFrame } from './canonical-frame.ts';
import { buildPyramid, algorithmVersion as preprocessingId } from './reference.mjs';

type Gray = { data: Uint8Array; width: number; height: number; stride?: number };
type Flow = Awaited<ReturnType<ComputeBackend['trackPoints']>>['value'];
/** Module-local injection points: the operators own the algorithms; the backend owns bounded resource lifetime. */
export interface CpuOperators {
  algorithmVersion: string;
  detectFeatures?(image: Gray, signal?: AbortSignal): readonly Point2[] | Promise<readonly Point2[]>;
  describeAndMatch?(image: Gray, target: TargetBundle, identity: Pick<FramePacket, 'sessionId' | 'frameId'>, signal?: AbortSignal): RecognitionObservation | Promise<RecognitionObservation>;
  trackPoints?(previous: Gray, current: Gray, points: readonly Point2[], signal?: AbortSignal): Flow | Promise<Flow>;
}
export interface PreprocessingOperators {
  kind: 'cpu' | 'wasm';
  copyFrame: typeof copyCanonicalFrame;
  buildPyramid: typeof buildPyramid;
  dispose(): void;
}

export class CpuComputeBackend implements ComputeBackend {
  readonly kind: 'cpu' | 'wasm';
  #preprocessing?: PreprocessingOperators;
  readonly algorithmVersion: string;
  #operators: CpuOperators;
  #initialized = false;
  #disposed = false;
  #active: Promise<unknown> | null = null;
  #resources = new Map<PreparedFrame, Gray>();
  #bytes = 0;
  #generation = 1;
  #serial = 0;
  #session: string | null = null;
  constructor(operators: CpuOperators = { algorithmVersion: preprocessingId }, preprocessing?: PreprocessingOperators) {
    if (!operators.algorithmVersion) throw new RangeError('Algorithm ID required');
    this.#operators = { ...operators }; this.algorithmVersion = operators.algorithmVersion;
    this.#preprocessing = preprocessing; this.kind = preprocessing?.kind ?? 'cpu';
  }
  #check(signal?: AbortSignal) {
    if (this.#disposed) throw new EngineError('DISPOSED', false, 'CPU backend disposed');
    if (signal?.aborted) throw new EngineError('ABORTED', true, 'Compute cancelled');
  }
  async init(signal?: AbortSignal): Promise<void> { this.#check(signal); this.#initialized = true; }
  async #run<T>(signal: AbortSignal | undefined, body: () => T | Promise<T>): Promise<T> {
    this.#check(signal);
    if (!this.#initialized) throw new EngineError('START_FAILED', true, 'Initialize CPU backend first');
    if (this.#active) throw new EngineError('RESOURCE_FAILED', true, 'One compute operation at a time');
    const existing = new Set(this.#resources.keys());
    const job = Promise.resolve().then(() => { this.#check(signal); return body(); });
    this.#active = job;
    try { const value = await job; this.#check(signal); return value; }
    catch (error) { for (const handle of this.#resources.keys()) if (!existing.has(handle)) handle.release(); throw error; }
    finally { this.#active = null; }
  }
  #get(frame: PreparedFrame): Gray {
    const image = this.#resources.get(frame);
    if (!image || frame.sessionId !== this.#session || frame.generation !== this.#generation) throw new EngineError('RESOURCE_FAILED', false, 'Foreign, released or stale prepared frame');
    return image;
  }
  #stamp(frame: Pick<FramePacket, 'sessionId' | 'frameId'>) {
    return { sessionId: frame.sessionId, frameId: frame.frameId, backend: this.kind, algorithmVersion: this.algorithmVersion, precision: 'u8-exact' as const };
  }
  #lease(image: Gray, frame: Pick<FramePacket, 'sessionId' | 'frameId'>, level = 0): PreparedFrame {
    if (this.#resources.size >= 32 || this.#bytes + image.data.byteLength > 32 * 1024 * 1024) throw new EngineError('RESOURCE_FAILED', true, 'CPU lease budget exceeded');
    const handle: PreparedFrame = Object.freeze({ ...this.#stamp(frame), resourceId: `cpu-${this.#generation}-${++this.#serial}`,
      generation: this.#generation, width: image.width, height: image.height, level, scale: 2 ** level,
      storageFormat: 'gray8' as const, preprocessingId,
      release: () => { if (this.#resources.delete(handle)) this.#bytes -= image.data.byteLength; } });
    this.#resources.set(handle, image); this.#bytes += image.data.byteLength; return handle;
  }
  prepareFrame(frame: FramePacket, signal?: AbortSignal): Promise<PreparedFrame> {
    return this.#run(signal, () => {
      const copied = (this.#preprocessing?.copyFrame ?? copyCanonicalFrame)(frame, signal);
      if (this.#session !== frame.sessionId) { this.#resources.clear(); this.#bytes = 0; this.#generation++; this.#session = frame.sessionId; }
      return this.#lease(copied.image, frame);
    });
  }
  buildPyramid(frame: PreparedFrame, levels: number, signal?: AbortSignal): Promise<ComputeResult<readonly PreparedFrame[]>> {
    return this.#run(signal, () => {
      const images = (this.#preprocessing?.buildPyramid ?? buildPyramid)(this.#get(frame), levels), leases: PreparedFrame[] = [];
      try {
        for (let i = 0; i < images.length; i++) leases.push(this.#lease(images[i], frame, (frame.level ?? 0) + i));
        return { ...this.#stamp(frame), value: leases };
      } catch (error) { leases.forEach(l => l.release()); throw error; }
    });
  }
  /** Copies public CPU results; never exposes mutable internal storage. */
  readGray(frame: PreparedFrame): Gray { this.#check(); const image = this.#get(frame); return { ...image, data: image.data.slice() }; }
  detectFeatures(frame: PreparedFrame, signal?: AbortSignal): Promise<ComputeResult<readonly Point2[]>> {
    return this.#run(signal, async () => {
      if (frame.level !== 0) throw new EngineError('UNSUPPORTED', true, 'Detector requires original canonical level zero');
      const image = this.readGray(frame), op = this.#operators.detectFeatures;
      if (!op) throw new EngineError('UNSUPPORTED', true, 'C detector adapter is not configured');
      return { ...this.#stamp(frame), backend: 'cpu', precision: 'f64', value: await op(image, signal) };
    });
  }
  describeAndMatch(frame: PreparedFrame, target: TargetBundle, signal?: AbortSignal): Promise<ComputeResult<RecognitionObservation>> {
    return this.#run(signal, async () => {
      if (frame.level !== 0) throw new EngineError('UNSUPPORTED', true, 'Recognition requires original canonical level zero');
      const image = this.readGray(frame), op = this.#operators.describeAndMatch;
      if (target.algorithmVersion !== this.algorithmVersion) throw new EngineError('INVALID_TARGET', false, 'Descriptor algorithm mismatch');
      if (!op) throw new EngineError('UNSUPPORTED', true, 'C recognition adapter is not configured');
      const value = await op(image, target, frame, signal);
      if (value.sessionId !== frame.sessionId || value.frameId !== frame.frameId || value.targetId !== target.targetId) throw new EngineError('FRAME_FAILED', false, 'Recognition identity mismatch');
      return { ...this.#stamp(frame), backend: 'cpu', precision: 'f64', value };
    });
  }
  trackPoints(previous: PreparedFrame, current: PreparedFrame, points: readonly Point2[], signal?: AbortSignal): Promise<ComputeResult<Flow>> {
    return this.#run(signal, async () => {
      const a = this.readGray(previous), b = this.readGray(current), op = this.#operators.trackPoints;
      if (points.length > 4096 || points.some(p => p.length !== 2 || !p.every(Number.isFinite))) throw new EngineError('FRAME_FAILED', false, 'Invalid or oversized points');
      if (!op) throw new EngineError('UNSUPPORTED', true, 'D flow adapter is not configured');
      if (previous.level !== 0 || current.level !== 0) throw new EngineError('UNSUPPORTED', true, 'Point tracking requires original canonical level zero');
      if (previous.frameId >= current.frameId || a.width !== b.width || a.height !== b.height) throw new EngineError('FRAME_FAILED', true, 'Point tracking requires ordered equal-sized frames');
      const value = await op(a, b, points, signal);
      if (value.points.length !== points.length || value.valid.length !== points.length) throw new EngineError('FRAME_FAILED', false, 'Flow output length mismatch');
      return { ...this.#stamp(current), backend: 'cpu', precision: 'f64', value };
    });
  }
  async dispose(): Promise<void> {
    this.#disposed = true;
    try { await this.#active; } catch { /* The caller receives its operation failure. */ }
    this.#resources.clear(); this.#bytes = 0; this.#generation++;
    this.#preprocessing?.dispose();
  }
}
