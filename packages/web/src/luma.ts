// SPDX-License-Identifier: Apache-2.0
// The standard gray image of a VideoFrame, in the orientation the user sees (orientation.ts). Planar YUV frames
// give their Y plane directly (no colour conversion); packed RGB frames are converted with the baseline's integer
// weights; opaque frames fall back to a 2D canvas (which draws them already oriented). The visible picture is
// resampled to the standard size: an exact 2:1 box average when upright, otherwise bilinear.

import type { GrayImage } from '@livemira-next/contracts';

import { DIAGNOSTICS } from './diagnostics.ts';
import { displaySize, rawFromDisplay, UPRIGHT, type Orientation, type Rotation } from './orientation.ts';

declare const __LIVEMIRA_DIAGNOSTICS__: boolean | undefined;

const YUV = new Set(['I420', 'I420A', 'I422', 'I444', 'NV12']);
const RGB: Readonly<Record<string, readonly [number, number, number]>> = {
  RGBA: [0, 1, 2],
  RGBX: [0, 1, 2],
  BGRA: [2, 1, 0],
  BGRX: [2, 1, 0],
};

export type LumaPath = 'yuv-plane' | 'rgb-convert' | 'canvas';

let scratch = new Uint8Array(0);
/** Gray picture of RGB frames before resampling, reused between frames. */
let grayScratch = new Uint8Array(0);
let canvas: OffscreenCanvas | null = null;

let boxed = new Uint8Array(0);

/**
 * The integer case of `resampleOriented` (the shown picture is 1, 2 or 4 times the output): an n × n box average in
 * raw orientation, then a quarter-turn or mirror by index steps, without interpolation. Equal to the bilinear path
 * for n = 1 and 2; a true box filter for n = 4.
 */
function orientedBox(
  src: Uint8Array,
  sw: number,
  sh: number,
  stride: number,
  n: number,
  width: number,
  height: number,
  out: Uint8Array,
  o: Orientation,
): void {
  const rw = sw / n;
  const rh = sh / n;
  let tmp = src;
  let ts = stride;
  if (n > 1) {
    if (boxed.length < rw * rh) boxed = new Uint8Array(rw * rh);
    const shift = n === 2 ? 2 : 4;
    const half = (n * n) >> 1;
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++) {
        let sum = 0;
        for (let j = 0; j < n; j++) {
          const row = (y * n + j) * stride + x * n;
          for (let i = 0; i < n; i++) sum += src[row + i]!;
        }
        boxed[y * rw + x] = (sum + half) >> shift;
      }
    tmp = boxed;
    ts = rw;
  }
  if (o.rotation === 0 && !o.flip) {
    for (let y = 0; y < height; y++) out.set(tmp.subarray(y * ts, y * ts + width), y * width);
    return;
  }
  // Pixel centres map to pixel centres: steps of ±1 or 0 per output pixel.
  const [a, b, c, d, e, f] = rawFromDisplay(rw, rh, o);
  const i0 = Math.round(0.5 * a + 0.5 * b + c - 0.5);
  const j0 = Math.round(0.5 * d + 0.5 * e + f - 0.5);
  for (let y = 0; y < height; y++) {
    let i = i0 + b * y;
    let j = j0 + e * y;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      out[row + x] = tmp[j * ts + i]!;
      i += a;
      j += d;
    }
  }
}

/**
 * Resamples a raw `sw` × `sh` picture (row length `stride`) into a `width` × `height` image of its shown orientation
 * `o` (exported for tests).
 */
export function resampleOriented(
  src: Uint8Array,
  sw: number,
  sh: number,
  stride: number,
  width: number,
  height: number,
  out: Uint8Array,
  o: Orientation = UPRIGHT,
): void {
  const [dw, dh] = displaySize(sw, sh, o);
  const n = dw / width;
  if ((n === 1 || n === 2 || n === 4) && dh === n * height && sw % n === 0 && sh % n === 0) {
    orientedBox(src, sw, sh, stride, n, width, height, out, o);
    return;
  }
  if (o.rotation !== 0 || o.flip) {
    const [dw, dh] = displaySize(sw, sh, o);
    const [a, b, c, d, e, f] = rawFromDisplay(sw, sh, o);
    const kx = dw / width;
    const ky = dh / height;
    for (let y = 0; y < height; y++) {
      const dy = (y + 0.5) * ky;
      for (let x = 0; x < width; x++) {
        const dx = (x + 0.5) * kx;
        const u = Math.min(sw - 1.001, Math.max(0, a * dx + b * dy + c - 0.5));
        const v = Math.min(sh - 1.001, Math.max(0, d * dx + e * dy + f - 0.5));
        const i = Math.floor(u);
        const j = Math.floor(v);
        const fx = u - i;
        const fy = v - j;
        const p = j * stride + i;
        const top = src[p]! + fx * (src[p + 1]! - src[p]!);
        const bottom = src[p + stride]! + fx * (src[p + stride + 1]! - src[p + stride]!);
        out[y * width + x] = (top + fy * (bottom - top) + 0.5) | 0;
      }
    }
    return;
  }
  const kx = sw / width;
  const ky = sh / height;
  for (let y = 0; y < height; y++) {
    const v = Math.min(sh - 1.001, Math.max(0, (y + 0.5) * ky - 0.5));
    const j = Math.floor(v);
    const fy = v - j;
    for (let x = 0; x < width; x++) {
      const u = Math.min(sw - 1.001, Math.max(0, (x + 0.5) * kx - 0.5));
      const i = Math.floor(u);
      const fx = u - i;
      const o = j * stride + i;
      const top = src[o]! + fx * (src[o + 1]! - src[o]!);
      const bottom = src[o + stride]! + fx * (src[o + stride + 1]! - src[o + stride]!);
      out[y * width + x] = (top + fy * (bottom - top) + 0.5) | 0;
    }
  }
}

/**
 * The frame's visible picture as a `width` × `height` gray image in its shown orientation `o` (the planes are raw;
 * the canvas fallback draws the frame already oriented), and how it was obtained.
 */
export async function lumaFromVideoFrame(
  frame: VideoFrame,
  width: number,
  height: number,
  out?: Uint8Array,
  o: Orientation = UPRIGHT,
): Promise<{ image: GrayImage; path: LumaPath }> {
  const data = out && out.length === width * height ? out : new Uint8Array(width * height);
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const format = frame.format;
  if (format && (YUV.has(format) || RGB[format])) {
    const size = frame.allocationSize({ rect });
    if (scratch.length < size) scratch = new Uint8Array(size);
    const layout = await frame.copyTo(scratch, { rect });
    const plane = layout[0]!;
    if (YUV.has(format)) {
      resampleOriented(scratch.subarray(plane.offset), rect.width, rect.height, plane.stride, width, height, data, o);
      return { image: { width, height, stride: width, data }, path: 'yuv-plane' };
    }
    const [r, g, b] = RGB[format]!;
    if (grayScratch.length < rect.width * rect.height) grayScratch = new Uint8Array(rect.width * rect.height);
    const gray = grayScratch;
    for (let y = 0; y < rect.height; y++) {
      const o = plane.offset + y * plane.stride;
      for (let x = 0; x < rect.width; x++) {
        const p = o + 4 * x;
        gray[y * rect.width + x] = (77 * scratch[p + r]! + 150 * scratch[p + g]! + 29 * scratch[p + b]! + 128) >> 8;
      }
    }
    resampleOriented(gray, rect.width, rect.height, rect.width, width, height, data, o);
    return { image: { width, height, stride: width, data }, path: 'rgb-convert' };
  }
  canvas ??= new OffscreenCanvas(width, height);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('No OffscreenCanvas 2D context for frame conversion');
  context.drawImage(frame, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  for (let i = 0; i < width * height; i++)
    data[i] = (77 * rgba[4 * i]! + 150 * rgba[4 * i + 1]! + 29 * rgba[4 * i + 2]! + 128) >> 8;
  return { image: { width, height, stride: width, data }, path: 'canvas' };
}

/** Normalised cross-correlation of two equally sized gray images. */
function ncc(a: Uint8Array, b: Uint8Array): number {
  const n = a.length;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i++) {
    sa += a[i]!;
    sb += b[i]!;
  }
  const ma = sa / n;
  const mb = sb / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

const toGray = (rgba: ArrayLike<number>, out: Uint8Array): Uint8Array => {
  for (let i = 0; i < out.length; i++)
    out[i] = (77 * rgba[4 * i]! + 150 * rgba[4 * i + 1]! + 29 * rgba[4 * i + 2]! + 128) >> 8;
  return out;
};

let canvas2d: OffscreenCanvas | null = null;

/** The frame as the browser draws it through a 2D canvas, `tw` × `th` gray. */
function drawn2d(frame: VideoFrame, tw: number, th: number): Uint8Array {
  canvas2d ??= new OffscreenCanvas(tw, th);
  canvas2d.width = tw;
  canvas2d.height = th;
  const context = canvas2d.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('no 2d context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(frame, 0, 0, tw, th);
  return toGray(context.getImageData(0, 0, tw, th).data, new Uint8Array(tw * th));
}

let webgl: { canvas: OffscreenCanvas; gl: WebGL2RenderingContext; texture: WebGLTexture } | null = null;

/**
 * The frame as the browser uploads it to WebGL (WebKit applies the camera rotation there), averaged down to
 * `tw` × `th` gray through mipmaps.
 */
function drawnWebgl(frame: VideoFrame, tw: number, th: number): Uint8Array {
  if (!webgl) {
    const canvas = new OffscreenCanvas(tw, th);
    const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('no webgl2 context');
    const shader = (type: number, source: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    // One triangle covering the viewport; the first texture row (top of the picture) at the top.
    gl.attachShader(
      program,
      shader(
        gl.VERTEX_SHADER,
        `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  uv = vec2(0.5 * p.x + 0.5, 0.5 - 0.5 * p.y);
}`,
      ),
    );
    gl.attachShader(
      program,
      shader(
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D picture;
out vec4 color;
void main() { color = texture(picture, uv); }`,
      ),
    );
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    gl.useProgram(program);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    webgl = { canvas, gl, texture };
  }
  const { canvas, gl, texture } = webgl;
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  gl.viewport(0, 0, tw, th);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const rgba = new Uint8Array(4 * tw * th);
  gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  // readPixels rows run bottom-up.
  const flipped = new Uint8Array(rgba.length);
  for (let y = 0; y < th; y++) flipped.set(rgba.subarray((th - 1 - y) * 4 * tw, (th - y) * 4 * tw), y * 4 * tw);
  return toGray(flipped, new Uint8Array(tw * th));
}

/** Raw planes under `o`, averaged down to `tw` × `th` (4×4 supersampling, comparable with the drawn thumbnails). */
function rawThumbnail(
  plane: Uint8Array,
  rw: number,
  rh: number,
  stride: number,
  tw: number,
  th: number,
  o: Orientation,
): Uint8Array {
  const big = new Uint8Array(16 * tw * th);
  resampleOriented(plane, rw, rh, stride, 4 * tw, 4 * th, big, o);
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let sum = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) sum += big[(4 * y + j) * 4 * tw + 4 * x + i]!;
      out[y * tw + x] = (sum + 8) >> 4;
    }
  return out;
}

export interface RotationReport {
  /** The rotation that one reference decided, or null. */
  readonly orientation: Orientation | null;
  readonly reference: '2d' | 'webgl' | null;
  readonly format: string | null;
  /** Visible size of the raw planes. */
  readonly raw: readonly [number, number];
  /** NCC of the raw planes under each candidate rotation against each reference (or the reference's error). */
  readonly scores: Readonly<Record<string, Readonly<Record<string, number>> | string>>;
  /** Thumbnails (gray, `size`), for diagnostics: the raw planes unrotated, and each reference. */
  readonly thumbnails?: { readonly size: readonly [number, number]; readonly [name: string]: unknown };
}

/**
 * The rotation that turns the frame's raw planes into the picture the user sees, for browsers that apply a camera
 * rotation without exposing it (WebKit). The raw luma under each rotation that fits the shown `width` × `height` is
 * compared with two renderings of the frame by the browser: a 2D canvas draw and a WebGL upload (WebKit rotates the
 * latter; the former has not been confirmed). Both sides come from the same frame, so the right rotation correlates
 * almost perfectly; a reference decides when its best rotation does (a featureless view or a reference that does
 * not rotate stays undecided).
 */
export async function detectRotation(
  frame: VideoFrame,
  width: number,
  height: number,
  thumbnails = false,
): Promise<RotationReport> {
  const format = frame.format;
  const rect = frame.visibleRect ?? { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
  const base = { format, raw: [rect.width, rect.height] as const };
  if (!format || !(YUV.has(format) || RGB[format]) || typeof OffscreenCanvas === 'undefined')
    return { ...base, orientation: null, reference: null, scores: {} };
  const tw = Math.max(16, Math.round(width / 8));
  const th = Math.max(16, Math.round(height / 8));
  const size = frame.allocationSize({ rect });
  if (scratch.length < size) scratch = new Uint8Array(size);
  const layout = (await frame.copyTo(scratch, { rect }))[0]!;
  // Raw luma: the Y plane, or gray converted from packed RGB.
  let raw = scratch.subarray(layout.offset);
  let plane = { stride: layout.stride };
  if (!YUV.has(format)) {
    const [r, g, b] = RGB[format]!;
    raw = new Uint8Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y++) {
      const o = layout.offset + y * layout.stride;
      for (let x = 0; x < rect.width; x++) {
        const p = o + 4 * x;
        raw[y * rect.width + x] = (77 * scratch[p + r]! + 150 * scratch[p + g]! + 29 * scratch[p + b]! + 128) >> 8;
      }
    }
    plane = { stride: rect.width };
  }
  const shownPortrait = height > width;
  const candidates = ([0, 90, 180, 270] as Rotation[])
    .map((rotation) => ({ rotation, flip: false }))
    .filter((o) => {
      const [dw, dh] = displaySize(rect.width, rect.height, o);
      return dh > dw === shownPortrait;
    })
    .map((o) => ({ o, thumb: rawThumbnail(raw, rect.width, rect.height, plane.stride, tw, th, o) }));
  const scores: Record<string, Record<string, number> | string> = {};
  const shots: Record<string, unknown> = {};
  let decided: { o: Orientation; reference: '2d' | 'webgl'; score: number } | null = null;
  for (const [reference, render] of [
    ['webgl', drawnWebgl],
    ['2d', drawn2d],
  ] as const) {
    let picture: Uint8Array;
    try {
      picture = render(frame, tw, th);
    } catch (e) {
      scores[reference] = `error: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`;
      continue;
    }
    if (DIAGNOSTICS && thumbnails) shots[reference] = Array.from(picture);
    const scored = candidates.map((c) => ({ o: c.o, score: ncc(c.thumb, picture) })).sort((p, q) => q.score - p.score);
    scores[reference] = Object.fromEntries(scored.map((c) => [`r${c.o.rotation}`, Math.round(c.score * 1000) / 1000]));
    const best = scored[0];
    const second = scored[1]?.score ?? -1;
    if (
      best &&
      best.score > 0.7 &&
      1 - second > 3 * (1 - best.score) + 0.02 &&
      (!decided || best.score > decided.score)
    )
      decided = { o: best.o, reference, score: best.score };
  }
  const report: RotationReport = {
    ...base,
    orientation: decided?.o ?? null,
    reference: decided?.reference ?? null,
    scores,
  };
  // Device-kit builds: the raw planes unrotated, at the same scale, and each reference. (The build flag itself, not
  // the imported constant: only a literal condition lets the bundler drop withThumbnails.)
  return typeof __LIVEMIRA_DIAGNOSTICS__ !== 'undefined' && __LIVEMIRA_DIAGNOSTICS__ && thumbnails
    ? withThumbnails(report, shots, raw, rect, plane.stride, [tw, th])
    : report;
}

function withThumbnails(
  report: RotationReport,
  shots: Record<string, unknown>,
  raw: Uint8Array,
  rect: { readonly width: number; readonly height: number },
  stride: number,
  [tw, th]: readonly [number, number],
): RotationReport {
  const k = Math.max(rect.width, rect.height) / Math.max(tw, th);
  const rawSize = [Math.round(rect.width / k), Math.round(rect.height / k)] as const;
  return {
    ...report,
    thumbnails: {
      size: [tw, th],
      rawSize,
      ...shots,
      raw: Array.from(rawThumbnail(raw, rect.width, rect.height, stride, rawSize[0], rawSize[1], UPRIGHT)),
    },
  };
}
