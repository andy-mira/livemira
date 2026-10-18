/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-frame scheduling records for the full diagnostic level. At the key level no record object is built.

import type { Frame } from '@livemira/contracts';
import type { FrameRecord, TelemetrySink } from '@livemira/diagnostics';

export type MutableFrameRecord = { -readonly [K in keyof FrameRecord]: FrameRecord[K] };

export function frameRecord(frame: Frame): MutableFrameRecord {
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    targetId: null,
    pictureKey: frame.pictureKey ?? null,
    arrivalTimeUs: frame.timing.arrivalTimeUs,
    submitTimeUs: null,
    resultAvailableTimeUs: null,
    renderSubmitTimeUs: null,
    queueWaitDurationUs: null,
    dropReason: null,
  };
}

/** Reports a record; the diagnostic observer can never interrupt the engine. */
export function reportFrame(
  sink: TelemetrySink | undefined,
  record: MutableFrameRecord | null,
): void {
  if (!record) return;
  try {
    sink?.frame?.({ ...record });
  } catch {
    // Diagnostics cannot interrupt cleanup.
  }
}
