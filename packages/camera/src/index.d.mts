/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import type { FramePacket, FrameGeometry, FrameSource, ImageHandle, PixelFormat, WorkerFrameLease } from '@livemira/contracts';

export type CameraEvent = { type: string; sessionId: string | null; [key: string]: unknown };
export interface CameraConfiguration { width?: number; height?: number; facingMode?: string; deviceId?: string; snapshotPreference?: 'auto' | 'cpu'; timestampPreference?: 'media' | 'callback' }
export interface GeometryOptions {
  rotation?: 0 | 90 | 180 | 270; mirrored?: boolean;
  crop?: { x: number; y: number; width: number; height: number };
  longEdge?: number | 'native'; cssWidth?: number; cssHeight?: number; dpr?: number;
  fit?: 'contain' | 'cover'; viewportMirrored?: boolean;
}
export interface CameraOptions {
  previewContainer?: HTMLElement | null;
  camera?: CameraConfiguration; env?: typeof globalThis; nowUs?: () => number;
  geometry?: GeometryOptions; onEvent?: (event: CameraEvent) => void;
  /** Default true in a browser: measures previewContainer CSS dimensions/DPR automatically. false retains manual geometry; object tunes fresh-frame settle rules. */
  viewportStabilization?: boolean | { stableFrames?: number; quietMs?: number; orientationIntrinsicWaitMs?: number };
  calibration?: (input: { settings: MediaTrackSettings; geometry: GeometryMapping; width: number; height: number }) => string | null;
}
export class CameraFrameSource implements FrameSource {
  constructor(options?: CameraOptions);
  readonly runtime: CameraRuntime | null;
  configureCamera(camera: CameraConfiguration): void;
  updateGeometry(geometry: GeometryOptions): void;
  getDiagnostics(): Record<string, unknown>;
  listCameras(): Promise<MediaDeviceInfo[]>;
  nowSessionUs(): number | null;
  onViewportTransition(listener: (event: { phase: 'begin' | 'end'; epoch: number; reason?: string | null }) => void): () => void;
  start(sessionId: string, onFrame: (frame: FramePacket) => void, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export interface ReplaySample {
  image: unknown; close?: () => void; sourceTimestampUs: number; width: number; height: number;
  pixelFormat?: PixelFormat; rotation?: 0 | 90 | 180 | 270; mirrored?: boolean;
  calibrationId?: string | null; imageIdentity?: string;
  geometry?: FrameGeometry;
}
export class ReplayFrameSource implements FrameSource {
  constructor(options?: { nowUs?: () => number });
  start(sessionId: string, onFrame: (frame: FramePacket) => void, signal: AbortSignal): Promise<void>;
  push(sessionId: string, sample: ReplaySample): boolean;
  nowSessionUs(): number | null;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}
export class ReplaySource {
  constructor(options: { consume: (frame: FramePacket) => void | Promise<void>; nowUs?: () => number; newSessionId?: () => string; onError?: (error: unknown) => void });
  start(sessionId?: string): string;
  push(sessionId: string, sample: ReplaySample): boolean;
  stop(): void;
  dispose(): Promise<void>;
}
export class CameraRuntime {
  constructor(options: CameraOptions & { consume: (frame: FramePacket) => void | Promise<void> });
  readonly sessionId: string | undefined;
  readonly state: string;
  readonly stats: { snapshots: number; bitmapCopies: number; snapshotFailures: number; duplicateCallbacks: number; busyDrops: number };
  start(config?: CameraConfiguration): Promise<void>;
  listCameras(): Promise<MediaDeviceInfo[]>;
  switchCamera(deviceId: string): Promise<void>;
  updateGeometry(options: GeometryOptions): void;
  getDiagnostics(): Record<string, unknown>;
  stop(): void;
  dispose(): Promise<void>;
}
export interface GeometryMapping {
  inputToCanonical: number[]; canonicalToViewport: number[];
  canonicalWidth: number; canonicalHeight: number;
  crop: { x: number; y: number; width: number; height: number };
  rotation: 0 | 90 | 180 | 270; mirrored: boolean; fit: 'contain' | 'cover';
  cssWidth: number; cssHeight: number; dpr: number; viewportMirrored: boolean;
}
export function createGeometry(options: GeometryOptions & { width: number; height: number }): GeometryMapping;
export function transformPoint(matrix: readonly number[], x: number, y: number): [number, number];
export function multiply3(a: readonly number[], b: readonly number[]): number[];
export function toFrameGeometry(geometry: GeometryMapping): FrameGeometry;
export function createFramePacket(sample: FramePacket): FramePacket;
export function getFrameGeometry(frame: FramePacket): FrameGeometry | null;
export function previewStyle(geometry: FrameGeometry, width: number, height: number): Record<string, string>;
export function mountCameraPreview(video: HTMLVideoElement, container: HTMLElement): { update(geometry: FrameGeometry, width: number, height: number): void; mask(on: boolean): void; remove(): void };
export function prepareWorkerFrame(frame: FramePacket, geometry?: FrameGeometry | null, signal?: AbortSignal): Promise<WorkerFrameLease>;
export function ownImage(value: unknown, close?: () => void, kind?: PixelFormat): ImageHandle & { readonly value: unknown };
export function probeCapabilities(env?: typeof globalThis): Promise<{
  secureContext: boolean; getUserMedia: boolean; requestVideoFrameCallback: boolean;
  videoFrame: boolean; imageBitmap: boolean; offscreenCanvas: boolean;
  webgpuPresent: boolean; webgpuAdapter: string; crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean; wasmSimd: boolean; wasmThreadsPrerequisites: boolean;
  capturePath: string; videoFrameConstruction: string; imageBitmapConstruction: string;
  videoFrameTransfer: string; imageBitmapTransfer: string; cpuBufferTransfer: string; canvasReadback: string; workerPresent: boolean;
}>;
export class LatestFrameQueue {
  constructor(consume: (frame: FramePacket) => void | Promise<void>, onError?: (error: unknown) => void);
  start(sessionId: string): void; offer(packet: FramePacket, imageHandle?: ImageHandle): boolean;
  stop(): void; drain(): Promise<void>;
}
export class MediaClock {
  constructor(nowUs?: () => number);
  arrival(): number;
  observe(sourceTimestampUs: number, arrivalTimeUs?: number): null | {
    sourceTimestampUs: number; arrivalTimeUs: number; captureTimeUs: null; captureTimeUncertaintyUs: null;
    mappedObservationTimeUs: number; clockMappingUncertaintyUs: null;
    clockMapping: { sourceToSessionOffsetUs: number; approximate: boolean; uncertaintyUs: null };
  };
}
