/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Main-thread side of the vision Worker: one Worker, one request at a time, a timeout per request, and a generation
// that makes every response of a terminated Worker irrelevant. Frame scheduling belongs to the engine; this client
// never queues frames.

import {
  EngineError,
  validateTargetBundle,
  type Frame,
  type TargetBundle,
  type TrackingResult,
} from '@livemira/contracts';
import { traceForFrame, type RecognitionTrace } from '@livemira/recognition';

import { prepareTransfer, type FrameLease } from './frame-transfer.ts';
import { sanitizeMatchedPoints } from './matched-points.ts';
import {
  DEFAULT_VISION_OPTIONS,
  safeWorkerReason,
  WORKER_PROTOCOL_VERSION,
  type VisionCapability,
  type VisionOptions,
  type VisionRequestBody,
  type VisionResponse,
  type WorkerTiming,
} from './protocol.ts';

/** The parts of a Worker the client uses; injectable for tests and for hosts that create Workers themselves. */
export interface WorkerEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: (event: MessageEvent) => void,
  ): void;
}

export interface VisionClientObservers {
  onCapability?(capability: VisionCapability): void;
  onTiming?(
    frame: { sessionId: string; frameId: number },
    generation: number,
    timing: WorkerTiming,
  ): void;
  /** The Worker failed or timed out and was terminated; a reset starts a new one. */
  onFailure?(error: EngineError): void;
  onResult?(result: TrackingResult): void;
  /** Only with `observeRecognition`: the validated trace of the frame whose result follows. */
  onRecognitionTrace?(trace: RecognitionTrace): void;
}

export interface VisionClientConfig extends VisionClientObservers {
  readonly workerFactory: () => WorkerEndpoint;
  readonly options?: Partial<VisionOptions>;
  /** 100..120000, default 30000. */
  readonly requestTimeoutMs?: number;
  /** Default prepareTransfer with the frame's own geometry. */
  readonly prepareFrame?: (frame: Frame, signal: AbortSignal) => Promise<FrameLease>;
}

interface PendingRequest {
  readonly id: number;
  readonly generation: number;
  readonly resolve: (value: VisionResponse) => void;
  readonly reject: (error: EngineError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function resolveOptions(options: Partial<VisionOptions> = {}): VisionOptions {
  const resolved = { ...DEFAULT_VISION_OPTIONS, ...options };
  for (const key of ['collectMatchedPoints', 'observeRecognition', 'scaleRetry'] as const) {
    if (typeof resolved[key] !== 'boolean') {
      throw new EngineError('INVALID_CONFIG', `${key} must be a boolean`, { isRecoverable: false });
    }
  }
  if (resolved.exactMatching !== 'wasm' && resolved.exactMatching !== 'js') {
    throw new EngineError('INVALID_CONFIG', "exactMatching must be 'wasm' or 'js'", {
      isRecoverable: false,
    });
  }
  return Object.freeze(resolved);
}

export class VisionClient {
  private worker: WorkerEndpoint | null = null;
  private generation = 0;
  private requestId = 0;
  private targets: readonly TargetBundle[] = [];
  private sessionId: string | null = null;
  private isDisposed = false;
  private lastCapability: string | null = null;
  private operation: Promise<unknown> | null = null;
  private pending: PendingRequest | null = null;
  private readonly options: VisionOptions;
  private readonly timeoutMs: number;
  private readonly config: VisionClientConfig;

  constructor(config: VisionClientConfig) {
    this.config = config;
    this.options = resolveOptions(config.options);
    this.timeoutMs = config.requestTimeoutMs ?? 30000;
    if (
      typeof config.workerFactory !== 'function' ||
      !Number.isFinite(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 120000
    ) {
      throw new EngineError('INVALID_CONFIG', 'Invalid worker configuration', {
        isRecoverable: false,
      });
    }
  }

  get visionOptions(): VisionOptions {
    return this.options;
  }

  private observe<T>(callback: ((value: T) => void) | undefined, value: T): void {
    try {
      callback?.(value);
    } catch {
      // Observers cannot own worker progress.
    }
  }

  private assertAlive(): void {
    if (this.isDisposed)
      throw new EngineError('DISPOSED', 'Worker pipeline disposed', { isRecoverable: false });
  }

  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    this.assertAlive();
    if (this.operation)
      throw new EngineError('RESOURCE_FAILED', 'Only one worker operation may be active', {
        isRecoverable: true,
      });
    const task = Promise.resolve().then(action);
    this.operation = task;
    try {
      return await task;
    } finally {
      if (this.operation === task) this.operation = null;
    }
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const value = event.data as VisionResponse;
    const pending = this.pending;
    if (
      !pending ||
      !value ||
      value.protocol !== WORKER_PROTOCOL_VERSION ||
      value.generation !== pending.generation ||
      value.requestId !== pending.id
    ) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (value.type === 'error') {
      pending.reject(
        new EngineError(value.code, safeWorkerReason(value.reason), { isRecoverable: true }),
      );
      return;
    }
    if (value.type === 'ready') {
      this.lastCapability = JSON.stringify(value.capability);
      this.observe(this.config.onCapability?.bind(this.config), value.capability);
    }
    pending.resolve(value);
  };

  private readonly onWorkerError = (): void => {
    const error = new EngineError('RESOURCE_FAILED', 'Worker failed; restart is required', {
      isRecoverable: true,
    });
    this.kill(error);
    this.observe(this.config.onFailure?.bind(this.config), error);
  };

  private kill(
    error = new EngineError('ABORTED', 'Worker operation cancelled', { isRecoverable: true }),
  ): void {
    const worker = this.worker;
    this.worker = null;
    this.sessionId = null;
    ++this.generation;
    if (worker) {
      worker.removeEventListener('message', this.onMessage);
      worker.removeEventListener('error', this.onWorkerError);
      worker.removeEventListener('messageerror', this.onWorkerError);
      worker.terminate();
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private request(body: VisionRequestBody, transfer: Transferable[] = []): Promise<VisionResponse> {
    this.assertAlive();
    if (!this.worker || this.pending) {
      return Promise.reject(
        new EngineError('RESOURCE_FAILED', 'Worker not ready or busy', { isRecoverable: true }),
      );
    }
    const id = ++this.requestId;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new EngineError(
          'RESOURCE_FAILED',
          'Worker request timed out; restart is required',
          { isRecoverable: true },
        );
        this.kill(error);
        this.observe(this.config.onFailure?.bind(this.config), error);
      }, this.timeoutMs);
      this.pending = { id, generation, resolve, reject, timer };
      try {
        this.worker!.postMessage(
          { ...body, protocol: WORKER_PROTOCOL_VERSION, requestId: id, generation },
          transfer,
        );
      } catch {
        this.kill(
          new EngineError('RESOURCE_FAILED', 'Worker transfer failed', { isRecoverable: true }),
        );
      }
    });
  }

  private async ensureWorker(): Promise<void> {
    this.assertAlive();
    if (this.worker) return;
    try {
      this.worker = this.config.workerFactory();
    } catch {
      throw new EngineError('UNSUPPORTED', 'Module Worker unavailable', { isRecoverable: true });
    }
    ++this.generation;
    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onWorkerError);
    this.worker.addEventListener('messageerror', this.onWorkerError);
    try {
      const ready = await this.request({ type: 'init', options: this.options });
      if (ready.type !== 'ready')
        throw new EngineError('START_FAILED', 'Invalid worker initialization response', {
          isRecoverable: true,
        });
      if (this.targets.length) await this.request({ type: 'load-targets', targets: this.targets });
    } catch (error) {
      this.kill();
      throw error;
    }
  }

  /** Validates and snapshots 1..10 targets with unique ids and sends them to the Worker (starting it if needed). */
  loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    return this.exclusive(async () => {
      if (
        !targets.length ||
        targets.length > 10 ||
        new Set(targets.map((t) => t.targetId)).size !== targets.length
      ) {
        throw new EngineError('INVALID_TARGET', 'Require 1..10 unique compatible targets', {
          isRecoverable: false,
        });
      }
      targets.forEach(validateTargetBundle);
      const snapshot = structuredClone(targets);
      await this.ensureWorker();
      await this.request({ type: 'load-targets', targets: snapshot });
      this.targets = snapshot;
      this.sessionId = null;
    });
  }

  /** Starts a session in the Worker (restarting a failed Worker with the loaded targets). */
  reset(sessionId: string): Promise<void> {
    return this.exclusive(async () => {
      if (!sessionId)
        throw new EngineError('INVALID_CONFIG', 'Session required', { isRecoverable: false });
      await this.ensureWorker();
      await this.request({ type: 'reset', sessionId });
      this.sessionId = sessionId;
    });
  }

  /** Decodes and compiles an encoded image in the Worker; aborting terminates the Worker. */
  compileEncodedImage(
    encodedImage: ArrayBuffer,
    targetId: string,
    maxEdgePx = 640,
    signal?: AbortSignal,
  ): Promise<TargetBundle> {
    return this.exclusive(async () => {
      if (signal?.aborted)
        throw new EngineError('ABORTED', 'Compilation cancelled', { isRecoverable: true });
      if (!encodedImage.byteLength || encodedImage.byteLength > 24_000_000) {
        throw new EngineError('INVALID_TARGET', 'Encoded target exceeds input limit', {
          isRecoverable: false,
        });
      }
      const abort = (): void => this.kill();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        await this.ensureWorker();
        if (signal?.aborted)
          throw new EngineError('ABORTED', 'Compilation cancelled', { isRecoverable: true });
        const response = await this.request(
          { type: 'compile', encodedImage, targetId, maxEdgePx },
          [encodedImage],
        );
        if (response.type !== 'compiled')
          throw new EngineError('INVALID_TARGET', 'Unexpected compile response', {
            isRecoverable: true,
          });
        return response.target;
      } finally {
        signal?.removeEventListener('abort', abort);
      }
    });
  }

  /** Tracks one frame in the Worker. Aborting terminates the Worker; a reset starts a new one. */
  process(frame: Frame, signal: AbortSignal): Promise<TrackingResult> {
    return this.exclusive(async () => {
      if (signal.aborted)
        throw new EngineError('ABORTED', 'Frame cancelled', { isRecoverable: true });
      if (!this.worker || this.sessionId !== frame.sessionId) {
        throw new EngineError('FRAME_FAILED', 'Worker session requires reset', {
          isRecoverable: true,
        });
      }
      let lease: FrameLease | undefined;
      const abort = (): void => this.kill();
      signal.addEventListener('abort', abort, { once: true });
      try {
        lease = await (this.config.prepareFrame ?? prepareTransfer)(frame, signal);
        if (signal.aborted || this.isDisposed)
          throw new EngineError('ABORTED', 'Frame preparation cancelled', { isRecoverable: true });
        const responsePromise = this.request({ type: 'frame', frame: lease.frame }, lease.transfer);
        if (this.worker && this.pending) lease.markTransferred();
        const response = await responsePromise;
        if (
          response.type !== 'result' ||
          response.result.sessionId !== frame.sessionId ||
          response.result.frameId !== frame.frameId
        ) {
          throw new EngineError('FRAME_FAILED', 'Worker result identity mismatch', {
            isRecoverable: true,
          });
        }
        return this.deliver(frame, response, lease);
      } finally {
        signal.removeEventListener('abort', abort);
        lease?.release();
      }
    });
  }

  /** Announces observations of one result in a fixed order: capability, timing, trace, result. */
  private deliver(
    frame: Frame,
    response: Extract<VisionResponse, { type: 'result' }>,
    lease: FrameLease,
  ): TrackingResult {
    // Matched points cross the Worker boundary only when requested and only if they describe exactly this result.
    sanitizeMatchedPoints(response.result, this.options.collectMatchedPoints);
    // A capability change found while processing (a WebAssembly failure) is announced once, before the result.
    if (response.capability) {
      const key = JSON.stringify(response.capability);
      if (key !== this.lastCapability) {
        this.lastCapability = key;
        this.observe(this.config.onCapability?.bind(this.config), response.capability);
      }
    }
    try {
      this.config.onTiming?.(frame, this.generation, {
        ...response.timing,
        inputPreparationDurationUs: lease.preparationDurationUs,
        inputCopiedBytes: lease.copiedBytes,
      });
    } catch {
      // Numeric observer only.
    }
    if (this.options.observeRecognition && response.trace !== undefined) {
      const trace = traceForFrame(response.trace, frame);
      if (trace) this.observe(this.config.onRecognitionTrace?.bind(this.config), trace);
    }
    this.observe(this.config.onResult?.bind(this.config), structuredClone(response.result));
    return response.result;
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.kill();
    await this.operation?.catch(() => {});
    this.targets = [];
  }
}
