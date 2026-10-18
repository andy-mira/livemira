/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs every regression fixture through the packages and digests the outputs. A short readable summary is kept next
// to each digest so a changed snapshot shows what moved.

import { createWasmMatchOperator, rgbaToGray, selectWasmExactMatcher } from '@livemira/compute';
import { createGeometry, type GeometryParams } from '@livemira/camera';
import type { TargetBundle } from '@livemira/contracts';
import { Recognizer, type ExactMatcher } from '@livemira/recognition';
import { compileGrayTarget, parseTarget, serializeTarget } from '@livemira/target-compiler';
import { Tracker } from '@livemira/tracking';

import {
  RGBA_CASES,
  GEOMETRY_CASES,
  SCENES,
  SEQUENCES,
  TARGETS,
  UNLOADED,
} from '../fixtures/scenarios.ts';
import { digest } from './encode.ts';

export interface Entry {
  readonly sha256: string;
  readonly summary: string;
}

const MATCHERS = ['js', 'wasm-scalar', 'wasm-simd'] as const;
type Matcher = (typeof MATCHERS)[number];

async function matcher(kind: Matcher): Promise<ExactMatcher | undefined> {
  if (kind === 'js') return undefined;
  const wanted = kind === 'wasm-simd' ? 'simd' : 'scalar';
  const selected = await selectWasmExactMatcher({ variants: [wanted] });
  if (!selected.matcher || selected.variant !== wanted)
    throw new Error(`WebAssembly ${wanted} matcher unavailable`);
  return createWasmMatchOperator(selected.matcher, {
    onFailure: () => {
      throw new Error('WebAssembly matcher failed');
    },
  });
}

/** Digests of the fixture inputs themselves, so a changed generator is told apart from a changed output. */
export function fixtureDigests(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(TARGETS).map(([id, image]) => [`target/${id}`, digest(image)]),
    ),
    'target/unloaded': digest(UNLOADED),
    ...Object.fromEntries(RGBA_CASES.map((c) => [`rgba/${c.id}`, digest(c.rgba)])),
    ...Object.fromEntries(SCENES.map((s) => [`scene/${s.id}`, digest(s.image)])),
    ...Object.fromEntries(
      Object.entries(SEQUENCES).map(([id, steps]) => [`sequence/${id}`, digest(steps)]),
    ),
  };
}

async function compiledTargets(out: Record<string, Entry>): Promise<TargetBundle[]> {
  const bundles: TargetBundle[] = [];
  for (const [id, image] of Object.entries(TARGETS)) {
    const serialized = await serializeTarget(await compileGrayTarget(image, { targetId: id }));
    const bundle = await parseTarget(serialized);
    out[`compile/${id}`] = {
      sha256: digest({ serialized, bundle }),
      summary: `${bundle.features.points.length} features`,
    };
    bundles.push(bundle);
  }
  return bundles;
}

async function recognition(
  bundles: readonly TargetBundle[],
  out: Record<string, Entry>,
): Promise<void> {
  for (const kind of MATCHERS) {
    const operator = await matcher(kind);
    const recognizer = new Recognizer(operator ? { exactMatcher: operator } : {});
    await recognizer.loadTargets(bundles);
    try {
      for (const [frameId, scene] of SCENES.entries()) {
        const batch = await recognizer.recognize(scene.image, { sessionId: 'regression', frameId });
        const found = batch.observations.map((o) => o.targetId).join('+') || 'none';
        out[`recognition/${kind}/${scene.id}`] = {
          sha256: digest(batch),
          summary: `${found}; ${batch.rejected.length} rejected; ${batch.facts.scalePasses} pass(es)`,
        };
      }
    } finally {
      recognizer.dispose();
    }
  }
}

async function tracking(
  bundles: readonly TargetBundle[],
  out: Record<string, Entry>,
): Promise<void> {
  for (const [id, steps] of Object.entries(SEQUENCES)) {
    const recognizer = new Recognizer({ exactMatcher: (await matcher('wasm-simd'))! });
    await recognizer.loadTargets(bundles);
    const tracker = new Tracker({
      recognize: async (frame, _targets, signal) =>
        (await recognizer.recognize(frame.image, frame, { signal })).observations,
      collectMatchedPoints: true,
    });
    await tracker.loadTargets(bundles);
    await tracker.reset('s1');
    const results: unknown[] = [];
    const states: string[] = [];
    let timeUs = 1_000_000;
    try {
      for (const [frameId, step] of steps.entries()) {
        timeUs += step.afterMs * 1000;
        const result = await tracker.process(
          {
            sessionId: 's1',
            frameId,
            pictureKey: `s1:${frameId}`,
            observationTimeUs: timeUs,
            image: step.image,
          },
          new AbortController().signal,
        );
        results.push(result);
        states.push(`${result.state}${result.targetId === null ? '' : `:${result.targetId}`}`);
      }
    } finally {
      await tracker.dispose();
      recognizer.dispose();
    }
    out[`tracking/${id}`] = { sha256: digest(results), summary: states.join(' ') };
  }
}

export async function regressionOutputs(): Promise<Record<string, Entry>> {
  const out: Record<string, Entry> = {};
  for (const c of RGBA_CASES) {
    const gray = rgbaToGray(c.rgba, c.widthPx, c.heightPx, c.strideBytes);
    out[`gray/${c.id}`] = { sha256: digest(gray), summary: `${gray.widthPx}x${gray.heightPx}` };
  }
  for (const c of GEOMETRY_CASES) {
    const geometry = createGeometry(c.params as unknown as GeometryParams);
    out[`geometry/${c.id}`] = {
      sha256: digest(geometry),
      summary: `standard ${geometry.standardWidthPx}x${geometry.standardHeightPx}`,
    };
  }
  const bundles = await compiledTargets(out);
  await recognition(bundles, out);
  await tracking(bundles, out);
  return out;
}
