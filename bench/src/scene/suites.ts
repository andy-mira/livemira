// SPDX-License-Identifier: Apache-2.0
// Benchmark scenes: S1 single-frame sweeps and S2 sequences with per-frame ground truth (design doc §5.2.1).

import { hashSeed, uniform } from '../rng.ts';
import {
  distanceForLongEdge,
  imageFromPlane,
  imageFromTarget,
  standardCamera,
  type CameraModel,
  type CameraPose,
  type TargetGeometry,
} from './camera.ts';
import {
  DEFAULT_NOISE,
  NEUTRAL_LIGHT,
  renderFrame,
  visibleFraction,
  type Occluder,
  type Photometry,
} from './render.ts';
import { mipmap, tableTexture, targetPicture, toGray8, type MipTexture, type TargetKind } from './textures.ts';

export const CAMERA: CameraModel = standardCamera();
export const TARGET_GEOMETRY: TargetGeometry = { widthPx: 640, heightPx: 480, widthM: 0.2 };
export const FRAME_INTERVAL_US = 1e6 / 30;

export interface SceneTarget {
  readonly id: string;
  readonly kind: TargetKind;
  readonly seed: number;
  readonly gray: Uint8Array;
  readonly mip: MipTexture;
}

const targetCache = new Map<string, SceneTarget>();

/** Target `kind-seed` (640 × 480 picture, 0.2 m wide). */
export function sceneTarget(kind: TargetKind, seed = 7): SceneTarget {
  const id = `${kind}-${seed}`;
  let t = targetCache.get(id);
  if (!t) {
    const picture = targetPicture(kind, seed, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx);
    t = { id, kind, seed, gray: toGray8(picture), mip: mipmap(picture) };
    targetCache.set(id, t);
  }
  return t;
}

let table: { mip: MipTexture; metersPerTexel: number } | null = null;
const tableScene = (): { mip: MipTexture; metersPerTexel: number } =>
  (table ??= { mip: mipmap(tableTexture(3)), metersPerTexel: 0.0025 });

/** One rendered frame and its ground truth. */
export interface GroundTruthFrame {
  readonly index: number;
  /** Mid-exposure capture time. */
  readonly timeUs: number;
  readonly image: Uint8Array;
  /** Null when no loaded target is in the scene. */
  readonly targetId: string | null;
  readonly H: Float64Array | null;
  /** Fraction of the target inside the frame and unoccluded, 0..1. */
  readonly visible: number;
}

export interface SceneState {
  readonly pose: CameraPose;
  readonly light: Photometry;
  readonly occluders: readonly Occluder[];
  readonly exposureMs: number;
}

const BASE_LONG_PX = 300;
const baseDistance = (): number => distanceForLongEdge(CAMERA, TARGET_GEOMETRY, BASE_LONG_PX);

function render(
  target: SceneTarget | null,
  stateAt: (tS: number) => SceneState,
  tS: number,
  seed: number,
  index: number,
  gtTargetId: string | null,
  camera: CameraModel = CAMERA,
): GroundTruthFrame {
  const state = stateAt(tS);
  // Motion blur: sample the trajectory over the exposure; one sample per ~1.5 px of image motion at the centre.
  const halfS = state.exposureMs / 2000;
  const a = imageFromPlane(camera, stateAt(tS - halfS).pose);
  const b = imageFromPlane(camera, stateAt(tS + halfS).pose);
  const motion = Math.hypot(a[2]! / a[8]! - b[2]! / b[8]!, a[5]! / a[8]! - b[5]! / b[8]!);
  const samples = Math.max(1, Math.min(32, Math.ceil(motion / 1.5)));
  const exposure =
    samples === 1
      ? [imageFromPlane(camera, state.pose)]
      : Array.from({ length: samples }, (_, k) =>
          imageFromPlane(camera, stateAt(tS - halfS + ((k + 0.5) / samples) * 2 * halfS).pose),
        );
  const image = renderFrame({
    camera: camera,
    exposure,
    target: target ? { mip: target.mip, ...TARGET_GEOMETRY } : null,
    table: tableScene(),
    light: state.light,
    occluders: state.occluders,
    noise: DEFAULT_NOISE,
    seed,
  });
  const H = target ? imageFromTarget(camera, state.pose, TARGET_GEOMETRY) : null;
  return {
    index,
    timeUs: Math.round(tS * 1e6),
    image,
    targetId: gtTargetId,
    H: gtTargetId ? H : null,
    visible:
      H && gtTargetId
        ? visibleFraction(camera, H, TARGET_GEOMETRY.widthPx, TARGET_GEOMETRY.heightPx, state.occluders)
        : 0,
  };
}

/** Renders `target` (null: table only) under `stateAt` around t = 0, for tools beyond S1/S2 (e.g. pattern training). */
export function renderAt(
  target: SceneTarget | null,
  stateAt: (tS: number) => SceneState,
  seed: number,
): GroundTruthFrame {
  return render(target, stateAt, 0, seed, 0, target?.id ?? null);
}

// ---------- S1: single-frame sweeps ----------

export type SweepFactor = 'roll' | 'longPx' | 'tilt' | 'gain' | 'blurPx' | 'occlusion' | 'noise' | 'negative';

export interface SweepCase {
  readonly factor: SweepFactor;
  readonly value: number;
  readonly variant: number;
}

export const SWEEPS: Readonly<Record<Exclude<SweepFactor, 'negative'>, readonly number[]>> = {
  roll: [0, 10, 15, 20, 30, 45, 60, 90, 135, 180],
  longPx: [48, 64, 80, 96, 128, 160, 220, 300, 450, 640],
  tilt: [0, 20, 40, 50, 60, 65, 70, 75],
  gain: [0.15, 0.25, 0.4, 0.6, 1, 1.6, 2.5],
  blurPx: [0, 4, 8, 12, 16, 24, 32],
  occlusion: [0, 0.2, 0.35, 0.5, 0.65, 0.8],
  noise: [0, 3, 6, 10],
};

export function sweepCases(variants = 4): SweepCase[] {
  const cases: SweepCase[] = [];
  for (const [factor, values] of Object.entries(SWEEPS) as [Exclude<SweepFactor, 'negative'>, readonly number[]][])
    for (const value of values)
      for (let variant = 0; variant < variants; variant++) cases.push({ factor, value, variant });
  for (let variant = 0; variant < variants * 3; variant++)
    cases.push({ factor: 'negative', value: variant % 3, variant });
  return cases;
}

/** Renders one S1 case for `target`; negatives show nothing (value 0), an unloaded picture (1) or a repetitive one (2). */
export function renderSweep(target: SceneTarget, c: SweepCase): GroundTruthFrame {
  const random = uniform(hashSeed(`${target.id}:${c.factor}:${c.value}:${c.variant}`));
  const jitter = (a: number): number => (random() * 2 - 1) * a;
  const d = baseDistance();
  const pose: CameraPose = {
    distanceM: c.factor === 'longPx' ? distanceForLongEdge(CAMERA, TARGET_GEOMETRY, c.value) : d,
    pitchDeg: (c.factor === 'tilt' ? c.value : 0) + jitter(2),
    yawDeg: jitter(3),
    rollDeg: (c.factor === 'roll' ? c.value * (c.variant % 2 ? -1 : 1) : 0) + jitter(2),
    offsetXPx: jitter(30),
    offsetYPx: jitter(15),
  };
  const light: Photometry = c.factor === 'gain' ? { ...NEUTRAL_LIGHT, gain: c.value } : NEUTRAL_LIGHT;
  const H = imageFromTarget(CAMERA, pose, TARGET_GEOMETRY);
  const occluders: Occluder[] = [];
  if (c.factor === 'occlusion' && c.value > 0) {
    const xs = [0, 1, 2, 3].map(
      (k) =>
        (H[0]! * [0, 640, 640, 0][k]! + H[1]! * [0, 0, 480, 480][k]! + H[2]!) /
        (H[6]! * [0, 640, 640, 0][k]! + H[7]! * [0, 0, 480, 480][k]! + 1),
    );
    const x1 = Math.max(...xs);
    const x0 = Math.min(...xs);
    const width = (x1 - x0) * c.value;
    occluders.push({
      kind: 'rect',
      cx: x1 - width / 2,
      cy: CAMERA.cy,
      rx: width / 2 + 2,
      ry: CAMERA.height,
      value: 150,
    });
  }
  const blurS = c.factor === 'blurPx' ? 0.02 : 0;
  const speedPx = c.factor === 'blurPx' ? c.value / blurS : 0;
  const stateAt = (tS: number): SceneState => ({
    pose: { ...pose, offsetXPx: pose.offsetXPx + speedPx * tS },
    light,
    occluders,
    exposureMs: c.factor === 'blurPx' ? blurS * 1000 : 0,
  });
  const noisy = c.factor === 'noise';
  if (c.factor === 'negative') {
    const shown = c.value === 0 ? null : sceneTarget(c.value === 1 ? 'poster' : 'repetitive', 999);
    return render(shown, stateAt, 0, hashSeed(`neg:${c.variant}`), c.variant, null);
  }
  const frame = render(target, stateAt, 0, hashSeed(`${c.factor}:${c.value}:${c.variant}`), c.variant, target.id);
  if (!noisy || c.value === 0) return frame;
  const n = uniform(hashSeed(`noise:${c.value}:${c.variant}`));
  const image = Uint8Array.from(frame.image, (v) => {
    const r = v + (n() + n() + n() - 1.5) * 2 * c.value;
    return r <= 0 ? 0 : r >= 255 ? 255 : Math.round(r);
  });
  return { ...frame, image };
}

// ---------- S2: sequences ----------

export interface SequenceSpec {
  readonly id: string;
  readonly title: string;
  readonly durationS: number;
  readonly stateAt: (tS: number) => SceneState;
}

/** Smooth hand tremor: a few incommensurate sines per axis. */
function tremor(seed: number, ampDeg: number, ampPx: number): (tS: number) => Partial<CameraPose> {
  const r = uniform(seed);
  const phases = Array.from({ length: 12 }, () => r() * 2 * Math.PI);
  const f = [0.7, 1.3, 2.1];
  const wave = (k: number, t: number): number =>
    (Math.sin(2 * Math.PI * f[0]! * t + phases[k * 3]!) +
      0.6 * Math.sin(2 * Math.PI * f[1]! * t + phases[k * 3 + 1]!) +
      0.3 * Math.sin(2 * Math.PI * f[2]! * t + phases[k * 3 + 2]!)) /
    1.9;
  return (t) => ({
    pitchDeg: ampDeg * wave(0, t),
    rollDeg: ampDeg * wave(1, t),
    offsetXPx: ampPx * wave(2, t),
    offsetYPx: ampPx * wave(3, t),
  });
}

function add(base: CameraPose, delta: Partial<CameraPose>): CameraPose {
  return {
    distanceM: base.distanceM + (delta.distanceM ?? 0),
    pitchDeg: base.pitchDeg + (delta.pitchDeg ?? 0),
    yawDeg: base.yawDeg + (delta.yawDeg ?? 0),
    rollDeg: base.rollDeg + (delta.rollDeg ?? 0),
    offsetXPx: base.offsetXPx + (delta.offsetXPx ?? 0),
    offsetYPx: base.offsetYPx + (delta.offsetYPx ?? 0),
  };
}

const smoothstep = (a: number, b: number, t: number): number => {
  const x = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return x * x * (3 - 2 * x);
};

export function sequences(): SequenceSpec[] {
  const d = baseDistance();
  const base: CameraPose = { distanceM: d, pitchDeg: 20, yawDeg: -10, rollDeg: 4, offsetXPx: 10, offsetYPx: -5 };
  const still = (pose: CameraPose, extra: Partial<SceneState> = {}): SceneState => ({
    pose,
    light: NEUTRAL_LIGHT,
    occluders: [],
    exposureMs: 8,
    ...extra,
  });
  const hand = tremor(11, 0.4, 3);
  return [
    { id: 'T1-static', title: '三脚架静止', durationS: 4, stateAt: () => still(base) },
    {
      id: 'T2-pan',
      title: '慢速平移',
      durationS: 5,
      stateAt: (t) =>
        still(
          add(base, {
            ...hand(t),
            offsetXPx: 160 * Math.sin((2 * Math.PI * t) / 5),
            offsetYPx: 40 * Math.sin((2 * Math.PI * t) / 2.5),
            pitchDeg: 5 * Math.sin(t),
          }),
        ),
    },
    {
      id: 'T3-shake',
      title: '2–4 Hz 手抖',
      durationS: 5,
      stateAt: (t) =>
        still(
          add(base, {
            offsetXPx: 35 * Math.sin(2 * Math.PI * 3 * t),
            offsetYPx: 20 * Math.sin(2 * Math.PI * 2.3 * t + 1),
            rollDeg: 6 * Math.sin(2 * Math.PI * 2 * t),
            pitchDeg: 5 * Math.sin(2 * Math.PI * 1.7 * t),
          }),
        ),
    },
    {
      id: 'T4-approach',
      title: '远近推拉',
      durationS: 6,
      stateAt: (t) => {
        const longPx = 140 * (600 / 140) ** Math.sin((Math.PI * t) / 6);
        return still(add({ ...base, distanceM: distanceForLongEdge(CAMERA, TARGET_GEOMETRY, longPx) }, hand(t)));
      },
    },
    {
      id: 'T5-roll',
      title: '连续旋转 360°',
      durationS: 6,
      stateAt: (t) => still(add({ ...base, pitchDeg: 15 }, { ...hand(t), rollDeg: 60 * t })),
    },
    {
      id: 'T6-tilt',
      title: '倾角往复 0–70°',
      durationS: 6,
      stateAt: (t) =>
        still(
          add(
            { ...base, pitchDeg: 0, yawDeg: 0 },
            { ...hand(t), pitchDeg: 70 * Math.sin((Math.PI * t) / 6), yawDeg: 30 * Math.sin((2 * Math.PI * t) / 6) },
          ),
        ),
    },
    {
      id: 'T7-occlusion',
      title: '遮挡扫过',
      durationS: 5,
      stateAt: (t) => {
        const x = -150 + 700 * (t / 5);
        return still(add(base, hand(t)), {
          occluders: [{ kind: 'ellipse', cx: x, cy: CAMERA.cy + 40, rx: 110, ry: 260, value: 150 }],
        });
      },
    },
    {
      id: 'T8-light',
      title: '光照阶跃',
      durationS: 5,
      stateAt: (t) => {
        const dim = smoothstep(1.5, 2, t) - smoothstep(3.5, 4, t);
        return still(add(base, hand(t)), {
          light: { ...NEUTRAL_LIGHT, gain: 1 - 0.7 * dim },
          exposureMs: 8 + 12 * dim,
        });
      },
    },
    {
      id: 'T9-blur',
      title: '甩动模糊突发',
      durationS: 5,
      stateAt: (t) =>
        still(add(base, { ...hand(t), offsetXPx: 120 * (smoothstep(1.5, 1.65, t) - smoothstep(3.5, 3.65, t)) }), {
          exposureMs: 20,
        }),
    },
    {
      id: 'T10-exit',
      title: '出画再入画',
      durationS: 6,
      stateAt: (t) =>
        still(add(base, { ...hand(t), offsetXPx: 720 * (smoothstep(1.5, 2.5, t) - smoothstep(3.5, 4.5, t)) })),
    },
    {
      id: 'T12-drift',
      title: '长时手持漂移',
      durationS: 10,
      stateAt: (t) => {
        const slow = tremor(29, 10, 40);
        return still(add(base, slow(t / 4)));
      },
    },
  ];
}

/** Renders a sequence at 30 fps for `target`. */
export function renderSequence(
  target: SceneTarget,
  spec: SequenceSpec,
  fps = 30,
  camera: CameraModel = CAMERA,
): GroundTruthFrame[] {
  const count = Math.round(spec.durationS * fps);
  return Array.from({ length: count }, (_, i) =>
    render(target, spec.stateAt, i / fps, hashSeed(`${spec.id}:${target.id}:${i}`), i, target.id, camera),
  );
}
