/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/recognition-diagnostics. Only re-exports belong here.
export {
  createRecognitionDiagnostics,
  DIAGNOSTICS_SCHEMA,
  type DiagnosticsSnapshot,
  type DiagnosticsTarget,
  type PassRejections,
  type PassStats,
  type RecognitionDiagnostics,
  type RecognitionDiagnosticsOptions,
  type RejectionStage,
  type RunningStat,
  type SessionDiagnostics,
  type TargetDiagnostics,
} from './recognition-diagnostics.ts';
