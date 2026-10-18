/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError } from '@livemira/contracts';

export interface FrameClockReading {
  readonly sourceTimestampUs: number;
  readonly arrivalTimeUs: number;
  /** Source time mapped onto the session clock with the offset of the first frame. */
  readonly observationTimeUs: number;
  readonly sourceToSessionOffsetUs: number;
}

/**
 * Session clock of one camera run (0 at creation) and the mapping of source timestamps onto it. The mapping is aligned
 * to arrival and therefore approximate; the sensor exposure time cannot be recovered.
 */
export class FrameClock {
  private readonly nowUs: () => number;
  private readonly originUs: number;
  private lastSourceUs = -Infinity;
  private offsetUs: number | null = null;

  constructor(nowUs: () => number = () => performance.now() * 1000) {
    this.nowUs = nowUs;
    this.originUs = nowUs();
  }

  /** Session time now. */
  arrival(): number {
    return Math.max(0, this.nowUs() - this.originUs);
  }

  /**
   * Maps one source timestamp. Returns null for a repeated timestamp (the same picture again); throws
   * `CAMERA_CLOCK_RESET` when the source clock goes backwards.
   */
  observe(
    sourceTimestampUs: number,
    arrivalTimeUs: number = this.arrival(),
  ): FrameClockReading | null {
    if (!Number.isFinite(sourceTimestampUs) || !Number.isFinite(arrivalTimeUs)) {
      throw new EngineError('CAMERA_CAPTURE_FAILED', 'Finite timestamps required', {
        isRecoverable: true,
      });
    }
    if (sourceTimestampUs === this.lastSourceUs) return null;
    if (sourceTimestampUs < this.lastSourceUs) {
      throw new EngineError('CAMERA_CLOCK_RESET', 'SOURCE_CLOCK_RESET', { isRecoverable: true });
    }
    this.lastSourceUs = sourceTimestampUs;
    this.offsetUs ??= arrivalTimeUs - sourceTimestampUs;
    return {
      sourceTimestampUs,
      arrivalTimeUs,
      observationTimeUs: sourceTimestampUs + this.offsetUs,
      sourceToSessionOffsetUs: this.offsetUs,
    };
  }

  /** Maps a different source clock from now on (callback timestamps after a frozen media time); session time goes on. */
  restartSource(): void {
    this.lastSourceUs = -Infinity;
    this.offsetUs = null;
  }
}
