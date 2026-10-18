/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Typed engine events: listener isolation, the diagnostic observer, and the event clock. Event times use the camera
// session clock once the camera reports it, otherwise the engine session clock, and before a session runs the clock
// of the start attempt.

import type { EventContext } from '@livemira/contracts';
import type { TelemetrySink } from '@livemira/diagnostics';

import type { EngineEvents } from './engine-types.ts';

type Listener = (event: never) => void;

export interface ClockState {
  readonly sessionId: string | null;
  readonly isRunning: boolean;
  /** The source's session clock now, or null before it exists. */
  sourceNowUs(): number | null;
}

export class EventHub {
  private readonly listeners = new Map<keyof EngineEvents, Set<Listener>>();
  private sessionOriginUs = 0;
  private hasSourceClock = false;
  private readonly clock: () => number;
  private readonly state: ClockState;
  private readonly telemetry: TelemetrySink | undefined;
  private readonly onListenerError: ((error: unknown) => void) | undefined;

  constructor(options: {
    clock: () => number;
    state: ClockState;
    telemetry?: TelemetrySink;
    onListenerError?: (error: unknown) => void;
  }) {
    this.clock = options.clock;
    this.state = options.state;
    this.telemetry = options.telemetry;
    this.onListenerError = options.onListenerError;
  }

  on<K extends keyof EngineEvents>(
    name: K,
    listener: (event: EngineEvents[K]) => void,
  ): () => void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(listener as Listener);
    this.listeners.set(name, set);
    return () => void set.delete(listener as Listener);
  }

  emit<K extends keyof EngineEvents>(name: K, event: EngineEvents[K]): void {
    try {
      this.telemetry?.event?.(name, event);
    } catch {
      // The diagnostic observer cannot interrupt the engine.
    }
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        (listener as (event: EngineEvents[K]) => void)(event);
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
          // Listener failures cannot interrupt resource cleanup.
        }
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  /** A new attempt: the engine session clock starts now and the source clock is not yet known. */
  beginAttempt(): number {
    this.sessionOriginUs = this.clock();
    this.hasSourceClock = false;
    return this.sessionOriginUs;
  }

  context(targetId: string | null): EventContext {
    const now = this.clock();
    const sourceNow = this.state.sourceNowUs();
    if (sourceNow != null) {
      this.sessionOriginUs = now - sourceNow;
      this.hasSourceClock = true;
    }
    return {
      sessionId: this.state.sessionId,
      targetId,
      timestampUs: sourceNow ?? Math.max(0, now - this.sessionOriginUs),
      timestampDomain: this.hasSourceClock
        ? 'source-session'
        : this.state.isRunning
          ? 'engine-session'
          : 'attempt',
    };
  }
}
