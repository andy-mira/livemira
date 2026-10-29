// SPDX-License-Identifier: Apache-2.0
// F3 check: focal length estimated online from the tracked homographies of a sequence, against the true focal
// length of the synthetic camera, and the metric camera distance it implies.
//   node bench/src/eval-focal.ts

import { FocalEstimator, poseFromHomography } from '@livemira-next/geometry';

import { pipelineById } from './pipelines.ts';
import { CAMERA, TARGET_GEOMETRY, renderSequence, sceneTarget, sequences } from './scene/suites.ts';
import { runRealtime } from './sim/realtime.ts';

const entry = pipelineById('N3-F1-r30');
const pipeline = entry.create();
const target = sceneTarget('poster');
await pipeline.load([
  {
    info: { id: target.id, width: 640, height: 480, physicalWidthMeters: 0.2 },
    image: { width: 640, height: 480, stride: 640, data: target.gray },
  },
]);
for (const spec of sequences().filter((s) => ['T6-tilt', 'T12-drift', 'T2-pan'].includes(s.id))) {
  const frames = renderSequence(target, spec);
  const processed = await runRealtime(pipeline, frames, {
    tier: 'mid',
    costs: entry.costs,
    width: CAMERA.width,
    height: CAMERA.height,
    sessionId: spec.id,
  });
  const focal = new FocalEstimator(CAMERA.cx, CAMERA.cy);
  const checkpoints: string[] = [];
  let distanceErrors: number[] = [];
  for (const p of processed) {
    const pose = p.output.poses[0];
    if (!pose) continue;
    focal.add(pose.H_imageFromTarget);
    const e = focal.estimate();
    if (p.index % 30 === 29)
      checkpoints.push(
        `${((p.index + 1) / 30).toFixed(0)}s:${e.focalPx === null ? '—' : ((100 * (e.focalPx - CAMERA.fx)) / CAMERA.fx).toFixed(1) + '%'}`,
      );
    if (e.focalPx !== null) {
      const plane = poseFromHomography(
        pose.H_imageFromTarget,
        e.focalPx,
        CAMERA.cx,
        CAMERA.cy,
        TARGET_GEOMETRY.widthM / TARGET_GEOMETRY.widthPx,
      );
      // Compare camera-to-target-centre distances: the plane origin is the target's top-left corner.
      const s = TARGET_GEOMETRY.widthM / TARGET_GEOMETRY.widthPx;
      const truthPose = spec.stateAt(frames[p.index]!.timeUs / 1e6).pose;
      const truth = Math.hypot(
        (truthPose.offsetXPx * truthPose.distanceM) / CAMERA.fx,
        (truthPose.offsetYPx * truthPose.distanceM) / CAMERA.fy,
        truthPose.distanceM,
      );
      if (plane) {
        const [cx, cy] = [(TARGET_GEOMETRY.widthPx / 2) * s, (TARGET_GEOMETRY.heightPx / 2) * s];
        const centre = [0, 1, 2].map((r) => plane.R[3 * r]! * cx + plane.R[3 * r + 1]! * cy + plane.t[r]!);
        distanceErrors.push(Math.abs(Math.hypot(...centre) - truth) / truth);
      }
    }
  }
  distanceErrors = distanceErrors.slice(Math.floor(distanceErrors.length / 2));
  const meanDist = distanceErrors.reduce((a, b) => a + b, 0) / Math.max(1, distanceErrors.length);
  console.log(
    `${spec.id}: focal error over time ${checkpoints.join(' ')}; camera distance error (second half) ${(100 * meanDist).toFixed(1)}%`,
  );
}
