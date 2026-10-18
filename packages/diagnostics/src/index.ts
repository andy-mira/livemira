/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/diagnostics. Only re-exports belong here.
export type {
  DiagnosticEventRecord,
  DiagnosticExport,
  DiagnosticLevel,
  DiagnosticTargetRecord,
  EngineIdentity,
  FrameRecord,
  MetadataValue,
  ResultRecord,
  TelemetrySink,
  WorkerTimingRecord,
} from './diagnostic-types.ts';
export { DEFAULT_CAPACITY, DiagnosticLog, type DiagnosticLogOptions } from './diagnostic-log.ts';
export { METADATA_KEYS, sanitizePresentation } from './sanitize.ts';
export { Ring } from './ring.ts';
