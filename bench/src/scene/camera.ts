// SPDX-License-Identifier: Apache-2.0
// Pinhole camera over the target plane. The target lies centred on the plane Z = 0 (X right, Y down, metres) and the
// camera sees it from distance `distanceM`; pitch/yaw tilt the plane, roll turns it in the image.

export interface CameraModel {
  readonly width: number;
  readonly height: number;
  readonly fx: number;
  readonly fy: number;
  readonly cx: number;
  readonly cy: number;
}

/** 640 × 360 standard image with a 65° horizontal field of view (the baseline's default processing image). */
export function standardCamera(width = 640, height = 360, hfovDeg = 65): CameraModel {
  const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
  return { width, height, fx, fy: fx, cx: width / 2, cy: height / 2 };
}

export interface CameraPose {
  readonly distanceM: number;
  readonly pitchDeg: number;
  readonly yawDeg: number;
  readonly rollDeg: number;
  /** Where the target centre projects, relative to the principal point, in pixels. */
  readonly offsetXPx: number;
  readonly offsetYPx: number;
}

/** Physical target: `widthM` across its `widthPx` picture pixels. */
export interface TargetGeometry {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly widthM: number;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return out;
}

export function invert3(m: ArrayLike<number>): Float64Array {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const cof = [
    e * i - f * h,
    c * h - b * i,
    b * f - c * e,
    f * g - d * i,
    a * i - c * g,
    c * d - a * f,
    d * h - e * g,
    b * g - a * h,
    a * e - b * d,
  ];
  const det = a * cof[0]! + b * cof[3]! + c * cof[6]!;
  return Float64Array.from(cof, (v) => v / det);
}

/** Rotation R = Rz(roll) · Ry(yaw) · Rx(pitch), row-major. */
export function rotation(pose: Pick<CameraPose, 'pitchDeg' | 'yawDeg' | 'rollDeg'>): Float64Array {
  const [p, y, r] = [rad(pose.pitchDeg), rad(pose.yawDeg), rad(pose.rollDeg)];
  const rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
  const ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
  const rz = [Math.cos(r), -Math.sin(r), 0, Math.sin(r), Math.cos(r), 0, 0, 0, 1];
  return multiply(rz, multiply(ry, rx));
}

/** Image-from-plane homography (plane metres, origin at the target centre). */
export function imageFromPlane(camera: CameraModel, pose: CameraPose): Float64Array {
  const R = rotation(pose);
  const d = pose.distanceM;
  const t = [(pose.offsetXPx * d) / camera.fx, (pose.offsetYPx * d) / camera.fy, d];
  const K = [camera.fx, 0, camera.cx, 0, camera.fy, camera.cy, 0, 0, 1];
  const Rt = [R[0]!, R[1]!, t[0]!, R[3]!, R[4]!, t[1]!, R[6]!, R[7]!, t[2]!];
  return multiply(K, Rt);
}

/** Image-from-target homography (target picture pixels, pixel edges, origin top-left). */
export function imageFromTarget(camera: CameraModel, pose: CameraPose, target: TargetGeometry): Float64Array {
  const s = target.widthM / target.widthPx;
  const A = [s, 0, (-s * target.widthPx) / 2, 0, s, (-s * target.heightPx) / 2, 0, 0, 1];
  const h = multiply(imageFromPlane(camera, pose), A);
  const k = h[8]!;
  return h.map((v) => v / k);
}

/** Distance that makes the target's longer picture edge `longPx` pixels long in a frontal view. */
export function distanceForLongEdge(camera: CameraModel, target: TargetGeometry, longPx: number): number {
  const longM = (target.widthM * Math.max(target.widthPx, target.heightPx)) / target.widthPx;
  return (camera.fx * longM) / longPx;
}

export function lerpPose(a: CameraPose, b: CameraPose, f: number): CameraPose {
  const mix = (x: number, y: number): number => x + (y - x) * f;
  return {
    distanceM: mix(a.distanceM, b.distanceM),
    pitchDeg: mix(a.pitchDeg, b.pitchDeg),
    yawDeg: mix(a.yawDeg, b.yawDeg),
    rollDeg: mix(a.rollDeg, b.rollDeg),
    offsetXPx: mix(a.offsetXPx, b.offsetXPx),
    offsetYPx: mix(a.offsetYPx, b.offsetYPx),
  };
}
