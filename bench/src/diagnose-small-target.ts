// SPDX-License-Identifier: Apache-2.0
// Small targets in a hand-held camera: tracking and losses by the target's long edge on screen (the ⑩ phone runs
// lost the photo more often below about half the frame's short edge). Renders hand-held sequences at fixed sizes
// and a pull-back from near to far, runs the engine's pipelines and candidate changes on them, and counts the frames
// tracked correctly and the losses.
//   node bench/src/diagnose-small-target.ts [--picture <png>] [--pipelines swift,hawk,...]

import { cornersOf, type FrameHandle, type VisionPipeline } from '@livemira-next/contracts';
import { OrbDetector } from '@livemira-next/features';
import { KalmanPoseFilter } from '@livemira-next/filters';
import {
  DualLoopPipeline,
  TemplateTracker,
  type DualLoopOptions,
  type EsmOptions,
  type TemplateTrackerMode,
} from '@livemira-next/tracking';

import { resampleOriented } from '@livemira-next/web';

import { distanceForLongEdge, standardCamera, type CameraModel } from './scene/camera.ts';
import {
  CAMERA,
  renderSequence,
  sceneTarget,
  TARGET_GEOMETRY,
  type SceneState,
  type SceneTarget,
  type SequenceSpec,
} from './scene/suites.ts';
import { pictureTarget } from './scene/picture.ts';
import { NEUTRAL_LIGHT } from './scene/render.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Candidate {
  readonly id: string;
  readonly mode: TemplateTrackerMode;
  readonly relocalizeEvery: number;
  readonly esm?: EsmOptions;
  readonly dual?: DualLoopOptions;
}

/** As in 0.5.0-rc.1: after a loss the whole frame at its own size, no enlarged regions. */
const RC1: DualLoopOptions = { lostSearchUs: 0, smallTargetPx: 0 };

/** The product profiles (packages/web/src/profiles.ts), as in rc.1 and now. */
const CANDIDATES: readonly Candidate[] = [
  { id: 'swift-rc1', mode: 'esm', relocalizeEvery: 60, dual: RC1 },
  { id: 'swift', mode: 'esm', relocalizeEvery: 60 },
  { id: 'hawk-rc1', mode: 'klt+esm', relocalizeEvery: 10, dual: RC1 },
  { id: 'hawk', mode: 'klt+esm', relocalizeEvery: 10 },
];

const create = (c: Candidate): VisionPipeline =>
  new DualLoopPipeline(
    {
      id: c.id,
      detector: new OrbDetector(),
      tracker: new TemplateTracker({ mode: c.mode, ...(c.esm ? { esm: c.esm } : {}) }),
      filter: (targets) => new KalmanPoseFilter(targets),
    },
    // The product relocalises in a second Worker; here the detection runs in place and is applied later.
    { relocalizeEvery: c.relocalizeEvery, asyncRelocalization: true, ...c.dual },
  );

/** When the picture is gone in the dropout sequences, s. */
const DROPOUT = [2, 2.3] as const;

/**
 * Hand tremor plus a slow wander (the ⑩ runs), or a 2–4 Hz shake, at a fixed size; a dropout (recognised near, then
 * at the size, then gone for 0.3 s: a jerk, a refocus, a hand in front); or a pull-back.
 */
function sequencesAt(longPx: number, camera: CameraModel = CAMERA): SequenceSpec[] {
  // Offsets are in camera pixels: the same hand motion moves the picture further on a finer camera.
  const k = camera.width / CAMERA.width;
  const d = distanceForLongEdge(camera, TARGET_GEOMETRY, longPx);
  const near = distanceForLongEdge(camera, TARGET_GEOMETRY, 260 * k);
  const state = (t: number, distanceM: number, x: number, y: number, pitch: number, roll: number): SceneState => ({
    pose: { distanceM, pitchDeg: 15 + pitch, yawDeg: -8, rollDeg: 3 + roll, offsetXPx: k * x, offsetYPx: k * y },
    light: NEUTRAL_LIGHT,
    occluders: [],
    exposureMs: 8,
  });
  const wobble = (t: number, f: number, phase: number): number =>
    (Math.sin(2 * Math.PI * f * t + phase) + 0.6 * Math.sin(2 * Math.PI * 1.9 * f * t + 2 * phase)) / 1.6;
  return [
    {
      id: `dropout-${longPx}`,
      title: '近处识别后退到该尺寸，中途断开 0.3 秒',
      durationS: 4.5,
      stateAt: (t) => {
        const k = Math.min(1, Math.max(0, (t - 0.5) / 0.7));
        const s = state(
          t,
          near + (d - near) * k * k * (3 - 2 * k),
          40 * wobble(t, 0.35, 1) + 3 * wobble(t, 2.3, 0),
          20 * wobble(t, 0.27, 2),
          3 * wobble(t, 0.5, 3),
          2 * wobble(t, 0.6, 1),
        );
        const gone = t >= DROPOUT[0] && t < DROPOUT[1];
        return gone
          ? {
              ...s,
              occluders: [
                { kind: 'rect', cx: camera.cx, cy: camera.cy, rx: camera.width, ry: camera.height, value: 110 },
              ],
            }
          : s;
      },
    },
    {
      id: `hand-${longPx}`,
      title: '手持',
      durationS: 6,
      stateAt: (t) =>
        state(
          t,
          d,
          60 * wobble(t, 0.35, 1) + 4 * wobble(t, 2.3, 0),
          30 * wobble(t, 0.27, 2),
          4 * wobble(t, 0.5, 3),
          3 * wobble(t, 0.6, 1),
        ),
    },
    {
      id: `shake-${longPx}`,
      title: '手抖 2–4 Hz',
      durationS: 5,
      stateAt: (t) =>
        state(
          t,
          d,
          25 * Math.sin(2 * Math.PI * 3 * t),
          15 * Math.sin(2 * Math.PI * 2.3 * t + 1),
          4 * Math.sin(2 * Math.PI * 1.7 * t),
          5 * Math.sin(2 * Math.PI * 2 * t),
        ),
    },
  ];
}

const pullBack: SequenceSpec = {
  id: 'pull-back',
  title: '从近拉远（长边 260 → 70 px，4 秒）',
  durationS: 6,
  stateAt: (t) => {
    const near = distanceForLongEdge(CAMERA, TARGET_GEOMETRY, 260);
    const far = distanceForLongEdge(CAMERA, TARGET_GEOMETRY, 70);
    const k = Math.min(1, Math.max(0, (t - 1) / 4));
    return {
      pose: {
        distanceM: near + (far - near) * k * k * (3 - 2 * k),
        pitchDeg: 15 + 3 * Math.sin(2 * Math.PI * 0.5 * t),
        yawDeg: -8,
        rollDeg: 3 + 2 * Math.sin(2 * Math.PI * 0.6 * t),
        offsetXPx: 30 * Math.sin(2 * Math.PI * 0.4 * t) + 3 * Math.sin(2 * Math.PI * 2.3 * t),
        offsetYPx: 15 * Math.sin(2 * Math.PI * 0.3 * t),
      },
      light: NEUTRAL_LIGHT,
      occluders: [],
      exposureMs: 8,
    };
  },
};

/** Mean corner error of `corners` against the ground truth, px. */
function cornerError(corners: readonly (readonly number[])[], H: Float64Array): number {
  const truth = cornersOf(H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
  return corners.reduce((s, c, i) => s + Math.hypot(c[0]! - truth[i]![0]!, c[1]! - truth[i]![1]!), 0) / 4;
}

interface Frame {
  readonly index: number;
  readonly timeUs: number;
  readonly image: Uint8Array;
  readonly H: Float64Array | null;
}

async function runOne(
  target: SceneTarget,
  specId: string,
  frames: readonly Frame[],
  c: Candidate,
  width = CAMERA.width,
  height = CAMERA.height,
): Promise<{
  tracked: number;
  losses: number;
  frames: number;
  lostAtPx: number[];
  backAfterMs: number | null;
  msPerFrame: number;
}> {
  const pipeline = create(c);
  await pipeline.load([
    {
      info: {
        id: target.id,
        width: TARGET_GEOMETRY.widthPx,
        height: TARGET_GEOMETRY.heightPx,
        physicalWidthMeters: 0.2,
      },
      image: {
        width: TARGET_GEOMETRY.widthPx,
        height: TARGET_GEOMETRY.heightPx,
        stride: TARGET_GEOMETRY.widthPx,
        data: target.gray,
      },
    },
  ]);
  pipeline.reset('s');
  let tracked = 0;
  const times: number[] = [];
  let losses = 0;
  let was = false;
  let everTracked = false;
  let lastPx = 0;
  const lostAtPx: number[] = [];
  let backAfterMs: number | null = null;
  for (const f of frames) {
    const handle: FrameHandle = {
      sessionId: 's',
      frameId: f.index + 1,
      time: { captureUs: f.timeUs, receiveUs: f.timeUs, source: 'callback' } as FrameHandle['time'],
      image: {
        kind: 'cpu-gray',
        image: { width, height, stride: width, data: f.image },
      },
    };
    const started = performance.now();
    const out = await pipeline.process(handle);
    times.push(performance.now() - started);
    const pose = out.display[0];
    const truth = f.H;
    const long = truth
      ? Math.max(
          ...cornersOf(truth, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx).map((p, i, a) =>
            Math.hypot(a[(i + 1) % 4]![0]! - p[0]!, a[(i + 1) % 4]![1]! - p[1]!),
          ),
        )
      : 0;
    const ok = !!pose && !!truth && cornerError(pose.corners, truth) < Math.max(3, 0.06 * long);
    // Back after the dropout: the first frame after it with a measured (not predicted) correct pose.
    if (specId.startsWith('dropout') && backAfterMs === null && f.timeUs >= DROPOUT[1] * 1e6 && ok && out.poses.length)
      backAfterMs = Math.round(f.timeUs / 1000 - DROPOUT[1] * 1000);
    if (ok) {
      tracked++;
      everTracked = true;
      lastPx = long;
    } else if (was && everTracked) {
      losses++;
      lostAtPx.push(Math.round(lastPx));
    }
    was = ok;
  }
  pipeline.dispose();
  times.sort((a, b) => a - b);
  return { tracked, losses, frames: frames.length, lostAtPx, backAfterMs, msPerFrame: times[times.length >> 1]! };
}

const picture = option('picture');
const targets: SceneTarget[] = [sceneTarget('photo'), ...(picture ? [pictureTarget(picture)] : [])];
const wanted = option('pipelines')?.split(',');
const candidates = CANDIDATES.filter((c) => !wanted || wanted.includes(c.id));
const sizes = (option('sizes') ?? '80,100,120,150,190,240').split(',').map(Number);

for (const target of targets) {
  if (process.argv.includes('--detect')) {
    await detectionBySize(target);
    continue;
  }
  if (process.argv.includes('--scales')) {
    await byProcessingScale(target);
    continue;
  }
  console.log(`\n目标 ${target.id === 'picture' ? picture : 'photo（合成）'}；每格：正确跟踪比例 / 丢失次数`);
  const specs = [...sizes.flatMap((size) => sequencesAt(size)), pullBack];
  console.log('每格：正确跟踪比例/丢失次数；断开序列另有 ↩ 照片回来后多久重新测到位姿（✗：没有找回）');
  console.log(['序列'.padEnd(12), ...candidates.map((c) => c.id.padStart(18))].join(' '));
  for (const spec of specs) {
    const cells: string[] = [];
    for (const c of candidates) {
      const r = await runOne(target, spec.id, renderSequence(target, spec), c);
      const back = spec.id.startsWith('dropout') ? ` ↩${r.backAfterMs === null ? '✗' : `${r.backAfterMs}ms`}` : '';
      const at = spec.id === 'pull-back' && r.lostAtPx.length ? ` @${r.lostAtPx.join(',')}` : '';
      cells.push(`${((100 * r.tracked) / r.frames).toFixed(0)}%/${r.losses}${back}${at}`.padStart(18));
    }
    console.log([spec.id.padEnd(12), ...cells].join(' '));
  }
}

/** Bilinear crop-and-scale of `rect` by `k` (the detector's view of an enlarged region). */
function upsample(
  src: Uint8Array,
  width: number,
  rect: { x: number; y: number; width: number; height: number },
  k: number,
): { data: Uint8Array; width: number; height: number } {
  const w = Math.round(rect.width * k);
  const h = Math.round(rect.height * k);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(rect.y + rect.height - 1.001, Math.max(rect.y, rect.y + (y + 0.5) / k - 0.5));
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(rect.x + rect.width - 1.001, Math.max(rect.x, rect.x + (x + 0.5) / k - 0.5));
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const i = y0 * width + x0;
      out[y * w + x] = Math.round(
        (src[i]! * (1 - fx) + src[i + 1]! * fx) * (1 - fy) +
          (src[i + width]! * (1 - fx) + src[i + width + 1]! * fx) * fy,
      );
    }
  }
  return { data: out, width: w, height: h };
}

/** Detection alone, by size: whole frame, a region around the target, and that region enlarged 2× and 3×. */
async function detectionBySize(target: SceneTarget): Promise<void> {
  const detector = new OrbDetector();
  await detector.load([
    {
      info: {
        id: target.id,
        width: TARGET_GEOMETRY.widthPx,
        height: TARGET_GEOMETRY.heightPx,
        physicalWidthMeters: 0.2,
      },
      image: {
        width: TARGET_GEOMETRY.widthPx,
        height: TARGET_GEOMETRY.heightPx,
        stride: TARGET_GEOMETRY.widthPx,
        data: target.gray,
      },
    },
  ]);
  const W = CAMERA.width;
  const H = CAMERA.height;
  const handle = (data: Uint8Array, width: number, height: number, id: number): FrameHandle => ({
    sessionId: 'd',
    frameId: id,
    time: { captureUs: id, receiveUs: id, source: 'callback' } as FrameHandle['time'],
    image: { kind: 'cpu-gray', image: { width, height, stride: width, data } },
  });
  console.log(`\n检测（无跟踪）：每种尺寸 20 帧的识别率；目标 ${target.id === 'picture' ? picture : 'photo（合成）'}`);
  console.log(['长边 px', '全画面', '局部', '局部放大2倍', '局部放大3倍'].join(' | '));
  for (const longPx of (option('detect-sizes') ?? '70,80,90,100,120,140,160,190').split(',').map(Number)) {
    const spec = sequencesAt(longPx)[0]!;
    const frames = renderSequence(target, { ...spec, durationS: 20 / 30 });
    const hits = [0, 0, 0, 0];
    for (const f of frames) {
      const truth = cornersOf(f.H!, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
      const xs = truth.map((p) => p[0]!);
      const ys = truth.map((p) => p[1]!);
      const bw = Math.max(...xs) - Math.min(...xs);
      const bh = Math.max(...ys) - Math.min(...ys);
      const x0 = Math.max(0, Math.floor(Math.min(...xs) - 0.5 * bw));
      const y0 = Math.max(0, Math.floor(Math.min(...ys) - 0.5 * bh));
      const roi = {
        x: x0,
        y: y0,
        width: Math.min(W, Math.ceil(Math.max(...xs) + 0.5 * bw)) - x0,
        height: Math.min(H, Math.ceil(Math.max(...ys) + 0.5 * bh)) - y0,
      };
      const good = (corners: readonly (readonly number[])[]): boolean =>
        corners.reduce((s, c, i) => s + Math.hypot(c[0]! - truth[i]![0]!, c[1]! - truth[i]![1]!), 0) / 4 <
        Math.max(3, 0.08 * longPx);
      if ((await detector.detect(handle(f.image, W, H, 1))).some((d) => good(d.corners))) hits[0]!++;
      if ((await detector.detect(handle(f.image, W, H, 2), { roi })).some((d) => good(d.corners))) hits[1]!++;
      for (const [slot, k] of [
        [2, 2],
        [3, 3],
      ] as const) {
        const up = upsample(f.image, W, roi, k);
        const found = await detector.detect(handle(up.data, up.width, up.height, 3));
        if (
          found.some((d) =>
            good(d.corners.map(([x, y]) => [roi.x + (x! + 0.5) / k - 0.5, roi.y + (y! + 0.5) / k - 0.5])),
          )
        )
          hits[slot]!++;
      }
    }
    console.log(
      [String(longPx).padStart(5), ...hits.map((h) => `${Math.round((100 * h) / frames.length)}%`.padStart(6))].join(
        ' | ',
      ),
    );
  }
}

/**
 * Processing sizes (EngineOptions.camera.processingScale) of a 1280 × 720 camera: each sequence is rendered once at
 * the camera's size and resampled as the engine does (luma.ts), then run at 1, 0.75, 0.5 and 0.25 of it.
 */
async function byProcessingScale(target: SceneTarget): Promise<void> {
  const camera = standardCamera(1280, 720);
  const c = CANDIDATES.find((x) => x.id === (option('profile') ?? 'swift'))!;
  const shares = (option('shares') ?? '0.2,0.25,0.3,0.4,0.5').split(',').map(Number);
  const scales = [1, 0.75, 0.5, 0.25];
  const sizeOf = (s: number): [number, number] => [2 * Math.round((1280 * s) / 2), 2 * Math.round((720 * s) / 2)];
  console.log(
    `\n处理尺寸（相机 1280×720，${c.id}）；目标 ${target.id === 'picture' ? picture : 'photo（合成）'}；` +
      '每格：正确跟踪比例/丢失次数，断开序列另有 ↩ 找回时间，最后是每帧处理耗时中位数（Node）',
  );
  console.log(
    [
      '占短边',
      '序列'.padEnd(8),
      ...scales.map((s) => `${s === 1 ? '原尺寸' : s} ${sizeOf(s).join('×')}`.padStart(26)),
    ].join(' '),
  );
  for (const share of shares)
    for (const spec of sequencesAt(Math.round(share * camera.height), camera)) {
      const full = renderSequence(target, spec, 30, camera);
      const cells: string[] = [];
      for (const scale of scales) {
        const [w, h] = sizeOf(scale);
        const frames = full.map((f) => {
          const image = new Uint8Array(w * h);
          resampleOriented(f.image, camera.width, camera.height, camera.width, w, h, image);
          const H =
            f.H &&
            Float64Array.from(f.H, (v, i) => (i < 3 ? (v * w) / camera.width : i < 6 ? (v * h) / camera.height : v));
          return { index: f.index, timeUs: f.timeUs, image, H };
        });
        const r = await runOne(target, spec.id, frames, c, w, h);
        const back = spec.id.startsWith('dropout') ? ` ↩${r.backAfterMs === null ? '✗' : `${r.backAfterMs}ms`}` : '';
        cells.push(
          `${((100 * r.tracked) / r.frames).toFixed(0)}%/${r.losses}${back} ${r.msPerFrame.toFixed(1)}ms`.padStart(26),
        );
      }
      console.log([`${Math.round(share * 100)}%`.padStart(5), spec.id.split('-')[0]!.padEnd(8), ...cells].join(' '));
    }
}
