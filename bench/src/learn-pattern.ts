// SPDX-License-Identifier: Apache-2.0
// Learns the C1 BRIEF test pattern (256 comparisons of 5×5 box sums around a keypoint, steered by its orientation).
// Training data: textures held out from the benchmark (seeds 101–104; S1/S2 use seed 7, negatives 999), rendered
// under random roll, distance, tilt, motion blur and lighting by the S1/S2 renderer. Frame keypoints are paired
// with target keypoints through the ground-truth homography (same place, compatible scale), as matching would.
// Every test inside a radius-10 disc is scored by (random-pair flip rate 2p(1−p)) − (true-pair flip rate); tests
// are then picked greedily in score order with |phi| correlation to the picked ones below a threshold (relaxed in
// steps of 0.05 when the pool runs out). Deterministic.
//   node bench/src/learn-pattern.ts [--frames 16] [--out bench/results/pattern] [--write]
// `--write` stores the pattern as packages/features/src/generated/brief-pattern.ts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GrayImage } from '@livemira-next/contracts';
import { angleBin, extractOrb, halfOctavePyramid, type OrbOptions } from '@livemira-next/features';

import { uniform } from './rng.ts';
import { distanceForLongEdge } from './scene/camera.ts';
import { NEUTRAL_LIGHT } from './scene/render.ts';
import { CAMERA, TARGET_GEOMETRY, renderAt, sceneTarget, type SceneState } from './scene/suites.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const FRAMES = Number(option('frames') ?? 16);
const OUT = option('out') ?? join('bench', 'results', 'pattern');
const KINDS = ['poster', 'photo', 'graphic'] as const;
const SEEDS = [101, 102, 103, 104];
const RADIUS = 10;
const BINS = 32;
const ORB: OrbOptions = { budget: 700 };

// Candidate box centres and their rounded rotations per steering bin.
const POS: [number, number][] = [];
for (let dy = -RADIUS; dy <= RADIUS; dy++)
  for (let dx = -RADIUS; dx <= RADIUS; dx++) if (dx * dx + dy * dy <= RADIUS * RADIUS) POS.push([dx, dy]);
const P = POS.length;
const ROT = new Int8Array(BINS * P * 2);
for (let b = 0; b < BINS; b++) {
  const a = (2 * Math.PI * b) / BINS;
  POS.forEach(([x, y], i) => {
    ROT[2 * (b * P + i)] = Math.round(Math.cos(a) * x - Math.sin(a) * y);
    ROT[2 * (b * P + i) + 1] = Math.round(Math.sin(a) * x + Math.cos(a) * y);
  });
}
const CA: number[] = [];
const CB: number[] = [];
for (let i = 0; i < P; i++)
  for (let j = i + 1; j < P; j++)
    if (Math.hypot(POS[i]![0] - POS[j]![0], POS[i]![1] - POS[j]![1]) >= 2) {
      CA.push(i);
      CB.push(j);
    }
const C = CA.length;

function integral(image: GrayImage): Int32Array {
  const w = image.width + 1;
  const out = new Int32Array(w * (image.height + 1));
  for (let y = 0; y < image.height; y++) {
    let row = 0;
    for (let x = 0; x < image.width; x++) {
      row += image.data[y * image.stride + x]!;
      out[(y + 1) * w + x + 1] = out[y * w + x + 1]! + row;
    }
  }
  return out;
}

interface Described {
  readonly x: number;
  readonly y: number;
  /** Image px per level px. */
  readonly scale: number;
  readonly sums: Int32Array;
}

/** Keypoints of `image` with the 5×5 box sums at every steered candidate centre. */
function describeAll(image: GrayImage): Described[] {
  const k = extractOrb(image, ORB);
  const levels = halfOctavePyramid(image, 6);
  const integrals = levels.map((l) => integral(l.image));
  const out: Described[] = [];
  for (let q = 0; q < k.count; q++) {
    const level = levels[k.level[q]!]!;
    const s = level.scale;
    const cx = Math.round(k.x[q]! / s - 0.5);
    const cy = Math.round(k.y[q]! / s - 0.5);
    const ii = integrals[k.level[q]!]!;
    const w = level.image.width + 1;
    const bin = angleBin(k.angle[q]!);
    const sums = new Int32Array(P);
    for (let i = 0; i < P; i++) {
      const a = (cy - 2 + ROT[2 * (bin * P + i) + 1]!) * w + (cx - 2 + ROT[2 * (bin * P + i)]!);
      sums[i] = ii[a + 5 * w + 5]! - ii[a + 5]! - ii[a + 5 * w]! + ii[a]!;
    }
    out.push({ x: k.x[q]!, y: k.y[q]!, scale: s, sums });
  }
  return out;
}

function invert(m: ArrayLike<number>): Float64Array {
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
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const D = d * h - e * g;
  const det = a * A + b * B + c * D;
  return Float64Array.from(
    [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), D, -(a * h - b * g), a * e - b * d].map(
      (v) => v / det,
    ),
  );
}

/** Target position of image point (x, y) and target px per image px there. */
function project(m: Float64Array, x: number, y: number): [number, number, number] {
  const w = m[6]! * x + m[7]! * y + m[8]!;
  const u = (m[0]! * x + m[1]! * y + m[2]!) / w;
  const v = (m[3]! * x + m[4]! * y + m[5]!) / w;
  const a = (m[0]! - u * m[6]!) / w;
  const b = (m[1]! - u * m[7]!) / w;
  const c = (m[3]! - v * m[6]!) / w;
  const d = (m[4]! - v * m[7]!) / w;
  return [u, v, Math.sqrt(Math.abs(a * d - b * c))];
}

const started = performance.now();
const frameRows: Int32Array[] = [];
const targetRows: Int32Array[] = [];
const population: Int32Array[] = [];
for (const kind of KINDS)
  for (const seed of SEEDS) {
    const target = sceneTarget(kind, seed);
    const reference = describeAll({ width: 640, height: 480, stride: 640, data: target.gray });
    const random = uniform(seed * 7919 + kind.length);
    for (let f = 0; f < FRAMES; f++) {
      const longPx = 130 * (640 / 130) ** random();
      const blurPx = random() < 0.35 ? 2 + 8 * random() : 0;
      const exposureS = 0.02;
      const speed = blurPx / exposureS;
      const angle = 2 * Math.PI * random();
      const pose = {
        distanceM: distanceForLongEdge(CAMERA, TARGET_GEOMETRY, longPx),
        pitchDeg: 60 * random() ** 1.5,
        yawDeg: (random() * 2 - 1) * 20,
        rollDeg: 360 * random(),
        offsetXPx: (random() * 2 - 1) * 60,
        offsetYPx: (random() * 2 - 1) * 30,
      };
      const gain = random() < 0.25 ? 0.3 + 1.2 * random() : 1;
      const stateAt = (tS: number): SceneState => ({
        pose: {
          ...pose,
          offsetXPx: pose.offsetXPx + Math.cos(angle) * speed * tS,
          offsetYPx: pose.offsetYPx + Math.sin(angle) * speed * tS,
        },
        light: { ...NEUTRAL_LIGHT, gain },
        occluders: [],
        exposureMs: blurPx ? exposureS * 1000 : 0,
      });
      const frame = renderAt(target, stateAt, seed * 1000 + f);
      const inv = invert(frame.H!);
      const keypoints = describeAll({
        width: CAMERA.width,
        height: CAMERA.height,
        stride: CAMERA.width,
        data: frame.image,
      });
      for (const q of keypoints) {
        if (population.length < 8192 && random() < 0.25) population.push(q.sums);
        const [u, v, s] = project(inv, q.x, q.y);
        if (u < 0 || v < 0 || u >= 640 || v >= 480) continue;
        // Target px per frame-level px; a partner needs a compatible level and the same place (1.5 level px).
        const sigma = s * q.scale;
        let best: Described | null = null;
        let bestD = 1.5 * sigma;
        for (const t of reference) {
          if (Math.abs(Math.log2(t.scale / sigma)) > 0.35) continue;
          const d = Math.hypot(t.x - u, t.y - v);
          if (d < bestD) {
            bestD = d;
            best = t;
          }
        }
        if (best) {
          frameRows.push(q.sums);
          targetRows.push(best.sums);
        }
      }
    }
    console.log(
      `[${((performance.now() - started) / 1000).toFixed(0)}s] ${target.id}: ${frameRows.length} pairs, ${population.length} population`,
    );
  }

// Statistics per candidate test.
const N = frameRows.length;
const agree = new Uint32Array(C);
const ones = new Uint32Array(C);
for (let n = 0; n < N; n++) {
  const f = frameRows[n]!;
  const t = targetRows[n]!;
  for (let c = 0; c < C; c++) {
    const a = CA[c]!;
    const b = CB[c]!;
    if (f[a]! < f[b]! === t[a]! < t[b]!) agree[c]!++;
  }
}
const M = population.length;
for (const f of population) for (let c = 0; c < C; c++) if (f[CA[c]!]! < f[CB[c]!]!) ones[c]!++;
const score = new Float64Array(C);
for (let c = 0; c < C; c++) {
  const p = ones[c]! / M;
  score[c] = 2 * p * (1 - p) - (1 - agree[c]! / N);
}
const order = Array.from({ length: C }, (_, c) => c).sort((a, b) => score[b]! - score[a]! || a - b);
console.log(`[${((performance.now() - started) / 1000).toFixed(0)}s] ${C} candidate tests scored on ${N} pairs`);

// Greedy decorrelated selection over the population's bit vectors.
const words = Math.ceil(M / 32);
const bits = (c: number): Uint32Array => {
  const v = new Uint32Array(words);
  population.forEach((f, i) => {
    if (f[CA[c]!]! < f[CB[c]!]!) v[i >> 5]! |= 1 << (i & 31);
  });
  return v;
};
const popcount = (x: number): number => {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};
const pool = order.slice(0, 6000);
const vectors = new Map<number, Uint32Array>();
const chosen: number[] = [];
for (let threshold = 0.2; chosen.length < 256 && threshold < 1; threshold += 0.05) {
  for (const c of pool) {
    if (chosen.length >= 256) break;
    if (chosen.includes(c)) continue;
    let v = vectors.get(c);
    if (!v) vectors.set(c, (v = bits(c)));
    const n1 = ones[c]!;
    let ok = true;
    for (const d of chosen) {
      const w = vectors.get(d)!;
      let n11 = 0;
      for (let k = 0; k < words; k++) n11 += popcount(v[k]! & w[k]!);
      const m1 = ones[d]!;
      const phi = (M * n11 - n1 * m1) / Math.sqrt(n1 * (M - n1) * m1 * (M - m1));
      if (Math.abs(phi) >= threshold) {
        ok = false;
        break;
      }
    }
    if (ok) chosen.push(c);
  }
  console.log(`threshold ${threshold.toFixed(2)}: ${chosen.length} tests`);
}

const pattern = new Int8Array(1024);
chosen.forEach((c, i) => pattern.set([...POS[CA[c]!]!, ...POS[CB[c]!]!], 4 * i));
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const summary = {
  pairs: N,
  population: M,
  candidates: C,
  meanRandomFlip: mean(chosen.map((c) => 2 * (ones[c]! / M) * (1 - ones[c]! / M))),
  meanTrueFlip: mean(chosen.map((c) => 1 - agree[c]! / N)),
};
console.log(summary);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'pattern.json'), `${JSON.stringify({ ...summary, pattern: Array.from(pattern) })}\n`);
if (process.argv.includes('--write')) {
  const file = join('packages', 'features', 'src', 'generated', 'brief-pattern.ts');
  writeFileSync(
    file,
    `// Generated by bench/src/learn-pattern.ts (${FRAMES} frames per training texture, ${N} keypoint pairs). Do not edit.
/** Learned BRIEF tests, 256 × (ax, ay, bx, by): mean flip rate ${summary.meanRandomFlip.toFixed(3)} for random pairs, ${summary.meanTrueFlip.toFixed(3)} for true pairs. */
export const LEARNED_PATTERN: Int8Array = Int8Array.from([
${Array.from({ length: 64 }, (_, r) => `  ${Array.from(pattern.subarray(16 * r, 16 * r + 16)).join(', ')},`).join('\n')}
]);
`,
  );
  console.log(`written ${file}`);
}
