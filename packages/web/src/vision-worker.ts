// SPDX-License-Identifier: Apache-2.0
// The vision Worker: frames arrive as a transferred processor stream (Chromium), a transferred track (WebKit), single
// VideoFrames or gray pixels from the main thread; the newest frame is processed whenever the Worker is free
// (latest wins), by the dual-loop pipeline of the engine profile: detector slow loop, ESM (or KLT + ESM) fast loop,
// Kalman filter. `startVisionWorker` installs it on a Worker scope (the engine's single Worker file picks a role
// first).

import type { FrameHandle, PoseEstimate, TargetImage, TargetInfo } from '@livemira-next/contracts';
import { OrbDetector } from '@livemira-next/features';
import { KalmanPoseFilter, OneEuroPoseFilter } from '@livemira-next/filters';
import { DualLoopPipeline, TemplateTracker } from '@livemira-next/tracking';

import { DIAGNOSTICS } from './diagnostics.ts';
import { detectRotation, lumaFromVideoFrame, type LumaPath, type RotationReport } from './luma.ts';
import { frameOrientation, orientationName, UPRIGHT, type Orientation } from './orientation.ts';
import {
  DEFAULT_PIPELINE,
  type DisplayPose,
  type FromWorker,
  type PipelineConfig,
  type RelocalizerRequest,
  type RelocalizerResponse,
  type ToWorker,
  type WorkerTarget,
} from './protocol.ts';

export interface VisionScope {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}

declare const MediaStreamTrackProcessor:
  | (new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> })
  | undefined;

let scope = globalThis as unknown as VisionScope;
let pipeline: DualLoopPipeline | null = null;
/** Relocalisation requests are numbered; answers to requests from before the last resize are dropped. */
let nextRequestId = 0;
let epochStartId = 0;
let session = 0;
let width = 640;
let height = 360;
const frameWidth = (): number => width;
const frameHeight = (): number => height;
let returnFrames = false;
/** Device-kit builds: attach a frame strip and a trace to every result (init `probe`). */
let probe = false;
let sequence = 0;
let busy = false;
let stopped = false;
/** Newest frame waiting while the pipeline is busy (frames from the main thread). */
let waiting: { frame: VideoFrame | null; gray: ArrayBuffer | null; captureUs: number } | null = null;

function post(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

function velocities(p: PoseEstimate, predict: ((t: number) => readonly PoseEstimate[]) | undefined): number[] {
  const ahead = predict?.(p.timeUs + 10_000).find((q) => q.targetId === p.targetId);
  if (!ahead) return new Array(8).fill(0);
  const v: number[] = [];
  for (let c = 0; c < 4; c++) for (let k = 0; k < 2; k++) v.push((ahead.corners[c]![k]! - p.corners[c]![k]!) / 0.01);
  return v;
}

/** The camera targets as the host gave them, kept for rebuilding the pipeline. */
let sources: { targets: readonly WorkerTarget[]; assets: readonly ArrayBuffer[] | null } | null = null;
/** Modules of the running pipeline (a reconfiguration changes them; a target change keeps them). */
let config: PipelineConfig = DEFAULT_PIPELINE;
let relocalizerPort: MessagePort | null = null;

/** Builds a vision pipeline of `config` and loads the targets into it. */
async function assemble(
  config: PipelineConfig,
): Promise<{ pipeline: DualLoopPipeline; matcher: string; infos: TargetInfo[] }> {
  const detector = new OrbDetector(
    config.wasm ? {} : { allowWasm: false, orb: { wasm: false }, compile: { orb: { wasm: false } } },
  );
  const port = relocalizerPort;
  const created = new DualLoopPipeline(
    {
      id: 'vision',
      detector,
      tracker: new TemplateTracker({
        mode: config.tracker,
        ...(config.esmIterations ? { esm: { iterations: config.esmIterations } } : {}),
      }),
      filter: (targets) => (config.filter === 'E1' ? new OneEuroPoseFilter(targets) : new KalmanPoseFilter(targets)),
      // Concurrent relocalisation: the frame's pixels go to the second Worker, the answer comes back later.
      ...(port
        ? {
            relocalizer: ({ frame, roi, tracked }) => {
              if (frame.image.kind !== 'cpu-gray') return;
              const gray = frame.image.image.data.slice().buffer;
              const request: RelocalizerRequest = {
                type: 'relocalize',
                id: nextRequestId++,
                gray,
                width: frame.image.image.width,
                height: frame.image.image.height,
                frameId: frame.frameId,
                captureUs: frame.time.captureUs,
                roi,
                tracked,
              };
              port.postMessage(request, [gray]);
            },
          }
        : {}),
    },
    { relocalizeEvery: config.relocalizeEvery, asyncRelocalization: !!port },
  );
  let infos: TargetInfo[];
  if (sources?.assets?.length) {
    const report = await created.loadEncoded(sources.assets.map((a) => new Uint8Array(a)));
    infos = report.targets.map((t) => t.info!);
  } else {
    const targets: TargetImage[] = (sources?.targets ?? []).map((t) => ({
      info: t.info,
      image: { width: t.info.width, height: t.info.height, stride: t.info.width, data: new Uint8Array(t.gray) },
    }));
    await created.load(targets);
    infos = targets.map((t) => t.info);
  }
  created.reset(`web-${++session}`);
  return { pipeline: created, matcher: detector.backend, infos };
}

/**
 * Shown orientation of the camera frames: from the frame's metadata, else detected every `REDETECT` frames. When
 * detection cannot decide and the raw planes are turned against the shown picture (landscape planes, portrait view),
 * a back camera held upright is assumed: a quarter turn clockwise (iOS).
 */
let orientation: Orientation = UPRIGHT;
let orientationKind = 'assumed';
/** Last detection: format, raw size and scores per reference. */
let orientationDetail = '';
let detectedAt = -Infinity;
/** Device-kit builds: the first detection's full report (with thumbnails), sent once with a result. */
let pendingDiagnostics: RotationReport | null = null;
let diagnosticsSent = false;
const REDETECT = 30;

async function orient(frame: VideoFrame): Promise<Orientation> {
  const meta = frameOrientation(frame);
  if (meta) {
    orientationKind = 'metadata';
    return (orientation = meta);
  }
  if (sequence - detectedAt >= REDETECT) {
    detectedAt = sequence;
    let report: RotationReport | null = null;
    try {
      report = await detectRotation(frame, width, height, DIAGNOSTICS && !diagnosticsSent);
    } catch (e) {
      orientationKind = 'error';
      orientationDetail = String(e instanceof Error ? e.message : e).slice(0, 120);
    }
    if (report) {
      if (DIAGNOSTICS && !diagnosticsSent) pendingDiagnostics = report;
      const scores = JSON.stringify(report.scores);
      if (report.orientation) {
        orientation = report.orientation;
        orientationKind = `detected[${report.reference}]`;
      } else {
        const turned = report.raw[0] > report.raw[1] !== width > height;
        orientation = turned ? { rotation: 90, flip: false } : UPRIGHT;
        orientationKind = turned ? 'fallback' : 'assumed';
      }
      orientationDetail = `${report.format} ${report.raw.join('x')} ${scores}`;
    }
  }
  return orientation;
}

async function process(frame: VideoFrame | null, grayBuffer: ArrayBuffer | null, captureUs: number): Promise<void> {
  if (!pipeline) {
    frame?.close();
    return;
  }
  // The size this frame is processed at, fixed for the frame (a resize may arrive during the awaits below).
  const width = frameWidth();
  const height = frameHeight();
  const started = performance.now();
  let path: LumaPath | 'gray' = 'gray';
  let pixels: Uint8Array;
  if (frame) {
    const luma = await lumaFromVideoFrame(frame, width, height, undefined, await orient(frame));
    pixels = luma.image.data;
    path = luma.path;
  } else pixels = new Uint8Array(grayBuffer!);
  const lumaDone = performance.now();
  const handle: FrameHandle = {
    sessionId: 'web',
    frameId: sequence,
    time: { captureUs, receiveUs: started * 1000, source: frame ? 'videoframe-timestamp' : 'callback' },
    image: { kind: 'cpu-gray', image: { width, height, stride: width, data: pixels } },
  };
  const output = await pipeline.process(handle);
  const done = performance.now();
  const poses: DisplayPose[] = output.display.map((p) => ({
    targetId: p.targetId,
    corners: p.corners,
    velocity: velocities(p, output.predict),
    timeUs: p.timeUs,
  }));
  let strip: Uint8Array | undefined;
  if (DIAGNOSTICS && probe) {
    strip = new Uint8Array(128 * 8);
    for (let y = 0; y < 8; y++)
      strip.set(pixels.subarray((height - 8 + y) * width, (height - 8 + y) * width + 128), 128 * y);
  }
  const arrival = frame && Math.abs(started * 1000 - captureUs) < 5e6 ? started * 1000 - captureUs : null;
  const message: FromWorker = {
    type: 'result',
    sequence: sequence++,
    captureUs,
    state: output.state,
    size: [width, height],
    poses,
    stats: {
      lumaUs: (lumaDone - started) * 1000,
      processUs: (done - lumaDone) * 1000,
      arrivalUs: arrival,
      lumaPath: path,
      orientation: frame ? `${orientationName(orientation)}/${orientationKind}` : 'gray',
      ...(frame && orientationDetail ? { orientationDetail } : {}),
    },
    ...(DIAGNOSTICS && pendingDiagnostics && !diagnosticsSent ? { diagnostics: pendingDiagnostics } : {}),
    ...(returnFrames && frame ? { frame } : {}),
    ...(DIAGNOSTICS && strip ? { strip } : {}),
    ...(DIAGNOSTICS && probe
      ? {
          trace: {
            measured: output.poses.map((p) => ({ targetId: p.targetId, origin: p.origin, ...p.quality })),
            timings: output.timings,
          },
        }
      : {}),
  };
  if (DIAGNOSTICS && pendingDiagnostics) {
    diagnosticsSent = true;
    pendingDiagnostics = null;
  }
  const transfer: Transferable[] = [];
  if (returnFrames && frame) transfer.push(frame);
  post(message, transfer);
  if (!returnFrames) frame?.close();
}

let lastCaptureUs = -Infinity;

/**
 * The frame's capture time, µs. Some sources stamp every frame 0 (WebKit's canvas capture): when the stamps do not
 * advance, the Worker's clock stands in, so motion prediction and loss timing still see time pass.
 */
function captureTime(frame: VideoFrame): number {
  const stamped = frame.timestamp;
  const t = Number.isFinite(stamped) && stamped > lastCaptureUs ? stamped : performance.now() * 1000;
  lastCaptureUs = t;
  return t;
}

/** Pulls frames from a stream: one in flight, and whatever queued meanwhile is replaced by the newest. */
async function pump(readable: ReadableStream<VideoFrame>): Promise<void> {
  const reader = readable.getReader();
  let pending: VideoFrame | null = null;
  let reading = false;
  const readNext = async (): Promise<void> => {
    reading = true;
    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      pending?.close();
      pending = value;
      if (!busy) void drain();
    }
    reading = false;
  };
  const drain = async (): Promise<void> => {
    busy = true;
    while (pending && !stopped) {
      const frame = pending;
      pending = null;
      try {
        await process(frame, null, captureTime(frame));
      } catch (error) {
        post({ type: 'error', message: String(error) });
      }
    }
    busy = false;
  };
  if (!reading) await readNext();
}

async function drainWaiting(): Promise<void> {
  busy = true;
  while (waiting && !stopped) {
    const w = waiting;
    waiting = null;
    try {
      await process(w.frame, w.gray, w.captureUs);
    } catch (error) {
      w.frame?.close();
      post({ type: 'error', message: String(error) });
    }
  }
  busy = false;
}

/** Installs the vision Worker's message handling on `target` (a Worker's global scope). */
export function startVisionWorker(target: VisionScope = globalThis as unknown as VisionScope): void {
  scope = target;
  scope.addEventListener('message', onMessage);
}

function onMessage(event: MessageEvent<ToWorker>): void {
  const message = event.data;
  switch (message.type) {
    case 'init': {
      void (async () => {
        width = message.width;
        height = message.height;
        returnFrames = message.returnFrames;
        probe = DIAGNOSTICS && message.probe;
        relocalizerPort = message.relocalizer ?? null;
        // Answers go to whichever pipeline runs now (a reconfiguration replaces it).
        relocalizerPort?.addEventListener('message', (event: MessageEvent<RelocalizerResponse>) => {
          if (event.data.id >= epochStartId) pipeline?.deliverRelocalization(event.data.detected, event.data.tracked);
        });
        relocalizerPort?.start();
        sources = { targets: message.targets, assets: message.assets ?? null };
        const started = performance.now();
        config = { ...DEFAULT_PIPELINE, ...message.pipeline };
        const built = await assemble(config);
        pipeline = built.pipeline;
        post({ type: 'ready', matcher: built.matcher, compileMs: performance.now() - started, targets: built.infos });
      })().catch((error) => post({ type: 'error', message: String(error) }));
      return;
    }
    case 'reconfigure': {
      // A lighter pipeline (Hawk → Swift): built and loaded beside the running one, then swapped in; tracking restarts.
      void (async () => {
        config = { ...DEFAULT_PIPELINE, ...message.pipeline };
        const built = await assemble(config);
        epochStartId = nextRequestId;
        pipeline?.dispose();
        pipeline = built.pipeline;
      })().catch((error) => post({ type: 'error', message: `reconfigure: ${String(error)}` }));
      return;
    }
    case 'targets': {
      // New targets: a pipeline with the same modules is built and loaded beside the running one, then swapped in.
      sources = { targets: [], assets: message.assets };
      void (async () => {
        const built = await assemble(config);
        epochStartId = nextRequestId;
        pipeline?.dispose();
        pipeline = built.pipeline;
        post({ type: 'targets', targets: built.infos });
      })().catch((error) => post({ type: 'error', message: `targets: ${String(error)}` }));
      return;
    }
    case 'stream':
      void pump(message.readable);
      return;
    case 'track': {
      if (typeof MediaStreamTrackProcessor !== 'function') {
        post({ type: 'error', message: 'MediaStreamTrackProcessor unavailable in Worker' });
        return;
      }
      void pump(new MediaStreamTrackProcessor({ track: message.track, maxBufferSize: 1 }).readable);
      return;
    }
    case 'frame':
    case 'gray': {
      waiting?.frame?.close();
      waiting =
        message.type === 'frame'
          ? { frame: message.frame, gray: null, captureUs: message.captureUs }
          : { frame: null, gray: message.gray, captureUs: message.captureUs };
      if (!busy) void drainWaiting();
      return;
    }
    case 'resize': {
      // The device turned: the standard image changes shape, so poses, the previous frame and the camera orientation
      // all start over (the loaded targets stay).
      width = message.width;
      height = message.height;
      epochStartId = nextRequestId;
      pipeline?.reset(`web-${++session}`);
      detectedAt = -Infinity;
      orientation = UPRIGHT;
      orientationKind = 'assumed';
      break;
    }
    case 'stop':
      stopped = true;
      waiting?.frame?.close();
      waiting = null;
      return;
  }
}
