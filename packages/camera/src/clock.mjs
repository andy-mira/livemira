/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/** Arrival alignment is approximate; it cannot recover sensor exposure time. */
export class MediaClock {
  constructor(nowUs = () => performance.now() * 1000) {
    this.nowUs = nowUs;
    this.originUs = nowUs();
    this.lastSourceUs = -Infinity;
    this.offsetUs = null;
  }
  arrival() { return Math.max(0, this.nowUs() - this.originUs); }
  observe(sourceTimestampUs, arrivalTimeUs = this.arrival()) {
    if (!Number.isFinite(sourceTimestampUs) || !Number.isFinite(arrivalTimeUs)) throw new TypeError('Finite timestamps required');
    if (sourceTimestampUs === this.lastSourceUs) return null;
    if (sourceTimestampUs < this.lastSourceUs) throw new Error('SOURCE_CLOCK_RESET');
    this.lastSourceUs = sourceTimestampUs;
    this.offsetUs ??= arrivalTimeUs - sourceTimestampUs;
    return {
      sourceTimestampUs, arrivalTimeUs, captureTimeUs: null, captureTimeUncertaintyUs: null,
      mappedObservationTimeUs: sourceTimestampUs + this.offsetUs, clockMappingUncertaintyUs: null,
      clockMapping: { sourceToSessionOffsetUs: this.offsetUs, approximate: true, uncertaintyUs: null },
    };
  }
}
