// SPDX-License-Identifier: Apache-2.0
// Target-anchored patch tracking (an alternative fast loop; no engine profile uses it). Around each anchor's predicted image position the template is warped into
// image space with the prior homography (so rotation and perspective are already compensated), then searched by
// zero-mean normalised cross-correlation within ±radius pixels; the peak is refined to sub-pixel by a parabola fit.
// Anchors are absolute target points, so the result does not drift.

import type { GrayImage } from '@livemira-next/contracts';
import { invert3 } from '@livemira-next/geometry';
import { sample } from '@livemira-next/imaging';

import type { TargetModel } from './target-model.ts';

export interface NccOptions {
  /** Patch half-size (patch side 2h + 1). */
  readonly halfSize?: number;
  /** Search radius, px. */
  readonly radius?: number;
  readonly minScore?: number;
}

export interface NccMatch {
  /** Interleaved target anchor coordinates and their matched image coordinates. */
  readonly target: Float64Array;
  readonly image: Float64Array;
  readonly score: Float64Array;
  readonly count: number;
}

const patch = new Float32Array(41 * 41);
const window = new Float32Array(81 * 81);

export function matchPatches(
  model: TargetModel,
  image: GrayImage,
  H: Float64Array,
  templateLevel: number,
  options: NccOptions = {},
): NccMatch {
  const h = Math.min(20, options.halfSize ?? 6);
  const radius = Math.min(20, options.radius ?? 8);
  const minScore = options.minScore ?? 0.7;
  const side = 2 * h + 1;
  const win = 2 * (h + radius) + 1;
  const Hinv = invert3(H);
  const template = model.pyramid.levels[templateLevel]!;
  const f = 2 ** templateLevel;
  const anchors = model.anchors;
  const n = anchors.length / 2;
  const target: number[] = [];
  const matched: number[] = [];
  const scores: number[] = [];
  if (!Hinv) return { target: new Float64Array(0), image: new Float64Array(0), score: new Float64Array(0), count: 0 };
  for (let k = 0; k < n; k++) {
    const ax = anchors[2 * k]!;
    const ay = anchors[2 * k + 1]!;
    const w0 = H[6]! * ax + H[7]! * ay + H[8]!;
    if (!(w0 > 0)) continue;
    const qx = (H[0]! * ax + H[1]! * ay + H[2]!) / w0;
    const qy = (H[3]! * ax + H[4]! * ay + H[5]!) / w0;
    const cx = Math.round(qx - 0.5) + 0.5;
    const cy = Math.round(qy - 0.5) + 0.5;
    if (
      cx - h - radius < 1 ||
      cy - h - radius < 1 ||
      cx + h + radius > image.width - 1 ||
      cy + h + radius > image.height - 1
    )
      continue;
    // Template patch warped into image space on the pixel grid around (cx, cy).
    let mean = 0;
    let valid = true;
    for (let j = 0, m = 0; j < side; j++)
      for (let i = 0; i < side; i++, m++) {
        const x = cx - h + i;
        const y = cy - h + j;
        const w = Hinv[6]! * x + Hinv[7]! * y + Hinv[8]!;
        const u = (Hinv[0]! * x + Hinv[1]! * y + Hinv[2]!) / w / f;
        const v = (Hinv[3]! * x + Hinv[4]! * y + Hinv[5]!) / w / f;
        const value = sample(template, u, v);
        if (Number.isNaN(value)) {
          valid = false;
          break;
        }
        patch[m] = value;
        mean += value;
      }
    if (!valid) continue;
    mean /= side * side;
    let norm = 0;
    for (let m = 0; m < side * side; m++) {
      patch[m]! -= mean;
      norm += patch[m]! ** 2;
    }
    if (norm < side * side * 25) continue;
    // Image window covering every shift.
    const x0 = cx - 0.5 - h - radius;
    const y0 = cy - 0.5 - h - radius;
    for (let j = 0; j < win; j++)
      for (let i = 0; i < win; i++) window[j * win + i] = image.data[(y0 + j) * image.stride + x0 + i]!;
    let best = -2;
    let bx = 0;
    let by = 0;
    const scoreAt = new Float32Array((2 * radius + 1) ** 2);
    for (let sy = 0; sy <= 2 * radius; sy++)
      for (let sx = 0; sx <= 2 * radius; sx++) {
        let sum = 0;
        let sum2 = 0;
        let cross = 0;
        for (let j = 0, m = 0; j < side; j++) {
          const row = (sy + j) * win + sx;
          for (let i = 0; i < side; i++, m++) {
            const v = window[row + i]!;
            sum += v;
            sum2 += v * v;
            cross += v * patch[m]!;
          }
        }
        const varI = sum2 - (sum * sum) / (side * side);
        const s = varI > 1e-6 ? cross / Math.sqrt(varI * norm) : -1;
        scoreAt[sy * (2 * radius + 1) + sx] = s;
        if (s > best) {
          best = s;
          bx = sx;
          by = sy;
        }
      }
    if (best < minScore || bx === 0 || by === 0 || bx === 2 * radius || by === 2 * radius) continue;
    const at = (x: number, y: number): number => scoreAt[y * (2 * radius + 1) + x]!;
    const dx = (at(bx - 1, by) - at(bx + 1, by)) / (2 * (at(bx - 1, by) - 2 * best + at(bx + 1, by)) || 1);
    const dy = (at(bx, by - 1) - at(bx, by + 1)) / (2 * (at(bx, by - 1) - 2 * best + at(bx, by + 1)) || 1);
    target.push(ax, ay);
    matched.push(
      cx + bx - radius + Math.max(-0.5, Math.min(0.5, dx)),
      cy + by - radius + Math.max(-0.5, Math.min(0.5, dy)),
    );
    scores.push(best);
  }
  return {
    target: Float64Array.from(target),
    image: Float64Array.from(matched),
    score: Float64Array.from(scores),
    count: scores.length,
  };
}
