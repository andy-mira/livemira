/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
// Public browser entry. Deliberately explicit: no DiagnosticRecorder, mock, replay, phone-trial or benchmark code is reachable from here.
// The single-file build (scripts/release/build-engine-single.mjs) bundles this module with the vision Worker embedded as a Blob source.
export { createEngine, Engine } from './index.js';
export type { EngineConfig, EngineEvents, TargetBundle, MediaConfig } from './index.js';
export type { ViewportTransitionEvent, TrackingResult, TrackingMatchedPoints, WorkerPipelineOptions, RecognitionTrace, RecognitionTracePass, RecognitionTraceStageMs } from '@livemira/contracts';
export { EngineError } from '@livemira/contracts';
export type { CameraOptions, CameraConfiguration, GeometryOptions } from '../../camera/src/index.mjs';
export { CameraFrameSource } from '../../camera/src/sdk-source.mjs';
export { getFrameGeometry } from '../../camera/src/preview.mjs';
export { prepareWorkerFrame } from '../../camera/src/worker-transfer.mjs';
export { CssVideoRenderSink } from '../../renderer/src/index.js';
export { compileGrayTarget, parseTarget, serializeTarget, ALGORITHM_VERSION, ANMS_ALGORITHM_VERSION, ORIENTED_ALGORITHM_VERSION, SUPPORTED_ALGORITHM_VERSIONS } from '../../target-compiler/src/index.js';
// The WorkerVisionPipeline class is deliberately not a value export here: constructing it directly would bypass the embedded Worker factory that
// createWorkerPipeline supplies. Its type is exported for annotations; the historic ./worker module keeps the class.
export type { WorkerEndpoint, WorkerPipelineConfig, WorkerVisionPipeline } from './worker-pipeline.js';
import { createWorkerPipeline as createFileWorkerPipeline, type WorkerEndpoint, type WorkerPipelineConfig, type WorkerVisionPipeline } from './worker-pipeline.js';

// Defined by the single-file build only; undefined in the multi-file tree.
declare const __LM_WORKER_SOURCE__: string | undefined;
declare const __LM_BUILD__: { format: 'single'; variant: 'readable' | 'minified'; buildId: string; inputHash: string } | undefined;

/** `variant` tells which text of the single-file runtime this is ('readable' or 'minified'; the behavior is the same); null in the multi-file tree. */
export interface EngineBuildInfo { format: 'single' | 'multi-file'; variant: 'readable' | 'minified' | null; buildId: string | null; inputHash: string | null }
/** Which engine build this is, so test logs can prove what ran. */
export const engineBuildInfo: Readonly<EngineBuildInfo> = Object.freeze(
  typeof __LM_BUILD__ !== 'undefined' ? { format: 'single' as const, variant: __LM_BUILD__.variant, buildId: __LM_BUILD__.buildId, inputHash: __LM_BUILD__.inputHash }
    : { format: 'multi-file' as const, variant: null, buildId: null, inputHash: null });

export interface EmbeddedWorkerEnv {
  Worker: new (url: string, options?: { type?: 'module'; name?: string }) => WorkerEndpoint;
  Blob: new (parts: string[], options?: { type?: string }) => unknown;
  URL: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
}
/**
 * A WorkerEndpoint factory for a fully bundled module Worker source. The Blob URL lives exactly as long as its Worker: terminate() (or a failed
 * construction) revokes it. The page CSP must allow `worker-src blob:` and, for the WASM backend, `'wasm-unsafe-eval'`.
 */
export function createEmbeddedWorkerFactory(source: string, env: EmbeddedWorkerEnv = globalThis as unknown as EmbeddedWorkerEnv): () => WorkerEndpoint {
  if (typeof source !== 'string' || !source) throw new TypeError('Embedded worker source required');
  return () => {
    const url = env.URL.createObjectURL(new env.Blob([source], { type: 'text/javascript' }));
    let worker: WorkerEndpoint;
    try { worker = new env.Worker(url, { type: 'module', name: 'LiveMira vision' }); } catch (error) { env.URL.revokeObjectURL(url); throw error; }
    let revoked = false;
    return {
      postMessage: (message, transfer) => worker.postMessage(message, transfer),
      terminate() { try { worker.terminate(); } finally { if (!revoked) { revoked = true; env.URL.revokeObjectURL(url); } } },
      addEventListener: (type, listener) => worker.addEventListener(type, listener),
      removeEventListener: (type, listener) => worker.removeEventListener(type, listener),
    };
  };
}
/** Same behavior as the multi-file createWorkerPipeline; in the single-file build the Worker defaults to the embedded one (still off the UI thread). */
export function createWorkerPipeline(config: WorkerPipelineConfig): WorkerVisionPipeline {
  const embedded = typeof __LM_WORKER_SOURCE__ === 'string' ? __LM_WORKER_SOURCE__ : undefined;
  return createFileWorkerPipeline(config.workerFactory || !embedded ? config : { ...config, workerFactory: createEmbeddedWorkerFactory(embedded) });
}
