// SPDX-License-Identifier: Apache-2.0
// The prototype engine's assembly in the browser: camera, capture path (A1 worker stream → transferred track → per-frame VideoFrame →
// canvas readback, the first that the platform supports), the vision Worker and a compositor (F1 frame-locked WebGL2,
// or F4 CSS over the native video). Records per-frame timings for diagnostics.

import type { Capability, TargetInfo } from '@livemira-next/contracts';

import {
  HAWK_BUDGET,
  probeMainThread,
  probeWorkerTrackProcessor,
  PROFILES,
  resolveProfile,
  type CapturePath,
  type FromWorker,
  type PipelineConfig,
  type ProfileId,
  type ToWorker,
} from '@livemira-next/web';

import { CssCompositor } from './compositor-css.ts';
import { FrameLockedCompositor, type PresentedFrame } from './compositor-webgl.ts';

export type CompositorKind = 'frame-locked' | 'css';

/** Thrown by `startEngine` on a device that no profile can run; `missing` lists what it lacks. */
export class UnsupportedDeviceError extends Error {
  readonly code = 'UNSUPPORTED_DEVICE';
  readonly missing: readonly Capability[];

  constructor(missing: readonly Capability[]) {
    super(`This device cannot run the engine: missing ${missing.join(', ')} (WebGL2 and VideoFrame are required)`);
    this.name = 'UnsupportedDeviceError';
    this.missing = missing;
  }
}

export interface EngineOptions {
  readonly container: HTMLElement;
  /** Target pictures, compiled at start-up; ignored when `assets` are given. */
  readonly targets?: readonly { readonly info: TargetInfo; readonly gray: Uint8Array }[];
  /** Precompiled G2 target assets (preferred). */
  readonly assets?: readonly Uint8Array[];
  readonly workerUrl: string | URL;
  /** Relocalisation Worker entry: when given, periodic relocalisation runs concurrently in a second Worker. */
  readonly relocalizerUrl?: string | URL;
  /**
   * Engine profile (profiles.ts): 'swift' by default; 'hawk' on request. The device decides what actually runs:
   * without Worker capture Hawk/Swift fall back to Wren, Hawk steps down to Swift when the device cannot keep up, and a
   * device without WebGL2 + VideoFrame is refused with `UnsupportedDeviceError`. Ignored when `pipeline`, `capture` or `compositor`
   * is given (a hand-made combination, for experiments).
   */
  readonly profile?: ProfileId;
  readonly onProfileChange?: (change: {
    readonly from: ProfileId;
    readonly to: ProfileId;
    readonly reason: string;
  }) => void;
  /** Hawk's processing budget per frame, µs, above which it steps down to Swift (default `HAWK_BUDGET.budgetUs`). */
  readonly hawkBudgetUs?: number;
  /** Modules of the Worker's vision pipeline (a hand-made combination; see `profile`). */
  readonly pipeline?: Partial<PipelineConfig>;
  readonly compositor?: CompositorKind;
  /**
   * CSS composition only: extrapolate the overlay to the capture time of the video frame on screen (F2 late binding,
   * default) or draw the latest pose as it is (F4 without prediction).
   */
  readonly cssPrediction?: boolean;
  /** Restrict the capture paths tried (in order); default all, best first. */
  readonly capture?: readonly CapturePath[];
  /**
   * Standard (processing) image size; default: long edge 640 px in the shape of the shown picture, following it when
   * the device turns. A size given here stays fixed.
   */
  readonly standardWidth?: number;
  readonly standardHeight?: number;
  readonly video?: MediaTrackConstraints;
  /** Diagnostics: results carry a picture strip for frame identification. */
  readonly probe?: boolean;
  readonly onResult?: (result: Extract<FromWorker, { type: 'result' }>) => void;
  /** The standard image changed size because the device turned (tracking starts over). */
  readonly onResize?: (size: { readonly width: number; readonly height: number }) => void;
  readonly onPresent?: (info: {
    readonly tag: unknown;
    readonly drawUs: number;
    readonly corners: readonly (readonly number[])[];
  }) => void;
}

export interface EngineStats {
  readonly frames: number;
  /** Main-thread time spent on capture work and result handling per processed frame, µs (mean). */
  readonly mainThreadUs: number;
  readonly drawUs: number;
  readonly lumaUs: number;
  readonly processUs: number;
}

export interface EngineHandle {
  /** The profile running now (null for a hand-made combination); it can step down while running (Hawk → Swift). */
  profile(): ProfileId | null;
  /** Profiles passed over at start because the device lacked what they need. */
  readonly profileFallbacks: readonly { readonly id: ProfileId; readonly missing: readonly Capability[] }[];
  readonly capturePath: CapturePath;
  readonly compositor: CompositorKind;
  readonly capabilities: ReadonlySet<Capability>;
  readonly matcher: string;
  readonly compileMs: number;
  stats(): EngineStats;
  stop(): void;
}

declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => {
  readable: ReadableStream<VideoFrame>;
};

export async function startEngine(options: EngineOptions): Promise<EngineHandle> {
  const caps = probeMainThread();
  if (await probeWorkerTrackProcessor()) caps.add('mstp-worker');
  // Profile mode unless the host assembled the modules itself.
  const manual = !!(options.pipeline || options.capture || options.compositor);
  const choice = manual ? null : resolveProfile(options.profile ?? 'swift', caps);
  if (!manual && !choice) {
    // Frame-locked composition needs WebGL2 + VideoFrame; reading frames needs Worker capture or rVFC.
    const missing: Capability[] = (['webgl2', 'videoframe'] as const).filter((c) => !caps.has(c));
    if (!caps.has('mstp-window') && !caps.has('mstp-worker') && !caps.has('rvfc')) missing.push('rvfc');
    throw new UnsupportedDeviceError(missing);
  }
  let profile: ProfileId | null = choice?.profile.id ?? null;
  const pipelineConfig: Partial<PipelineConfig> | undefined = choice ? choice.profile.pipeline : options.pipeline;
  const capturePaths = choice ? choice.profile.capture : options.capture;
  const relocalizerUrl = choice && !choice.profile.concurrentSlowLoop ? undefined : options.relocalizerUrl;
  const kind: CompositorKind =
    options.compositor ?? (caps.has('webgl2') && caps.has('videoframe') ? 'frame-locked' : 'css');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: options.video ?? {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      facingMode: { ideal: 'environment' },
    },
  });
  const track = stream.getVideoTracks()[0]!;
  const container = options.container;
  const video = container.ownerDocument.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  Object.assign(video.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    visibility: kind === 'css' ? 'visible' : 'hidden',
  });
  container.append(video);
  await video.play();
  // Standard image: long edge 640 px in the orientation the user sees. The video element's size is the shown one;
  // track settings can report the sensor orientation (iOS: landscape while the phone is held upright).
  const settings = track.getSettings();
  const shownStandard = (): [number, number] => {
    const cw = video.videoWidth || settings.width || 16;
    const ch = video.videoHeight || settings.height || 9;
    return [
      options.standardWidth ?? (cw >= ch ? 640 : 2 * Math.round((320 * cw) / ch)),
      options.standardHeight ?? (cw >= ch ? 2 * Math.round((320 * ch) / cw) : 640),
    ];
  };
  // Mutable: when the device turns, the shown picture changes shape and the standard image follows it.
  let [width, height] = shownStandard();

  const worker = new Worker(options.workerUrl, { type: 'module', name: 'LiveMira Next vision' });
  const send = (message: ToWorker, transfer: Transferable[] = []): void => worker.postMessage(message, transfer);
  let mainUs = 0;
  let drawUs = 0;
  let lumaUs = 0;
  let processUs = 0;
  let frames = 0;
  let inFlight = 0;
  let compositorF1: FrameLockedCompositor | null = null;
  let compositorCss: CssCompositor | null = null;
  const createCompositor = (infos: readonly TargetInfo[]): void => {
    const sizes = new Map(infos.map((t) => [t.id, { width: t.width, height: t.height }]));
    if (kind === 'frame-locked') {
      const canvas = container.ownerDocument.createElement('canvas');
      Object.assign(canvas.style, {
        position: 'absolute',
        inset: '0',
        width: '100%',
        height: '100%',
      });
      container.append(canvas);
      compositorF1 = new FrameLockedCompositor(canvas, {
        standardWidth: width,
        standardHeight: height,
        targetSizes: sizes,
      });
      compositorF1.onPresent = (p: PresentedFrame, us) => {
        drawUs += us;
        options.onPresent?.({
          tag: p.tag,
          drawUs: us,
          corners: p.poses.flatMap((q) => q.corners.map((c) => [c[0], c[1]])),
        });
      };
    } else {
      compositorCss = new CssCompositor(container, {
        standardWidth: width,
        standardHeight: height,
        targetSizes: sizes,
      });
      compositorCss.onPresent = (corners, us) => {
        drawUs += us;
        options.onPresent?.({
          tag: null,
          drawUs: us,
          corners: [...corners.values()].flatMap((c) => c.map((p) => [p[0], p[1]])),
        });
      };
    }
  };
  let lastResult: { receivedUs: number; delayUs: number } | null = null;
  /** Worker processing times of the latest results, for Hawk's step-down. */
  const recent: number[] = [];
  /** Follows the shown picture's shape; installed once the compositor exists (see `onVideoResize`). */
  let checkShape = (): void => {};
  const ready = new Promise<{ matcher: string; compileMs: number }>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const started = performance.now();
      const m = event.data;
      if (m.type === 'ready') {
        createCompositor(m.targets);
        resolve({ matcher: m.matcher, compileMs: m.compileMs });
      } else if (m.type === 'error') {
        if (!frames) reject(new Error(m.message));
      } else if (m.type === 'result') {
        inFlight = Math.max(0, inFlight - 1);
        frames++;
        lumaUs += m.stats.lumaUs;
        processUs += m.stats.processUs;
        // Hawk that cannot keep up with the camera steps down to Swift (same capture; lighter pipeline).
        if (profile === 'hawk') {
          recent.push(m.stats.processUs);
          if (recent.length > HAWK_BUDGET.window) recent.shift();
          const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
          const budgetUs = options.hawkBudgetUs ?? HAWK_BUDGET.budgetUs;
          if (frames > HAWK_BUDGET.warmup && recent.length === HAWK_BUDGET.window && mean > budgetUs) {
            profile = 'swift';
            send({ type: 'reconfigure', pipeline: PROFILES.swift.pipeline });
            options.onProfileChange?.({
              from: 'hawk',
              to: 'swift',
              reason: `processing ${(mean / 1000).toFixed(1)} ms/frame > ${budgetUs / 1000} ms`,
            });
          }
        }
        lastResult = {
          receivedUs: performance.now() * 1000,
          delayUs: m.stats.lumaUs + m.stats.processUs + (m.stats.arrivalUs ?? 0),
        };
        // Not every browser fires the video's resize event when the device turns: check the shape per result too.
        checkShape();
        // A result computed before a resize is in the old standard image: show its frame, not its poses.
        const poses = m.size[0] === width && m.size[1] === height ? m.poses : [];
        if (compositorF1 && m.frame) compositorF1.present({ frame: m.frame, poses, tag: m.strip ?? m.sequence });
        else m.frame?.close();
        compositorCss?.update(poses);
        options.onResult?.(m);
      }
      mainUs += (performance.now() - started) * 1000;
    };
    worker.onerror = (event) => reject(new Error(event.message));
  });
  const targets = (options.assets?.length ? [] : (options.targets ?? [])).map((t) => ({
    info: t.info,
    gray: t.gray.slice().buffer,
  }));
  const assets = options.assets?.map((a) => a.slice().buffer);
  let relocalizer: Worker | null = null;
  let port: MessagePort | null = null;
  if (relocalizerUrl) {
    relocalizer = new Worker(relocalizerUrl, {
      type: 'module',
      name: 'LiveMira Next relocalizer',
    });
    const channel = new MessageChannel();
    relocalizer.postMessage(
      {
        type: 'init',
        targets,
        ...(assets ? { assets: assets.map((a) => a.slice(0)) } : {}),
        port: channel.port2,
        ...(pipelineConfig?.wasm === false ? { wasm: false } : {}),
      },
      [channel.port2],
    );
    port = channel.port1;
  }
  send(
    {
      type: 'init',
      targets,
      ...(assets ? { assets } : {}),
      width,
      height,
      returnFrames: kind === 'frame-locked',
      probe: options.probe === true,
      ...(port ? { relocalizer: port } : {}),
      ...(pipelineConfig ? { pipeline: pipelineConfig } : {}),
    },
    port ? [port] : [],
  );
  const { matcher, compileMs } = await ready;
  // Created by the 'ready' handler (the targets come from the Worker), which TypeScript's narrowing cannot see.
  const css = compositorCss as CssCompositor | null;
  if (css && options.cssPrediction !== false)
    // Late binding: extrapolate to the capture time of what the native video shows now (≈ 12 ms behind availability).
    css.shownCaptureUs = () =>
      lastResult ? performance.now() * 1000 - lastResult.receivedUs + lastResult.delayUs - 12_000 : null;

  // The device turned (the video's shown size changed shape): the standard image, the Worker and the compositor
  // follow; results still in flight from before are shown without their poses.
  const f1 = compositorF1 as FrameLockedCompositor | null;
  const onVideoResize = (): void => {
    const [w, h] = shownStandard();
    if (w === width && h === height) return;
    width = w;
    height = h;
    send({ type: 'resize', width, height });
    f1?.setStandardSize(width, height);
    css?.setStandardSize(width, height);
    options.onResize?.({ width, height });
  };
  video.addEventListener('resize', onVideoResize);
  checkShape = onVideoResize;

  const order = capturePaths ?? ['mstp-window', 'mstp-worker', 'videoframe', 'canvas'];
  let path: CapturePath | null = null;
  let stopCallbacks: (() => void) | null = null;
  for (const candidate of order) {
    try {
      if (candidate === 'mstp-window' && caps.has('mstp-window')) {
        const processor = new MediaStreamTrackProcessor({ track: track.clone(), maxBufferSize: 1 });
        send({ type: 'stream', readable: processor.readable }, [processor.readable as unknown as Transferable]);
        path = candidate;
      } else if (candidate === 'mstp-worker' && caps.has('mstp-worker')) {
        const clone = track.clone();
        send({ type: 'track', track: clone }, [clone as unknown as Transferable]);
        path = candidate;
      } else if (
        (candidate === 'videoframe' && caps.has('videoframe') && caps.has('rvfc')) ||
        (candidate === 'canvas' && caps.has('rvfc'))
      ) {
        const readback = candidate === 'canvas' ? container.ownerDocument.createElement('canvas') : null;
        const context = readback?.getContext('2d', { willReadFrequently: true }) ?? null;
        if (readback) {
          readback.width = width;
          readback.height = height;
        }
        let id = 0;
        let active = true;
        const onFrame = (now: number, metadata: VideoFrameCallbackMetadata): void => {
          if (!active) return;
          id = video.requestVideoFrameCallback(onFrame);
          if (inFlight > 0) return;
          const started = performance.now();
          const captureUs = (metadata.captureTime ?? now) * 1000;
          if (context && readback) {
            if (readback.width !== width || readback.height !== height) {
              readback.width = width;
              readback.height = height;
            }
            context.drawImage(video, 0, 0, width, height);
            const rgba = context.getImageData(0, 0, width, height).data;
            const gray = new Uint8Array(width * height);
            for (let i = 0; i < gray.length; i++)
              gray[i] = (77 * rgba[4 * i]! + 150 * rgba[4 * i + 1]! + 29 * rgba[4 * i + 2]! + 128) >> 8;
            send({ type: 'gray', gray: gray.buffer, captureUs }, [gray.buffer]);
          } else {
            const frame = new VideoFrame(video, { timestamp: Math.round(captureUs) });
            send({ type: 'frame', frame, captureUs }, [frame]);
          }
          inFlight++;
          mainUs += (performance.now() - started) * 1000;
        };
        id = video.requestVideoFrameCallback(onFrame);
        stopCallbacks = () => {
          active = false;
          video.cancelVideoFrameCallback(id);
        };
        path = candidate;
      }
    } catch {
      path = null;
    }
    if (path) break;
  }
  if (!path) throw new Error('No capture path available');
  const capturePath: CapturePath = path;
  return {
    profile: () => profile,
    profileFallbacks: choice?.skipped ?? [],
    capturePath,
    compositor: kind,
    capabilities: caps,
    matcher,
    compileMs,
    stats: () => ({
      frames,
      mainThreadUs: frames ? mainUs / frames : 0,
      drawUs: frames ? drawUs / frames : 0,
      lumaUs: frames ? lumaUs / frames : 0,
      processUs: frames ? processUs / frames : 0,
    }),
    stop: () => {
      video.removeEventListener('resize', onVideoResize);
      stopCallbacks?.();
      send({ type: 'stop' });
      worker.terminate();
      relocalizer?.terminate();
      compositorF1?.dispose();
      compositorCss?.dispose();
      for (const t of stream.getTracks()) t.stop();
      video.remove();
    },
  };
}
