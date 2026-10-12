/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError, type FramePacket, type TargetBundle, type VisionPipeline } from '@livemira/contracts';
import { CpuRecognizer, type ExactMatchingOperator, type RecognitionBatch } from '../../recognition/src/index.js';
import { createTrackingPipeline, createHybridTrackingPipeline, createSubpixelTrackingPipeline } from '../../tracking/src/index.js';
import { copyCanonicalFrame } from '../../compute/src/canonical-frame.js';

/** Recognizer image cap shared with the private Worker output: 4096 px per edge, 4,194,304 pixels. */
export const PREPARED_GRAY_MAX_EDGE = 4096;
export const PREPARED_GRAY_MAX_PIXELS = 4194304;

/** Strict gate for borrowing a pipeline-private gray8 image. Returns null when the shape needs the copying path. */
function borrowPreparedGray(frame: FramePacket, canonical: FramePacket, signal: AbortSignal): FramePacket | null {
  signal.throwIfAborted();
  if (canonical.imageHandle.released) throw new RangeError('Frame handle is released');
  if (!canonical.sessionId || canonical.sessionId !== frame.sessionId || !Number.isSafeInteger(canonical.frameId) || canonical.frameId < 0 || canonical.frameId !== frame.frameId) throw new RangeError('Invalid frame identity');
  if (canonical.rotation !== 0 || canonical.mirrored) throw new RangeError('Canonical orientation required');
  if (canonical.pixelFormat !== 'gray8' || canonical.imageHandle.kind !== 'gray8') return null;
  const data = canonical.imageHandle.data, { width, height } = canonical;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > PREPARED_GRAY_MAX_EDGE || height > PREPARED_GRAY_MAX_EDGE || width * height > PREPARED_GRAY_MAX_PIXELS) throw new EngineError('UNSUPPORTED', false, 'Prepared image exceeds recognizer limit');
  if (!(data instanceof Uint8Array) || (typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer) || data.length !== width * height) return null;
  return { ...frame, width, height, pixelFormat: 'gray8', rotation: 0, mirrored: false, imageHandle: { kind: 'gray8', data, released: false, release() {} } };
}

/**
 * CPU baseline pipeline (recognition and tracking). canonicalize returns borrowed CPU scratch, never a new owned native handle.
 * borrowPreparedGray is set only by the private Worker runtime, whose gray8 output is a fresh per-frame array it never
 * reuses; every other pipeline copies the canonical image regardless of what the frame claims about itself.
 */
export function createCpuPipeline(options: { canonicalize?: (frame: FramePacket, signal: AbortSignal) => Promise<FramePacket>; experimentalLocalTracking?: boolean; experimentalSubpixelTracking?: boolean; exactMatching?: ExactMatchingOperator; borrowPreparedGray?: boolean; /** Explicit recognition algorithm identity; targets compiled with another algorithm are rejected. Default: whatever the loaded targets declare. */ algorithmVersion?: string; /** Generic observer seam, default undefined = no work and no retention: called synchronously with each completed recognition batch and the frame identity it belongs to. */ onRecognition?: (batch: RecognitionBatch, frame: { sessionId: string; frameId: number }) => void; /** Default false: attach matchedPoints to measured TRACKING results. */ collectMatchedPoints?: boolean; /** Default true; must be a boolean when given. false disables the legacy half-octave scale retry (diagnostic comparison only). */ legacyScaleSearch?: boolean } = {}): VisionPipeline {
  const recognizer = new CpuRecognizer({exactMatching: options.exactMatching, algorithmVersion: options.algorithmVersion, legacyScaleSearch: options.legacyScaleSearch, capturePasses: options.onRecognition !== undefined});
  const makeTracker = options.experimentalSubpixelTracking ? createSubpixelTrackingPipeline : options.experimentalLocalTracking ? createHybridTrackingPipeline : createTrackingPipeline;
  const observe = options.onRecognition;
  const tracking = makeTracker(async (frame, _targets, signal) => { const batch = await recognizer.recognizeFrame(frame, { signal }); if (observe) observe(batch, { sessionId: frame.sessionId, frameId: frame.frameId }); return batch.observations; }, { collectMatchedPoints: options.collectMatchedPoints });
  const borrow = options.borrowPreparedGray === true;
  return {
    async loadTargets(targets: readonly TargetBundle[]) { await recognizer.loadTargets(targets); await tracking.loadTargets(targets); },
    reset: sessionId => tracking.reset(sessionId),
    async process(frame, signal) {
      if (borrow) signal.throwIfAborted();
      const canonical = options.canonicalize ? await options.canonicalize(frame, signal) : frame;
      let gray = borrow ? borrowPreparedGray(frame, canonical, signal) : null;
      if (!gray) {
        const { image } = copyCanonicalFrame(canonical, signal);
        gray = { ...frame, width: image.width, height: image.height, pixelFormat: 'gray8', rotation: 0, mirrored: false, imageHandle: { kind: 'gray8', data: image.data, released: false, release() {} } };
      }
      return tracking.process(gray, signal);
    },
    async dispose() { await tracking.dispose(); recognizer.dispose(); },
  };
}
