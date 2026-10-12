/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { createHash } from 'node:crypto';
import { ALGORITHM, LIMITS, extractFeatures, hamming, validateGray } from '../../recognition/experimental/features.mjs';
import { hullArea } from '../../recognition/experimental/geometry.mjs';

export const SCHEMA = 'webar-m0-experiment/1';
export const COMPILER = 'gray8-cpu/0.1.0';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('INVALID_TARGET_BUNDLE'); };
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const hexHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function diagnose(features, width, height) {
  let repeated = 0;
  for (let i = 0; i < features.length; i++) if (features.some((f, j) => j !== i && hamming(f.descriptor, features[i].descriptor) <= 16)) repeated++;
  const coverage = hullArea(features.map(f => [f.x, f.y])) / ((width - 1) * (height - 1));
  const repeatedFraction = features.length ? repeated / features.length : 0, reasons = [];
  if (features.length < 24) reasons.push('LOW_TEXTURE');
  if (coverage < 0.15) reasons.push('LOW_COVERAGE');
  if (repeatedFraction > 0.35) reasons.push('REPETITIVE_TEXTURE');
  return { usable: reasons.length === 0, featureCount: features.length, coverage, repeatedFraction, reasons };
}

export function compileGray(image, { targetId, physicalWidthMeters = null, originalImageSha256 = null, maxFeatures = 384, levels = 3 } = {}) {
  validateGray(image);
  if (typeof targetId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) ||
      (physicalWidthMeters !== null && (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0)) ||
      (originalImageSha256 !== null && !hexHash(originalImageSha256))) fail();
  const extracted = extractFeatures(image, { maxFeatures, levels });
  return { schemaVersion: SCHEMA, compilerVersion: COMPILER, algorithmVersion: ALGORITHM, targetId,
    originalImageSha256, normalizedGraySha256: sha256(image.data), widthPx: image.width, heightPx: image.height,
    physicalWidthMeters, orientation: 'upright', descriptorBytes: 32,
    preprocessing: { pixelFormat: 'gray8', packed: true, levels, maxFeatures, downsample: 'box2-center', smoothing: 'box3', orientation: 'upright-only' },
    ...extracted, quality: diagnose(extracted.features, image.width, image.height) };
}

export function validateBundle(b) {
  if (!b || b.schemaVersion !== SCHEMA || b.compilerVersion !== COMPILER || b.algorithmVersion !== ALGORITHM ||
      typeof b.targetId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(b.targetId) ||
      !integer(b.widthPx, 32, LIMITS.dimension) || !integer(b.heightPx, 32, LIMITS.dimension) || b.widthPx * b.heightPx > LIMITS.pixels ||
      !hexHash(b.normalizedGraySha256) || (b.originalImageSha256 !== null && !hexHash(b.originalImageSha256)) ||
      (b.physicalWidthMeters !== null && (!Number.isFinite(b.physicalWidthMeters) || b.physicalWidthMeters <= 0)) ||
      b.orientation !== 'upright' || b.descriptorBytes !== 32 ||
      b.preprocessing?.pixelFormat !== 'gray8' || b.preprocessing?.packed !== true || b.preprocessing?.downsample !== 'box2-center' ||
      b.preprocessing?.smoothing !== 'box3' || b.preprocessing?.orientation !== 'upright-only' ||
      !integer(b.preprocessing?.levels, 1, LIMITS.levels) || !integer(b.preprocessing?.maxFeatures, 16, LIMITS.features) ||
      !Array.isArray(b.features) || b.features.length > b.preprocessing.maxFeatures || !Array.isArray(b.pyramid)) fail();
  let width = b.widthPx, height = b.heightPx, count = 0;
  while (count < b.preprocessing.levels && Math.min(width, height) >= 32) {
    const layer = b.pyramid[count];
    if (!layer || layer.width !== width || layer.height !== height || layer.scale !== 2 ** count) fail();
    count++; width = Math.floor(width / 2); height = Math.floor(height / 2);
  }
  if (b.pyramid.length !== count) fail();
  for (const f of b.features) if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y) || f.x < 0 || f.y < 0 ||
      f.x >= b.widthPx || f.y >= b.heightPx || !Number.isFinite(f.score) || f.score <= 0 || !integer(f.level, 0, count - 1) ||
      !Array.isArray(f.descriptor) || f.descriptor.length !== 32 || !f.descriptor.every(v => integer(v, 0, 255))) fail();
  const quality = diagnose(b.features, b.widthPx, b.heightPx);
  if (!b.quality || ['usable', 'featureCount', 'coverage', 'repeatedFraction'].some(k => b.quality[k] !== quality[k]) ||
      JSON.stringify(b.quality.reasons) !== JSON.stringify(quality.reasons)) fail();
  return b;
}

// Integrity covers the exact UTF-8 payload bytes, avoiding canonical JSON ambiguity.
// It detects corruption; it is not a signature or a trust/authentication mechanism.
export function serializeBundle(bundle) {
  validateBundle(bundle);
  const payload = JSON.stringify(bundle), serialized = JSON.stringify({ sha256: sha256(payload), payload });
  if (Buffer.byteLength(serialized, 'utf8') > LIMITS.bundleBytes) throw new Error('BUNDLE_TOO_LARGE');
  return serialized;
}
export function parseBundle(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > LIMITS.bundleBytes) throw new Error('BUNDLE_TOO_LARGE_OR_INVALID');
  const envelope = JSON.parse(serialized);
  if (!envelope || !hexHash(envelope.sha256) || typeof envelope.payload !== 'string' || sha256(envelope.payload) !== envelope.sha256) throw new Error('BUNDLE_INTEGRITY');
  return validateBundle(JSON.parse(envelope.payload));
}
