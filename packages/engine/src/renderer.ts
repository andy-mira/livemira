// SPDX-License-Identifier: Apache-2.0
// The stage: one WebGL2 canvas that draws the newest processed camera frame and, over it, each target's plane placed
// with that same frame's pose (frame-locked: the plane cannot drift against the picture). Planes are drawn with
// homogeneous clip coordinates from the homography, so everything on them (video, loading region, ring, the reveal
// circle) is perspective-correct and anti-aliased in the target's own coordinates. Between camera frames the last frame is
// redrawn whenever a plane animates or its video has a new frame, so effects run at the display's rate.

import type { Corners } from '@livemira-next/contracts';
import { cornerUvs, frameOrientation, UPRIGHT, viewportFromStandard } from '@livemira-next/web';

import type { MediaPlayer } from './media.ts';
import type { PlaneLook } from './presenter.ts';

const QUAD_VERTEX = `#version 300 es
in vec4 aPosition;
in vec2 aUv;
out vec2 vUv;
void main() { gl_Position = aPosition; vUv = aUv; }`;

const CAMERA_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTexture;
out vec4 color;
void main() { color = vec4(texture(uTexture, vUv).rgb, 1.0); }`;

const PLANE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo;
uniform float uHasVideo;
uniform vec4 uVideoRect;
uniform float uAspect;
uniform float uAlpha;
uniform float uVeil;
uniform float uReveal;
uniform float uWave;
uniform float uRing;
uniform float uRingProgress;
uniform float uSpin;
uniform float uPlay;
uniform float uGlow;
uniform vec3 uAccent;
out vec4 color;

const float PI = 3.14159265;

float aastep(float edge, float x) {
  float w = max(fwidth(x), 1e-5);
  return smoothstep(edge - w, edge + w, x);
}

// Equilateral triangle (side 2) pointing towards +x in the plane; negative inside.
float triangle(vec2 p) {
  p = vec2(p.y, p.x);
  const float k = 1.7320508;
  p.x = abs(p.x) - 1.0;
  p.y = p.y + 1.0 / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0, 0.0);
  return -length(p) * sign(p.y);
}

void over(inout vec3 rgb, inout float a, vec3 c, float ca) {
  rgb = c * ca + rgb * (1.0 - ca);
  a = ca + a * (1.0 - ca);
}

void main() {
  // Target coordinates: height 1, width uAspect, y down. The video region is the video's rect clipped to the photo;
  // q is relative to its centre.
  vec2 scale = vec2(uAspect, 1.0);
  vec4 visible = clamp(uVideoRect, 0.0, 1.0);
  vec2 halfSize = 0.5 * (visible.zw - visible.xy) * scale;
  vec2 q = (vUv - 0.5 * (visible.xy + visible.zw)) * scale;
  float shortEdge = 2.0 * min(halfSize.x, halfSize.y);
  float r = length(q);
  float corner = length(halfSize);

  // The reveal: a soft circle from the region's centre to past its farthest corner.
  float feather = 0.07 * shortEdge;
  float R = uReveal * (corner + feather);
  float inside = uReveal >= 1.0 ? 1.0 : 1.0 - smoothstep(R - feather, R, r);

  vec2 vuv = (vUv - uVideoRect.xy) / (uVideoRect.zw - uVideoRect.xy);
  vec2 d = min(vuv, 1.0 - vuv);
  float inRect = aastep(0.0, min(d.x, d.y));
  vec3 rgb = vec3(0.0);
  float a = 0.0;
  if (uHasVideo > 0.5) {
    float va = inRect * inside;
    // Inset by a fraction of a texel: codecs often leave a stray colour in the outermost row and column.
    rgb = texture(uVideo, clamp(vuv, 0.002, 0.998)).rgb * va;
    a = va;
  }
  // The region outside the revealed circle: dark and see-through while the video is on the way.
  over(rgb, a, vec3(0.0), uVeil * inRect * (1.0 - inside));

  // Recognition glow along the photo's edges, falling off inwards.
  float edge = min(min(vUv.x, 1.0 - vUv.x) * uAspect, min(vUv.y, 1.0 - vUv.y));
  float glow = uGlow * exp(-edge / (0.045 * min(uAspect, 1.0)));
  over(rgb, a, uAccent, 0.85 * glow);

  // Wavefront riding the reveal edge, inside the region: a thin white core in an accent halo.
  float x = r - (R - 0.5 * feather);
  float halo = uWave * inRect * exp(-pow(x / (0.9 * feather), 2.0));
  float core = uWave * inRect * exp(-pow(x / (0.22 * feather), 2.0));
  over(rgb, a, uAccent, clamp(0.75 * halo, 0.0, 1.0));
  over(rgb, a, vec3(1.0), clamp(0.9 * core, 0.0, 1.0));

  // Loading ring: a faint track and an arc (progress from the top, clockwise, or a spinning segment).
  float ringR = 0.1 * shortEdge;
  float ringW = 0.014 * shortEdge;
  float stroke = 1.0 - aastep(ringW, abs(r - ringR));
  float turn = fract(atan(q.x, -q.y) / (2.0 * PI) + 1.0);
  float arc;
  if (uRingProgress >= 0.0) arc = 1.0 - aastep(uRingProgress, turn);
  else arc = 1.0 - aastep(0.3, fract(turn - fract(uSpin) + 1.0));
  over(rgb, a, vec3(0.0), uRing * 0.28 * (1.0 - aastep(ringR + 2.5 * ringW, r)));
  over(rgb, a, vec3(1.0), uRing * stroke * (0.3 + 0.7 * arc));

  // Play mark (playback needs a tap): a dark disc with a white triangle.
  float disc = 1.0 - aastep(ringR * 1.25, r);
  over(rgb, a, vec3(0.0), uPlay * 0.45 * disc);
  float tri = 1.0 - aastep(0.0, triangle((q + vec2(0.12 * ringR, 0.0)) / (0.45 * ringR)));
  over(rgb, a, vec3(1.0), uPlay * tri);

  // Anti-aliased plane edges.
  vec2 e = min(vUv, 1.0 - vUv);
  vec2 w = max(fwidth(vUv), vec2(1e-5));
  float edgeAA = clamp(min(e.x / w.x, e.y / w.y), 0.0, 1.0);
  color = vec4(rgb, a) * (uAlpha * edgeAA);
}`;

export interface Plane {
  readonly targetId: string;
  /** In the standard image of the frame on screen. */
  readonly corners: Corners;
  readonly targetAspect: number;
  /** `look.aspect` gives the video region's shape. */
  readonly look: PlaneLook;
  readonly player: MediaPlayer | null;
  readonly fit: 'contain' | 'cover' | 'fill';
}

export interface StageOptions {
  readonly fit: 'cover' | 'contain';
  /** Linear RGB 0..1. */
  readonly accent: readonly [number, number, number];
  /** Planes to draw now (called once per drawn display frame). */
  readonly planes: (now: number) => readonly Plane[];
}

/** Where the video sits in the target, in target UV (u0, v0, u1, v1). */
export function videoRect(
  targetAspect: number,
  videoAspect: number,
  fit: Plane['fit'],
): [number, number, number, number] {
  if (fit === 'fill' || !(videoAspect > 0) || !(targetAspect > 0)) return [0, 0, 1, 1];
  const wider = videoAspect > targetAspect;
  // contain: the video's long side fits; cover: its short side does.
  const fraction = wider === (fit === 'contain') ? targetAspect / videoAspect : videoAspect / targetAspect;
  if (wider === (fit === 'contain')) return [0, (1 - fraction) / 2, 1, (1 + fraction) / 2];
  return [(1 - fraction) / 2, 0, (1 + fraction) / 2, 1];
}

interface Programs {
  readonly camera: WebGLProgram;
  readonly plane: WebGLProgram;
  readonly buffer: WebGLBuffer;
  readonly cameraTexture: WebGLTexture;
  readonly uniforms: Map<string, WebGLUniformLocation | null>;
}

export class StageRenderer {
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private programs: Programs | null = null;
  private readonly videoTextures = new Map<MediaPlayer, WebGLTexture>();
  private readonly options: StageOptions;
  private standard: { width: number; height: number };
  private hasFrame = false;
  private dirty = false;
  private raf = 0;
  private disposed = false;
  private readonly rawUploads = new Map<string, boolean>();
  private cameraUvs: number[] = cornerUvs(UPRIGHT);
  private isContextLost = false;

  constructor(parent: HTMLElement, standardWidth: number, standardHeight: number, options: StageOptions) {
    this.options = options;
    this.standard = { width: standardWidth, height: standardHeight };
    const canvas = parent.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      zIndex: '1',
      display: 'block',
      pointerEvents: 'none',
    });
    parent.append(canvas);
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
    if (!gl) {
      canvas.remove();
      throw new Error('WebGL2 unavailable');
    }
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.programs = this.createPrograms();
    this.loop();
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.isContextLost = true;
    this.programs = null;
    this.videoTextures.clear();
    this.hasFrame = false;
  };

  private readonly onContextRestored = (): void => {
    this.isContextLost = false;
    this.rawUploads.clear();
    this.programs = this.createPrograms();
  };

  private createPrograms(): Programs {
    const gl = this.gl;
    const compile = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
      return shader;
    };
    const link = (fragment: string): WebGLProgram => {
      const program = gl.createProgram()!;
      gl.attachShader(program, compile(gl.VERTEX_SHADER, QUAD_VERTEX));
      gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
      gl.bindAttribLocation(program, 0, 'aPosition');
      gl.bindAttribLocation(program, 1, 'aUv');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'link');
      return program;
    };
    const plane = link(PLANE_FRAGMENT);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    for (const name of [
      'uVideo',
      'uHasVideo',
      'uVideoRect',
      'uAspect',
      'uAlpha',
      'uVeil',
      'uReveal',
      'uWave',
      'uRing',
      'uRingProgress',
      'uSpin',
      'uPlay',
      'uGlow',
      'uAccent',
    ])
      uniforms.set(name, gl.getUniformLocation(plane, name));
    return {
      camera: link(CAMERA_FRAGMENT),
      plane,
      buffer: gl.createBuffer()!,
      cameraTexture: this.texture(),
      uniforms,
    };
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
   * Whether `texImage2D` kept a quarter-turned frame's raw planes. Browsers differ (Chromium even by frame backing),
   * so the uploaded texture is checked: a raw texture has the raw width, and a pixel there exists only then.
   */
  private uploadedRaw(frame: VideoFrame, rotation: number, texture: WebGLTexture): boolean {
    const w = frame.visibleRect?.width ?? frame.codedWidth;
    const h = frame.visibleRect?.height ?? frame.codedHeight;
    if (rotation % 180 === 0 || w === h) return false;
    const key = `${rotation}|${w}x${h}|${frame.format}`;
    const known = this.rawUploads.get(key);
    if (known !== undefined) return known;
    const gl = this.gl;
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixel = new Uint8Array(4).fill(77);
    if (w > h) gl.readPixels(w - 1, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    else gl.readPixels(0, h - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    const raw = !(pixel[0] === 77 && pixel[3] === 77);
    this.rawUploads.set(key, raw);
    return raw;
  }

  /**
   * A processed camera frame becomes the picture on screen (uploaded now and closed); the planes the next draw asks
   * for must be in this frame's standard image.
   */
  presentFrame(frame: VideoFrame): void {
    const programs = this.programs;
    if (!programs || this.disposed) {
      frame.close();
      return;
    }
    const gl = this.gl;
    try {
      gl.bindTexture(gl.TEXTURE_2D, programs.cameraTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
      const meta = frameOrientation(frame);
      const orientation = meta && this.uploadedRaw(frame, meta.rotation, programs.cameraTexture) ? meta : UPRIGHT;
      this.cameraUvs = cornerUvs(orientation);
      this.hasFrame = true;
      this.dirty = true;
    } finally {
      frame.close();
    }
  }

  setStandardSize(width: number, height: number): void {
    this.standard = { width, height };
    this.dirty = true;
  }

  /** Draw again at the next display frame even if nothing seems to change (e.g. a plane appeared). */
  invalidate(): void {
    this.dirty = true;
  }

  private loop(): void {
    this.raf = requestAnimationFrame((now) => {
      if (this.disposed) return;
      this.loop();
      this.draw(now);
    });
  }

  private draw(now: number): void {
    const programs = this.programs;
    if (!programs || this.isContextLost || !this.hasFrame) return;
    const planes = this.options.planes(now);
    const moving = planes.some((p) => p.look.isAnimating || (p.look.showVideo && p.player?.frameDirty));
    const canvas = this.canvas;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const ch = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const resized = canvas.width !== cw || canvas.height !== ch;
    if (!this.dirty && !moving && !resized) return;
    this.dirty = false;
    if (resized) {
      canvas.width = cw;
      canvas.height = ch;
    }
    const gl = this.gl;
    const fit = viewportFromStandard(this.standard.width, this.standard.height, cw, ch, this.options.fit);
    const ndc = (x: number, y: number): [number, number] => [
      (2 * (fit.scale * x + fit.offsetX)) / cw - 1,
      1 - (2 * (fit.scale * y + fit.offsetY)) / ch,
    ];
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.BLEND);
    gl.useProgram(programs.camera);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, programs.cameraTexture);
    const sw = this.standard.width;
    const sh = this.standard.height;
    this.quad(
      [ndc(0, 0), ndc(sw, 0), ndc(sw, sh), ndc(0, sh)].flatMap(([x, y]) => [x, y, 0, 1]),
      this.cameraUvs,
    );
    if (!planes.length) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(programs.plane);
    const u = (name: string): WebGLUniformLocation | null => programs.uniforms.get(name) ?? null;
    gl.uniform1i(u('uVideo'), 0);
    gl.uniform3f(u('uAccent'), ...this.options.accent);
    for (const plane of planes) {
      const look = plane.look;
      if (look.alpha <= 0) continue;
      let hasVideo = 0;
      if (look.showVideo && plane.player?.hasPicture) {
        const texture = this.videoTexture(plane.player);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (plane.player.frameDirty) {
          plane.player.frameDirty = false;
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plane.player.video);
          } catch {
            // A tainted or not yet decodable frame: keep the previous one.
          }
        }
        hasVideo = 1;
      }
      gl.uniform1f(u('uHasVideo'), hasVideo);
      gl.uniform4f(u('uVideoRect'), ...videoRect(plane.targetAspect, look.aspect, plane.fit));
      gl.uniform1f(u('uAspect'), plane.targetAspect);
      gl.uniform1f(u('uAlpha'), look.alpha);
      gl.uniform1f(u('uVeil'), look.veil);
      gl.uniform1f(u('uReveal'), look.reveal);
      gl.uniform1f(u('uWave'), look.wave);
      gl.uniform1f(u('uRing'), look.ring);
      gl.uniform1f(u('uRingProgress'), look.ringProgress);
      gl.uniform1f(u('uSpin'), look.spin);
      gl.uniform1f(u('uPlay'), look.play);
      gl.uniform1f(u('uGlow'), look.glow);
      this.quad(this.clipQuad(plane.corners, ndc), [0, 0, 1, 0, 1, 1, 0, 1]);
    }
  }

  private videoTexture(player: MediaPlayer): WebGLTexture {
    let texture = this.videoTextures.get(player);
    if (!texture) {
      texture = this.texture();
      this.videoTextures.set(player, texture);
      player.frameDirty = true;
    }
    return texture;
  }

  /** The player is gone: its texture is released. */
  forget(player: MediaPlayer): void {
    const texture = this.videoTextures.get(player);
    if (texture) this.gl.deleteTexture(texture);
    this.videoTextures.delete(player);
  }

  private quad(positions: readonly number[], uvs: readonly number[]): void {
    const gl = this.gl;
    const data = new Float32Array(24);
    for (let i = 0; i < 4; i++) {
      data.set(positions.slice(4 * i, 4 * i + 4), 6 * i);
      data.set(uvs.slice(2 * i, 2 * i + 2), 6 * i + 4);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.programs!.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 24, 16);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }

  /**
   * Homogeneous clip coordinates of the corners. With the diagonals meeting at p0 + s·(p2 − p0) = p1 + t·(p3 − p1),
   * giving the corners the clip w = 1 − s, 1 − t, s, t makes the GPU's perspective-correct interpolation reproduce
   * the projective mapping across both triangles.
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
}
