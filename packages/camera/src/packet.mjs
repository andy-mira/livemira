/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * The canonical packet definition is owned by A. Extra clock/geometry diagnostics
 * stay in the sample and are not silently promoted to a second public contract.
 * @param {import('@livemira/contracts').FramePacket} sample
 * @returns {import('@livemira/contracts').FramePacket}
 */
export function createFramePacket(sample) {
  const { sessionId, frameId, sourceTimestampUs, timestampSource, captureTimeUs,
    captureTimeUncertaintyUs, arrivalTimeUs, width, height, pixelFormat, rotation,
    mirrored, calibrationId, imageHandle, mappedObservationTimeUs, clockMappingUncertaintyUs, imageIdentity } = sample;
  return { sessionId, frameId, sourceTimestampUs, timestampSource, captureTimeUs,
    captureTimeUncertaintyUs, arrivalTimeUs, width, height, pixelFormat, rotation,
    mirrored, calibrationId, imageHandle, mappedObservationTimeUs, clockMappingUncertaintyUs, imageIdentity };
}

/** @returns {import('@livemira/contracts').FrameGeometry} */
export function toFrameGeometry(geometry) {
  return {
    H_standardFromInput: geometry.inputToCanonical,
    H_viewportFromStandard: geometry.canonicalToViewport,
    standardWidth: geometry.canonicalWidth, standardHeight: geometry.canonicalHeight,
    crop: geometry.crop, rotation: geometry.rotation, mirrored: geometry.mirrored,
    objectFit: geometry.fit, cssWidth: geometry.cssWidth, cssHeight: geometry.cssHeight,
    devicePixelRatio: geometry.dpr,
  };
}
