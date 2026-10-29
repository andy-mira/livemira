// SPDX-License-Identifier: Apache-2.0

export type Layer = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';

/** Technical route of a candidate: light deterministic, hardware-heavy, or frontier model. */
export type Route = 'light' | 'hardware' | 'frontier';

/** How tests compare a module's output: bit-exact replay, tolerance, or statistics only. */
export type Determinism = 'bit-exact' | 'tolerance' | 'none';

/** Platform capabilities a module may require; probed at runtime, never inferred from the user agent. */
export type Capability =
  | 'mstp-window'
  | 'mstp-worker'
  | 'videoframe'
  | 'videoframe-copyto'
  | 'rvfc'
  | 'rvfc-capture-time'
  | 'offscreen-2d'
  | 'offscreen-webgl2'
  | 'webgl2'
  | 'webgpu'
  | 'webgpu-subgroups'
  | 'wasm-simd'
  | 'wasm-threads'
  | 'cross-origin-isolated'
  | 'generic-sensor'
  | 'device-motion'
  | 'image-capture-constraints'
  | 'dom';

export interface ModuleInfo {
  /** Candidate id and variant, e.g. 'D2.esm-sl3'. */
  readonly id: string;
  readonly layer: Layer;
  readonly route: Route;
  readonly determinism: Determinism;
  readonly requires: readonly Capability[];
}

export interface ProbeResult {
  readonly isAvailable: boolean;
  /** Why the module cannot run here, when unavailable. */
  readonly reason?: string;
}

/** Numeric observer; modules report stage times and counters, never pixels. */
export interface TelemetrySink {
  stage?(name: string, durationUs: number): void;
  counter?(name: string, delta: number): void;
}

export interface ModuleContext {
  readonly nowUs: () => number;
  /** Seeded generator per named stream; identical seeds give identical sequences. */
  readonly rng: (stream: string) => () => number;
  readonly telemetry: TelemetrySink;
  readonly params: Readonly<Record<string, number | string | boolean>>;
}

export interface Module {
  readonly info: ModuleInfo;
  probe(capabilities: ReadonlySet<Capability>): ProbeResult;
}

export function probeRequirements(info: ModuleInfo, capabilities: ReadonlySet<Capability>): ProbeResult {
  const missing = info.requires.filter((c) => !capabilities.has(c));
  return missing.length ? { isAvailable: false, reason: `missing ${missing.join(', ')}` } : { isAvailable: true };
}
