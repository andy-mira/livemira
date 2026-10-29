// SPDX-License-Identifier: Apache-2.0
// The engine: options, state, targets and their videos across sessions, and the order of start/stop/dispose.

import type {
  Engine,
  EngineEvents,
  EngineOptions,
  EngineState,
  ProfileName,
  TargetBundle,
  TargetMedia,
} from './api.ts';
import { Emitter } from './emitter.ts';
import { asEngineError, EngineError } from './errors.ts';
import { chooseProfile, Session, type SessionSettings } from './session.ts';
import { checkTargets, isValidTargetId } from './targets.ts';

const PROFILE_NAMES: readonly ProfileName[] = ['hawk', 'swift', 'wren'];

const invalid = (message: string): EngineError => new EngineError('INVALID_CONFIG', message);

function inRange(value: unknown, min: number, max: number, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw invalid(`${name} must be a number ${min}..${max}`);
  return value;
}

/** '#rrggbb' → linear-ish 0..1 components (the shader works in display space). */
function parseAccent(color: unknown): [number, number, number] {
  if (color === undefined) return [0xc0 / 255, 0x67 / 255, 0x4a / 255];
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color))
    throw invalid('presentation.accent must be a #rrggbb colour');
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16) / 255) as [number, number, number];
}

function settingsFrom(options: EngineOptions): SessionSettings {
  if (!options || typeof options !== 'object') throw invalid('createEngine needs options');
  const container = options.container;
  if (typeof HTMLElement === 'undefined' || !(container instanceof HTMLElement))
    throw invalid('container must be an HTMLElement');
  const profile = options.profile ?? 'swift';
  if (!PROFILE_NAMES.includes(profile)) throw invalid(`profile must be one of ${PROFILE_NAMES.join(', ')}`);
  const camera = options.camera ?? {};
  const facingMode = camera.facingMode ?? 'environment';
  if (facingMode !== 'environment' && facingMode !== 'user')
    throw invalid("camera.facingMode must be 'environment' or 'user'");
  const fit = camera.fit ?? 'cover';
  if (fit !== 'cover' && fit !== 'contain') throw invalid("camera.fit must be 'cover' or 'contain'");
  if (camera.deviceId !== undefined && typeof camera.deviceId !== 'string')
    throw invalid('camera.deviceId must be a string');
  const processingScale = camera.processingScale ?? 1;
  if (![1, 0.75, 0.5].includes(processingScale)) throw invalid('camera.processingScale must be 1, 0.75 or 0.5');
  const lossGraceMs = inRange(options.tracking?.lossGraceMs, 0, 1000, 'tracking.lossGraceMs') ?? 200;
  const p = options.presentation;
  const presentation =
    p === false
      ? null
      : {
          revealMs: inRange(p?.revealMs, 0, 3000, 'presentation.revealMs') ?? 900,
          resumeRevealMs: inRange(p?.resumeRevealMs, 0, 3000, 'presentation.resumeRevealMs') ?? 320,
          veilOpacity: inRange(p?.veilOpacity, 0, 1, 'presentation.veilOpacity') ?? 0.5,
        };
  return {
    container,
    profile,
    facingMode,
    deviceId: camera.deviceId,
    fit,
    processingScale,
    lossGraceMs,
    presentation,
    accent: parseAccent(p === false ? undefined : p?.accent),
    workerUrl: options.workerUrl,
  };
}

function checkMedia(media: TargetMedia): TargetMedia {
  if (!media || typeof media !== 'object') throw invalid('media must be an object or null');
  const hasFile = typeof Blob !== 'undefined' && media.file instanceof Blob;
  const hasUrl = typeof media.url === 'string' && media.url.length > 0;
  if (hasFile === hasUrl) throw invalid('media needs exactly one of file (a Blob) and url');
  if (hasFile && media.file!.size === 0) throw new EngineError('MEDIA_FAILED', 'The video file is empty');
  if (media.fit !== undefined && !['contain', 'cover', 'fill'].includes(media.fit))
    throw invalid("media.fit must be 'contain', 'cover' or 'fill'");
  return { ...media };
}

class LiveMiraEngine implements Engine {
  private stateValue: EngineState = 'idle';
  private readonly settings: SessionSettings;
  private readonly events = new Emitter<EngineEvents>();
  private targets: readonly TargetBundle[] = [];
  private readonly mediaSpecs = new Map<string, TargetMedia>();
  private readonly progressValues = new Map<string, number>();
  private muted = true;
  private session: Session | null = null;
  /** Lifecycle operations run one after another. */
  private queue: Promise<void> = Promise.resolve();
  private disposing: Promise<void> | null = null;

  readonly media: Engine['media'];

  constructor(settings: SessionSettings) {
    this.settings = settings;
    const engine = this;
    this.media = {
      get isMuted() {
        return engine.muted;
      },
      setMuted: (isMuted) => this.setMuted(isMuted),
      retry: () => this.session?.retry() ?? Promise.resolve(false),
    };
  }

  get state(): EngineState {
    return this.stateValue;
  }

  get profile(): ProfileName | null {
    return this.stateValue === 'running' ? (this.session?.profile ?? null) : null;
  }

  private setState(state: EngineState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.events.emit('state', { state });
  }

  on<K extends keyof EngineEvents>(type: K, listener: (event: EngineEvents[K]) => void): () => void {
    return this.events.on(type, listener);
  }

  private assertUsable(): void {
    if (this.stateValue === 'disposed') throw new EngineError('DISPOSED', 'The engine was disposed');
  }

  async setTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.assertUsable();
    checkTargets(targets);
    const ids = new Set(targets.map((t) => t.targetId));
    for (const id of [...this.mediaSpecs.keys()]) if (!ids.has(id)) this.mediaSpecs.delete(id);
    for (const id of [...this.progressValues.keys()]) if (!ids.has(id)) this.progressValues.delete(id);
    this.targets = [...targets];
    if (this.session && (this.stateValue === 'running' || this.stateValue === 'starting'))
      await this.session.loadTargets(this.targets);
  }

  setTargetMedia(targetId: string, media: TargetMedia | null): void {
    this.assertUsable();
    if (!isValidTargetId(targetId)) throw invalid(`Invalid target id ${JSON.stringify(targetId)}`);
    if (media === null) this.mediaSpecs.delete(targetId);
    else this.mediaSpecs.set(targetId, checkMedia(media));
    if (this.stateValue === 'running') this.session?.mediaChanged(targetId);
  }

  setTargetProgress(targetId: string, progress: number | null): void {
    if (progress === null) this.progressValues.delete(targetId);
    else if (typeof progress === 'number') this.progressValues.set(targetId, progress);
  }

  private async setMuted(isMuted: boolean): Promise<boolean> {
    this.muted = isMuted;
    this.session?.setMuted(isMuted);
    const player = this.session?.activePlayer();
    if (!player || isMuted) return true;
    // Sound needs the tap's activation: play now (it may have been refused before), fall back to muted on refusal.
    try {
      await player.video.play();
      return true;
    } catch {
      this.muted = true;
      this.session?.setMuted(true);
      return false;
    }
  }

  start(): Promise<void> {
    this.assertUsable();
    if (this.stateValue === 'running' || this.stateValue === 'starting') return this.queue;
    const run = this.queue.then(() => this.runStart());
    this.queue = run.catch(() => {});
    return run;
  }

  private async runStart(): Promise<void> {
    if (this.stateValue === 'disposed') throw new EngineError('DISPOSED', 'The engine was disposed');
    if (this.stateValue === 'running') return;
    this.setState('starting');
    let session: Session | null = null;
    try {
      const { profile, caps, fallbacks } = await chooseProfile(this.settings.profile);
      session = new Session(this.settings, this.host(), profile);
      this.session = session;
      const targets = this.targets;
      const capture = await session.start(targets, caps);
      if (this.session !== session) throw new EngineError('ABORTED', 'The start was cancelled by a stop');
      this.setState('running');
      this.events.emit('ready', { profile: session.profile, capture, fallbacks });
      if (targets.length) this.events.emit('targetsReady', { targetIds: targets.map((t) => t.targetId) });
    } catch (cause) {
      const error = asEngineError(cause, 'CAMERA_START_FAILED', 'The engine could not start');
      session?.dispose();
      if (this.session === session) this.session = null;
      this.setState('idle');
      this.events.emit('ended', error.code === 'ABORTED' ? { reason: 'stopped' } : { reason: 'start-failed', error });
      if (error.code !== 'ABORTED') this.events.emit('error', { error });
      throw error;
    }
  }

  private host(): ConstructorParameters<typeof Session>[1] {
    return {
      emit: (type, event) => this.events.emit(type, event),
      media: (id) => this.mediaSpecs.get(id) ?? null,
      progress: (id) => this.progressValues.get(id) ?? null,
      isMuted: () => this.muted,
      failed: (error, reason) => {
        // The camera or a Worker failed while running: end the session.
        const session = this.session;
        if (!session) return;
        this.session = null;
        session.dispose();
        if (this.stateValue === 'running' || this.stateValue === 'starting') this.setState('idle');
        this.events.emit('ended', { reason, error });
        this.events.emit('error', { error });
      },
    };
  }

  stop(reason = 'stopped'): Promise<void> {
    if (this.stateValue === 'disposed') return Promise.resolve();
    // A stop during a start cancels it right away (the start then rejects with ABORTED).
    const session = this.session;
    if (this.stateValue === 'starting' && session) {
      this.session = null;
      session.dispose();
    }
    const run = this.queue.then(() => this.runStop(reason));
    this.queue = run.catch(() => {});
    return run;
  }

  private async runStop(reason: string): Promise<void> {
    const session = this.session;
    if (!session || this.stateValue !== 'running') return;
    this.setState('stopping');
    this.session = null;
    session.dispose();
    this.setState('idle');
    this.events.emit('ended', { reason });
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    this.disposing = this.stop('disposed').then(() => {
      this.mediaSpecs.clear();
      this.progressValues.clear();
      this.targets = [];
      this.setState('disposed');
      this.events.clear();
    });
    return this.disposing;
  }
}

/** Creates an engine in `options.container`. Throws INVALID_CONFIG for invalid options. Nothing starts until `start()`. */
export function createEngine(options: EngineOptions): Engine {
  return new LiveMiraEngine(settingsFrom(options));
}

/** What this device supports, without opening the camera. */
export async function probeDevice(): Promise<{ isSupported: boolean; missing: string[]; profile: ProfileName | null }> {
  try {
    const { profile } = await chooseProfile('swift');
    return { isSupported: true, missing: [], profile };
  } catch (error) {
    return {
      isSupported: false,
      missing: [...((error as EngineError).missing ?? ['unknown'])],
      profile: null,
    };
  }
}
