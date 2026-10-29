"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // packages/imaging/src/pyramid.ts
  var PyramidWorkspace = class {
    constructor() {
      __publicField(this, "rows", new Int32Array(0));
      __publicField(this, "levels", []);
    }
    /** Builds up to `levels` levels (stopping before a side drops below `minSize`); level 0 is the input itself. */
    build(image, levels, minSize = 24) {
      const out = [{ ...image, scale: 1 }];
      for (let l = 1; l < levels; l++) {
        const prev = out[l - 1];
        const w = prev.width >> 1;
        const h = prev.height >> 1;
        if (w < minSize || h < minSize) break;
        if (this.rows.length < prev.width * h) this.rows = new Int32Array(prev.width * h);
        const buf = this.levels[l] = this.levels[l] && this.levels[l].length === w * h ? this.levels[l] : new Uint8Array(w * h);
        downsample(prev, w, h, this.rows, buf);
        out.push({ width: w, height: h, stride: w, data: buf, scale: prev.scale * 2 });
      }
      return { levels: out };
    }
  };
  function downsample(src, w, h, rows, dst) {
    const sw = src.width;
    const sh = src.height;
    const s = src.data;
    const stride = src.stride;
    for (let y = 0; y < h; y++) {
      const c = 2 * y;
      const r0 = Math.max(0, c - 1) * stride;
      const r1 = c * stride;
      const r2 = Math.min(sh - 1, c + 1) * stride;
      const r3 = Math.min(sh - 1, c + 2) * stride;
      const o = y * sw;
      for (let x = 0; x < sw; x++) rows[o + x] = s[r0 + x] + 3 * s[r1 + x] + 3 * s[r2 + x] + s[r3 + x];
    }
    for (let y = 0; y < h; y++) {
      const o = y * sw;
      for (let x = 0; x < w; x++) {
        const c = 2 * x;
        const a = rows[o + Math.max(0, c - 1)];
        const b = rows[o + c];
        const d = rows[o + Math.min(sw - 1, c + 1)];
        const e = rows[o + Math.min(sw - 1, c + 2)];
        dst[y * w + x] = a + 3 * b + 3 * d + e + 32 >> 6;
      }
    }
  }
  function buildPyramid(image, levels, minSize = 24) {
    return new PyramidWorkspace().build(image, levels, minSize);
  }

  // packages/imaging/src/sample.ts
  function sample(image, x, y) {
    const u = x - 0.5;
    const v = y - 0.5;
    const i = Math.floor(u);
    const j = Math.floor(v);
    if (i < 0 || j < 0 || i + 1 >= image.width || j + 1 >= image.height) return NaN;
    const fx = u - i;
    const fy = v - j;
    const d = image.data;
    const o = j * image.stride + i;
    const top = d[o] + fx * (d[o + 1] - d[o]);
    const bottom = d[o + image.stride] + fx * (d[o + image.stride + 1] - d[o + image.stride]);
    return top + fy * (bottom - top);
  }

  // packages/features/src/generated/kernels-wasm.ts
  var KERNELS_WASM = Object.freeze({
    sha256: "d51fe1439175bb1343361385d7910036f36a63ed17a83311619a3b04cfa3e837",
    byteLength: 4375,
    base64: "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"
  });

  // packages/features/src/kernels.ts
  function decode(base64) {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  }
  var compiled;
  function instantiateKernels() {
    if (typeof WebAssembly === "undefined") return null;
    try {
      if (compiled === void 0) {
        const bytes = decode(KERNELS_WASM.base64);
        compiled = WebAssembly.validate(bytes) ? new WebAssembly.Module(bytes) : null;
      }
      return compiled ? new WebAssembly.Instance(compiled, {}).exports : null;
    } catch {
      compiled = null;
      return null;
    }
  }

  // packages/features/src/fast.ts
  var CIRCLE = [
    [0, -3],
    [1, -3],
    [2, -2],
    [3, -1],
    [3, 0],
    [3, 1],
    [2, 2],
    [1, 3],
    [0, 3],
    [-1, 3],
    [-2, 2],
    [-3, 1],
    [-3, 0],
    [-3, -1],
    [-2, -2],
    [-1, -3]
  ];
  function fastScore(d, o, offsets, t) {
    const c = d[o];
    const hi = c + t;
    const lo = c - t;
    const p0 = d[o + offsets[0]];
    const p8 = d[o + offsets[8]];
    if (p0 <= hi && p0 >= lo && p8 <= hi && p8 >= lo) return 0;
    const p4 = d[o + offsets[4]];
    const p12 = d[o + offsets[12]];
    if (p4 <= hi && p4 >= lo && p12 <= hi && p12 >= lo) return 0;
    let bright = 0;
    let dark = 0;
    let sb = 0;
    let sd = 0;
    for (let i = 0; i < 16; i++) {
      const p = d[o + offsets[i]];
      if (p > hi) {
        bright |= 1 << i;
        sb += p - hi;
      } else if (p < lo) {
        dark |= 1 << i;
        sd += lo - p;
      }
    }
    if (arc9(bright)) return sb + 1;
    if (arc9(dark)) return sd + 1;
    return 0;
  }
  function arc9(mask) {
    if (!mask) return false;
    const m = (mask | mask << 16) >>> 0;
    let acc = m;
    for (let s = 1; s < 9; s++) acc &= m >>> s;
    return acc !== 0;
  }
  var JsFastScorer = class {
    constructor() {
      __publicField(this, "backend", "js");
      __publicField(this, "map", new Uint16Array(0));
      __publicField(this, "image", null);
      __publicField(this, "offsets", new Int32Array(16));
    }
    begin(image) {
      if (this.map.length < image.width * image.height) this.map = new Uint16Array(image.width * image.height);
      this.image = image;
      this.offsets = Int32Array.from(CIRCLE.map(([dx, dy]) => dy * image.stride + dx));
      return this.map;
    }
    score(x0, y0, x1, y1, t, found) {
      const { width: w, stride, data: d } = this.image;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const s = fastScore(d, y * stride + x, this.offsets, t);
          if (s > 0) {
            this.map[y * w + x] = s;
            found.push(y * w + x);
          }
        }
    }
  };
  var WasmFastScorer = class {
    constructor(kernel) {
      __publicField(this, "backend", "wasm-simd");
      __publicField(this, "k");
      __publicField(this, "capacity", 0);
      __publicField(this, "img", 0);
      __publicField(this, "scores", 0);
      __publicField(this, "found", 0);
      __publicField(this, "map", new Uint16Array(0));
      __publicField(this, "image", null);
      this.k = kernel;
    }
    begin(image) {
      const bytes = image.stride * image.height;
      if (bytes > this.capacity) {
        const k = this.k;
        k.reset_heap();
        this.img = k.reserve(bytes + 16);
        this.scores = k.reserve(2 * bytes);
        this.found = k.reserve(4 * bytes);
        if (!this.img || !this.scores || !this.found) throw new Error("fast9: out of memory");
        this.capacity = bytes;
        new Uint16Array(k.memory.buffer, this.scores, bytes).fill(0);
      }
      new Uint8Array(this.k.memory.buffer, this.img, bytes).set(image.data.subarray(0, bytes));
      this.map = new Uint16Array(this.k.memory.buffer, this.scores, image.width * image.height);
      this.image = image;
      return this.map;
    }
    score(x0, y0, x1, y1, t, found) {
      const image = this.image;
      const n = this.k.fast9(this.img, image.stride, x0, y0, x1, y1, t, this.scores, image.width, this.found);
      const indices = new Uint32Array(this.k.memory.buffer, this.found, n);
      for (let i = 0; i < n; i++) found.push(indices[i]);
    }
  };
  function selfTest(kernel) {
    const width = 61;
    const height = 47;
    const data = new Uint8Array(width * height);
    let s = 2654435769;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const noise = (s >>> 0) % 64;
        data[y * width + x] = x < 20 ? 128 : x < 40 ? ((x >> 2) + (y >> 2)) % 2 ? 230 - noise : 20 + noise : noise * 4;
      }
    const image = { width, height, stride: width, data };
    const reference = new JsFastScorer();
    for (const t of [4, 16, 40]) {
      const a = [];
      const b = [];
      const ma = reference.begin(image);
      const mb = kernel.begin(image);
      reference.score(3, 3, width - 18, height - 3, t, a);
      kernel.score(3, 3, width - 18, height - 3, t, b);
      if (a.length !== b.length || a.some((v, i) => v !== b[i] || ma[v] !== mb[v])) return false;
      for (const i of a) ma[i] = 0;
      for (const i of b) mb[i] = 0;
      if (t === 16 && a.length < 10) return false;
    }
    return true;
  }
  var shared = null;
  function fastScorer(allowWasm = true) {
    if (!shared) {
      const kernel = instantiateKernels();
      let wasm = null;
      try {
        wasm = kernel ? new WasmFastScorer(kernel) : null;
        if (wasm && !selfTest(wasm)) wasm = null;
      } catch {
        wasm = null;
      }
      shared = { wasm, js: new JsFastScorer() };
    }
    return allowWasm && shared.wasm || shared.js;
  }

  // packages/features/src/orb.ts
  var PATCH = 15;
  var BORDER = PATCH + 3;
  var ANGLE_BINS = 32;
  var GAUSSIAN_PATTERN = (() => {
    let s = 625341585;
    const uniform = () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return (s + 0.5) / 4294967296;
    };
    const gauss = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
    const out = new Int8Array(1024);
    for (let i = 0; i < 256; ) {
      const p = [0, 1, 2, 3].map(() => Math.round(gauss() * 8.5));
      if (Math.hypot(p[0], p[1]) > 15 || Math.hypot(p[2], p[3]) > 15 || Math.hypot(p[0] - p[2], p[1] - p[3]) < 2)
        continue;
      out.set(p, 4 * i);
      i++;
    }
    return out;
  })();
  var PATTERN_VERSION = 2;
  function steer(pattern) {
    return Array.from({ length: ANGLE_BINS }, (_, b) => {
      const a = 2 * Math.PI * b / ANGLE_BINS;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const out = new Int8Array(1024);
      for (let i = 0; i < 512; i++) {
        const x = pattern[2 * i];
        const y = pattern[2 * i + 1];
        out[2 * i] = Math.round(c * x - sn * y);
        out[2 * i + 1] = Math.round(sn * x + c * y);
      }
      return out;
    });
  }
  var STEERED = /* @__PURE__ */ new WeakMap();
  function steered(pattern) {
    let s = STEERED.get(pattern);
    if (!s) {
      let ok = pattern.length === 1024;
      for (let i = 0; i < 512 && ok; i++) ok = Math.hypot(pattern[2 * i], pattern[2 * i + 1]) <= 15;
      if (!ok) throw new Error("BRIEF pattern: 256 tests with box centres within 15 px");
      s = steer(pattern);
      STEERED.set(pattern, s);
    }
    return s;
  }
  var UMAX = (() => {
    const u = new Int32Array(PATCH + 1);
    for (let v = 0; v <= PATCH; v++) u[v] = Math.floor(Math.sqrt(PATCH * PATCH - v * v) + 0.5);
    return u;
  })();
  var OrbWorkspace = class {
    constructor() {
      __publicField(this, "octaves", new PyramidWorkspace());
      __publicField(this, "halfOctaves", new PyramidWorkspace());
      __publicField(this, "horizontal", new Uint16Array(0));
      __publicField(this, "blur", new Uint8Array(0));
      __publicField(this, "half", new Uint8Array(0));
      __publicField(this, "integral", new Int32Array(0));
    }
  };
  var WORKSPACE = new OrbWorkspace();
  function halfOctave(src, ws) {
    const sw = src.width;
    const sh = src.height;
    const w = Math.floor(sw / Math.SQRT2);
    const h = Math.floor(sh / Math.SQRT2);
    const d = src.data;
    if (ws.horizontal.length < sw * sh) {
      ws.horizontal = new Uint16Array(sw * sh);
      ws.blur = new Uint8Array(sw * sh);
    }
    if (ws.half.length !== w * h) ws.half = new Uint8Array(w * h);
    const horizontal = ws.horizontal;
    for (let y = 0; y < sh; y++) {
      const o = y * src.stride;
      const r = y * sw;
      horizontal[r] = 3 * d[o] + d[o + 1];
      for (let x = 1; x < sw - 1; x++) horizontal[r + x] = d[o + x - 1] + 2 * d[o + x] + d[o + x + 1];
      horizontal[r + sw - 1] = d[o + sw - 2] + 3 * d[o + sw - 1];
    }
    const blur = ws.blur;
    for (let y = 0; y < sh; y++) {
      const a = Math.max(0, y - 1) * sw;
      const b = y * sw;
      const c = Math.min(sh - 1, y + 1) * sw;
      for (let x = 0; x < sw; x++)
        blur[b + x] = horizontal[a + x] + 2 * horizontal[b + x] + horizontal[c + x] + 8 >> 4;
    }
    const xi = new Int32Array(w);
    const xf = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const sx = (x + 0.5) * Math.SQRT2 - 0.5;
      xi[x] = Math.min(sw - 2, Math.max(0, Math.floor(sx)));
      xf[x] = sx - xi[x];
    }
    const out = ws.half;
    for (let y = 0; y < h; y++) {
      const sy = (y + 0.5) * Math.SQRT2 - 0.5;
      const j = Math.min(sh - 2, Math.max(0, Math.floor(sy)));
      const fy = sy - j;
      const r0 = j * sw;
      const r1 = r0 + sw;
      for (let x = 0; x < w; x++) {
        const i = xi[x];
        const fx = xf[x];
        const top = blur[r0 + i] + fx * (blur[r0 + i + 1] - blur[r0 + i]);
        const bottom = blur[r1 + i] + fx * (blur[r1 + i + 1] - blur[r1 + i]);
        out[y * w + x] = top + fy * (bottom - top) + 0.5 | 0;
      }
    }
    return { width: w, height: h, stride: w, data: out };
  }
  function halfOctavePyramid(image, levels, ws = new OrbWorkspace()) {
    const octaves = Math.ceil(levels / 2);
    const a = ws.octaves.build(image, octaves, 24).levels;
    const b = ws.halfOctaves.build(halfOctave(image, ws), octaves, 24).levels;
    const out = [];
    for (let o = 0; o < octaves; o++) {
      if (a[o]) out.push({ image: a[o], scale: 2 ** o });
      if (b[o]) out.push({ image: b[o], scale: Math.SQRT2 * 2 ** o });
    }
    return out.slice(0, levels);
  }
  function harris(d, stride, x, y) {
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const o = (y + dy) * stride + x + dx;
        const gx = d[o + 1] - d[o - 1];
        const gy = d[o + stride] - d[o - stride];
        xx += gx * gx;
        yy += gy * gy;
        xy += gx * gy;
      }
    return xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
  }
  function integral(image, ws) {
    const w = image.width + 1;
    if (ws.integral.length < w * (image.height + 1)) ws.integral = new Int32Array(w * (image.height + 1));
    const out = ws.integral;
    out.fill(0, 0, w);
    for (let y = 0; y < image.height; y++) {
      out[(y + 1) * w] = 0;
      let row = 0;
      for (let x = 0; x < image.width; x++) {
        row += image.data[y * image.stride + x];
        out[(y + 1) * w + x + 1] = out[y * w + x + 1] + row;
      }
    }
    return out;
  }
  function levelCorners(image, quota, options, roi, fast) {
    const { width: w, height: h, stride, data: d } = image;
    const cell = options.cell;
    const picked = [];
    const x0 = Math.max(BORDER, Math.floor(roi.x0));
    const y0 = Math.max(BORDER, Math.floor(roi.y0));
    const x1 = Math.min(w - BORDER, Math.ceil(roi.x1));
    const y1 = Math.min(h - BORDER, Math.ceil(roi.y1));
    if (x1 <= x0 || y1 <= y0) return picked;
    const scoreMap = fast.begin(image);
    const found = [];
    for (let cy = y0; cy < y1; cy += cell)
      for (let cx = x0; cx < x1; cx += cell) {
        const ey = Math.min(y1, cy + cell);
        const ex = Math.min(x1, cx + cell);
        found.length = 0;
        let min = 255;
        let max = 0;
        for (let y = cy; y < ey; y += 2)
          for (let x = cx; x < ex; x += 2) {
            const v = d[y * stride + x];
            if (v < min) min = v;
            if (v > max) max = v;
          }
        if (max - min < 2 * options.minFastThreshold) continue;
        for (let t = options.fastThreshold; ; t = options.minFastThreshold) {
          fast.score(cx, cy, ex, ey, t, found);
          if (found.length >= 2 || t === options.minFastThreshold) break;
          for (const i of found) scoreMap[i] = 0;
          found.length = 0;
        }
        const peaks = [];
        for (const i of found) {
          const s0 = scoreMap[i];
          let peak = true;
          for (let dy = -1; dy <= 1 && peak; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const o = scoreMap[i + dy * w + dx];
              if (o > s0 || o === s0 && (dy < 0 || dy === 0 && dx < 0)) {
                peak = false;
                break;
              }
            }
          if (peak) peaks.push({ i, s: s0 });
        }
        for (const i of found) scoreMap[i] = 0;
        peaks.sort((a, b) => b.s - a.s || a.i - b.i);
        const ranked = [];
        for (const p of peaks.slice(0, 8)) {
          const x = p.i % w;
          const y = (p.i - x) / w;
          const score = harris(d, stride, x, y);
          if (score > 0) ranked.push({ x, y, score });
        }
        ranked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
        picked.push(...ranked.slice(0, 2));
      }
    picked.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    return picked.slice(0, quota);
  }
  function orientation(image, x, y) {
    const d = image.data;
    const s = image.stride;
    let m01 = 0;
    let m10 = 0;
    const c = y * s + x;
    for (let u = -PATCH; u <= PATCH; u++) m10 += u * d[c + u];
    for (let v = 1; v <= PATCH; v++) {
      let sum = 0;
      const umax = UMAX[v];
      for (let u = -umax; u <= umax; u++) {
        const top = d[c - v * s + u];
        const bottom = d[c + v * s + u];
        sum += bottom - top;
        m10 += u * (top + bottom);
      }
      m01 += v * sum;
    }
    return Math.atan2(m01, m10);
  }
  function angleBin(angle) {
    return (Math.round(angle * ANGLE_BINS / (2 * Math.PI)) % ANGLE_BINS + ANGLE_BINS) % ANGLE_BINS;
  }
  function describe(ii, w, x, y, angle, pattern, out, at) {
    const p = pattern[angleBin(angle)];
    const base = (y - 2) * w + (x - 2);
    const w5 = 5 * w;
    for (let byte = 0; byte < 32; byte++) {
      let v = 0;
      for (let bit = 0; bit < 8; bit++) {
        const i = 4 * (8 * byte + bit);
        const a = base + p[i + 1] * w + p[i];
        const b = base + p[i + 3] * w + p[i + 2];
        const sa = ii[a + w5 + 5] - ii[a + 5] - ii[a + w5] + ii[a];
        const sb = ii[b + w5 + 5] - ii[b + 5] - ii[b + w5] + ii[b];
        if (sa < sb) v |= 1 << bit;
      }
      out[at + byte] = v;
    }
  }
  function extractOrb(image, options = {}) {
    const budget = options.budget ?? 700;
    const levels = halfOctavePyramid(image, options.levels ?? 6, WORKSPACE);
    const params = {
      fastThreshold: options.fastThreshold ?? 16,
      minFastThreshold: options.minFastThreshold ?? 4,
      cell: options.cell ?? 24
    };
    const fast = fastScorer(options.wasm !== false);
    const pattern = steered(options.pattern ?? GAUSSIAN_PATTERN);
    const area = levels.reduce((s, l) => s + l.image.width * l.image.height, 0);
    const roi = options.roi ?? { x: 0, y: 0, width: image.width, height: image.height };
    const xs = [];
    const ys = [];
    const lv = [];
    const angles = [];
    const scores = [];
    const descriptors = [];
    levels.forEach((level, index) => {
      const quota = Math.max(16, Math.round(budget * level.image.width * level.image.height / area));
      const s = level.scale;
      const corners = levelCorners(
        level.image,
        quota,
        params,
        { x0: roi.x / s, y0: roi.y / s, x1: (roi.x + roi.width) / s, y1: (roi.y + roi.height) / s },
        fast
      );
      if (!corners.length) return;
      const ii = integral(level.image, WORKSPACE);
      const desc = new Uint8Array(32 * corners.length);
      corners.forEach((c, k) => {
        const a = orientation(level.image, c.x, c.y);
        describe(ii, level.image.width + 1, c.x, c.y, a, pattern, desc, 32 * k);
        xs.push((c.x + 0.5) * s);
        ys.push((c.y + 0.5) * s);
        lv.push(index);
        angles.push(a);
        scores.push(c.score);
      });
      descriptors.push(desc);
    });
    const all = new Uint8Array(32 * xs.length);
    let o = 0;
    for (const d of descriptors) {
      all.set(d, o);
      o += d.length;
    }
    return {
      count: xs.length,
      x: Float32Array.from(xs),
      y: Float32Array.from(ys),
      level: Uint8Array.from(lv),
      angle: Float32Array.from(angles),
      score: Float32Array.from(scores),
      descriptors: all,
      descriptorBytes: 32
    };
  }

  // packages/features/src/compile.ts
  function tiltView(src, t, phiDeg) {
    const phi = phiDeg * Math.PI / 180;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    const a = c * c / t + s * s;
    const b = c * s / t - c * s;
    const d = s * s / t + c * c;
    const corners = [
      [0, 0],
      [src.width, 0],
      [src.width, src.height],
      [0, src.height]
    ].map(([x, y]) => [a * x + b * y, b * x + d * y]);
    const minX = Math.min(...corners.map((p) => p[0]));
    const minY = Math.min(...corners.map((p) => p[1]));
    const w = Math.ceil(Math.max(...corners.map((p) => p[0])) - minX);
    const h = Math.ceil(Math.max(...corners.map((p) => p[1])) - minY);
    const A = [a, b, -minX, b, d, -minY];
    const sigma = 0.8 * Math.sqrt(Math.max(0, t * t - 1));
    const blurred = sigma > 0.3 ? gaussian(src, sigma) : src;
    const det = a * d - b * b;
    const ia = d / det;
    const ib = -b / det;
    const id = a / det;
    const data = new Uint8Array(w * h).fill(128);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const vx = x + 0.5 - A[2];
        const vy = y + 0.5 - A[5];
        const u = ia * vx + ib * vy - 0.5;
        const v = ib * vx + id * vy - 0.5;
        const i = Math.floor(u);
        const j = Math.floor(v);
        if (i < 0 || j < 0 || i + 1 >= src.width || j + 1 >= src.height) continue;
        const fx = u - i;
        const fy = v - j;
        const o = j * blurred.stride + i;
        const p = blurred.data;
        const top = p[o] + fx * (p[o + 1] - p[o]);
        const bottom = p[o + blurred.stride] + fx * (p[o + blurred.stride + 1] - p[o + blurred.stride]);
        data[y * w + x] = Math.round(top + fy * (bottom - top));
      }
    return { image: { width: w, height: h, stride: w, data }, A };
  }
  function gaussian(src, sigma) {
    const r = Math.ceil(3 * sigma);
    const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
    const sum = k.reduce((a, b) => a + b, 0);
    const kn = k.map((v) => v / sum);
    const tmp = new Float32Array(src.width * src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        let v = 0;
        for (let i = -r; i <= r; i++)
          v += kn[i + r] * src.data[y * src.stride + Math.min(src.width - 1, Math.max(0, x + i))];
        tmp[y * src.width + x] = v;
      }
    const out = new Uint8Array(src.width * src.height);
    for (let y = 0; y < src.height; y++)
      for (let x = 0; x < src.width; x++) {
        let v = 0;
        for (let i = -r; i <= r; i++)
          v += kn[i + r] * tmp[Math.min(src.height - 1, Math.max(0, y + i)) * src.width + x];
        out[y * src.width + x] = Math.round(v);
      }
    return { width: src.width, height: src.height, stride: src.width, data: out };
  }
  function hamming(a, ai, b, bi) {
    let d = 0;
    for (let k = 0; k < 32; k++) {
      let v = a[ai + k] ^ b[bi + k];
      while (v) {
        v &= v - 1;
        d++;
      }
    }
    return d;
  }
  function compileTarget(target, options = {}) {
    const tilts = options.tilts ?? [1.4, 2, 2.8];
    const longitudes = options.longitudes ?? [0, 45, 90, 135];
    const views = [{ image: target.image, A: [1, 0, 0, 0, 1, 0] }];
    for (const t of tilts) for (const phi of longitudes) views.push(tiltView(target.image, t, phi));
    for (const sigma of options.blurs ?? [2.5])
      views.push({ image: gaussian(target.image, sigma), A: [1, 0, 0, 0, 1, 0] });
    const groups = [];
    const grid = /* @__PURE__ */ new Map();
    const cell = 4;
    const key = (x, y) => Math.floor(y / cell) * 65536 + Math.floor(x / cell);
    views.forEach((view, vi) => {
      const k = extractOrb(view.image, { budget: 900, ...options.orb });
      const [a, b, tx, c, d, ty] = view.A;
      const det = a * d - b * c;
      for (let i = 0; i < k.count; i++) {
        const vx = k.x[i] - tx;
        const vy = k.y[i] - ty;
        const x = (d * vx - b * vy) / det;
        const y = (-c * vx + a * vy) / det;
        if (x < 0 || y < 0 || x >= target.info.width || y >= target.info.height) continue;
        const radius = 2 + 1.5 * (2 ** (k.level[i] / 2) - 1);
        let found = -1;
        for (let gy = -1; gy <= 1 && found < 0; gy++)
          for (let gx = -1; gx <= 1 && found < 0; gx++)
            for (const gi of grid.get(key(x + gx * cell, y + gy * cell)) ?? []) {
              const g = groups[gi];
              if (Math.hypot(g.x - x, g.y - y) <= radius) {
                found = gi;
                break;
              }
            }
        const desc = k.descriptors.slice(32 * i, 32 * i + 32);
        if (found < 0) {
          groups.push({ x, y, n: 1, views: /* @__PURE__ */ new Set([vi]), score: k.score[i], desc: [desc] });
          const kk = key(x, y);
          grid.set(kk, [...grid.get(kk) ?? [], groups.length - 1]);
        } else {
          const g = groups[found];
          g.views.add(vi);
          g.n++;
          g.score = Math.max(g.score, k.score[i]);
          g.desc.push(desc);
        }
      }
    });
    const maxPoints = options.maxPoints ?? 700;
    const perPoint = options.descriptorsPerPoint ?? 3;
    const kept = groups.map((g, i) => ({ g, i })).sort((p, q) => q.g.views.size - p.g.views.size || q.g.score - p.g.score || p.i - q.i).slice(0, maxPoints).map((p) => p.g);
    const points = new Float32Array(2 * kept.length);
    const repeatability = new Uint8Array(kept.length);
    const descs = [];
    const owner = [];
    kept.forEach((g, pi) => {
      points[2 * pi] = g.x;
      points[2 * pi + 1] = g.y;
      repeatability[pi] = g.views.size;
      const chosen = [];
      for (const d of g.desc) {
        if (chosen.length >= perPoint) break;
        if (chosen.every((c) => hamming(c, 0, d, 0) > 24)) chosen.push(d);
      }
      for (const d of chosen) {
        descs.push(d);
        owner.push(pi);
      }
    });
    const descriptors = new Uint8Array(32 * descs.length);
    descs.forEach((d, i) => descriptors.set(d, 32 * i));
    return { info: target.info, points, repeatability, descriptors, descriptorPoint: Uint32Array.from(owner) };
  }

  // packages/contracts/src/geometry.ts
  function project(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    if (Math.abs(w) < 1e-12) return [NaN, NaN];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }
  function cornersOf(h, widthPx, heightPx) {
    return [project(h, 0, 0), project(h, widthPx, 0), project(h, widthPx, heightPx), project(h, 0, heightPx)];
  }

  // packages/geometry/src/linalg.ts
  function solveInPlace(a, b, n) {
    for (let c = 0; c < n; c++) {
      let pivot = c;
      let best = Math.abs(a[c * n + c]);
      for (let r = c + 1; r < n; r++) {
        const v = Math.abs(a[r * n + c]);
        if (v > best) {
          best = v;
          pivot = r;
        }
      }
      if (best < 1e-12) return false;
      if (pivot !== c) {
        for (let k = 0; k < n; k++) {
          const t2 = a[c * n + k];
          a[c * n + k] = a[pivot * n + k];
          a[pivot * n + k] = t2;
        }
        const t = b[c];
        b[c] = b[pivot];
        b[pivot] = t;
      }
      const d = a[c * n + c];
      for (let r = c + 1; r < n; r++) {
        const f = a[r * n + c] / d;
        if (f === 0) continue;
        for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k];
        b[r] -= f * b[c];
      }
    }
    for (let r = n - 1; r >= 0; r--) {
      let s = b[r];
      for (let k = r + 1; k < n; k++) s -= a[r * n + k] * b[k];
      b[r] = s / a[r * n + r];
    }
    return b.every(Number.isFinite);
  }
  function invertSymmetric(a, n) {
    const m = new Float64Array(a);
    const inv = new Float64Array(n * n);
    for (let i = 0; i < n; i++) inv[i * n + i] = 1;
    for (let c = 0; c < n; c++) {
      let pivot = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]) > Math.abs(m[pivot * n + c])) pivot = r;
      if (Math.abs(m[pivot * n + c]) < 1e-15) return null;
      if (pivot !== c)
        for (let k = 0; k < n; k++) {
          let t = m[c * n + k];
          m[c * n + k] = m[pivot * n + k];
          m[pivot * n + k] = t;
          t = inv[c * n + k];
          inv[c * n + k] = inv[pivot * n + k];
          inv[pivot * n + k] = t;
        }
      const d = m[c * n + c];
      for (let k = 0; k < n; k++) {
        m[c * n + k] /= d;
        inv[c * n + k] /= d;
      }
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = m[r * n + c];
        if (f === 0) continue;
        for (let k = 0; k < n; k++) {
          m[r * n + k] -= f * m[c * n + k];
          inv[r * n + k] -= f * inv[c * n + k];
        }
      }
    }
    return inv;
  }
  function smallestEigenvector(sym, n) {
    const a = new Float64Array(sym);
    const v = new Float64Array(n * n);
    for (let i = 0; i < n; i++) v[i * n + i] = 1;
    for (let sweep = 0; sweep < 50; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
      if (off < 1e-24) break;
      for (let p = 0; p < n; p++)
        for (let q = p + 1; q < n; q++) {
          const apq = a[p * n + q];
          if (Math.abs(apq) < 1e-300) continue;
          const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
          const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k * n + p];
            const akq = a[k * n + q];
            a[k * n + p] = c * akp - s * akq;
            a[k * n + q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p * n + k];
            const aqk = a[q * n + k];
            a[p * n + k] = c * apk - s * aqk;
            a[q * n + k] = s * apk + c * aqk;
          }
          for (let k = 0; k < n; k++) {
            const vkp = v[k * n + p];
            const vkq = v[k * n + q];
            v[k * n + p] = c * vkp - s * vkq;
            v[k * n + q] = s * vkp + c * vkq;
          }
        }
    }
    let min = 0;
    for (let i = 1; i < n; i++) if (a[i * n + i] < a[min * n + min]) min = i;
    const out = new Float64Array(n);
    for (let k = 0; k < n; k++) out[k] = v[k * n + min];
    return out;
  }

  // packages/geometry/src/homography.ts
  function multiply3(a, b) {
    const out = new Float64Array(9);
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++)
        out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    return out;
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]];
    const cof = [
      e * i - f * h,
      c * h - b * i,
      b * f - c * e,
      f * g - d * i,
      a * i - c * g,
      c * d - a * f,
      d * h - e * g,
      b * g - a * h,
      a * e - b * d
    ];
    const det = a * cof[0] + b * cof[3] + c * cof[6];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
    return Float64Array.from(cof, (v) => v / det);
  }
  function normalizeH(h) {
    const k = h[8];
    if (!Number.isFinite(k) || Math.abs(k) < 1e-12) return null;
    for (let i = 0; i < 9; i++) h[i] /= k;
    return h.every(Number.isFinite) ? h : null;
  }
  function normalization(xy, indices, count) {
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      cx += xy[2 * i];
      cy += xy[2 * i + 1];
    }
    cx /= count;
    cy /= count;
    let r = 0;
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      r += Math.hypot(xy[2 * i] - cx, xy[2 * i + 1] - cy);
    }
    r /= count;
    if (r < 1e-9) return null;
    return [Math.SQRT2 / r, cx, cy];
  }
  function denormalize(hn, ta, ib) {
    const [sa, ax, ay] = ta;
    const [sb, bx, by] = ib;
    const Ta = [sa, 0, -sa * ax, 0, sa, -sa * ay, 0, 0, 1];
    const TbInv = [1 / sb, 0, bx, 0, 1 / sb, by, 0, 0, 1];
    return normalizeH(multiply3(multiply3(TbInv, hn), Ta));
  }
  function fitHomography(target, image, indices, count, weights) {
    if (count < 4) return null;
    const ta = normalization(target, indices, count);
    const ib = normalization(image, indices, count);
    if (!ta || !ib) return null;
    const ata = new Float64Array(81);
    const row = new Float64Array(9);
    for (let k = 0; k < count; k++) {
      const i = indices[k];
      const w = weights ? weights[i] : 1;
      if (w <= 0) continue;
      const x = ta[0] * (target[2 * i] - ta[1]);
      const y = ta[0] * (target[2 * i + 1] - ta[2]);
      const u = ib[0] * (image[2 * i] - ib[1]);
      const v = ib[0] * (image[2 * i + 1] - ib[2]);
      for (let r = 0; r < 2; r++) {
        if (r === 0) row.set([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
        else row.set([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
        for (let p = 0; p < 9; p++) {
          const rp = row[p] * w;
          if (rp === 0) continue;
          for (let q = p; q < 9; q++) ata[p * 9 + q] += rp * row[q];
        }
      }
    }
    for (let p = 0; p < 9; p++) for (let q = 0; q < p; q++) ata[p * 9 + q] = ata[q * 9 + p];
    return denormalize(smallestEigenvector(ata, 9), ta, ib);
  }
  var scratchA = new Float64Array(64);
  var scratchB = new Float64Array(8);
  function solve4(target, image, idx) {
    const ta = normalization(target, idx, 4);
    const ib = normalization(image, idx, 4);
    if (!ta || !ib) return null;
    scratchA.fill(0);
    for (let k = 0; k < 4; k++) {
      const i = idx[k];
      const x = ta[0] * (target[2 * i] - ta[1]);
      const y = ta[0] * (target[2 * i + 1] - ta[2]);
      const u = ib[0] * (image[2 * i] - ib[1]);
      const v = ib[0] * (image[2 * i + 1] - ib[2]);
      scratchA.set([x, y, 1, 0, 0, 0, -u * x, -u * y], 16 * k);
      scratchA.set([0, 0, 0, x, y, 1, -v * x, -v * y], 16 * k + 8);
      scratchB[2 * k] = u;
      scratchB[2 * k + 1] = v;
    }
    if (!solveInPlace(scratchA, scratchB, 8)) return null;
    return denormalize([...scratchB, 1], ta, ib);
  }
  function projectInto(h, x, y, out) {
    const w = h[6] * x + h[7] * y + h[8];
    if (!(w > 1e-12)) return false;
    out[0] = (h[0] * x + h[1] * y + h[2]) / w;
    out[1] = (h[3] * x + h[4] * y + h[5]) / w;
    return true;
  }
  var cornerScratch = new Float64Array(8);
  var p2 = new Float64Array(2);
  function isPlausible(h, width, height, minAreaPx = 64, maxEdgeRatio = 30) {
    const xs = [0, width, width, 0];
    const ys = [0, 0, height, height];
    for (let k = 0; k < 4; k++) {
      if (!projectInto(h, xs[k], ys[k], p2)) return false;
      cornerScratch[2 * k] = p2[0];
      cornerScratch[2 * k + 1] = p2[1];
    }
    let area = 0;
    let minEdge = Infinity;
    let maxEdge = 0;
    for (let k = 0; k < 4; k++) {
      const ax = cornerScratch[2 * k];
      const ay = cornerScratch[2 * k + 1];
      const bx = cornerScratch[(2 * k + 2) % 8];
      const by = cornerScratch[(2 * k + 3) % 8];
      const cx = cornerScratch[(2 * k + 4) % 8];
      const cy = cornerScratch[(2 * k + 5) % 8];
      if ((bx - ax) * (cy - by) - (by - ay) * (cx - bx) <= 0) return false;
      area += ax * by - bx * ay;
      const edge = Math.hypot(bx - ax, by - ay);
      minEdge = Math.min(minEdge, edge);
      maxEdge = Math.max(maxEdge, edge);
    }
    return area / 2 >= minAreaPx && maxEdge <= maxEdgeRatio * Math.max(minEdge, 1e-9);
  }
  function hullArea(xy, mask, count) {
    const pts = [];
    for (let i = 0; i < count; i++) if (!mask || mask[i]) pts.push([xy[2 * i], xy[2 * i + 1]]);
    if (pts.length < 3) return 0;
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
      upper.push(p);
    }
    const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    let area = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i];
      const b = hull[(i + 1) % hull.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(area) / 2;
  }

  // packages/geometry/src/refine.ts
  var huber = (r, k) => r <= k ? 1 : k / r;
  function refineHomography(h, target, image, mask, count, options = {}) {
    const iterations = options.iterations ?? 8;
    const k = options.huberPx ?? 1.5;
    let p = Float64Array.from(h.subarray(0, 8));
    let lambda = 1e-3;
    const jtj = new Float64Array(64);
    const jtr = new Float64Array(8);
    const jx = new Float64Array(8);
    const jy = new Float64Array(8);
    const cost = (params) => {
      let c = 0;
      for (let i = 0; i < count; i++) {
        if (!mask[i]) continue;
        const x = target[2 * i];
        const y = target[2 * i + 1];
        const w = params[6] * x + params[7] * y + 1;
        if (!(w > 1e-12)) return Infinity;
        const ex = (params[0] * x + params[1] * y + params[2]) / w - image[2 * i];
        const ey = (params[3] * x + params[4] * y + params[5]) / w - image[2 * i + 1];
        const r = Math.hypot(ex, ey);
        c += r <= k ? r * r : 2 * k * r - k * k;
      }
      return c;
    };
    let current = cost(p);
    for (let it = 0; it < iterations; it++) {
      jtj.fill(0);
      jtr.fill(0);
      for (let i = 0; i < count; i++) {
        if (!mask[i]) continue;
        const x = target[2 * i];
        const y = target[2 * i + 1];
        const w = p[6] * x + p[7] * y + 1;
        const u = (p[0] * x + p[1] * y + p[2]) / w;
        const v = (p[3] * x + p[4] * y + p[5]) / w;
        const ex = u - image[2 * i];
        const ey = v - image[2 * i + 1];
        const wt = huber(Math.hypot(ex, ey), k);
        jx.set([x / w, y / w, 1 / w, 0, 0, 0, -u * x / w, -u * y / w]);
        jy.set([0, 0, 0, x / w, y / w, 1 / w, -v * x / w, -v * y / w]);
        for (let a = 0; a < 8; a++) {
          jtr[a] += wt * (jx[a] * ex + jy[a] * ey);
          for (let b = a; b < 8; b++) jtj[a * 8 + b] += wt * (jx[a] * jx[b] + jy[a] * jy[b]);
        }
      }
      for (let a = 0; a < 8; a++) for (let b = 0; b < a; b++) jtj[a * 8 + b] = jtj[b * 8 + a];
      let improved = false;
      for (let attempt = 0; attempt < 4 && !improved; attempt++) {
        const a = new Float64Array(jtj);
        for (let d = 0; d < 8; d++) a[d * 9] *= 1 + lambda;
        const step = Float64Array.from(jtr, (v) => -v);
        if (!solveInPlace(a, step, 8)) {
          lambda *= 10;
          continue;
        }
        const next = Float64Array.from(p, (v, i) => v + step[i]);
        const c = cost(next);
        if (c < current) {
          p = next;
          current = c;
          lambda = Math.max(1e-7, lambda / 10);
          improved = true;
        } else lambda *= 10;
      }
      if (!improved) break;
    }
    let n = 0;
    let sum = 0;
    jtj.fill(0);
    for (let i = 0; i < count; i++) {
      if (!mask[i]) continue;
      const x = target[2 * i];
      const y = target[2 * i + 1];
      const w = p[6] * x + p[7] * y + 1;
      const u = (p[0] * x + p[1] * y + p[2]) / w;
      const v = (p[3] * x + p[4] * y + p[5]) / w;
      sum += (u - image[2 * i]) ** 2 + (v - image[2 * i + 1]) ** 2;
      n++;
      jx.set([x / w, y / w, 1 / w, 0, 0, 0, -u * x / w, -u * y / w]);
      jy.set([0, 0, 0, x / w, y / w, 1 / w, -v * x / w, -v * y / w]);
      for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) jtj[a * 8 + b] += jx[a] * jx[b] + jy[a] * jy[b];
    }
    const sigma2 = n > 4 ? sum / (2 * n - 8) : sum;
    const inv = invertSymmetric(jtj, 8);
    return {
      H: Float64Array.from([...p, 1]),
      rmsPx: n ? Math.sqrt(sum / n) : Infinity,
      paramCovariance: inv ? inv.map((v) => v * sigma2) : null
    };
  }

  // packages/geometry/src/robust.ts
  function xorshift(seed) {
    let s = seed >>> 0 || 625341585;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s;
    };
  }
  function evaluate(h, target, image, count, thr2, mask) {
    let score = 0;
    let inliers = 0;
    for (let i = 0; i < count; i++) {
      const x = target[2 * i];
      const y = target[2 * i + 1];
      const w = h[6] * x + h[7] * y + h[8];
      let r2 = thr2;
      if (w > 1e-12) {
        const dx = (h[0] * x + h[1] * y + h[2]) / w - image[2 * i];
        const dy = (h[3] * x + h[4] * y + h[5]) / w - image[2 * i + 1];
        r2 = Math.min(thr2, dx * dx + dy * dy);
      }
      const isIn = r2 < thr2;
      mask[i] = isIn ? 1 : 0;
      if (isIn) inliers++;
      score += r2;
    }
    return { score, inliers };
  }
  function indicesOf(mask, count) {
    let n = 0;
    for (let i = 0; i < count; i++) if (mask[i]) n++;
    const out = new Int32Array(n);
    for (let i = 0, k = 0; i < count; i++) if (mask[i]) out[k++] = i;
    return out;
  }
  function collinear(xy, a, b, c) {
    const area = (xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * b + 1] - xy[2 * a + 1]) * (xy[2 * c] - xy[2 * a]);
    return Math.abs(area) < 1e-3 * (1 + Math.abs(xy[2 * a]) + Math.abs(xy[2 * b]));
  }
  function estimateHomography(target, image, count, width, height, options = {}) {
    const thr = options.thresholdPx ?? 3;
    const thr2 = thr * thr;
    const confidence = options.confidence ?? 0.995;
    const maxIterations = options.maxIterations ?? 500;
    const minInliers = options.minInliers ?? 12;
    const minRatio = options.minInlierRatio ?? 0.2;
    const minCoverage = options.minCoverage ?? 0.08;
    if (count < Math.max(4, minInliers)) return { accepted: false, reason: "INSUFFICIENT_MATCHES", iterations: 0 };
    const random = xorshift(options.seed ?? 12345);
    const mask = new Uint8Array(count);
    const bestMask = new Uint8Array(count);
    let best = null;
    let bestScore = Infinity;
    let bestInliers = 0;
    let limit = maxIterations;
    let n = 4;
    let tn = maxIterations;
    for (let i = 0; i < 4; i++) tn *= (n - i) / (count - i);
    let tnPrime = 1;
    const sample2 = new Int32Array(4);
    let t = 0;
    const consider = (h) => {
      if (!h || !isPlausible(h, width, height)) return;
      const { score, inliers } = evaluate(h, target, image, count, thr2, mask);
      if (score >= bestScore) return;
      best = h;
      bestScore = score;
      bestInliers = inliers;
      bestMask.set(mask);
      for (let lo = 0; lo < 3 && bestInliers >= 8; lo++) {
        const refit = fitHomography(target, image, indicesOf(bestMask, count), bestInliers);
        if (!refit || !isPlausible(refit, width, height)) break;
        const e = evaluate(refit, target, image, count, thr2, mask);
        if (e.score >= bestScore) break;
        best = refit;
        bestScore = e.score;
        bestInliers = e.inliers;
        bestMask.set(mask);
      }
      const w = bestInliers / count;
      const k = Math.log(1 - confidence) / Math.log(Math.max(1e-12, 1 - w ** 4));
      limit = Math.min(maxIterations, Math.max(16, Math.ceil(k)));
    };
    while (t < limit) {
      t++;
      if (t >= tnPrime && n < count) {
        const next = tn * (n + 1) / (n + 1 - 4);
        n++;
        tnPrime += Math.ceil(next - tn);
        tn = next;
      }
      const pool = tnPrime > t ? n - 1 : n;
      let k = 0;
      if (tnPrime > t) sample2[k++] = n - 1;
      let guard = 0;
      while (k < 4 && guard++ < 64) {
        const c2 = random() % pool;
        let dup = false;
        for (let j = 0; j < k; j++) if (sample2[j] === c2) dup = true;
        if (!dup) sample2[k++] = c2;
      }
      if (k < 4) continue;
      const [a, b, c, d] = [sample2[0], sample2[1], sample2[2], sample2[3]];
      if (collinear(target, a, b, c) || collinear(target, a, b, d) || collinear(target, a, c, d) || collinear(target, b, c, d))
        continue;
      consider(solve4(target, image, sample2));
    }
    if (!best || bestInliers < minInliers) return { accepted: false, reason: "NO_MODEL", iterations: t };
    let H = best;
    let refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
    for (let pass = 0; pass < 2; pass++) {
      if (!isPlausible(refined.H, width, height)) return { accepted: false, reason: "IMPLAUSIBLE_MODEL", iterations: t };
      H = refined.H;
      const e = evaluate(H, target, image, count, thr2, bestMask);
      bestInliers = e.inliers;
      if (pass === 0) refined = refineHomography(H, target, image, bestMask, count, { huberPx: thr / 2 });
    }
    const ratio = bestInliers / count;
    if (bestInliers < minInliers || ratio < minRatio)
      return { accepted: false, reason: "LOW_INLIER_SUPPORT", iterations: t };
    const coverage = hullArea(target, bestMask, count) / (width * height);
    if (coverage < minCoverage) return { accepted: false, reason: "LOW_SPATIAL_COVERAGE", iterations: t };
    return {
      accepted: true,
      H,
      mask: bestMask,
      inliers: bestInliers,
      ratio,
      rmsPx: refined.rmsPx,
      coverage,
      paramCovariance: refined.paramCovariance,
      iterations: t
    };
  }

  // packages/features/src/format.ts
  var MAGIC = 844385612;
  function resample(src, width, height) {
    if (src.width === width && src.height === height) return src;
    const out = new Uint8Array(width * height);
    const sx = src.width / width;
    const sy = src.height / height;
    for (let y = 0; y < height; y++) {
      const v = Math.min(src.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5));
      const j = Math.floor(v);
      const fy = v - j;
      for (let x = 0; x < width; x++) {
        const u = Math.min(src.width - 1.001, Math.max(0, (x + 0.5) * sx - 0.5));
        const i = Math.floor(u);
        const fx = u - i;
        const o = j * src.stride + i;
        const d = src.data;
        const top = d[o] + fx * (d[o + 1] - d[o]);
        const bottom = d[o + src.stride] + fx * (d[o + src.stride + 1] - d[o + src.stride]);
        out[y * width + x] = Math.round(top + fy * (bottom - top));
      }
    }
    return { width, height, stride: width, data: out };
  }
  function shrink(src, maxEdge) {
    const k = Math.max(src.width, src.height) / maxEdge;
    if (k <= 1) return src;
    const w = Math.round(src.width / k);
    const h = Math.round(src.height / k);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * k);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
        const y0 = Math.floor(y * k);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += src.data[yy * src.stride + xx];
        out[y * w + x] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
      }
    return { width: w, height: h, stride: w, data: out };
  }
  async function encodeTarget(compiled2, template, options = {}) {
    const t = shrink(template, options.templateMaxEdge ?? 480);
    const id = new TextEncoder().encode(compiled2.info.id);
    const n = compiled2.points.length / 2;
    const d = compiled2.descriptorPoint.length;
    const size = 8 + 2 + id.length + 8 + 8 + 8 * n + n + 4 * d + 32 * d + 4 + t.width * t.height;
    const bytes = new Uint8Array(size + 32);
    const view = new DataView(bytes.buffer);
    let o = 0;
    view.setUint32(o, MAGIC, true);
    view.setUint16(o + 4, 2, true);
    view.setUint16(o + 6, PATTERN_VERSION, true);
    o += 8;
    view.setUint16(o, id.length, true);
    bytes.set(id, o + 2);
    o += 2 + id.length;
    view.setUint16(o, compiled2.info.width, true);
    view.setUint16(o + 2, compiled2.info.height, true);
    view.setFloat32(o + 4, compiled2.info.physicalWidthMeters ?? NaN, true);
    o += 8;
    view.setUint32(o, n, true);
    view.setUint32(o + 4, d, true);
    o += 8;
    for (let i = 0; i < 2 * n; i++, o += 4) view.setFloat32(o, compiled2.points[i], true);
    bytes.set(compiled2.repeatability, o);
    o += n;
    for (let i = 0; i < d; i++, o += 4) view.setUint32(o, compiled2.descriptorPoint[i], true);
    bytes.set(compiled2.descriptors, o);
    o += 32 * d;
    view.setUint16(o, t.width, true);
    view.setUint16(o + 2, t.height, true);
    o += 4;
    for (let y = 0; y < t.height; y++) bytes.set(t.data.subarray(y * t.stride, y * t.stride + t.width), o + y * t.width);
    o += t.width * t.height;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.subarray(0, o)));
    bytes.set(digest, o);
    return bytes;
  }
  async function decodeTarget(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fail = (why) => {
      throw new Error(`Invalid target asset: ${why}`);
    };
    if (bytes.length < 64 || view.getUint32(0, true) !== MAGIC || view.getUint16(4, true) !== 2) fail("header");
    const pattern = view.getUint16(6, true) & 255;
    if (pattern !== PATTERN_VERSION)
      fail(`descriptor pattern v${pattern}, this engine uses v${PATTERN_VERSION}; recompile the target`);
    const body = bytes.subarray(0, bytes.length - 32);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
    if (!digest.every((v, i) => v === bytes[bytes.length - 32 + i])) fail("checksum");
    let o = 8;
    const idLength = view.getUint16(o, true);
    const id = new TextDecoder().decode(bytes.subarray(o + 2, o + 2 + idLength));
    o += 2 + idLength;
    const width = view.getUint16(o, true);
    const height = view.getUint16(o + 2, true);
    const physical = view.getFloat32(o + 4, true);
    o += 8;
    const n = view.getUint32(o, true);
    const d = view.getUint32(o + 4, true);
    o += 8;
    const points = new Float32Array(2 * n);
    for (let i = 0; i < 2 * n; i++, o += 4) points[i] = view.getFloat32(o, true);
    const repeatability = bytes.slice(o, o + n);
    o += n;
    const descriptorPoint = new Uint32Array(d);
    for (let i = 0; i < d; i++, o += 4) descriptorPoint[i] = view.getUint32(o, true);
    const descriptors = bytes.slice(o, o + 32 * d);
    o += 32 * d;
    const tw = view.getUint16(o, true);
    const th = view.getUint16(o + 2, true);
    o += 4;
    const stored = { width: tw, height: th, stride: tw, data: bytes.slice(o, o + tw * th) };
    return {
      compiled: {
        info: { id, width, height, physicalWidthMeters: Number.isNaN(physical) ? null : physical },
        points,
        repeatability,
        descriptors,
        descriptorPoint
      },
      template: resample(stored, width, height)
    };
  }

  // packages/features/src/hamming.ts
  function nearest2Reference(queries, refs) {
    const m = queries.length / 32;
    const n = refs.length / 32;
    const out = new Uint32Array(3 * m);
    const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
    const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
    for (let q = 0; q < m; q++) {
      let best = 257;
      let second = 257;
      let index = 4294967295;
      const a = 8 * q;
      for (let r = 0; r < n; r++) {
        const b = 8 * r;
        let d = 0;
        for (let k = 0; k < 8; k++) {
          let v = (q32[a + k] ^ r32[b + k]) >>> 0;
          v -= v >>> 1 & 1431655765;
          v = (v & 858993459) + (v >>> 2 & 858993459);
          d += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
        }
        if (d < best) {
          second = best;
          best = d;
          index = r;
        } else if (d < second) second = d;
      }
      out[3 * q] = index;
      out[3 * q + 1] = best;
      out[3 * q + 2] = second;
    }
    return out;
  }
  function nearest2GroupedReference(queries, refs, groups) {
    const m = queries.length / 32;
    const n = refs.length / 32;
    const out = new Uint32Array(3 * m);
    const q32 = new Uint32Array(queries.buffer, queries.byteOffset, queries.length / 4);
    const r32 = new Uint32Array(refs.buffer, refs.byteOffset, refs.length / 4);
    for (let q = 0; q < m; q++) {
      let best = 257;
      let bestGroup = 4294967295;
      let second = 257;
      let index = 4294967295;
      const a = 8 * q;
      for (let r = 0; r < n; r++) {
        const b = 8 * r;
        let d = 0;
        for (let k = 0; k < 8; k++) {
          let v = (q32[a + k] ^ r32[b + k]) >>> 0;
          v -= v >>> 1 & 1431655765;
          v = (v & 858993459) + (v >>> 2 & 858993459);
          d += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
        }
        const g = groups[r];
        if (g === bestGroup) {
          if (d < best) {
            best = d;
            index = r;
          }
        } else if (d < best) {
          second = best;
          best = d;
          bestGroup = g;
          index = r;
        } else if (d < second) second = d;
      }
      out[3 * q] = index;
      out[3 * q + 1] = best;
      out[3 * q + 2] = second;
    }
    return out;
  }
  var HammingMatcher = class _HammingMatcher {
    constructor(kernel) {
      __publicField(this, "backend");
      __publicField(this, "kernel");
      this.kernel = kernel;
      this.backend = kernel ? "wasm-simd" : "js";
    }
    /** Synchronous instantiation (the module is ~1 KB); `allowWasm: false` forces the reference. */
    static create(options = {}) {
      const kernel = options.allowWasm === false ? null : instantiateKernels();
      if (!kernel) return new _HammingMatcher(null);
      try {
        const matcher = new _HammingMatcher(kernel);
        return matcher.selfTest() ? matcher : new _HammingMatcher(null);
      } catch {
        return new _HammingMatcher(null);
      }
    }
    selfTest() {
      let s = 19088743;
      const random = (n) => Uint8Array.from({ length: n }, () => {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        return s & 255;
      });
      const refs = random(32 * 37);
      const queries = new Uint8Array(32 * 11);
      queries.set(random(32 * 10));
      queries.set(refs.subarray(32 * 5, 32 * 6), 32 * 10);
      const want = nearest2Reference(queries, refs);
      const got = this.nearest2(queries, refs);
      const groups = Uint32Array.from({ length: 37 }, (_, i) => i >> 1);
      const wantG = nearest2GroupedReference(queries, refs, groups);
      const gotG = this.nearest2Grouped(queries, refs, groups);
      return got.length === want.length && got.every((v, i) => v === want[i]) && gotG.length === wantG.length && gotG.every((v, i) => v === wantG[i]);
    }
    nearest2(queries, refs) {
      const k = this.kernel;
      if (!k) return nearest2Reference(queries, refs);
      const m = queries.length / 32;
      const n = refs.length / 32;
      k.reset_heap();
      const q = k.reserve(queries.length);
      const r = k.reserve(refs.length);
      const o = k.reserve(12 * m);
      if (!q || !r || !o) return nearest2Reference(queries, refs);
      new Uint8Array(k.memory.buffer).set(queries, q);
      new Uint8Array(k.memory.buffer).set(refs, r);
      k.nearest2(q, m, r, n, o);
      return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
    }
    nearest2Grouped(queries, refs, groups) {
      const k = this.kernel;
      if (!k) return nearest2GroupedReference(queries, refs, groups);
      const m = queries.length / 32;
      k.reset_heap();
      const q = k.reserve(queries.length);
      const r = k.reserve(refs.length);
      const g = k.reserve(groups.byteLength);
      const o = k.reserve(12 * m);
      if (!q || !r || !g || !o) return nearest2GroupedReference(queries, refs, groups);
      const mem = k.memory.buffer;
      new Uint8Array(mem).set(queries, q);
      new Uint8Array(mem).set(refs, r);
      new Uint8Array(mem).set(new Uint8Array(groups.buffer, groups.byteOffset, groups.byteLength), g);
      k.nearest2_grouped(q, m, r, g, refs.length / 32, o);
      return new Uint32Array(k.memory.buffer.slice(o, o + 12 * m));
    }
  };

  // packages/features/src/detector.ts
  var wholeFrameBudget = (image) => Math.max(700, Math.round(700 * image.width * image.height / (640 * 360)));
  var MAX_ENLARGED_PX = 36e4;
  function enlargedFeatures(image, roi, scale, options) {
    const s = Math.min(scale, 3, Math.sqrt(MAX_ENLARGED_PX / (roi.width * roi.height)));
    if (s < 1.2) return null;
    const width = Math.round(roi.width * s);
    const height = Math.round(roi.height * s);
    const data = new Uint8Array(width * height);
    const xMax = image.width - 1.001;
    const yMax = image.height - 1.001;
    for (let y = 0; y < height; y++) {
      const sy = Math.min(yMax, Math.max(0.5, roi.y + (y + 0.5) / s));
      for (let x = 0; x < width; x++)
        data[y * width + x] = Math.round(sample(image, Math.min(xMax, Math.max(0.5, roi.x + (x + 0.5) / s)), sy));
    }
    const k = extractOrb({ width, height, stride: width, data }, { budget: 500, ...options });
    return {
      ...k,
      x: k.x.map((v) => roi.x + (v + 0.5) / s - 0.5),
      y: k.y.map((v) => roi.y + (v + 0.5) / s - 0.5)
    };
  }
  var OrbDetector = class {
    constructor(options = {}) {
      __publicField(this, "info", {
        id: "C1.orb-views",
        layer: "L2",
        route: "light",
        determinism: "bit-exact",
        requires: []
      });
      __publicField(this, "options");
      __publicField(this, "matcher");
      __publicField(this, "targets", []);
      this.options = options;
      this.matcher = HammingMatcher.create(options.allowWasm === false ? { allowWasm: false } : {});
    }
    get backend() {
      return this.matcher.backend;
    }
    probe(_capabilities) {
      return { isAvailable: true };
    }
    async load(targets) {
      const report = [];
      this.targets = [];
      for (const t of targets) {
        const started = performance.now();
        const compiled2 = compileTarget(t, this.options.compile);
        const serialized = await encodeTarget(compiled2, t.image, {
          templateMaxEdge: this.options.templateMaxEdge ?? 480
        });
        const asset = await decodeTarget(serialized);
        this.targets.push(asset.compiled);
        report.push({
          id: t.info.id,
          compileUs: (performance.now() - started) * 1e3,
          serialized,
          template: asset.template
        });
      }
      return { targets: report };
    }
    async loadEncoded(assets) {
      const report = [];
      this.targets = [];
      for (const bytes of assets) {
        const started = performance.now();
        const asset = await decodeTarget(bytes);
        this.targets.push(asset.compiled);
        report.push({
          id: asset.compiled.info.id,
          compileUs: (performance.now() - started) * 1e3,
          serialized: bytes,
          template: asset.template,
          info: asset.compiled.info
        });
      }
      return { targets: report };
    }
    async detect(frame, options = {}) {
      if (frame.image.kind !== "cpu-gray") throw new Error("OrbDetector needs cpu-gray frames");
      const roi = options.roi ?? null;
      const k = (roi && (options.upscale ?? 1) > 1 ? enlargedFeatures(frame.image.image, roi, options.upscale, this.options.orb ?? {}) : null) ?? extractOrb(frame.image.image, {
        budget: roi ? 500 : wholeFrameBudget(frame.image.image),
        ...this.options.orb,
        roi
      });
      if (k.count < 8) return [];
      const ratio = this.options.ratio ?? 0.85;
      const maxDistance = this.options.maxDistance ?? 80;
      const found = [];
      for (const t of this.targets) {
        const nn = this.matcher.nearest2Grouped(k.descriptors, t.descriptors, t.descriptorPoint);
        const byPoint = /* @__PURE__ */ new Map();
        for (let q = 0; q < k.count; q++) {
          const best = nn[3 * q + 1];
          const second = nn[3 * q + 2];
          if (best > maxDistance || ratio < 1 && best >= ratio * second) continue;
          const point = t.descriptorPoint[nn[3 * q]];
          const r = best / Math.max(1, second);
          const prev = byPoint.get(point);
          if (!prev || r < prev.r) byPoint.set(point, { q, r });
        }
        const matches = [...byPoint].sort((a, b) => a[1].r - b[1].r || a[0] - b[0]);
        if (matches.length < 12) continue;
        const tp = new Float64Array(2 * matches.length);
        const ip = new Float64Array(2 * matches.length);
        matches.forEach(([point, { q }], i) => {
          tp[2 * i] = t.points[2 * point];
          tp[2 * i + 1] = t.points[2 * point + 1];
          ip[2 * i] = k.x[q];
          ip[2 * i + 1] = k.y[q];
        });
        const result = estimateHomography(tp, ip, matches.length, t.info.width, t.info.height, {
          thresholdPx: this.options.thresholdPx ?? 4,
          maxIterations: 1e3,
          minInliers: 12,
          minInlierRatio: 0.1,
          minCoverage: 0.05
        });
        if (!result.accepted) continue;
        found.push({
          inliers: result.inliers,
          pose: {
            targetId: t.info.id,
            frameId: frame.frameId,
            timeUs: frame.time.captureUs,
            H_imageFromTarget: result.H,
            corners: cornersOf(result.H, t.info.width, t.info.height),
            covariance: null,
            quality: {
              support: result.inliers,
              ratio: result.ratio,
              residual: result.rmsPx,
              residualKind: "px",
              coverage: result.coverage
            },
            origin: "detector"
          }
        });
      }
      found.sort((a, b) => b.inliers - a.inliers || a.pose.targetId.localeCompare(b.pose.targetId));
      if (found.length > 1 && found[1].inliers >= 0.85 * found[0].inliers) return [];
      return found.map((f) => f.pose);
    }
  };

  // packages/web/src/picture.ts
  var MIN_POINTS = 48;
  var MIN_EDGE_PX = 64;
  var PictureError = class extends Error {
    constructor(code, message, options) {
      super(message, options);
      __publicField(this, "code");
      this.name = "PictureError";
      this.code = code;
    }
  };
  function scaledSize(width, height, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
  }
  function grayFromRgba(rgba, width, height) {
    const gray = new Uint8Array(width * height);
    for (let i = 0; i < gray.length; i++)
      gray[i] = 77 * rgba[4 * i] + 150 * rgba[4 * i + 1] + 29 * rgba[4 * i + 2] + 128 >> 8;
    return gray;
  }
  function canDrawPictures() {
    try {
      return typeof OffscreenCanvas === "function" && !!new OffscreenCanvas(1, 1).getContext("2d");
    } catch {
      return false;
    }
  }
  async function decodePicture(blob, maxEdge) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      try {
        bitmap = await createImageBitmap(blob);
      } catch (cause) {
        throw new PictureError("DECODE_FAILED", `The picture cannot be decoded: ${String(cause)}`, { cause });
      }
    }
    try {
      const [width, height] = scaledSize(bitmap.width, bitmap.height, maxEdge);
      let source = bitmap;
      let sw = bitmap.width;
      let sh = bitmap.height;
      while (sw > 2 * width && sh > 2 * height) {
        const half = new OffscreenCanvas(Math.ceil(sw / 2), Math.ceil(sh / 2));
        const c = half.getContext("2d");
        c.imageSmoothingQuality = "high";
        c.drawImage(source, 0, 0, half.width, half.height);
        source = half;
        sw = half.width;
        sh = half.height;
      }
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.imageSmoothingQuality = "high";
      context.drawImage(source, 0, 0, width, height);
      const rgba = context.getImageData(0, 0, width, height).data;
      return { width, height, stride: width, data: grayFromRgba(rgba, width, height) };
    } finally {
      bitmap.close();
    }
  }
  async function compilePicture(targetId, image) {
    if (Math.min(image.width, image.height) < MIN_EDGE_PX)
      throw new PictureError("UNSUITABLE_TARGET", `The picture is too small (${image.width}×${image.height} px)`);
    const compiled2 = compileTarget({
      info: { id: targetId, width: image.width, height: image.height, physicalWidthMeters: null },
      image
    });
    const pointCount = compiled2.points.length / 2;
    if (pointCount < MIN_POINTS)
      throw new PictureError("UNSUITABLE_TARGET", `The picture has too little detail (${pointCount} recognition points)`);
    return { bytes: await encodeTarget(compiled2, image), pointCount };
  }

  // packages/rating/src/rating.ts
  var ROBUST_VIEWS = 5;
  var TWIN_BITS = 24;
  var TWIN_AWAY = 0.08;
  var WEIGHTS = { detail: 0.15, spread: 0.4, distinctiveness: 0.05, recognition: 0.4 };
  var RECOGNITION_RANGE = [0.1, 0.7];
  var STAR_RANGE = [15, 95];
  var CAP_CURVE = 0.4;
  var FAILS = { size: 0.08, tilt: 0.15, blur: 0.33, dim: 0.6, covered: 0.6 };
  var ramp = (value, low, high) => value <= low ? 0 : value >= high ? 1 : (value - low) / (high - low);
  var FRAME_W = 640;
  var FRAME_H = 360;
  var FOCAL = 500;
  var BACKGROUND = 118;
  var VIEWS = [
    ...[160, 120, 90, 70].map((longPx) => ({ name: `size-${longPx}`, test: "size", longPx })),
    ...[45, 60, 70].map((tiltDeg) => ({ name: `tilt-${tiltDeg}`, test: "tilt", longPx: 240, tiltDeg })),
    ...[6, 10, 16].map((blurPx) => ({ name: `blur-${blurPx}`, test: "blur", longPx: 240, blurPx })),
    ...[0.35, 0.2].map((gain) => ({ name: `dim-${gain}`, test: "dim", longPx: 240, gain })),
    ...[[0], [1], [2], [3], [0, 2], [1, 3], [0, 1], [2, 3]].map((covered) => ({
      name: `covered-${covered.join("")}`,
      test: "covered",
      longPx: 240,
      covered
    }))
  ].flatMap((step) => [
    { ...step, rollDeg: 8, offset: [24, 12] },
    { ...step, rollDeg: -12, offset: [-30, -8] }
  ]);
  var MARGIN_INLIERS = [12, 40];
  var TEST_WEIGHTS = {
    size: 0.25,
    tilt: 0.2,
    blur: 0.2,
    dim: 0.15,
    covered: 0.2
  };
  function viewHomography(v, tw, th) {
    const s = v.longPx / Math.max(tw, th);
    const w = tw * s;
    const h = th * s;
    const cx = FRAME_W / 2 + v.offset[0];
    const cy = FRAME_H / 2 + v.offset[1];
    let quad = [
      [cx - w / 2, cy - h / 2],
      [cx + w / 2, cy - h / 2],
      [cx + w / 2, cy + h / 2],
      [cx - w / 2, cy + h / 2]
    ];
    if (v.tiltDeg) {
      const a = v.tiltDeg * Math.PI / 180;
      quad = quad.map(([x, y]) => {
        const z = FOCAL + (y - cy) * Math.sin(a);
        return [cx + (x - cx) * FOCAL / z, cy + (y - cy) * Math.cos(a) * FOCAL / z];
      });
    }
    const r = v.rollDeg * Math.PI / 180;
    quad = quad.map(([x, y]) => [
      cx + (x - cx) * Math.cos(r) - (y - cy) * Math.sin(r),
      cy + (x - cx) * Math.sin(r) + (y - cy) * Math.cos(r)
    ]);
    const target = Float64Array.from([0, 0, tw, 0, tw, th, 0, th]);
    const image = Float64Array.from(quad.flat());
    return solve4(target, image, [0, 1, 2, 3]);
  }
  function renderView(pyramid, v, H) {
    const template = pyramid.levels[0];
    const scale = v.longPx / Math.max(template.width, template.height);
    const level = Math.max(0, Math.min(pyramid.levels.length - 1, Math.floor(Math.log2(1 / scale))));
    const image = pyramid.levels[level];
    const k = 2 ** level;
    const inverse = invert3(H);
    const data = new Uint8Array(FRAME_W * FRAME_H);
    let seed = 12345;
    const hw = template.width / 2;
    const hh = template.height / 2;
    for (let y = 0; y < FRAME_H; y++)
      for (let x = 0; x < FRAME_W; x++) {
        seed = seed * 1103515245 + 12345 >>> 0;
        let value = BACKGROUND + (seed >>> 16) % 9 - 4;
        const px = x + 0.5;
        const py = y + 0.5;
        const w = inverse[6] * px + inverse[7] * py + inverse[8];
        const u = (inverse[0] * px + inverse[1] * py + inverse[2]) / w;
        const t = (inverse[3] * px + inverse[4] * py + inverse[5]) / w;
        if (u >= 0 && t >= 0 && u < template.width && t < template.height) {
          const quarter = (t < hh ? 0 : 2) + (u < hw ? 0 : 1);
          if (!v.covered?.includes(quarter)) {
            const s = sample(
              image,
              Math.min(image.width - 0.51, Math.max(0.5, u / k)),
              Math.min(image.height - 0.51, Math.max(0.5, t / k))
            );
            if (!Number.isNaN(s)) value = s;
          }
        }
        if (v.gain !== void 0) {
          seed = seed * 1103515245 + 12345 >>> 0;
          value = BACKGROUND + (value - BACKGROUND) * v.gain + (seed >>> 16) % 13 - 6;
        }
        data[y * FRAME_W + x] = Math.max(0, Math.min(255, Math.round(value)));
      }
    if (v.blurPx) {
      const half = Math.floor(v.blurPx / 2);
      const row = new Float64Array(FRAME_W + 1);
      for (let y = 0; y < FRAME_H; y++) {
        for (let x = 0; x < FRAME_W; x++) row[x + 1] = row[x] + data[y * FRAME_W + x];
        for (let x = 0; x < FRAME_W; x++) {
          const a = Math.max(0, x - half);
          const b = Math.min(FRAME_W, x - half + v.blurPx);
          data[y * FRAME_W + x] = Math.round((row[b] - row[a]) / (b - a));
        }
      }
    }
    return { width: FRAME_W, height: FRAME_H, stride: FRAME_W, data };
  }
  async function rateCompiledTarget(bytes) {
    const asset = await decodeTarget(bytes);
    const { compiled: compiled2, template } = asset;
    const { width, height } = compiled2.info;
    const n = compiled2.points.length / 2;
    const robust = [];
    for (let i = 0; i < n; i++) if (compiled2.repeatability[i] >= ROBUST_VIEWS) robust.push(i);
    const points = new Float32Array(2 * robust.length);
    robust.forEach((p, i) => {
      points[2 * i] = compiled2.points[2 * p];
      points[2 * i + 1] = compiled2.points[2 * p + 1];
    });
    const detail = ramp(robust.length, 40, 250);
    const aspect = width / height;
    const columns = Math.max(2, Math.round(4 * Math.sqrt(aspect)));
    const rows = Math.max(2, Math.round(4 / Math.sqrt(aspect)));
    const counts = new Array(columns * rows).fill(0);
    const quarters = [0, 0, 0, 0];
    for (let i = 0; i < robust.length; i++) {
      const x = points[2 * i];
      const y = points[2 * i + 1];
      counts[Math.min(rows - 1, Math.floor(y / height * rows)) * columns + Math.min(columns - 1, Math.floor(x / width * columns))]++;
      quarters[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]++;
    }
    const total = Math.max(1, robust.length);
    const cells = columns * rows;
    const populatedCells = counts.filter((c) => c >= Math.max(3, 0.3 * total / cells)).length;
    const concentration = counts.reduce((s, c) => s + (c / total) ** 2, 0);
    const evenness = robust.length ? 1 / concentration / cells : 0;
    const weakestIndex = quarters.indexOf(Math.min(...quarters));
    const weakestShare = quarters[weakestIndex] / total;
    const spread = (0.5 * ramp(populatedCells / cells, 0.3, 0.85) + 0.5 * ramp(evenness, 0.25, 0.65)) * (0.6 + 0.4 * ramp(weakestShare, 0.03, 0.15));
    const d32 = new Uint32Array(
      compiled2.descriptors.buffer,
      compiled2.descriptors.byteOffset,
      compiled2.descriptors.length / 4
    );
    const ofPoint = Array.from({ length: n }, () => []);
    compiled2.descriptorPoint.forEach((p, d) => ofPoint[p].push(d));
    const away = (TWIN_AWAY * Math.hypot(width, height)) ** 2;
    const hamming2 = (a, b) => {
      let bits = 0;
      for (let k = 0; k < 8; k++) {
        let v = (d32[8 * a + k] ^ d32[8 * b + k]) >>> 0;
        v -= v >>> 1 & 1431655765;
        v = (v & 858993459) + (v >>> 2 & 858993459);
        bits += (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
      }
      return bits;
    };
    const hasFarTwin = (p) => {
      const px = compiled2.points[2 * p];
      const py = compiled2.points[2 * p + 1];
      for (let q = 0; q < n; q++) {
        if ((compiled2.points[2 * q] - px) ** 2 + (compiled2.points[2 * q + 1] - py) ** 2 < away) continue;
        for (const a of ofPoint[p]) for (const b of ofPoint[q]) if (hamming2(a, b) <= TWIN_BITS) return true;
      }
      return false;
    };
    const distinctShare = robust.length ? robust.filter((p) => !hasFarTwin(p)).length / robust.length : 0;
    const distinctiveness = ramp(distinctShare, 0.35, 0.7);
    const detector = new OrbDetector();
    await detector.loadEncoded([bytes]);
    const pyramid = buildPyramid(template, 6, 16);
    const views = [];
    for (const [i, v] of VIEWS.entries()) {
      const H = viewHomography(v, width, height);
      const truth = cornersOf(H, width, height);
      const found = await detector.detect({
        sessionId: "rate",
        frameId: i + 1,
        time: { captureUs: i, receiveUs: i, source: "replay" },
        image: { kind: "cpu-gray", image: renderView(pyramid, v, H) }
      });
      const hit = found.find(
        (d) => d.corners.reduce((s, c, k) => s + Math.hypot(c[0] - truth[k][0], c[1] - truth[k][1]), 0) / 4 < 0.08 * v.longPx
      );
      views.push({
        name: v.name,
        test: v.test,
        found: !!hit,
        margin: hit ? ramp(hit.quality.support, MARGIN_INLIERS[0], MARGIN_INLIERS[1]) : 0
      });
    }
    const tests = Object.fromEntries(
      Object.keys(TEST_WEIGHTS).map((test) => {
        const own = views.filter((v) => v.test === test);
        return [test, own.reduce((sum, v) => sum + v.margin, 0) / own.length];
      })
    );
    const recognition = ramp(
      Object.keys(TEST_WEIGHTS).reduce((sum, test) => sum + TEST_WEIGHTS[test] * tests[test], 0),
      ...RECOGNITION_RANGE
    );
    const score = 100 * (WEIGHTS.detail * detail + WEIGHTS.spread * spread + WEIGHTS.distinctiveness * distinctiveness + WEIGHTS.recognition * recognition);
    const raw = Math.min(0.5 + 4.5 * ramp(score, ...STAR_RANGE), 1 + 4 * Math.min(spread, recognition) ** CAP_CURVE);
    const stars = Math.min(5, Math.max(0.5, Math.round(raw * 2) / 2));
    const advice = [];
    if (recognition < 0.4) advice.push("HARD_TO_FIND");
    if (spread < 0.6 && (populatedCells / cells < 0.6 || evenness < 0.45)) advice.push("CONCENTRATED");
    if (weakestShare < 0.08) advice.push("WEAK_QUARTER");
    if (detail < 0.5) advice.push("FEW_DETAILS");
    if (distinctiveness < 0.4) advice.push("REPETITIVE");
    if (tests.size < FAILS.size) advice.push("FAILS_SMALL");
    if (tests.tilt < FAILS.tilt) advice.push("FAILS_TILTED");
    if (tests.blur < FAILS.blur) advice.push("FAILS_BLURRED");
    if (tests.dim < FAILS.dim) advice.push("FAILS_DIM");
    if (tests.covered < FAILS.covered) advice.push("FAILS_COVERED");
    return {
      stars,
      score: Math.round(20 * raw),
      factors: { detail, spread, distinctiveness, recognition },
      metrics: {
        robustPoints: robust.length,
        grid: { columns, rows, counts },
        populatedCells,
        evenness,
        weakestQuarter: { index: weakestIndex, share: weakestShare },
        distinctShare,
        tests,
        views
      },
      advice,
      points,
      width,
      height
    };
  }

  // packages/rating/src/worker.ts
  var Failure = class extends Error {
    constructor(code, message) {
      super(message);
      __publicField(this, "code");
      this.code = code;
    }
  };
  async function bytesOf(m) {
    if (m.bytes) return new Uint8Array(m.bytes);
    let image;
    if (m.gray)
      image = { width: m.gray.width, height: m.gray.height, stride: m.gray.width, data: new Uint8Array(m.gray.data) };
    else if (!canDrawPictures()) return null;
    else image = await decodePicture(m.image, m.maxEdgePx);
    return (await compilePicture("rated", image)).bytes;
  }
  function startRater(scope) {
    let queue = Promise.resolve();
    scope.addEventListener("message", (event) => {
      const m = event.data;
      if (m.type !== "rate") return;
      queue = queue.then(async () => {
        try {
          const bytes = await bytesOf(m);
          if (!bytes) {
            scope.postMessage({ type: "need-gray", id: m.id });
            return;
          }
          let rating;
          try {
            rating = await rateCompiledTarget(bytes);
          } catch (error) {
            if (!m.bytes) throw error;
            throw new Failure("INVALID_TARGET", error instanceof Error ? error.message : String(error));
          }
          scope.postMessage({ type: "rated", id: m.id, rating }, [rating.points.buffer]);
        } catch (error) {
          scope.postMessage({
            type: "failed",
            id: m.id,
            code: error instanceof PictureError || error instanceof Failure ? error.code : "WORKER_FAILED",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      });
    });
  }

  // packages/rating/src/worker-entry.ts
  startRater(globalThis);
})();
