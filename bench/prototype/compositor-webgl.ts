// SPDX-License-Identifier: Apache-2.0
// F1: frame-locked composition in one WebGL2 canvas. Each animation frame draws the newest processed camera frame and
// the overlay placed with that same frame's pose, so the overlay cannot drift against the picture behind it. The
// overlay quad is drawn with homogeneous clip coordinates (x·w, y·w, 0, w) from the homography, which makes the GPU
// interpolate its texture perspective-correctly.

import type { Corners } from '@livemira-next/contracts';

import {
  cornerUvs,
  frameOrientation,
  UPRIGHT,
  viewportFromStandard,
  type DisplayPose,
  type FitTransform,
} from '@livemira-next/web';

const VERTEX = `#version 300 es
in vec4 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() { gl_Position = aPosition; vUv = aUv; }`;

const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uAlpha;
out vec4 color;
void main() { color = vec4(texture(uTexture, vUv).rgb, uAlpha); }`;

export interface FrameLockedOptions {
  readonly standardWidth: number;
  readonly standardHeight: number;
  /** Overlay picture per target (drawn over the target rectangle); a built-in pattern when absent. */
  readonly overlays?: ReadonlyMap<string, TexImageSource>;
  readonly targetSizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  readonly overlayAlpha?: number;
}

export interface PresentedFrame {
  readonly frame: VideoFrame;
  readonly poses: readonly DisplayPose[];
  /** Caller data echoed back on presentation (e.g. a frame identifier for probes). */
  readonly tag?: unknown;
}

export class FrameLockedCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly buffer: WebGLBuffer;
  private readonly cameraTexture: WebGLTexture;
  private readonly overlayTextures = new Map<string, WebGLTexture>();
  private readonly options: FrameLockedOptions;
  /** Standard image size the poses are in; changes when the device turns (`setStandardSize`). */
  private standard: { width: number; height: number };
  private pending: PresentedFrame | null = null;
  private raf = 0;
  private fit: FitTransform | null = null;
  private readonly rawUploads = new Map<string, boolean>();
  /** Called after each draw with what was drawn; for diagnostics. */
  onPresent: ((presented: PresentedFrame, drawUs: number) => void) | null = null;
  readonly canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, options: FrameLockedOptions) {
    this.canvas = canvas;
    this.options = options;
    this.standard = { width: options.standardWidth, height: options.standardHeight };
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      desynchronized: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const shader = (type: number, source: string): WebGLShader => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, shader(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
    this.program = program;
    this.buffer = gl.createBuffer()!;
    this.cameraTexture = this.texture();
    for (const [id, size] of options.targetSizes) {
      const t = this.texture();
      const source = options.overlays?.get(id);
      if (source) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      else
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          2,
          2,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          Uint8Array.from([255, 80, 40, 255, 40, 200, 255, 255, 40, 200, 255, 255, 255, 80, 40, 255]),
        );
      void size;
      this.overlayTextures.set(id, t);
    }
  }

  private texture(): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /**
   * Whether `texImage2D` kept a quarter-turned frame's raw planes. Browsers differ, and Chromium even differs by frame
   * backing (buffer frames are uploaded oriented, canvas-backed ones raw), so the uploaded texture itself is checked:
   * a raw texture has the raw width, and a pixel there exists only then (reads outside leave the sentinel). Cached
   * per rotation, size and format. A half turn or a mirror alone cannot be told apart by size; those are taken as
   * uploaded oriented.
   */
  private uploadedRaw(frame: VideoFrame, rotation: number): boolean {
    const w = frame.visibleRect?.width ?? frame.codedWidth;
    const h = frame.visibleRect?.height ?? frame.codedHeight;
    if (rotation % 180 === 0 || w === h) return false;
    const key = `${rotation}|${w}x${h}|${frame.format}`;
    const known = this.rawUploads.get(key);
    if (known !== undefined) return known;
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.cameraTexture, 0);
    const pixel = new Uint8Array(4).fill(77);
    if (w > h) gl.readPixels(w - 1, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    else gl.readPixels(0, h - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    const raw = !(pixel[0] === 77 && pixel[3] === 77);
    this.rawUploads.set(key, raw);
    return raw;
  }

  /** Queues a processed frame; the newest replaces an undrawn older one (which is closed). */
  present(frame: PresentedFrame): void {
    this.pending?.frame.close();
    this.pending = frame;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  private quad(positions: readonly number[], uvs: readonly number[], texture: WebGLTexture, alpha: number): void {
    const gl = this.gl;
    const data = new Float32Array(24);
    for (let i = 0; i < 4; i++) {
      data.set(positions.slice(4 * i, 4 * i + 4), 6 * i);
      data.set(uvs.slice(2 * i, 2 * i + 2), 6 * i + 4);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    const position = gl.getAttribLocation(this.program, 'aPosition');
    const uv = gl.getAttribLocation(this.program, 'aUv');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 24, 16);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uAlpha'), alpha);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  private draw(): void {
    this.raf = 0;
    const presented = this.pending;
    if (!presented) return;
    this.pending = null;
    const started = performance.now();
    const gl = this.gl;
    const canvas = this.canvas;
    const dpr = globalThis.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
      this.fit = null;
    }
    this.fit ??= viewportFromStandard(this.standard.width, this.standard.height, cw, ch, 'cover');
    const fit = this.fit;
    gl.viewport(0, 0, cw, ch);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cameraTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, presented.frame);
    // Background: the standard image rectangle mapped into the viewport (cover), in clip coordinates.
    const ndc = (x: number, y: number): [number, number] => [
      (2 * (fit.scale * x + fit.offsetX)) / cw - 1,
      1 - (2 * (fit.scale * y + fit.offsetY)) / ch,
    ];
    const sw = this.standard.width;
    const sh = this.standard.height;
    const corners = [ndc(0, 0), ndc(sw, 0), ndc(sw, sh), ndc(0, sh)];
    gl.disable(gl.BLEND);
    // A raw upload is sampled through the frame's orientation, so the background shows what the user should see.
    const meta = frameOrientation(presented.frame);
    const orientation = meta && this.uploadedRaw(presented.frame, meta.rotation) ? meta : UPRIGHT;
    this.quad(
      corners.flatMap(([x, y]) => [x, y, 0, 1]),
      cornerUvs(orientation),
      this.cameraTexture,
      1,
    );
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    for (const pose of presented.poses) {
      const texture = this.overlayTextures.get(pose.targetId);
      if (!texture) continue;
      this.quad(this.clipQuad(pose.corners, ndc), [0, 0, 1, 0, 1, 1, 0, 1], texture, this.options.overlayAlpha ?? 0.6);
    }
    presented.frame.close();
    this.onPresent?.(presented, (performance.now() - started) * 1000);
  }

  /**
   * Homogeneous clip coordinates of the corners. With the diagonals meeting at p0 + s·(p2 − p0) = p1 + t·(p3 − p1),
   * the projective weights are q = 1/(1−s), 1/(1−t), 1/s, 1/t; giving each corner the clip w = 1/q makes the GPU's
   * perspective-correct interpolation reproduce the projective mapping across both triangles.
   */
  private clipQuad(c: Corners, ndc: (x: number, y: number) => [number, number]): number[] {
    const p = c.map(([x, y]) => ndc(x, y));
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = p as [
      [number, number],
      [number, number],
      [number, number],
      [number, number],
    ];
    const d = (x2 - x0) * (y3 - y1) - (y2 - y0) * (x3 - x1);
    const s = ((x1 - x0) * (y3 - y1) - (y1 - y0) * (x3 - x1)) / d;
    const t = ((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)) / d;
    const w = [1 - s, 1 - t, s, t];
    if (!w.every((v) => Number.isFinite(v) && v > 1e-6)) return p.flatMap(([x, y]) => [x, y, 0, 1]);
    return p.flatMap(([x, y], i) => [x * w[i]!, y * w[i]!, 0, w[i]!]);
  }

  /** The shown picture changed shape (the device turned): later poses are in a `width` × `height` standard image. */
  setStandardSize(width: number, height: number): void {
    this.standard = { width, height };
    this.fit = null;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.pending?.frame.close();
    this.pending = null;
  }
}
