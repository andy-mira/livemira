/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Worker side of the vision protocol. One request at a time; a request that arrives while another is in progress is
// refused (the engine never sends one). Errors leave the Worker only as a code and a safe, input-independent reason.

import {
  rgbaToGray,
  standardize,
  StandardImageWorkspace,
  type PrepareStages,
} from '@livemira/compute';
import { EngineError, type ErrorCode, type TargetBundle } from '@livemira/contracts';
import { traceOf, type RecognitionTrace } from '@livemira/recognition';
import { compileGrayTarget } from '@livemira/target-compiler';

import { MatchingSelection } from './matching-selection.ts';
import {
  safeWorkerReason,
  WORKER_PROTOCOL_VERSION,
  type VisionOptions,
  type VisionRequest,
  type VisionResponse,
  type WorkerFrame,
} from './protocol.ts';
import { VisionCore } from './vision-core.ts';

const MAX_ENCODED_TARGET_BYTES = 24_000_000;
const MAX_DECODED_TARGET_PIXELS = 33554432;

function closeFrame(frame: WorkerFrame): void {
  if (frame.image.kind === 'video-frame' || frame.image.kind === 'image-bitmap')
    frame.image.image.close();
}

function checkOptions(options: VisionOptions): void {
  const invalid =
    !options ||
    typeof options.collectMatchedPoints !== 'boolean' ||
    typeof options.observeRecognition !== 'boolean' ||
    typeof options.scaleRetry !== 'boolean' ||
    (options.exactMatching !== 'wasm' && options.exactMatching !== 'js');
  if (invalid)
    throw new EngineError('INVALID_CONFIG', 'Invalid worker options', { isRecoverable: false });
}

/** Decodes an encoded image, scales its long edge to at most `maxEdgePx` (never enlarging) and compiles it. */
async function compileEncoded(
  encodedImage: ArrayBuffer,
  targetId: string,
  maxEdgePx: number,
): Promise<TargetBundle> {
  if (
    !encodedImage.byteLength ||
    encodedImage.byteLength > MAX_ENCODED_TARGET_BYTES ||
    !Number.isInteger(maxEdgePx) ||
    maxEdgePx < 32 ||
    maxEdgePx > 1024 ||
    typeof OffscreenCanvas === 'undefined' ||
    typeof createImageBitmap === 'undefined'
  ) {
    throw new EngineError('UNSUPPORTED', 'Worker image compilation unavailable or over budget', {
      isRecoverable: true,
    });
  }
  const bitmap = await createImageBitmap(new Blob([encodedImage]));
  try {
    if (bitmap.width * bitmap.height > MAX_DECODED_TARGET_PIXELS) {
      throw new EngineError('INVALID_TARGET', 'Decoded target exceeds limit', {
        isRecoverable: false,
      });
    }
    const scale = Math.min(1, maxEdgePx / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new EngineError('UNSUPPORTED', 'No worker canvas', { isRecoverable: true });
    context.drawImage(bitmap, 0, 0, width, height);
    const gray = rgbaToGray(
      new Uint8Array(context.getImageData(0, 0, width, height).data),
      width,
      height,
    );
    return compileGrayTarget(gray, { targetId });
  } finally {
    bitmap.close();
  }
}

export type PostResponse = (message: VisionResponse) => void;

/** Creates the message handler of one vision Worker. */
export function createVisionRuntime(post: PostResponse): (message: VisionRequest) => Promise<void> {
  let isBusy = false;
  let generation = -1;
  let core: VisionCore | null = null;
  let options: VisionOptions | null = null;
  let matching: MatchingSelection | null = null;
  const workspace = new StandardImageWorkspace();
  // Only assigned when recognition is observed; otherwise no recognition result is inspected or kept.
  let trace: RecognitionTrace | null = null;

  const describe = () => matching!.describe('worker', generation);

  async function initialize(envelope: Envelope, requested: VisionOptions): Promise<void> {
    if (core)
      throw new EngineError('INVALID_CONFIG', 'Worker already initialized', {
        isRecoverable: false,
      });
    checkOptions(requested);
    generation = envelope.generation;
    options = requested;
    matching = new MatchingSelection(requested.exactMatching);
    await matching.initialize();
    const exactMatcher = matching.operator();
    core = new VisionCore({
      ...(exactMatcher ? { exactMatcher } : {}),
      collectMatchedPoints: requested.collectMatchedPoints,
      scaleRetry: requested.scaleRetry,
      ...(requested.observeRecognition
        ? {
            onRecognition: (batch, frame) => {
              trace = traceOf(batch, frame);
            },
          }
        : {}),
    });
    post({ ...envelope, type: 'ready', capability: describe() });
  }

  async function processFrame(envelope: Envelope, frame: WorkerFrame): Promise<void> {
    trace = null;
    const stages: PrepareStages | undefined = options!.observeRecognition
      ? {
          inputPackingDurationUs: 0,
          inputUploadDurationUs: 0,
          standardDrawDurationUs: 0,
          readbackDurationUs: 0,
          grayscaleDurationUs: 0,
        }
      : undefined;
    const started = performance.now();
    const image = standardize(
      { image: frame.image, geometry: frame.geometry },
      workspace,
      rgbaToGray,
      stages,
    );
    const prepared = performance.now();
    const result = await core!.process({ ...frame.metadata, image }, new AbortController().signal);
    const ended = performance.now();
    const attached = trace as RecognitionTrace | null;
    trace = null;
    post({
      ...envelope,
      type: 'result',
      result,
      timing: {
        ...(stages ? { prepareStages: stages } : {}),
        prepareDurationUs: (prepared - started) * 1000,
        computeDurationUs: (ended - prepared) * 1000,
        totalDurationUs: (ended - started) * 1000,
      },
      ...(matching!.hasChangedSinceAnnounced ? { capability: describe() } : {}),
      ...(attached && attached.sessionId === result.sessionId && attached.frameId === result.frameId
        ? { trace: attached }
        : {}),
    });
  }

  async function dispose(envelope: Envelope): Promise<void> {
    // Every owner is released even when an earlier disposer rejects; the first failure is then reported.
    let failure: unknown;
    for (const release of [() => core?.dispose(), () => matching?.dispose()]) {
      try {
        await release();
      } catch (cause) {
        failure ??= cause;
      }
    }
    workspace.dispose();
    core = null;
    matching = null;
    options = null;
    trace = null;
    if (failure !== undefined) {
      throw failure instanceof EngineError
        ? failure
        : new EngineError('RESOURCE_FAILED', 'Worker disposal failed', { isRecoverable: true });
    }
    post({ ...envelope, type: 'ack' });
  }

  async function dispatch(message: VisionRequest, envelope: Envelope): Promise<void> {
    if (message.type === 'init') return initialize(envelope, message.options);
    if (!core || generation !== message.generation) {
      throw new EngineError('FRAME_FAILED', 'Stale worker generation', { isRecoverable: true });
    }
    switch (message.type) {
      case 'load-targets':
        await core.loadTargets(message.targets);
        post({ ...envelope, type: 'ready', capability: describe() });
        return;
      case 'reset':
        await core.reset(message.sessionId);
        post({ ...envelope, type: 'ready', capability: describe() });
        return;
      case 'dispose':
        return dispose(envelope);
      case 'compile':
        post({
          ...envelope,
          type: 'compiled',
          target: await compileEncoded(message.encodedImage, message.targetId, message.maxEdgePx),
        });
        return;
      case 'frame':
        return processFrame(envelope, message.frame);
      default:
        throw new EngineError('FRAME_FAILED', 'Unknown worker request', { isRecoverable: true });
    }
  }

  return async function handle(message: VisionRequest): Promise<void> {
    const envelope: Envelope = {
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      generation: message.generation,
    };
    const refuse = (code: ErrorCode = 'RESOURCE_FAILED'): void =>
      post({
        ...envelope,
        type: 'error',
        code,
        isRecoverable: true,
        reason: safeWorkerReason(null),
      });
    if (
      isBusy ||
      message.protocol !== WORKER_PROTOCOL_VERSION ||
      !Number.isSafeInteger(message.requestId) ||
      !Number.isSafeInteger(message.generation)
    ) {
      if (message.type === 'frame') closeFrame(message.frame);
      refuse();
      return;
    }
    isBusy = true;
    try {
      await dispatch(message, envelope);
    } catch (cause) {
      post({
        ...envelope,
        type: 'error',
        code: cause instanceof EngineError ? cause.code : 'RESOURCE_FAILED',
        isRecoverable: true,
        reason: safeWorkerReason(cause instanceof EngineError ? cause.message : null),
      });
    } finally {
      try {
        if (message.type === 'frame') closeFrame(message.frame);
      } finally {
        isBusy = false;
      }
    }
  };
}

interface Envelope {
  readonly protocol: typeof WORKER_PROTOCOL_VERSION;
  readonly requestId: number;
  readonly generation: number;
}
