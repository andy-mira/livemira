// SPDX-License-Identifier: Apache-2.0
// One camera session, from `start()` to stop: the camera, the vision Worker (and the relocaliser of concurrent
// profiles), the capture path, the stage renderer, the target videos, visibility and view changes.

import type { Capability } from '@livemira-next/contracts';
import {
  DIAGNOSTICS,
  HAWK_BUDGET,
  probeMainThread,
  probeWorkerTrackProcessor,
  PROFILES,
  resolveProfile,
  type DisplayPose,
  type FromWorker,
  type ProfileId,
  type ToWorker,
} from '@livemira-next/web';

import type { EngineEvents, MediaState, ProfileName, TargetBundle, TargetMedia } from './api.ts';
import { openCamera, standardSize, type OpenCamera } from './camera.ts';
import { EngineError } from './errors.ts';
import { MediaPlayer } from './media.ts';
import { PlanePresenter, type PlaneLook } from './presenter.ts';
import { StageRenderer, type Plane } from './renderer.ts';
import { TargetVisibility } from './visibility.ts';
import { spawnWorker } from './worker-source.ts';

declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => {
  readable: ReadableStream<VideoFrame>;
};

export interface SessionSettings {
  readonly container: HTMLElement;
  readonly profile: ProfileName;
  readonly facingMode: 'environment' | 'user';
  readonly deviceId: string | undefined;
  readonly fit: 'cover' | 'contain';
  /** Share of the camera picture's size that recognition works on. */
  readonly processingScale: number;
  readonly lossGraceMs: number;
  readonly presentation: { revealMs: number; resumeRevealMs: number; veilOpacity: number } | null;
  readonly accent: readonly [number, number, number];
  readonly workerUrl: string | URL | undefined;
}

/** What the session needs of its engine. */
export interface SessionHost {
  emit<K extends keyof EngineEvents>(type: K, event: EngineEvents[K]): void;
  media(targetId: string): TargetMedia | null;
  progress(targetId: string): number | null;
  isMuted(): boolean;
  /** The session ended on its own (camera or Worker failure). */
  failed(error: EngineError, reason: string): void;
}

/** Profiles a device can run must at least read frames: Worker capture or video frame callbacks. */
function missingCapabilities(caps: ReadonlySet<Capability>): string[] {
  const missing: string[] = (['webgl2', 'videoframe'] as const).filter((c) => !caps.has(c));
  if (!caps.has('mstp-window') && !caps.has('mstp-worker') && !caps.has('rvfc')) missing.push('rvfc');
  return missing;
}

/** Resolves the profile for this device, or throws UNSUPPORTED_DEVICE. */
export async function chooseProfile(preferred: ProfileName): Promise<{
  profile: ProfileName;
  caps: Set<Capability>;
  fallbacks: { profile: ProfileName; missing: string[] }[];
}> {
  const caps = probeMainThread();
  if (await probeWorkerTrackProcessor()) caps.add('mstp-worker');
  const choice = resolveProfile(preferred as ProfileId, caps);
  if (!choice) {
    const missing = missingCapabilities(caps);
    throw new EngineError(
      'UNSUPPORTED_DEVICE',
      `This device cannot run recognition: it lacks ${missing.join(', ') || 'a supported capture path'} (WebGL2 is required)`,
      { missing },
    );
  }
  return {
    profile: choice.profile.id,
    caps,
    fallbacks: choice.skipped.map((s) => ({ profile: s.id, missing: [...s.missing] })),
  };
}

const prefersReducedMotion = (doc: Document): boolean => {
  try {
    return !!doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** A settled view: no further size change for this long. */
const VIEW_SETTLE_MS = 280;
/** No processed frame for this long (a stalled camera): the targets in view count as lost. */
const STALL_MS = 600;

export class Session {
  private readonly settings: SessionSettings;
  private readonly host: SessionHost;
  private aborted = false;
  private ended = false;
  profile: ProfileName;
  private camera: OpenCamera | null = null;
  private layer: HTMLDivElement | null = null;
  private vision: Worker | null = null;
  private relocalizer: Worker | null = null;
  private renderer: StageRenderer | null = null;
  private stopCapture: (() => void) | null = null;
  /** Track clones handed to capture; stopped with the session. */
  private readonly clones: MediaStreamTrack[] = [];
  private resizeObserver: ResizeObserver | null = null;
  private width = 640;
  private height = 360;
  private inFlight = 0;
  private frames = 0;
  private lastResultAt = 0;
  private readonly recent: number[] = [];
  private readonly visibility: TargetVisibility;
  private readonly presenters = new Map<string, PlanePresenter>();
  private readonly players = new Map<string, MediaPlayer>();
  private readonly corners = new Map<string, DisplayPose['corners']>();
  private aspects = new Map<string, number>();
  private targetIds: string[] = [];
  private transition: { timer: ReturnType<typeof setTimeout> | null; settled: boolean } | null = null;
  private layoutKey = '';
  private pendingTargets: { resolve: () => void; ids: string[] } | null = null;

  constructor(settings: SessionSettings, host: SessionHost, profile: ProfileName) {
    this.settings = settings;
    this.host = host;
    this.profile = profile;
    this.visibility = new TargetVisibility(settings.lossGraceMs);
  }

  private check(): void {
    if (this.aborted) throw new EngineError('ABORTED', 'The start was cancelled by a stop');
  }

  async start(targets: readonly TargetBundle[], caps: ReadonlySet<Capability>): Promise<string> {
    const s = this.settings;
    const profile = PROFILES[this.profile as ProfileId];
    // Workers start while the camera opens (their scripts compile meanwhile).
    this.vision = spawnWorker('vision', s.workerUrl);
    if (profile.concurrentSlowLoop) this.relocalizer = spawnWorker('relocalizer', s.workerUrl);
    const layer = s.container.ownerDocument.createElement('div');
    layer.setAttribute('data-livemira-stage', '');
    Object.assign(layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', background: '#000' });
    s.container.append(layer);
    this.layer = layer;
    this.camera = await openCamera(
      { facingMode: s.facingMode, ...(s.deviceId ? { deviceId: s.deviceId } : {}) },
      layer,
    );
    this.check();
    const { video, track } = this.camera;
    [this.width, this.height] = standardSize(video.videoWidth, video.videoHeight, s.processingScale);
    this.renderer = new StageRenderer(layer, this.width, this.height, {
      fit: s.fit,
      accent: s.accent,
      planes: (now) => this.planes(now),
    });
    this.setTargetsInfo(targets);

    const ready = new Promise<void>((resolve, reject) => {
      const vision = this.vision!;
      vision.onmessage = (event: MessageEvent<FromWorker>) => {
        const m = event.data;
        if (m.type === 'ready') resolve();
        else if (m.type === 'result') this.onResult(m);
        else if (m.type === 'targets') this.onTargetsLoaded();
        else if (m.type === 'error') {
          const error = new EngineError('WORKER_FAILED', `Recognition failed: ${m.message}`);
          if (this.frames) this.fail(error, 'worker-failure');
          else reject(error);
        }
      };
      vision.onerror = (event) => {
        event.preventDefault();
        const error = new EngineError('WORKER_FAILED', `The vision Worker failed: ${event.message}`);
        if (this.frames) this.fail(error, 'worker-failure');
        else reject(error);
      };
    });
    const assets = targets.map((t) => t.bytes.slice().buffer as ArrayBuffer);
    let port: MessagePort | null = null;
    if (this.relocalizer) {
      const channel = new MessageChannel();
      this.relocalizer.postMessage(
        { type: 'init', targets: [], assets: assets.map((a) => a.slice(0)), port: channel.port2 },
        [channel.port2],
      );
      this.relocalizer.onerror = (event) => {
        event.preventDefault();
        this.fail(
          new EngineError('WORKER_FAILED', `The relocalisation Worker failed: ${event.message}`),
          'worker-failure',
        );
      };
      port = channel.port1;
    }
    this.send(
      {
        type: 'init',
        targets: [],
        assets,
        width: this.width,
        height: this.height,
        returnFrames: true,
        probe: DIAGNOSTICS,
        ...(port ? { relocalizer: port } : {}),
        pipeline: profile.pipeline,
      },
      port ? [port] : [],
    );
    await ready;
    this.check();

    track.addEventListener('ended', this.onTrackEnded);
    video.addEventListener('resize', this.onLayoutChange);
    this.resizeObserver = new ResizeObserver(() => this.onLayoutChange());
    this.resizeObserver.observe(s.container);
    this.layoutKey = this.currentLayoutKey();
    const capture = this.startCapture(caps, profile.capture);
    this.check();
    for (const id of this.targetIds) this.mediaChanged(id);
    return capture;
  }

  private send(message: ToWorker, transfer: Transferable[] = []): void {
    this.vision?.postMessage(message, transfer);
  }

  /** Reads frames: the profile's capture paths in order, the first the platform supports. */
  private startCapture(caps: ReadonlySet<Capability>, order: readonly string[]): string {
    const { video, track } = this.camera!;
    for (const path of order) {
      try {
        if (path === 'mstp-window' && caps.has('mstp-window')) {
          const clone = track.clone();
          this.clones.push(clone);
          const processor = new MediaStreamTrackProcessor({ track: clone, maxBufferSize: 1 });
          this.send({ type: 'stream', readable: processor.readable }, [processor.readable as unknown as Transferable]);
          return path;
        }
        if (path === 'mstp-worker' && caps.has('mstp-worker')) {
          const clone = track.clone();
          this.clones.push(clone);
          this.send({ type: 'track', track: clone }, [clone as unknown as Transferable]);
          return path;
        }
        if (path === 'videoframe' && caps.has('videoframe') && caps.has('rvfc')) {
          let handle = 0;
          let active = true;
          const onFrame = (now: number, metadata: VideoFrameCallbackMetadata): void => {
            if (!active) return;
            handle = video.requestVideoFrameCallback(onFrame);
            if (this.inFlight > 0) return;
            const captureUs = (metadata.captureTime ?? now) * 1000;
            const frame = new VideoFrame(video, { timestamp: Math.round(captureUs) });
            this.send({ type: 'frame', frame, captureUs }, [frame]);
            this.inFlight++;
          };
          handle = video.requestVideoFrameCallback(onFrame);
          this.stopCapture = () => {
            active = false;
            video.cancelVideoFrameCallback(handle);
          };
          return path;
        }
      } catch {
        // Try the next path.
      }
    }
    throw new EngineError('UNSUPPORTED_DEVICE', 'No way to read camera frames on this device', { missing: ['rvfc'] });
  }

  private onResult(m: Extract<FromWorker, { type: 'result' }>): void {
    if (this.ended) {
      m.frame?.close();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.frames++;
    this.lastResultAt = performance.now();
    this.stepDown(m.stats.processUs);
    // Not every browser fires the video's resize event when the device turns.
    if (this.currentLayoutKey() !== this.layoutKey) this.onLayoutChange();
    const current = m.size[0] === this.width && m.size[1] === this.height;
    const poses = current && !this.transition ? m.poses : [];
    if (m.frame) {
      if (current) this.renderer?.presentFrame(m.frame);
      else m.frame.close();
    }
    if (this.transition?.settled && current) this.endTransition();
    if (this.transition) return;
    for (const p of poses) this.corners.set(p.targetId, p.corners);
    const { found, lost } = this.visibility.update(
      performance.now(),
      poses.map((p) => p.targetId),
    );
    for (const id of lost) this.targetLost(id, 'out-of-view');
    // Device-kit builds only: a per-frame `trace` event (state, poses, pose quality, timings); not in releases, whose
    // public events are unchanged.
    if (DIAGNOSTICS)
      (this.host.emit as (type: string, event: unknown) => void)('trace', {
        timeMs: performance.now(),
        wallMs: Date.now(),
        state: m.state,
        size: m.size,
        poses: poses.map((p) => ({ targetId: p.targetId, corners: p.corners })),
        visible: this.visibility.visible(),
        processUs: m.stats.processUs,
        lumaUs: m.stats.lumaUs,
        ...(m.trace ? { measured: m.trace.measured, timings: m.trace.timings } : {}),
      });
    for (const id of found) {
      this.host.emit('targetFound', { targetId: id });
      const player = this.players.get(id);
      if (player && player.state !== 'error') void player.play();
    }
  }

  /** Hawk that cannot keep up with the camera steps down to Swift (same capture, lighter pipeline). */
  private stepDown(processUs: number): void {
    if (this.profile !== 'hawk') return;
    this.recent.push(processUs);
    if (this.recent.length > HAWK_BUDGET.window) this.recent.shift();
    const mean = this.recent.reduce((a, b) => a + b, 0) / this.recent.length;
    if (this.frames > HAWK_BUDGET.warmup && this.recent.length === HAWK_BUDGET.window && mean > HAWK_BUDGET.budgetUs) {
      this.profile = 'swift';
      this.send({ type: 'reconfigure', pipeline: PROFILES.swift.pipeline });
      this.host.emit('profileChange', {
        from: 'hawk',
        to: 'swift',
        reason: `processing ${(mean / 1000).toFixed(1)} ms/frame > ${HAWK_BUDGET.budgetUs / 1000} ms`,
      });
    }
  }

  private targetLost(id: string, reason: EngineEvents['targetLost']['reason']): void {
    this.corners.delete(id);
    this.players.get(id)?.pause();
    this.host.emit('targetLost', { targetId: id, reason });
  }

  private currentLayoutKey(): string {
    const video = this.camera?.video;
    const c = this.settings.container;
    return `${c.clientWidth}x${c.clientHeight}|${video?.videoWidth ?? 0}x${video?.videoHeight ?? 0}`;
  }

  /**
   * The view changes shape (rotation, resize, the address bar): nothing is drawn on targets until it settles and a
   * frame in the new standard size has been processed; the targets in view count as lost meanwhile.
   */
  private readonly onLayoutChange = (): void => {
    if (this.ended) return;
    const key = this.currentLayoutKey();
    if (key === this.layoutKey && !this.transition) return;
    this.layoutKey = key;
    if (!this.transition) {
      this.transition = { timer: null, settled: false };
      for (const id of this.visibility.clear()) this.targetLost(id, 'viewport');
      this.renderer?.invalidate();
      this.host.emit('viewport', { phase: 'begin' });
    }
    const t = this.transition;
    t.settled = false;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      t.timer = null;
      const video = this.camera?.video;
      if (!video) return;
      const [w, h] = standardSize(video.videoWidth, video.videoHeight, this.settings.processingScale);
      if (w !== this.width || h !== this.height) {
        this.width = w;
        this.height = h;
        this.send({ type: 'resize', width: w, height: h });
        this.renderer?.setStandardSize(w, h);
      }
      t.settled = true;
    }, VIEW_SETTLE_MS);
  };

  private endTransition(): void {
    this.transition = null;
    this.host.emit('viewport', { phase: 'end' });
  }

  private readonly onTrackEnded = (): void => {
    this.fail(new EngineError('CAMERA_ENDED', 'The camera stopped'), 'camera-ended');
  };

  private fail(error: EngineError, reason: string): void {
    if (this.ended) return;
    this.host.failed(error, reason);
  }

  // ---- Targets and their videos ----

  private setTargetsInfo(targets: readonly TargetBundle[]): void {
    this.targetIds = targets.map((t) => t.targetId);
    this.aspects = new Map(targets.map((t) => [t.targetId, t.widthPx / t.heightPx]));
  }

  /** New targets while running: loaded in the background; resolves once they are recognised. */
  loadTargets(targets: readonly TargetBundle[]): Promise<void> {
    const removed = this.targetIds.filter((id) => !targets.some((t) => t.targetId === id));
    for (const id of this.visibility.clear()) this.targetLost(id, 'out-of-view');
    this.setTargetsInfo(targets);
    for (const id of removed) this.mediaChanged(id);
    const assets = targets.map((t) => t.bytes.slice().buffer as ArrayBuffer);
    this.relocalizer?.postMessage({ type: 'targets', assets: assets.map((a) => a.slice(0)) });
    this.send({ type: 'targets', assets }, assets);
    this.pendingTargets?.resolve();
    return new Promise((resolve) => {
      this.pendingTargets = { resolve, ids: [...this.targetIds] };
    });
  }

  private onTargetsLoaded(): void {
    const pending = this.pendingTargets;
    this.pendingTargets = null;
    if (!pending) return;
    pending.resolve();
    this.host.emit('targetsReady', { targetIds: pending.ids });
  }

  /** The target's video changed (set, replaced or cleared): its player is rebuilt. */
  mediaChanged(id: string): void {
    const old = this.players.get(id);
    if (old) {
      this.renderer?.forget(old);
      old.dispose();
      this.players.delete(id);
    }
    this.presenters.get(id)?.mediaChanged();
    const media = this.targetIds.includes(id) ? this.host.media(id) : null;
    if (!media || !this.layer) {
      if (old) this.host.emit('media', { targetId: id, state: 'none' });
      return;
    }
    const player = new MediaPlayer(this.layer, media, this.host.isMuted(), (state: MediaState, code?: string) => {
      if (this.players.get(id) !== player) return;
      this.host.emit('media', { targetId: id, state, ...(code ? { code } : {}) });
      if (state === 'blocked') this.host.emit('playbackBlocked', { targetId: id });
      if (state === 'ready' && this.visibility.isVisible(id)) void player.play();
      this.renderer?.invalidate();
    });
    this.players.set(id, player);
    this.host.emit('media', { targetId: id, state: 'loading' });
    // Asked for at once: the browser starts as soon as enough has arrived (and some only load a video asked to play).
    if (this.visibility.isVisible(id)) void player.play();
  }

  setMuted(isMuted: boolean): void {
    for (const p of this.players.values()) p.setMuted(isMuted);
  }

  /** From a tap: plays the video of the photo in view (reloading it after an error). */
  async retry(): Promise<boolean> {
    const id = this.visibility.visible()[0];
    if (!id) return false;
    let player = this.players.get(id);
    if (!player) return false;
    if (player.state === 'error') {
      this.mediaChanged(id);
      player = this.players.get(id);
      if (!player) return false;
      return true;
    }
    await player.play();
    return player.state === 'playing';
  }

  /** The video of a visible target (for sound changes from a tap). */
  activePlayer(): MediaPlayer | null {
    const id = this.visibility.visible()[0];
    return (id && this.players.get(id)) || null;
  }

  // ---- Drawing ----

  private planes(now: number): Plane[] {
    if (this.transition) return [];
    // Frames stopped coming (the camera stalled): nothing in view can be confirmed any more.
    if (this.lastResultAt && now - this.lastResultAt > STALL_MS && this.visibility.visible().length)
      for (const id of this.visibility.clear()) this.targetLost(id, 'out-of-view');
    const out: Plane[] = [];
    const presentation = this.settings.presentation;
    for (const id of this.visibility.visible()) {
      const corners = this.corners.get(id);
      if (!corners) continue;
      const presence = this.visibility.presence(id, now);
      const player = this.players.get(id) ?? null;
      const targetAspect = this.aspects.get(id) ?? 1;
      let look: PlaneLook | null;
      if (presentation) {
        let presenter = this.presenters.get(id);
        if (!presenter)
          this.presenters.set(
            id,
            (presenter = new PlanePresenter({
              ...presentation,
              isReducedMotion: () => prefersReducedMotion(this.settings.container.ownerDocument),
            })),
          );
        const progress = this.host.progress(id);
        look = presenter.look(now, {
          presence,
          isPlaying: !!player?.isFlowing,
          isWaiting: progress !== null || (!!player && player.state !== 'error' && player.state !== 'none'),
          isBlocked: player?.state === 'blocked',
          isBuffering: !!player?.isBuffering,
          progress,
          targetAspect,
          videoAspect: player?.aspect ?? 0,
        });
      } else {
        const playing = !!player?.isFlowing;
        look = {
          alpha: presence,
          aspect: player?.aspect || targetAspect,
          veil: 0,
          reveal: playing ? 1 : 0,
          wave: 0,
          ring: 0,
          ringProgress: -1,
          spin: 0,
          play: 0,
          glow: 0,
          showVideo: playing,
          isAnimating: presence < 1,
        };
      }
      if (!look) continue;
      out.push({
        targetId: id,
        corners,
        targetAspect,
        look,
        player,
        fit: this.host.media(id)?.fit ?? 'contain',
      });
    }
    return out;
  }

  /** Releases everything; the targets in view are reported lost. Idempotent. */
  dispose(): void {
    this.aborted = true;
    if (this.ended) return;
    this.ended = true;
    for (const id of this.visibility.clear()) this.targetLost(id, 'stopped');
    if (this.transition?.timer) clearTimeout(this.transition.timer);
    this.transition = null;
    this.pendingTargets?.resolve();
    this.pendingTargets = null;
    this.resizeObserver?.disconnect();
    this.stopCapture?.();
    try {
      this.send({ type: 'stop' });
    } catch {
      // The Worker is gone already.
    }
    this.vision?.terminate();
    this.relocalizer?.terminate();
    for (const clone of this.clones)
      try {
        clone.stop();
      } catch {
        // Transferred to the Worker: it ended with it.
      }
    for (const player of this.players.values()) player.dispose();
    this.players.clear();
    this.renderer?.dispose();
    if (this.camera) {
      this.camera.track.removeEventListener('ended', this.onTrackEnded);
      this.camera.video.removeEventListener('resize', this.onLayoutChange);
      for (const t of this.camera.stream.getTracks()) t.stop();
      this.camera.video.srcObject = null;
    }
    this.layer?.remove();
  }
}
