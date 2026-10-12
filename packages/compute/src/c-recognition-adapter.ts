/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { EngineError } from '@livemira/contracts';
import { ALGORITHM, extractFeatures } from '../../recognition/experimental/features.mjs';
import { CpuRecognizer } from '../../recognition/src/index.ts';
import type { CpuOperators } from './cpu-backend.ts';

/** Delegates to the recognizer on the original canonical gray pixels; the backend's Gaussian pyramid is not reused. */
export function createCRecognitionOperators(): CpuOperators {
  return {
    algorithmVersion: ALGORITHM,
    detectFeatures(image, signal) {
      signal?.throwIfAborted();
      return extractFeatures(image, { maxFeatures: 512, levels: 3 }).features.map(p => [p.x, p.y] as const);
    },
    async describeAndMatch(image, target, identity, signal) {
      const recognizer = new CpuRecognizer();
      try {
        signal?.throwIfAborted();
        await recognizer.loadTargets([target]);
        const batch = await recognizer.recognizeGray(image, identity, { signal });
        if (!batch.observations.length) throw new EngineError('FRAME_FAILED', true, batch.rejected.map(r => r.reason).join(',') || 'No recognition candidate');
        return batch.observations[0];
      } finally { recognizer.dispose(); }
    },
  };
}
