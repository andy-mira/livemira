// SPDX-License-Identifier: Apache-2.0
// Detector vs detector + ESM under S1 occlusion, per case: corner errors and ESM's quality figures.
//   node bench/src/diagnose-occlusion.ts [occlusion values]

import { cornersOf } from '@livemira-next/contracts';
import { OrbDetector } from '@livemira-next/features';
import { buildPyramid } from '@livemira-next/imaging';
import { esmAlign, TemplateTracker } from '@livemira-next/tracking';

import { cornerError, diagonal } from './metrics/sequence.ts';
import { CAMERA, renderSweep, sceneTarget } from './scene/suites.ts';
import { frameHandle } from './sim/realtime.ts';

const values = (process.argv[2] ?? '0.5').split(',').map(Number);
const kinds = ['poster', 'photo'] as const;
const scene = [...kinds, 'graphic' as const].map((k) => sceneTarget(k));
const images = scene.map((t) => ({
  info: { id: t.id, width: 640, height: 480, physicalWidthMeters: 0.2 },
  image: { width: 640, height: 480, stride: 640, data: t.gray },
}));
const detector = new OrbDetector();
const report = await detector.load(images);
const tracker = new TemplateTracker({ mode: 'esm' });
tracker.prepare(images.map((t, i) => ({ info: t.info, image: report.targets[i]!.template ?? t.image })));
for (const value of values)
  for (const kind of kinds)
    for (let variant = 0; variant < 4; variant++) {
      const target = sceneTarget(kind);
      const f = renderSweep(target, { factor: 'occlusion', value, variant });
      const frame = frameHandle('occ', f, CAMERA.width, CAMERA.height, 0);
      const truth = cornersOf(f.H!, 640, 480);
      const err = (c: readonly (readonly number[])[]): string =>
        ((100 * cornerError(c as never, truth)) / diagonal(truth)).toFixed(2);
      const det = (await detector.detect(frame)).find((p) => p.targetId === target.id);
      if (!det) {
        console.log(`${value} ${kind} v${variant}: no detection`);
        continue;
      }
      const pyramid = buildPyramid(frame.image.kind === 'cpu-gray' ? frame.image.image : (null as never), 4);
      const model = tracker.model(target.id)!;
      const raw = esmAlign(model, pyramid, () => null as never, det.H_imageFromTarget as Float64Array);
      const tracked = tracker.track({ frame, pyramid, prior: det, previous: null });
      console.log(
        `${value} ${kind} v${variant}: det ${err(det.corners)}% (inl ${det.quality.support})  esm ${raw ? `${err(cornersOf(raw.H, 640, 480))}% ncc ${raw.ncc.toFixed(2)} valid ${raw.validRatio.toFixed(2)} gain ${raw.gain.toFixed(2)}` : 'failed'}  ${'reason' in tracked ? tracked.reason : 'accepted'}`,
      );
    }
