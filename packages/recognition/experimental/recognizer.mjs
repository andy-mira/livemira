/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { performance } from 'node:perf_hooks';
import { LIMITS, extractFeatures, matchFeatures } from './features.mjs';
import { verifyGeometry } from './geometry.mjs';
import { validateBundle } from '../../target-compiler/experimental/bundle.mjs';

export class ExperimentalRecognizer {
  #targets;
  constructor(bundles) {
    if (!Array.isArray(bundles) || bundles.length < 1 || bundles.length > LIMITS.targets) throw new Error('INVALID_TARGET_COUNT');
    if (new Set(bundles.map(b => b.targetId)).size !== bundles.length) throw new Error('DUPLICATE_TARGET_ID');
    this.#targets = bundles.map(b => structuredClone(validateBundle(b)));
  }
  recognize(image, { roi = null } = {}) {
    const start = performance.now();
    const { features } = extractFeatures(image, { maxFeatures: 512, levels: 3, roi });
    const featureMs = performance.now() - start, candidates = [], rejected = [];
    let matchMs = 0, geometryMs = 0;
    for (const target of this.#targets) {
      if (!target.quality.usable) { rejected.push({ targetId: target.targetId, reason: target.quality.reasons.join(',') }); continue; }
      const matchingStart = performance.now(), pairs = matchFeatures(target.features, features);
      matchMs += performance.now() - matchingStart;
      const geometryStart = performance.now(), result = verifyGeometry(pairs, target.widthPx, target.heightPx);
      geometryMs += performance.now() - geometryStart;
      (result.accepted ? candidates : rejected).push({ targetId: target.targetId, ...result });
    }
    candidates.sort((a, b) => b.inlierCount - a.inlierCount || a.rmsErrorPx - b.rmsErrorPx);
    const ambiguous = candidates.length > 1 && candidates[1].inlierCount >= candidates[0].inlierCount * 0.85;
    return { candidates, rejected, ambiguous, selectedTargetId: ambiguous ? null : candidates[0]?.targetId ?? null,
      timings: { featureMs, matchMs, geometryMs, totalMs: performance.now() - start }, featureCount: features.length };
  }
}
