/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { IDENTITY_3, type FramePacket, type FrameSource, type ImageHandle, type RenderSink, type TrackingResult, type VisionPipeline } from '@livemira/contracts';
/** Explicit synthetic fixtures. Never select these as production fallbacks. */
export function mockFrame(sessionId: string, frameId: number, onRelease = () => {}): FramePacket {
  let released = false;
  const imageHandle: ImageHandle = { kind: 'gray8', data: new Uint8Array(16), get released() { return released; }, release() { if (released) throw new Error('Double release'); released = true; onRelease(); } };
  return { sessionId, frameId, sourceTimestampUs: frameId*33333, timestampSource: 'replay', captureTimeUs: null, captureTimeUncertaintyUs: null, arrivalTimeUs: performance.now()*1000, width: 4, height: 4, pixelFormat: 'gray8', rotation: 0, mirrored: false, calibrationId: null, imageHandle };
}
export function mockObservation(frame: FramePacket, targetId = 'synthetic-target'): TrackingResult {
  return { sessionId: frame.sessionId, frameId: frame.frameId, observationTimeUs: frame.arrivalTimeUs, targetId, state: 'TRACKING', H_imageFromTarget: IDENTITY_3, cornersPx: [[0,0],[3,0],[3,3],[0,3]], T_cameraFromTarget: null, poseMetricValid: false, quality: { inlierCount: 4, inlierRatio: 1, reprojectionErrorPx: 0, spatialCoverage: 1, degenerate: false, measured: true }, predictionAgeUs: 0, reason: 'synthetic-fixture' };
}
export class MockSource implements FrameSource {
  sessionId = ''; callback: ((frame: FramePacket) => void) | null = null;
  async start(session: string, callback: (frame: FramePacket) => void) { this.sessionId = session; this.callback = callback; }
  push(frame: FramePacket) { if (this.callback) this.callback(frame); else frame.imageHandle.release(); }
  async stop() { this.callback = null; }
  async dispose() { await this.stop(); }
}
export class MockPipeline implements VisionPipeline { async loadTargets() {} async reset() {} async process(frame: FramePacket) { return mockObservation(frame); } async dispose() {} }
export class MockRenderer implements RenderSink { visible = false; updates: TrackingResult[] = []; async start() {} async update(result: TrackingResult) { this.visible = true; this.updates.push(result); } hide() { this.visible = false; } setTargetMedia() {} async stop() { this.hide(); } async dispose() { this.hide(); } }
