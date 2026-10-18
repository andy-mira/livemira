/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The engine core: session lifecycle, frame scheduling, viewport transitions and presentation over three seams (a
// frame source, a vision pipeline and an overlay). Lifecycle operations run one after another. Every asynchronous
// boundary re-checks the session, the stop generation and the transition epoch it began under.

import {
  EngineError,
  validateTargetBundle,
  type EventContext,
  type Frame,
  type TargetBundle,
  type ViewportTransition,
} from '@livemira/contracts';
import type { TelemetrySink } from '@livemira/diagnostics';

import type {
  EngineCapability,
  EngineEvents,
  FrameSource,
  OverlaySink,
  StartupStage,
  TargetMedia,
  VisionPipeline,
} from './engine-types.ts';
import { EventHub } from './event-hub.ts';
import { frameRecord, reportFrame, type MutableFrameRecord } from './frame-records.ts';
import { FrameScheduler, type DropReason } from './frame-scheduler.ts';
import {
  captureTargetFrame,
  LossContextTracker,
  type CapturedTargetFrame,
} from './loss-context.ts';
import { PresentationPolicy, type PresentationModes } from './presentation-policy.ts';
import { SessionConfigState, type SessionFacts } from './session-config.ts';
import { ViewportTransitions } from './viewport-transitions.ts';
import { WORKER_SAFE_REASONS } from '../worker/protocol.ts';

export const MAX_TARGETS = 10;
const MAX_PREDICTION_MS = 100;
const MAX_LOSS_DISPLAY_GRACE_MS = 1000;

export type EngineState = 'idle' | 'starting' | 'running' | 'stopping' | 'disposed';

export interface EngineCoreConfig {
  readonly source: FrameSource;
  readonly pipeline: VisionPipeline;
  readonly overlay: OverlaySink;
  /** 0..100, default 100. */
  readonly maxPredictionMs?: number;
  /** 0..1000, default 0. */
  readonly lossDisplayGraceMs?: number;
  /** How losses are presented beyond the grace; see PresentationModes. */
  readonly presentationModes?: PresentationModes;
  readonly nowUs?: () => number;
  readonly telemetry?: TelemetrySink;
  readonly onListenerError?: (error: unknown) => void;
  /** Camera and capability facts for the session configuration. */
  readonly sessionFacts?: () => SessionFacts;
  readonly capability?: () => EngineCapability;
  readonly sessionIdPrefix?: string;
}

const invalid = (message: string, isRecoverable = false): EngineError =>
  new EngineError('INVALID_CONFIG', message, { isRecoverable });

export class EngineCore {
  private lifecycle: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private session: string | null = null;
  private sessionCounter = 0;
  private stopGeneration = 0;
  private attemptOriginUs = 0;
  private isDisposed = false;
  private isDisposing = false;
  private isRunning = false;
  private phase: 'idle' | 'starting' | 'stopping' = 'idle';
  private wantsFrameDetail = false;
  private capabilityKey: string | null = null;
  private disconnectOverlay: (() => void) | undefined;
  private readonly hub: EventHub;
  private readonly scheduler: FrameScheduler;
  private readonly transitions = new ViewportTransitions();
  private readonly losses = new LossContextTracker();
  private readonly presentation: PresentationPolicy;
  private readonly sessionConfig = new SessionConfigState();
  private readonly clock: () => number;
  private readonly policy: { maxPredictionMs: number; lossDisplayGraceMs: number };
  private readonly config: EngineCoreConfig;

  constructor(config: EngineCoreConfig) {
    const maxPredictionMs = config.maxPredictionMs ?? MAX_PREDICTION_MS;
    if (!config.source || !config.pipeline || !config.overlay)
      throw invalid('Provide a frame source, a vision pipeline and an overlay');
    if (
      !Number.isFinite(maxPredictionMs) ||
      maxPredictionMs < 0 ||
      maxPredictionMs > MAX_PREDICTION_MS
    )
      throw invalid('maxPredictionMs must be in [0,100] ms');
    // Only an absent value means the default; null is invalid like any other non-number.
    const grace = config.lossDisplayGraceMs === undefined ? 0 : config.lossDisplayGraceMs;
    if (
      typeof grace !== 'number' ||
      !Number.isFinite(grace) ||
      grace < 0 ||
      grace > MAX_LOSS_DISPLAY_GRACE_MS
    )
      throw invalid(`lossDisplayGraceMs must be in [0,${MAX_LOSS_DISPLAY_GRACE_MS}] ms`);
    this.config = config;
    this.policy = { maxPredictionMs, lossDisplayGraceMs: grace };
    this.clock = config.nowUs ?? (() => performance.now() * 1000);
    const sessionNow = (): string | null => this.session;
    const runningNow = (): boolean => this.isRunning;
    this.hub = new EventHub({
      clock: this.clock,
      state: {
        get sessionId() {
          return sessionNow();
        },
        get isRunning() {
          return runningNow();
        },
        sourceNowUs: () => config.source.nowSessionUs?.() ?? null,
      },
      ...(config.telemetry ? { telemetry: config.telemetry } : {}),
      ...(config.onListenerError ? { onListenerError: config.onListenerError } : {}),
    });
    this.scheduler = new FrameScheduler(() =>
      this.emit('error', {
        ...this.context(),
        error: new EngineError('RESOURCE_FAILED', 'Frame owner failed to release its resource', {
          isRecoverable: true,
        }),
      }),
    );
    const isAborted = (): boolean => this.controller?.signal.aborted ?? false;
    const stopGeneration = (): number => this.stopGeneration;
    const transitionEpoch = (): number => this.transitions.epoch;
    this.presentation = new PresentationPolicy(
      {
        overlay: config.overlay,
        clock: this.clock,
        losses: this.losses,
        get sessionId() {
          return sessionNow();
        },
        get isRunning() {
          return runningNow();
        },
        get isAborted() {
          return isAborted();
        },
        get stopGeneration() {
          return stopGeneration();
        },
        get transitionEpoch() {
          return transitionEpoch();
        },
        sourceNowUs: () => config.source.nowSessionUs?.() ?? null,
        context: (targetId) => this.context(targetId ?? null),
        emit: (name, event) => this.emit(name, event),
      },
      this.policy,
      config.presentationModes,
    );
    this.disconnectOverlay = config.overlay.onEvent?.((event) => {
      if (event.sessionId !== this.session || this.isDisposed) return;
      const context = this.context(event.targetId);
      if (event.type === 'playbackBlocked') this.emit('playbackBlocked', context);
      else if (event.type === 'error') this.emit('error', { ...context, error: event.error });
      else this.emit('mediaState', { ...context, state: event.state, media: event.media });
    });
  }

  get state(): EngineState {
    if (this.isDisposed || this.isDisposing) return 'disposed';
    if (this.isRunning) return 'running';
    return this.phase;
  }

  get sessionId(): string | null {
    return this.session;
  }

  on<K extends keyof EngineEvents>(
    name: K,
    listener: (event: EngineEvents[K]) => void,
  ): () => void {
    this.assertUsable();
    return this.hub.on(name, listener);
  }

  emit<K extends keyof EngineEvents>(name: K, event: EngineEvents[K]): void {
    this.hub.emit(name, event);
  }

  context(targetId: string | null = this.presentation.activeTarget): EventContext {
    return this.hub.context(targetId);
  }

  private assertUsable(): void {
    if (this.isDisposed || this.isDisposing)
      throw new EngineError('DISPOSED', 'Engine disposed', { isRecoverable: false });
  }

  /** Called when camera or capability facts change (never per frame). */
  refreshSessionConfig(): void {
    if (this.session && !this.isDisposed)
      this.emit('sessionConfigUpdated', { ...this.context(), config: this.snapshot() });
  }

  /** Called when the capability changes after the session became ready. */
  refreshCapability(): void {
    if (!this.session || !this.isRunning || this.isDisposed || !this.config.capability) return;
    this.announceCapability(false);
  }

  /** Emits the capability; after the first one of a session, only when it changed. */
  private announceCapability(isFirst: boolean): void {
    const capability = this.config.capability!();
    const key = JSON.stringify(capability);
    if (!isFirst && key === this.capabilityKey) return;
    this.capabilityKey = key;
    this.emit('capabilityChanged', { ...this.context(), capability });
  }

  private snapshot(): ReturnType<SessionConfigState['snapshot']> {
    let facts: SessionFacts = {};
    try {
      facts = this.config.sessionFacts?.() ?? {};
    } catch {
      // Unknown facts stay null.
    }
    return this.sessionConfig.snapshot(this.policy, facts);
  }

  private async startupStage(stage: StartupStage, action: () => Promise<void>): Promise<void> {
    const started = this.clock();
    let status: 'completed' | 'failed' | 'cancelled' = 'completed';
    try {
      await action();
      if (this.controller?.signal.aborted) status = 'cancelled';
    } catch (error) {
      status = this.controller?.signal.aborted ? 'cancelled' : 'failed';
      throw error;
    } finally {
      this.emit('stageTiming', {
        ...this.context(),
        stage,
        status,
        durationUs: Math.max(0, this.clock() - started),
        attemptTimeUs: Math.max(0, this.clock() - this.attemptOriginUs),
      });
    }
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(action);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  /** Replaces the loaded targets (1..10 unique, valid bundles); only while stopped. */
  setTargets(targets: readonly TargetBundle[]): Promise<void> {
    this.assertUsable();
    if (
      targets.length < 1 ||
      targets.length > MAX_TARGETS ||
      new Set(targets.map((t) => t.targetId)).size !== targets.length
    )
      throw new EngineError('INVALID_TARGET', 'Require 1..10 unique targets', {
        isRecoverable: false,
      });
    targets.forEach(validateTargetBundle);
    return this.enqueue(async () => {
      this.assertUsable();
      if (this.isRunning) throw invalid('Stop before replacing targets', true);
      await this.config.pipeline.loadTargets(targets);
      this.sessionConfig.setTargets(targets);
      this.config.overlay.setTargets?.(
        targets.map((t) => ({ targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx })),
      );
    });
  }

  /** Sets or clears one target's media; while running, the active media is released. */
  setTargetMedia(targetId: string, media: TargetMedia | null): void {
    this.assertUsable();
    if (!targetId) throw invalid('Target required');
    if (media === null) {
      this.config.overlay.clearTargetMedia?.(targetId);
      this.sessionConfig.setMedia(targetId, null);
      return;
    }
    const { url, file, ...options } = media as { url?: string; file?: Blob } & Omit<
      TargetMedia,
      'url' | 'file'
    >;
    const source = file !== undefined ? file : url;
    if (
      !(typeof source === 'string' ? source : source instanceof Blob) ||
      (options.fit !== undefined && options.fit !== 'contain' && options.fit !== 'cover')
    )
      throw invalid('Invalid media configuration');
    this.config.overlay.setTargetMedia?.(targetId, source as string | Blob, options);
    this.sessionConfig.setMedia(targetId, source as string | Blob, options.fit ?? 'contain');
  }

  start(container: HTMLElement): Promise<void> {
    this.assertUsable();
    const generation = this.stopGeneration;
    return this.enqueue(async () => {
      this.assertUsable();
      if (this.isRunning || generation !== this.stopGeneration) return;
      this.phase = 'starting';
      try {
        await this.run(container);
      } finally {
        if (this.phase === 'starting') this.phase = 'idle';
      }
    });
  }

  private async run(container: HTMLElement): Promise<void> {
    this.session = `${this.config.sessionIdPrefix ?? ''}session-${++this.sessionCounter}`;
    this.scheduler.reset();
    this.losses.reset();
    this.attemptOriginUs = this.hub.beginAttempt();
    const session = this.session;
    const controller = new AbortController();
    this.controller = controller;
    this.emit('attemptStart', this.context());
    this.wantsFrameDetail = this.config.telemetry?.wantsFrameDetail === true;
    const cancelled = async (): Promise<boolean> => {
      if (!controller.signal.aborted) return false;
      await this.cleanup('start-cancelled');
      return true;
    };
    try {
      await this.sessionConfig.settleMedia();
      this.emit('sessionConfig', { ...this.context(), config: this.snapshot() });
      if (await cancelled()) return;
      await this.startupStage('pipeline-init', () => this.config.pipeline.reset(session));
      if (await cancelled()) return;
      await this.startupStage('renderer-init', () => this.config.overlay.start(container, session));
      if (await cancelled()) return;
      this.transitions.subscribe(null);
      this.transitions.subscribe(
        this.config.source.onViewportTransition?.((event) =>
          this.onTransition(event, controller, session),
        ) ?? null,
      );
      await this.startupStage('camera-init', () =>
        this.config.source.start(session, (frame) => this.accept(frame), controller.signal),
      );
      if (await cancelled()) return;
      this.isRunning = true;
      if (this.config.capability) this.announceCapability(true);
      if (await cancelled()) return;
      this.refreshSessionConfig();
      if (await cancelled()) return;
      this.emit('ready', this.context());
    } catch (cause) {
      const error = new EngineError(
        cause instanceof EngineError ? cause.code : 'START_FAILED',
        cause instanceof EngineError
          ? cause.message
          : 'Source, pipeline or renderer initialization failed',
        { isRecoverable: true, cause },
      );
      this.emit('sessionStartFailed', {
        ...this.context(),
        code: error.code,
        attemptTimeUs: Math.max(0, this.clock() - this.attemptOriginUs),
      });
      this.emit('error', { ...this.context(), error });
      await this.cleanup('start-failed');
      throw error;
    }
  }

  stop(reason = 'stopped'): Promise<void> {
    ++this.stopGeneration;
    this.controller?.abort();
    this.presentation.hideNow();
    return this.enqueue(() => this.cleanup(reason));
  }

  dispose(): Promise<void> {
    if (this.isDisposed || this.isDisposing) return this.lifecycle;
    this.isDisposing = true;
    ++this.stopGeneration;
    this.controller?.abort();
    this.presentation.hideNow();
    return this.enqueue(async () => {
      await this.cleanup('disposed');
      const config = this.config;
      const outcomes = await Promise.allSettled(
        [
          () => config.source.dispose(),
          () => config.pipeline.dispose(),
          () => config.overlay.dispose(),
        ].map((dispose) => Promise.resolve().then(dispose)),
      );
      this.isDisposed = true;
      let hasDisconnectFailed = false;
      try {
        this.disconnectOverlay?.();
      } catch {
        hasDisconnectFailed = true;
      }
      this.disconnectOverlay = undefined;
      this.hub.clear();
      if (outcomes.some((x) => x.status === 'rejected') || hasDisconnectFailed)
        throw new EngineError('RESOURCE_FAILED', 'One or more parts failed during disposal', {
          isRecoverable: true,
        });
    });
  }

  private record(frame: Frame): MutableFrameRecord | null {
    return this.wantsFrameDetail ? frameRecord(frame) : null;
  }

  private drop(frame: Frame, reason: DropReason): void {
    const record = this.record(frame);
    if (record) record.dropReason = reason;
    reportFrame(this.config.telemetry, record);
    this.scheduler.release(frame);
  }

  private onTransition(
    event: ViewportTransition,
    controller: AbortController,
    session: string,
  ): void {
    if (
      controller !== this.controller ||
      session !== this.session ||
      controller.signal.aborted ||
      this.isDisposed
    )
      return;
    const transitions = this.transitions;
    transitions.epoch++;
    if (event.phase === 'begin') {
      transitions.isGated = true;
      transitions.ready = null;
      const pending = this.scheduler.take();
      if (pending) this.drop(pending, 'viewport-transition');
      if (this.isRunning) this.presentation.lose('viewport-transition');
      else this.presentation.hideNow();
      return;
    }
    transitions.isGated = false;
    if (!this.isRunning) return;
    const epoch = transitions.epoch;
    const processing = this.scheduler.processing;
    const precedingReset = transitions.work;
    // The old frame (if any) finishes in the same Worker; only then is stale tracker state cleared, without abort.
    const ready = (async () => {
      await Promise.all([processing, precedingReset]);
      if (epoch !== transitions.epoch || controller.signal.aborted || !this.isRunning) return;
      await this.config.pipeline.reset(session);
    })().catch(() => {
      if (controller.signal.aborted || epoch !== transitions.epoch) return;
      transitions.isGated = true;
      const pending = this.scheduler.take();
      if (pending) this.scheduler.release(pending);
      this.presentation.hideNow();
      this.emit('error', {
        ...this.context(),
        error: new EngineError(
          'RESOURCE_FAILED',
          'Pipeline reset after viewport transition failed',
          {
            isRecoverable: true,
          },
        ),
      });
    });
    transitions.ready = ready;
    transitions.work = ready;
    void ready.then(() => {
      if (transitions.ready !== ready) return;
      transitions.ready = null;
      if (
        this.scheduler.pending &&
        !this.scheduler.processing &&
        this.isRunning &&
        !transitions.isGated
      )
        this.startDrain();
    });
  }

  private startDrain(): void {
    this.scheduler.processing = this.drain().finally(() => {
      this.scheduler.processing = null;
    });
  }

  private accept(frame: Frame): void {
    if (this.transitions.isGated) {
      this.drop(frame, 'viewport-transition');
      return;
    }
    if (
      !this.isRunning ||
      frame.sessionId !== this.session ||
      this.controller?.signal.aborted ||
      !this.scheduler.isFresh(frame)
    ) {
      this.drop(frame, 'inactive-stale-or-duplicate');
      return;
    }
    const replaced = this.scheduler.offer(frame, this.clock());
    if (replaced) this.drop(replaced, 'candidate-replaced');
    if (!this.scheduler.processing && !this.transitions.ready) this.startDrain();
  }

  private async drain(): Promise<void> {
    const transitions = this.transitions;
    while (this.scheduler.pending && !transitions.isGated && !transitions.ready) {
      const frame = this.scheduler.take()!;
      const signal = this.controller!.signal;
      const frameEpoch = transitions.epoch;
      const record = this.record(frame);
      let sample: CapturedTargetFrame | null = null;
      try {
        if (record) {
          record.submitTimeUs = this.context().timestampUs;
          // Engine-clock time from accept() to hand-off; independent of camera clocks.
          const receiptUs = this.scheduler.receiptUs(frame);
          record.queueWaitDurationUs =
            receiptUs === undefined ? null : Math.max(0, this.clock() - receiptUs);
        }
        const result = await this.config.pipeline.process(frame, signal);
        if (record) {
          record.resultAvailableTimeUs = this.context().timestampUs;
          record.targetId = result.targetId;
        }
        if (frameEpoch !== transitions.epoch) {
          if (record) record.dropReason = 'viewport-transition';
        } else if (
          !signal.aborted &&
          this.isRunning &&
          result.sessionId === this.session &&
          result.frameId === frame.frameId
        ) {
          sample = captureTargetFrame(frame, result);
          await this.presentation.present(
            result,
            frame.geometry,
            this.scheduler.receiptUs(frame)!,
            sample,
            () => {
              if (record) record.renderSubmitTimeUs = this.context().timestampUs;
            },
          );
          if (frameEpoch !== transitions.epoch && !signal.aborted) {
            this.presentation.hideNow();
            if (this.presentation.activeTarget) this.presentation.lose('viewport-transition');
          }
          if (
            frameEpoch === transitions.epoch &&
            !signal.aborted &&
            this.session === sample.sessionId
          )
            this.losses.processed(sample);
        } else if (record) record.dropReason = 'cancelled-or-stale-result';
      } catch (cause) {
        if (frameEpoch !== transitions.epoch) {
          if (record) record.dropReason = 'viewport-transition';
        } else if (!signal.aborted) {
          this.presentation.lose('frame-failed', sample);
          const isSafe =
            cause instanceof EngineError &&
            (WORKER_SAFE_REASONS as readonly string[]).includes(cause.message);
          this.emit('error', {
            ...this.context(),
            error: new EngineError(
              cause instanceof EngineError ? cause.code : 'FRAME_FAILED',
              isSafe ? cause.message : 'Frame processing or presentation failed',
              { isRecoverable: true },
            ),
          });
        }
      } finally {
        this.scheduler.release(frame);
        reportFrame(this.config.telemetry, record);
      }
    }
  }

  private async cleanup(reason: string): Promise<void> {
    const errors: unknown[] = [];
    this.phase = 'stopping';
    try {
      try {
        this.transitions.close();
      } catch (error) {
        errors.push(error);
      }
      this.isRunning = false;
      this.controller?.abort();
      this.presentation.hideNow();
      const pending = this.scheduler.take();
      if (pending) this.drop(pending, 'stopped-before-processing');
      try {
        await this.config.source.stop();
      } catch (error) {
        errors.push(error);
      }
      await this.scheduler.processing;
      await this.transitions.work;
      try {
        this.presentation.lose(reason);
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.config.overlay.stop();
      } catch (error) {
        errors.push(error);
      }
      const endedContext = this.context();
      this.session = null;
      this.controller = null;
      this.losses.reset();
      if (endedContext.sessionId) this.emit('sessionEnded', { ...endedContext, reason });
      for (const _ of errors)
        this.emit('error', {
          ...this.context(),
          error: new EngineError('RESOURCE_FAILED', 'A part failed during stop cleanup', {
            isRecoverable: true,
          }),
        });
    } finally {
      this.phase = 'idle';
    }
  }

  getEventContext(): EventContext {
    return this.context();
  }
}
