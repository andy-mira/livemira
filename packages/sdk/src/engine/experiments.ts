/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Internal presentation switches are read when an engine is created and exposed in diagnostics.
// They do not form part of the public options API.

/** Optional page-level overrides, read before engine initialization. */
const GLOBAL_NAME = '__livemiraExperiments';

/** Default presentation behavior when no boolean override is supplied. */
export const EXPERIMENT_DEFAULTS = Object.freeze({
  /** After a loss, retain the overlay only while the target's last measured motion permits it. */
  motionAdaptiveHold: true,
  /** Require confirmation before showing a target whose overlay was hidden. */
  reconfirmAfterHide: true,
});

export type ExperimentName = keyof typeof EXPERIMENT_DEFAULTS;
export type EngineExperiments = Readonly<Record<ExperimentName, boolean>>;

/** Resolve immutable presentation switches from boolean page overrides and defaults. */
export function selectedExperiments(scope: object = globalThis): EngineExperiments {
  const value = (scope as Record<string, unknown>)[GLOBAL_NAME];
  const selected = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.freeze(
    Object.fromEntries(
      (Object.keys(EXPERIMENT_DEFAULTS) as ExperimentName[]).map((name) => [
        name,
        typeof selected[name] === 'boolean' ? selected[name] : EXPERIMENT_DEFAULTS[name],
      ]),
    ),
  ) as EngineExperiments;
}
