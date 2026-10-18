/*! LiveMira engine | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

// packages/contracts/src/errors.ts
var EngineError = class extends Error {
  code;
  isRecoverable;
  constructor(code, message, options) {
    super(message, options.cause === void 0 ? void 0 : { cause: options.cause });
    this.name = "EngineError";
    this.code = code;
    this.isRecoverable = options.isRecoverable;
  }
};

// packages/contracts/src/math.ts
function normalizeHomography(h) {
  if (h.length !== 9 || !h.every(Number.isFinite)) {
    throw new EngineError("INVALID_TARGET", "Homography requires nine finite elements", {
      isRecoverable: false
    });
  }
  const scale = Math.abs(h[8]) > 1e-12 ? h[8] : Math.max(...h.map(Math.abs));
  if (!scale) throw new EngineError("INVALID_TARGET", "Zero homography", { isRecoverable: false });
  const m = h.map((x) => x / scale);
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-12)
    throw new EngineError("INVALID_TARGET", "Singular homography", { isRecoverable: false });
  return m;
}

// packages/contracts/src/target.ts
function validateTargetBundle(value) {
  const t = value;
  const fail = () => {
    throw new EngineError("INVALID_TARGET", "Malformed, incompatible or oversized target bundle", {
      isRecoverable: false
    });
  };
  if (!t || t.schemaVersion !== 1 || !t.targetId || typeof t.targetId !== "string" || t.targetId.length > 256 || !t.compilerVersion || !t.algorithmVersion || !/^[a-f0-9]{64}$/i.test(t.imageHash ?? "") || t.orientation !== "top-left") {
    fail();
  }
  if (![t.widthPx, t.heightPx].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || t.physicalWidthMeters !== null && !(Number.isFinite(t.physicalWidthMeters) && t.physicalWidthMeters > 0)) {
    fail();
  }
  const f = t.features;
  if (!f || !Array.isArray(f.points) || f.points.length > 1e5 || !Number.isInteger(f.descriptorLength) || f.descriptorLength < 1 || f.descriptorLength > 512 || !f.descriptorType || !Array.isArray(f.descriptors) || f.descriptors.length !== f.points.length * f.descriptorLength || !f.descriptors.every(Number.isFinite)) {
    fail();
  }
  if (!f.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))
    fail();
  if (!Array.isArray(t.pyramid) || t.pyramid.length > 16 || !t.preprocessing || !Array.isArray(t.diagnostics))
    fail();
  let bytes = 0;
  for (const level of t.pyramid) {
    if (![level.width, level.height].every((n) => Number.isInteger(n) && n > 0 && n <= 16384) || !Number.isFinite(level.scale) || level.scale <= 0 || !Array.isArray(level.pixels) || level.pixels.length !== level.width * level.height) {
      fail();
    }
    bytes += level.pixels.length;
    if (bytes > 16777216 || !level.pixels.every((n) => Number.isInteger(n) && n >= 0 && n <= 255))
      fail();
  }
}

// packages/contracts/src/tracking-result.ts
var MAX_MATCHED_POINTS = 512;

// packages/compute/src/gray/rgba-to-gray.ts
var MAX_GRAY_PIXELS = 4096 * 4096;
function checkLayout(data, widthPx, heightPx, strideBytes, channels) {
  if (!(data instanceof Uint8Array) || !Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1 || widthPx * heightPx > MAX_GRAY_PIXELS || !Number.isSafeInteger(strideBytes) || strideBytes < widthPx * channels || (heightPx - 1) * strideBytes + widthPx * channels > data.length) {
    throw new EngineError("FRAME_FAILED", "Invalid or oversized image layout", {
      isRecoverable: false
    });
  }
}
function rgbaToGray(data, widthPx, heightPx, strideBytes = widthPx * 4) {
  checkLayout(data, widthPx, heightPx, strideBytes, 4);
  const output = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const i = y * strideBytes + x * 4;
      output[y * widthPx + x] = 77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2] + 128 >>> 8;
    }
  }
  return { data: output, widthPx, heightPx };
}

// packages/compute/src/matching/hamming-reference.ts
var EXACT_MATCHING_VERSION = "hamming32-mutual-ratio075-max64/1";
var NONE = 4294967295;
function descriptorCount(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length % 32 || bytes.length > 512 * 32) {
    throw new EngineError("INVALID_CONFIG", "Expected at most 512 packed 32-byte descriptors", {
      isRecoverable: false
    });
  }
  return bytes.length / 32;
}
function pack(bytes) {
  const words = new Uint32Array(bytes.length / 4);
  for (let i = 0; i < words.length; i++) {
    words[i] = (bytes[4 * i] | bytes[4 * i + 1] << 8 | bytes[4 * i + 2] << 16 | bytes[4 * i + 3] << 24) >>> 0;
  }
  return words;
}
function popcount(v) {
  v -= v >>> 1 & 1431655765;
  v = (v & 858993459) + (v >>> 2 & 858993459);
  return (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
}
function pairsFromResults(data, n, m) {
  const pairs = [];
  for (let t = 0; t < n; t++) {
    const f = data[t * 4];
    const best = data[t * 4 + 1];
    const second = data[t * 4 + 2];
    if (f < m && best <= 64 && 4 * best < 3 * second && data[(n + f) * 4] === t) {
      pairs.push({ targetIndex: t, frameIndex: f, distance: best });
    }
  }
  return pairs;
}
function matchHammingReference(target, frame) {
  const n = descriptorCount(target);
  const m = descriptorCount(frame);
  if (!n || !m) return [];
  const a = pack(target);
  const b = pack(frame);
  const out = new Uint32Array((n + m) * 4);
  for (let f = 0; f < m; f++) {
    out[(n + f) * 4] = NONE;
    out[(n + f) * 4 + 1] = 257;
  }
  for (let t = 0; t < n; t++) {
    let index = NONE;
    let best = 257;
    let second = 257;
    for (let f = 0; f < m; f++) {
      let d = 0;
      for (let w = 0; w < 8; w++) d += popcount(a[t * 8 + w] ^ b[f * 8 + w]);
      if (d < best) {
        second = best;
        best = d;
        index = f;
      } else if (d < second) second = d;
      const r = (n + f) * 4;
      if (d < out[r + 1]) {
        out[r] = t;
        out[r + 1] = d;
      } else if (d === out[r + 1]) out[r] = NONE;
    }
    out.set([index, best, second, 0], t * 4);
  }
  return pairsFromResults(out, n, m);
}

// packages/compute/src/matching/generated/exact-matching-wasm.ts
var EXACT_MATCHING_WASM = Object.freeze({
  abi: 1,
  scalar: Object.freeze({
    source: "hamming-exact-scalar.wat",
    byteLength: 647,
    sha256: "5692cd0c74822126695c29720dc8ff6d283ea802487cb5629564d784fdd98fe1",
    base64: "AGFzbQEAAAABEwNgAAF/YAR/f39/AX9gAn9/AX8DBAMAAQIFBAEBBAQHGAMGbWVtb3J5AgADYWJpAAAFbWF0Y2gAAQrBBAMEAEEBC7EDAwV/BH4EfyABQYAESyADQYAES3IgAEGAgApLIABBH3FycgRAQX8PCyAAIAFBBXRqQYCACksEQEF/DwsgAkGA8AtJIAJBgOANS3IgAkEBcXIEQEF/DwsgAiABQQZsakGA4A1LBEBBfw8LIAFFIANFcgRAQQAPCwNAQYCACyAFQQJ0aiEIIAhBgQI2AgAgCEF/NgKAICAFQQFqIgUgA0kNAAsDQCAAIARBBXRqIQYgBikDACEJIAYpAwghCiAGKQMQIQsgBikDGCEMQYECIQ5BgQIhD0F/IRBBACEFQYCACiEHA0AgCSAHKQMAhXsgCiAHKQMIhXt8IAsgBykDEIV7IAwgBykDGIV7fHynIQ0gDSAOSQRAIA4hDyANIQ4gBSEQBSANIA9JBEAgDSEPCwtBgIALIAVBAnRqIQggDSAIKAIASQRAIAggDTYCACAIIAQ2AoAgBSANIAgoAgBGBEAgCEF/NgKAIAsLIAdBIGohByAFQQFqIgUgA0kNAAtBgMALIARBDGxqIQYgBiAONgIAIAYgDzYCBCAGIBA2AgggBEEBaiIEIAFJDQALIAEgAhACC4YBAQZ/A0BBgMALIAJBDGxqIQMgAygCACEEIAMoAgghBSAFQQBOIARBwABNIARBAnQgAygCBEEDbElxcQRAQYCgCyAFQQJ0aigCACACRgRAIAEgBkEGbGohByAHIAI7AQAgByAFOwECIAcgBDsBBCAGQQFqIQYLCyACQQFqIgIgAEkNAAsgBgs="
  }),
  simd: Object.freeze({
    source: "hamming-exact-simd.wat",
    byteLength: 1197,
    sha256: "93b68db7070a353ec49abdaf5afc852a7d8a48ba96b4deaee9f466aa38fe7c06",
    base64: "AGFzbQEAAAABGARgAAF/YAF7AX9gBH9/f38Bf2ACf38BfwMFBAABAgMFBAEBBAQHGAMGbWVtb3J5AgADYWJpAAAFbWF0Y2gAAgrhCAQEAEEBC0EAIAAgACAA/Q0ICQoLDA0ODwABAgMEBQYH/bcBIQAgACAAIAD9DQQFBgcAAQIDDA0ODwgJCgv9twEhACAA/RsAC48HAgZ/EnsgAUGABEsgA0GABEtyIABBgIAKSyAAQR9xcnIEQEF/DwsgACABQQV0akGAgApLBEBBfw8LIAJBgPALSSACQYDgDUtyIAJBAXFyBEBBfw8LIAIgAUEGbGpBgOANSwRAQX8PCyABRSADRXIEQEEADwsDQEGAgAsgBUECdGohCCAI/QwBAQAAAQEAAAEBAAABAQAA/QsEACAI/Qz//////////////////////QsEgCAgBUEEaiIFIANJDQALIAP9ESENA0AgACAEQQV0aiEGIAb9AAQAIQsgBv0ABBAhDCAE/REhDv0MAQEAAAEBAAABAQAAAQEAACEQ/QwBAQAAAQEAAAEBAAABAQAAIRH9DP////////////////////8hEv0MAAAAAAEAAAACAAAAAwAAACEPQQAhBUGAgAohBwNAIAsgB/0ABAD9Uf1iIAwgB/0ABBD9Uf1i/W79fSEWIAsgB/0ABCD9Uf1iIAwgB/0ABDD9Uf1i/W79fSEXIAsgB/0ABED9Uf1iIAwgB/0ABFD9Uf1i/W79fSEYIAsgB/0ABGD9Uf1iIAwgB/0ABHD9Uf1i/W79fSEZIBYgF/0NAAEEBQgJDA0QERQVGBkcHSAWIBf9DQIDBgcKCw4PEhMWFxobHh/9jgEhGiAYIBn9DQABBAUICQwNEBEUFRgZHB0gGCAZ/Q0CAwYHCgsODxITFhcaGx4f/Y4BIRsgGiAb/Q0AAQQFCAkMDRARFBUYGRwdIBogG/0NAgMGBwoLDg8SExYXGhseH/2OAf1/IRMgE/0MAQEAAAEBAAABAQAAAQEAACAPIA39Ov1SIRMgEyAQ/TohFCAQIBEgE/23ASAU/VIhESATIBAgFP1SIRAgDyASIBT9UiESQYCACyAFQQJ0aiEIIAj9AAQAIRUgCCAO/Qz/////////////////////IAj9AASAICATIBX9N/1SIBMgFf06/VL9CwSAICAIIBMgFf23Af0LBAAgD/0MBAAAAAQAAAAEAAAABAAAAP2uASEPIAdBgAFqIQcgBUEEaiIFIANJDQALIBAQASEJIBAgCf0R/TchCkGAwAsgBEEMbGohBiAGIAk2AgAgBiAK/aQBaUEBSwR/IAkFIBEgECAK/VIQAQs2AgQgBiAS/Qz/////////////////////IAr9UhABNgIIIARBAWoiBCABSQ0ACyABIAIQAwuGAQEGfwNAQYDACyACQQxsaiEDIAMoAgAhBCADKAIIIQUgBUEATiAEQcAATSAEQQJ0IAMoAgRBA2xJcXEEQEGAoAsgBUECdGooAgAgAkYEQCABIAZBBmxqIQcgByACOwEAIAcgBTsBAiAHIAQ7AQQgBkEBaiEGCwsgAkEBaiICIABJDQALIAYL"
  })
});

// packages/compute/src/matching/wasm-exact-matcher.ts
var ABI = 1;
var MEMORY_BYTES = 4 * 65536;
var SLOT_BYTES = 512 * 32;
var FRAME = 163840;
var OUT = 194560;
var OUT_SLOT = 512 * 6;
var MAX_TARGETS = 10;
var WASM_MATCHER_VARIANTS = Object.freeze([
  "simd",
  "scalar"
]);
var aborted = () => new EngineError("ABORTED", "Matching aborted", { isRecoverable: true });
function throwIfAborted(signal) {
  if (signal?.aborted) throw aborted();
}
var invalidRequest = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
function descriptorCount2(bytes) {
  return bytes instanceof Uint8Array && bytes.length % 32 === 0 && bytes.length <= SLOT_BYTES ? bytes.length / 32 : -1;
}
function decode(base64) {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}
var WasmExactMatcher = class {
  #match;
  #u8;
  #u16;
  #variant;
  #targets = /* @__PURE__ */ new Map();
  #failure = null;
  constructor(instance, variant) {
    const e = instance?.exports;
    if (!WASM_MATCHER_VARIANTS.includes(variant) || !(e?.memory instanceof WebAssembly.Memory) || e.memory.buffer.byteLength !== MEMORY_BYTES || typeof e.match !== "function" || typeof e.abi !== "function" || e.abi() !== ABI) {
      throw new EngineError("UNSUPPORTED", "Invalid exact matching module", {
        isRecoverable: false
      });
    }
    this.#match = e.match;
    this.#variant = variant;
    this.#u8 = new Uint8Array(e.memory.buffer);
    this.#u16 = new Uint16Array(e.memory.buffer);
  }
  get variant() {
    return this.#variant;
  }
  get isAvailable() {
    return this.#match !== null;
  }
  get diagnostics() {
    return {
      matchingVersion: EXACT_MATCHING_VERSION,
      backend: this.#match ? "wasm" : "cpu",
      variant: this.#variant,
      fallbackReason: this.#failure,
      targetCount: this.#targets.size
    };
  }
  #live() {
    if (!this.#match || !this.#u8 || !this.#u16) {
      throw new EngineError("RESOURCE_FAILED", "WASM exact matcher unavailable", {
        isRecoverable: false
      });
    }
    return { match: this.#match, u8: this.#u8, u16: this.#u16 };
  }
  /** Replaces the resident roster: at most ten unique targets of at most 512 descriptors; fully validated before any byte is written. */
  setTargets(targets) {
    const { u8 } = this.#live();
    if (!Array.isArray(targets) || targets.length > MAX_TARGETS || new Set(targets.map((t) => t?.id)).size !== targets.length) {
      throw invalidRequest("Expected at most ten unique targets");
    }
    const counts = targets.map((t) => {
      if (typeof t.id !== "string" || !t.id || t.id.length > 256)
        throw invalidRequest("Invalid target ID");
      const n = descriptorCount2(t.descriptors);
      if (n < 0) throw invalidRequest("Expected at most 512 packed 32-byte descriptors");
      return n;
    });
    const next = /* @__PURE__ */ new Map();
    targets.forEach((t, slot) => {
      u8.set(t.descriptors, slot * SLOT_BYTES);
      next.set(t.id, { offset: slot * SLOT_BYTES, count: counts[slot] });
    });
    this.#targets = next;
  }
  /** One frame upload, then one exact pass per requested resident target. */
  matchBatch(targetIds, frame, signal) {
    const { match, u8, u16 } = this.#live();
    throwIfAborted(signal);
    if (!Array.isArray(targetIds) || targetIds.length > MAX_TARGETS || new Set(targetIds).size !== targetIds.length || targetIds.some((id) => !this.#targets.has(id))) {
      throw invalidRequest("Expected at most ten loaded targets");
    }
    const m = descriptorCount2(frame);
    if (m < 0) throw invalidRequest("Expected at most 512 packed 32-byte descriptors");
    const start = performance.now();
    const matches = [];
    u8.set(frame, FRAME);
    for (let k = 0; k < targetIds.length; k++) {
      throwIfAborted(signal);
      const targetId = targetIds[k];
      const target = this.#targets.get(targetId);
      const out = OUT + k * OUT_SLOT;
      const count = match(target.offset, target.count, out, m);
      if (!Number.isInteger(count) || count < 0 || count > Math.min(target.count, m)) {
        throw new EngineError("RESOURCE_FAILED", "WASM exact matching failed", {
          isRecoverable: false
        });
      }
      const pairs = new Array(count);
      for (let q = 0, p = out >>> 1; q < count; q++, p += 3) {
        pairs[q] = { targetIndex: u16[p], frameIndex: u16[p + 1], distance: u16[p + 2] };
      }
      matches.push({ targetId, pairs });
    }
    throwIfAborted(signal);
    return {
      backend: "wasm",
      variant: this.#variant,
      matchingVersion: EXACT_MATCHING_VERSION,
      matches,
      timing: { totalMs: performance.now() - start }
    };
  }
  /** Permanently disables this instance (the caller then keeps the JavaScript matcher) and records why. */
  fail(reason) {
    this.#failure = reason;
    this.dispose();
  }
  /** Drops every reference to the instance and its memory; later calls throw. */
  dispose() {
    this.#match = null;
    this.#u8 = null;
    this.#u16 = null;
    this.#targets.clear();
  }
};
function selfTestCases() {
  let seed = 625341585;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const random = (n) => {
    const b = new Uint8Array(n * 32);
    for (let i = 0; i < b.length; i++) b[i] = rnd() & 255;
    return b;
  };
  const flip = (src, i, bits) => {
    const d = src.slice(i * 32, i * 32 + 32);
    for (let k = 0; k < bits; k++) d[k % 32] ^= 1 << (k >> 5);
    return d;
  };
  const join = (list) => {
    const out = new Uint8Array(list.reduce((s, d) => s + d.length, 0));
    let o = 0;
    for (const d of list) {
      out.set(d, o);
      o += d.length;
    }
    return out;
  };
  const target = random(37);
  const frameList = [];
  for (let j = 0; j < 41; j++)
    frameList.push(j % 3 === 0 ? flip(target, j * 7 % 37, j % 70) : random(1));
  const zero = new Uint8Array(32);
  const ones = (bits) => {
    const d = new Uint8Array(32);
    for (let k = 0; k < bits; k++) d[k >> 3] |= 1 << (k & 7);
    return d;
  };
  const big = random(512);
  return [
    [target, join(frameList)],
    [
      join([target.slice(0, 32), target.slice(0, 32), target.slice(32, 64)]),
      join([target.slice(0, 32), target.slice(32, 96)])
    ],
    [join([zero, ones(256)]), join([ones(64), ones(65)])],
    [join([zero]), join([ones(64)])],
    [join([zero]), join([ones(65)])],
    [join([zero]), join([ones(30), ones(40)])],
    [join([zero]), join([ones(30), ones(41)])],
    [join([zero]), join([ones(30), ones(39), ones(200)])],
    [big, join([big.slice(0, 32 * 300), random(212)])]
  ];
}
function passesSelfTest(matcher) {
  try {
    for (const [target, frame] of selfTestCases()) {
      matcher.setTargets([{ id: "self-test", descriptors: target }]);
      const got = matcher.matchBatch(["self-test"], frame).matches[0].pairs;
      const want = matchHammingReference(target, frame);
      if (got.length !== want.length || got.some(
        (p, i) => p.targetIndex !== want[i].targetIndex || p.frameIndex !== want[i].frameIndex || p.distance !== want[i].distance
      )) {
        return false;
      }
    }
    matcher.setTargets([]);
    return true;
  } catch {
    return false;
  }
}
async function selectWasmExactMatcher(options = {}) {
  const {
    variants = WASM_MATCHER_VARIANTS,
    signal,
    webAssembly = globalThis.WebAssembly,
    binaries = EXACT_MATCHING_WASM
  } = options;
  throwIfAborted(signal);
  if (!Array.isArray(variants) || !variants.length || variants.some((v) => !WASM_MATCHER_VARIANTS.includes(v))) {
    throw invalidRequest("Unknown WASM exact matching variant");
  }
  const attempts = [];
  if (typeof webAssembly?.instantiate !== "function" || typeof webAssembly.validate !== "function") {
    return {
      matcher: null,
      variant: null,
      fallbackReason: "WASM_UNAVAILABLE",
      attempts: [{ variant: "*", outcome: "WASM_UNAVAILABLE" }]
    };
  }
  for (const variant of variants) {
    let bytes;
    try {
      bytes = decode(binaries[variant].base64);
    } catch {
      attempts.push({ variant, outcome: "WASM_MODULE_MISSING" });
      continue;
    }
    if (!webAssembly.validate(bytes)) {
      attempts.push({
        variant,
        outcome: variant === "simd" ? "WASM_SIMD_UNSUPPORTED" : "WASM_MODULE_INVALID"
      });
      continue;
    }
    let matcher;
    try {
      const { instance } = await webAssembly.instantiate(bytes, {});
      throwIfAborted(signal);
      matcher = new WasmExactMatcher(instance, variant);
    } catch (error) {
      if (error instanceof EngineError && error.code === "ABORTED") throw error;
      attempts.push({ variant, outcome: "WASM_INIT_FAILED" });
      continue;
    }
    if (!passesSelfTest(matcher)) {
      matcher.dispose();
      attempts.push({ variant, outcome: "WASM_SELFTEST_MISMATCH" });
      continue;
    }
    attempts.push({ variant, outcome: "selected" });
    return {
      matcher,
      variant,
      fallbackReason: attempts.length > 1 ? attempts[0].outcome : null,
      attempts
    };
  }
  return {
    matcher: null,
    variant: null,
    fallbackReason: attempts[0]?.outcome ?? "WASM_UNAVAILABLE",
    attempts
  };
}
function createWasmMatchOperator(matcher, options = {}) {
  let roster = /* @__PURE__ */ new Map();
  return async (targets, frameDescriptors, signal) => {
    if (!matcher.isAvailable) return null;
    throwIfAborted(signal);
    if (targets.length > MAX_TARGETS || descriptorCount2(frameDescriptors) < 0 || targets.some((t) => descriptorCount2(t.descriptors) < 0)) {
      return null;
    }
    try {
      let changed = false;
      let next = new Map(roster);
      for (const t of targets) {
        if (next.get(t.targetId) !== t.descriptors) {
          changed = true;
          next.set(t.targetId, t.descriptors);
        }
      }
      if (next.size > MAX_TARGETS) {
        next = new Map(targets.map((t) => [t.targetId, t.descriptors]));
        changed = true;
      }
      if (changed) {
        roster = /* @__PURE__ */ new Map();
        matcher.setTargets([...next].map(([id, descriptors]) => ({ id, descriptors })));
        roster = next;
      }
      return matcher.matchBatch(
        targets.map((t) => t.targetId),
        frameDescriptors,
        signal
      );
    } catch (error) {
      if (error instanceof EngineError && error.code === "ABORTED" || signal?.aborted)
        throw error;
      roster = /* @__PURE__ */ new Map();
      matcher.fail("WASM_EXECUTION_FAILED");
      try {
        options.onFailure?.("WASM_EXECUTION_FAILED");
      } catch {
      }
      return null;
    }
  };
}

// packages/compute/src/standard-image/standardize.ts
var STANDARD_MAX_EDGE = 4096;
var STANDARD_MAX_PIXELS = 4194304;
var RAW_MAX_EDGE = 16384;
var RAW_MAX_PIXELS = 16777216;
var SOURCE_TOO_LARGE = "Worker source frame exceeds supported size";
var STANDARD_TOO_LARGE = "Standard image exceeds processing limit; frames are never silently resized";
function checkRawLayout(image) {
  const { width, height, strideBytes: stride } = image;
  const channels = image.kind === "gray8" ? 1 : image.kind === "rgba8" ? 4 : 0;
  if (!channels || !(image.buffer instanceof ArrayBuffer) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || !Number.isSafeInteger(stride) || stride < width * channels || !Number.isSafeInteger((height - 1) * stride + width * channels) || (height - 1) * stride + width * channels > image.buffer.byteLength) {
    throw new EngineError("FRAME_FAILED", "Invalid worker CPU layout", { isRecoverable: false });
  }
  if (width > RAW_MAX_EDGE || height > RAW_MAX_EDGE || width * height > RAW_MAX_PIXELS) {
    throw new EngineError("UNSUPPORTED", SOURCE_TOO_LARGE, { isRecoverable: false });
  }
  return channels;
}
function checkStandardSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new EngineError("FRAME_FAILED", "Invalid standard image dimensions", {
      isRecoverable: false
    });
  }
  if (width > STANDARD_MAX_EDGE || height > STANDARD_MAX_EDGE || width * height > STANDARD_MAX_PIXELS) {
    throw new EngineError("UNSUPPORTED", STANDARD_TOO_LARGE, { isRecoverable: false });
  }
}
function checkGeometry(geometry) {
  checkStandardSize(geometry.standardWidthPx, geometry.standardHeightPx);
  const h = geometry.H_standardFromInput;
  const invalid3 = () => {
    throw new EngineError("FRAME_FAILED", "Invalid frame transform", { isRecoverable: false });
  };
  if (!h || h.length !== 9) invalid3();
  for (let i = 0; i < 9; i++) if (typeof h[i] !== "number" || !Number.isFinite(h[i])) invalid3();
  if (h[6] !== 0 || h[7] !== 0 || h[8] !== 1) invalid3();
}
var now = () => performance.now();
function drawStandard(workspace, source, geometry, stages) {
  const began = stages ? now() : 0;
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const h = geometry.H_standardFromInput;
  const out = workspace.outputSurface(width, height).context;
  try {
    out.setTransform(1, 0, 0, 1, 0, 0);
    out.clearRect(0, 0, width, height);
    out.setTransform(h[0], h[3], h[1], h[4], h[2], h[5]);
    out.drawImage(source, 0, 0);
  } finally {
    out.setTransform(1, 0, 0, 1, 0, 0);
  }
  const drawn = stages ? now() : 0;
  const pixels = out.getImageData(0, 0, width, height).data;
  if (stages) {
    stages.standardDrawDurationUs += (drawn - began) * 1e3;
    stages.readbackDurationUs += (now() - drawn) * 1e3;
  }
  return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}
function standardizeCpuPixels(image, channels, geometry, workspace, convert, stages) {
  checkGeometry(geometry);
  if (typeof OffscreenCanvas === "undefined" || typeof ImageData === "undefined") {
    throw new EngineError("UNSUPPORTED", "Input pixels require Worker canvas", {
      isRecoverable: true
    });
  }
  const stride = image.strideBytes;
  const rowBytes = image.width * channels;
  const packingStarted = stages ? now() : 0;
  let rgba;
  if (channels === 4 && stride === rowBytes)
    rgba = new Uint8ClampedArray(image.buffer, 0, rowBytes * image.height);
  else {
    rgba = workspace.bytes(image.width * image.height * 4);
    const source = new Uint8Array(image.buffer);
    if (channels === 4) {
      for (let y = 0; y < image.height; y++)
        rgba.set(source.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
    } else {
      for (let y = 0; y < image.height; y++) {
        let from = y * stride;
        let to = y * rowBytes * 4;
        for (let x = 0; x < image.width; x++, from++, to += 4) {
          rgba[to] = rgba[to + 1] = rgba[to + 2] = source[from];
          rgba[to + 3] = 255;
        }
      }
    }
  }
  const packed = stages ? now() : 0;
  const input = workspace.inputSurface(image.width, image.height);
  input.context.putImageData(new ImageData(rgba, image.width, image.height), 0, 0);
  if (stages) {
    stages.inputPackingDurationUs += (packed - packingStarted) * 1e3;
    stages.inputUploadDurationUs += (now() - packed) * 1e3;
  }
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const pixels = drawStandard(workspace, input.canvas, geometry, stages);
  const grayStarted = stages ? now() : 0;
  const data = convert(pixels, width, height).data;
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;
  return { widthPx: width, heightPx: height, data };
}
function standardizeStandardPixels(image, channels, convert, stages) {
  checkStandardSize(image.width, image.height);
  const width = image.width;
  const height = image.height;
  const stride = image.strideBytes;
  const rowBytes = width * channels;
  const grayStarted = stages ? now() : 0;
  let data;
  if (channels === 4)
    data = convert(
      new Uint8Array(image.buffer, 0, (height - 1) * stride + rowBytes),
      width,
      height,
      stride
    ).data;
  else if (stride === rowBytes) data = new Uint8Array(image.buffer, 0, width * height);
  else {
    data = new Uint8Array(width * height);
    const source = new Uint8Array(image.buffer);
    for (let y = 0; y < height; y++)
      data.set(source.subarray(y * stride, y * stride + width), y * width);
  }
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;
  return { widthPx: width, heightPx: height, data };
}
function standardize(input, workspace, convert = rgbaToGray, stages) {
  const { image, geometry } = input;
  if ("buffer" in image) {
    const channels = checkRawLayout(image);
    return geometry ? standardizeCpuPixels(image, channels, geometry, workspace, convert, stages) : standardizeStandardPixels(image, channels, convert, stages);
  }
  if (!geometry || typeof OffscreenCanvas === "undefined") {
    throw new EngineError(
      "UNSUPPORTED",
      "Native frame conversion needs Worker OffscreenCanvas and geometry",
      {
        isRecoverable: true
      }
    );
  }
  const source = image.image;
  const sourceWidth = source.displayWidth ?? source.width;
  const sourceHeight = source.displayHeight ?? source.height;
  if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth < 1 || sourceHeight < 1 || sourceWidth > RAW_MAX_EDGE || sourceHeight > RAW_MAX_EDGE || sourceWidth * sourceHeight > RAW_MAX_PIXELS) {
    throw new EngineError("UNSUPPORTED", SOURCE_TOO_LARGE, { isRecoverable: false });
  }
  checkGeometry(geometry);
  const width = geometry.standardWidthPx;
  const height = geometry.standardHeightPx;
  const pixels = drawStandard(workspace, image.image, geometry, stages);
  const grayStarted = stages ? now() : 0;
  const data = convert(pixels, width, height).data;
  if (stages) stages.grayscaleDurationUs += (now() - grayStarted) * 1e3;
  return { widthPx: width, heightPx: height, data };
}

// packages/compute/src/standard-image/workspace.ts
var SCRATCH_CACHE_MAX_BYTES = 16 * 1048576;
var offscreenSurface = (widthPx, heightPx, willReadFrequently) => {
  let canvas = null;
  try {
    canvas = new OffscreenCanvas(widthPx, heightPx);
    const context = canvas.getContext(
      "2d",
      willReadFrequently ? { willReadFrequently: true } : void 0
    );
    if (context) return { canvas, context };
  } catch {
  }
  if (canvas) canvas.width = canvas.height = 0;
  throw new EngineError("UNSUPPORTED", "No worker canvas", { isRecoverable: true });
};
var StandardImageWorkspace = class {
  input = null;
  output = null;
  scratch = null;
  createSurface;
  constructor(createSurface = offscreenSurface) {
    this.createSurface = createSurface;
  }
  inputSurface(widthPx, heightPx) {
    return this.input = this.fit(this.input, widthPx, heightPx, false);
  }
  outputSurface(widthPx, heightPx) {
    return this.output = this.fit(this.output, widthPx, heightPx, true);
  }
  fit(surface, widthPx, heightPx, willReadFrequently) {
    if (!surface) return this.createSurface(widthPx, heightPx, willReadFrequently);
    if (surface.canvas.width !== widthPx || surface.canvas.height !== heightPx) {
      surface.canvas.width = widthPx;
      surface.canvas.height = heightPx;
    }
    return surface;
  }
  /** Contents are undefined; callers overwrite every byte. Small buffers are reused across frames. */
  bytes(length) {
    if (length > SCRATCH_CACHE_MAX_BYTES) return new Uint8ClampedArray(length);
    if (!this.scratch || this.scratch.byteLength < length) this.scratch = new ArrayBuffer(length);
    return new Uint8ClampedArray(this.scratch, 0, length);
  }
  dispose() {
    for (const surface of [this.input, this.output])
      if (surface) surface.canvas.width = surface.canvas.height = 0;
    this.input = this.output = null;
    this.scratch = null;
  }
};

// packages/recognition/src/features/anms.ts
var ANMS_ROBUSTNESS = 0.9;
var ANMS_POOL_LIMIT = 1024;
var MAX_POOL_LIMIT = 4096;
var ANMS_SELECTION_ID = `anms-c${ANMS_ROBUSTNESS}-pool${ANMS_POOL_LIMIT}-per-level`;
var byStrength = (a, b) => b.score - a.score || a.y - b.y || a.x - b.x;
function anmsRadiiSquared(sorted, robustness = ANMS_ROBUSTNESS) {
  const n = sorted.length;
  const radii = new Array(n);
  let stronger = 0;
  for (let i = 0; i < n; i++) {
    while (stronger < i && sorted[i].score < robustness * sorted[stronger].score) stronger++;
    let best = Infinity;
    for (let j = 0; j < stronger; j++) {
      const dx = sorted[j].x - sorted[i].x;
      const dy = sorted[j].y - sorted[i].y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    radii[i] = best;
  }
  return radii;
}
function selectAnms(candidates, count, { robustness = ANMS_ROBUSTNESS, poolLimit = ANMS_POOL_LIMIT } = {}) {
  const invalid3 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Array.isArray(candidates)) throw invalid3("INVALID_ANMS_CANDIDATES");
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > MAX_POOL_LIMIT || !(robustness > 0 && robustness < 1)) {
    throw invalid3("INVALID_ANMS_OPTIONS");
  }
  for (const c of candidates) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.score) || c.score <= 0) {
      throw invalid3("INVALID_ANMS_CANDIDATE");
    }
  }
  if (!count || !candidates.length) return [];
  const pool = candidates.slice().sort(byStrength).slice(0, poolLimit);
  const radii = anmsRadiiSquared(pool, robustness);
  return pool.map((candidate, rank) => ({ candidate, rank, radius: radii[rank] })).sort((a, b) => (a.radius === b.radius ? 0 : b.radius - a.radius) || a.rank - b.rank).slice(0, count).map((entry) => entry.candidate);
}

// packages/recognition/src/features/brief.ts
function generatePattern() {
  let seed = 2654435769;
  const offset = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % 17 - 8;
  };
  return Array.from({ length: 256 }, () => [offset(), offset(), offset(), offset()]);
}
var BRIEF_PATTERN = generatePattern();
function briefOffsetTable(widthPx) {
  const table = new Int32Array(512);
  for (let bit = 0; bit < 256; bit++) {
    const p = BRIEF_PATTERN[bit];
    table[2 * bit] = p[1] * widthPx + p[0];
    table[2 * bit + 1] = p[3] * widthPx + p[2];
  }
  return table;
}
function describe(data, center, table) {
  const descriptor = Array(32).fill(0);
  for (let bit = 0, k = 0; bit < 256; bit++, k += 2) {
    if (data[center + table[k]] < data[center + table[k + 1]])
      descriptor[bit >> 3] |= 1 << (bit & 7);
  }
  return descriptor;
}

// packages/recognition/src/image/gray-image.ts
var RECOGNITION_LIMITS = Object.freeze({
  /** Most pixels of one image. */
  pixels: 4194304,
  /** Longest image edge. */
  dimension: 4096,
  /** Most features per image (target or frame). */
  features: 512,
  /** Most pyramid levels. */
  levels: 4,
  /** Most loaded targets. */
  targets: 10
});
function validateGray(image) {
  const { widthPx, heightPx, data } = image ?? {};
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 32 || heightPx < 32 || widthPx > RECOGNITION_LIMITS.dimension || heightPx > RECOGNITION_LIMITS.dimension || widthPx * heightPx > RECOGNITION_LIMITS.pixels || !(data instanceof Uint8Array) || data.length !== widthPx * heightPx) {
    throw new EngineError("INVALID_CONFIG", "INVALID_GRAY8", { isRecoverable: false });
  }
}

// packages/recognition/src/features/harris.ts
function createTensorRows(widthPx) {
  return [new Int32Array(widthPx * 3), new Int32Array(widthPx * 3), new Int32Array(widthPx * 3)];
}
function harrisScores(data, w, h, scale, roi, scores, rows) {
  let x0 = 10;
  let x1 = w - 10;
  let y0 = 10;
  let y1 = h - 10;
  if (roi) {
    while (x0 < x1 && (x0 + 0.5) * scale - 0.5 < roi.x) x0++;
    while (x1 > x0 && (x1 - 0.5) * scale - 0.5 >= roi.x + roi.width) x1--;
    while (y0 < y1 && (y0 + 0.5) * scale - 0.5 < roi.y) y0++;
    while (y1 > y0 && (y1 - 0.5) * scale - 0.5 >= roi.y + roi.height) y1--;
  }
  if (x0 >= x1 || y0 >= y1) return;
  const [xxRows, yyRows, xyRows] = rows;
  const row = (y) => {
    const base = y * w;
    const slot = y % 3 * w;
    let i = base + x0 - 1;
    let gx = data[i + 1] - data[i - 1];
    let gy = data[i + w] - data[i - w];
    let ax = gx * gx;
    let ay = gy * gy;
    let az = gx * gy;
    i++;
    gx = data[i + 1] - data[i - 1];
    gy = data[i + w] - data[i - w];
    let bx = gx * gx;
    let by = gy * gy;
    let bz = gx * gy;
    for (let x = x0; x < x1; x++) {
      i = base + x + 1;
      gx = data[i + 1] - data[i - 1];
      gy = data[i + w] - data[i - w];
      const cx = gx * gx;
      const cy = gy * gy;
      const cz = gx * gy;
      xxRows[slot + x] = ax + bx + cx;
      yyRows[slot + x] = ay + by + cy;
      xyRows[slot + x] = az + bz + cz;
      ax = bx;
      ay = by;
      az = bz;
      bx = cx;
      by = cy;
      bz = cz;
    }
  };
  row(y0 - 1);
  row(y0);
  for (let y = y0; y < y1; y++) {
    row(y + 1);
    const a = (y - 1) % 3 * w;
    const b = y % 3 * w;
    const c = (y + 1) % 3 * w;
    for (let x = x0; x < x1; x++) {
      const xx = xxRows[a + x] + xxRows[b + x] + xxRows[c + x];
      const yy = yyRows[a + x] + yyRows[b + x] + yyRows[c + x];
      const xy = xyRows[a + x] + xyRows[b + x] + xyRows[c + x];
      scores[y * w + x] = xx * yy - xy * xy - 0.04 * (xx + yy) ** 2;
    }
  }
}
function detectCorners(data, w, h, scale, roi, rows) {
  const scores = new Float64Array(w * h);
  const candidates = [];
  harrisScores(data, w, h, scale, roi, scores, rows);
  for (let y = 10; y < h - 10; y++) {
    for (let x = 10; x < w - 10; x++) {
      const score = scores[y * w + x];
      if (score < 1e6) continue;
      let peak = true;
      nms: for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (!dx && !dy) continue;
          const other = scores[(y + dy) * w + x + dx];
          if (other > score || other === score && (dy < 0 || dy === 0 && dx < 0)) {
            peak = false;
            break nms;
          }
        }
      }
      if (peak) candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
  return candidates;
}

// packages/recognition/src/features/pyramid.ts
function buildPyramid(image, levels = 3) {
  validateGray(image);
  if (!Number.isInteger(levels) || levels < 1 || levels > RECOGNITION_LIMITS.levels) {
    throw new EngineError("INVALID_CONFIG", "INVALID_LEVELS", { isRecoverable: false });
  }
  const result = [{ ...image, scale: 1 }];
  while (result.length < levels) {
    const prev = result.at(-1);
    const widthPx = Math.floor(prev.widthPx / 2);
    const heightPx = Math.floor(prev.heightPx / 2);
    if (Math.min(widthPx, heightPx) < 32) break;
    const data = new Uint8Array(widthPx * heightPx);
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const i = 2 * y * prev.widthPx + 2 * x;
        data[y * widthPx + x] = Math.round(
          (prev.data[i] + prev.data[i + 1] + prev.data[i + prev.widthPx] + prev.data[i + prev.widthPx + 1]) / 4
        );
      }
    }
    result.push({ widthPx, heightPx, data, scale: prev.scale * 2 });
  }
  return result;
}
function smoothBox3(level) {
  const { widthPx: w, heightPx: h, data } = level;
  const out = new Uint8Array(data);
  const rowSums = new Uint16Array(w * 3);
  const fillRow = (y) => {
    const base = y * w;
    const slot = y % 3 * w;
    let a = data[base];
    let b = data[base + 1];
    for (let x = 1; x < w - 1; x++) {
      const c = data[base + x + 1];
      rowSums[slot + x] = a + b + c;
      a = b;
      b = c;
    }
  };
  fillRow(0);
  fillRow(1);
  for (let y = 1; y < h - 1; y++) {
    fillRow(y + 1);
    const r0 = (y - 1) % 3 * w;
    const r1 = y % 3 * w;
    const r2 = (y + 1) % 3 * w;
    const base = y * w;
    for (let x = 1; x < w - 1; x++) {
      const sum = rowSums[r0 + x] + rowSums[r1 + x] + rowSums[r2 + x];
      out[base + x] = Math.round(sum / 9);
    }
  }
  return out;
}

// packages/recognition/src/features/extract.ts
function checkOptions(image, maxFeatures, roi) {
  const invalid3 = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Number.isInteger(maxFeatures) || maxFeatures < 16 || maxFeatures > RECOGNITION_LIMITS.features) {
    throw invalid3("INVALID_FEATURE_LIMIT");
  }
  if (roi && (!["x", "y", "width", "height"].every((k) => Number.isFinite(roi[k])) || roi.width <= 0 || roi.height <= 0 || roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.widthPx || roi.y + roi.height > image.heightPx)) {
    throw invalid3("INVALID_ROI");
  }
}
function extractFeatures(image, options) {
  const { maxFeatures, levels } = options;
  const roi = options.roi ?? null;
  validateGray(image);
  checkOptions(image, maxFeatures, roi);
  const layers = buildPyramid(image, levels);
  const features = [];
  const rows = createTensorRows(image.widthPx);
  for (let level = 0; level < layers.length; level++) {
    const layer = layers[level];
    const { widthPx: w, heightPx: h, scale } = layer;
    const data = smoothBox3(layer);
    const candidates = detectCorners(data, w, h, scale, roi, rows);
    const quota = Math.floor(maxFeatures / layers.length) + (level < maxFeatures % layers.length ? 1 : 0);
    const table = briefOffsetTable(w);
    let selectedCount = 0;
    for (const point of selectAnms(candidates, quota)) {
      const descriptor = describe(data, point.y * w + point.x, table);
      selectedCount++;
      features.push({
        x: (point.x + 0.5) * scale - 0.5,
        y: (point.y + 0.5) * scale - 0.5,
        level,
        score: point.score,
        descriptor
      });
      if (selectedCount >= quota) break;
    }
  }
  return {
    features,
    pyramid: layers.map(({ widthPx, heightPx, scale }) => ({ widthPx, heightPx, scale }))
  };
}

// packages/recognition/src/geometry/homography.ts
function project(h, [x, y]) {
  const z = h[6] * x + h[7] * y + h[8];
  return Math.abs(z) < 1e-10 ? [Infinity, Infinity] : [(h[0] * x + h[1] * y + h[2]) / z, (h[3] * x + h[4] * y + h[5]) / z];
}
function multiply(a, b) {
  return Array.from(
    { length: 9 },
    (_, i) => [0, 1, 2].reduce((s, k) => s + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + i % 3], 0)
  );
}
function normalize(points) {
  const cx = points.reduce((s2, p) => s2 + p[0], 0) / points.length;
  const cy = points.reduce((s2, p) => s2 + p[1], 0) / points.length;
  const radius = Math.sqrt(
    points.reduce((s2, p) => s2 + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / points.length
  );
  if (radius < 1e-8) return null;
  const s = Math.SQRT2 / radius;
  return {
    points: points.map(([x, y]) => [(x - cx) * s, (y - cy) * s]),
    t: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    inv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1]
  };
}
function solve(a, b) {
  const m = a.map((row, i) => [...row, b[i]]);
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    if (Math.abs(m[pivot][i]) < 1e-9) return null;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const divisor = m[i][i];
    for (let k = i; k <= n; k++) m[i][k] /= divisor;
    for (let j = 0; j < n; j++) {
      if (j !== i) {
        const f = m[j][i];
        for (let k = i; k <= n; k++) m[j][k] -= f * m[i][k];
      }
    }
  }
  return m.map((row) => row[n]);
}
function fitHomography(pairs) {
  if (pairs.length < 4) return null;
  const a = normalize(pairs.map((p) => p.target));
  const b = normalize(pairs.map((p) => p.image));
  if (!a || !b) return null;
  const ata = Array.from({ length: 8 }, () => Array(8).fill(0));
  const atb = Array(8).fill(0);
  for (let i = 0; i < pairs.length; i++) {
    const [x, y] = a.points[i];
    const [u, v] = b.points[i];
    for (const [row, rhs] of [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v]
    ]) {
      for (let j = 0; j < 8; j++) {
        atb[j] += row[j] * rhs;
        for (let k = 0; k < 8; k++) ata[j][k] += row[j] * row[k];
      }
    }
  }
  const h = solve(ata, atb);
  if (!h) return null;
  const denormalized = multiply(multiply(b.inv, [...h, 1]), a.t);
  const z = denormalized[8];
  if (Math.abs(z) < 1e-10) return null;
  const result = denormalized.map((v) => v / z);
  return result.every(Number.isFinite) ? result : null;
}
var cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hullArea(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return 0;
  const half = (values) => {
    const h = [];
    for (const p of values) {
      while (h.length >= 2 && cross(h.at(-2), h.at(-1), p) <= 0) h.pop();
      h.push(p);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(
    hull.reduce((s, p, i) => {
      const q = hull[(i + 1) % hull.length];
      return s + p[0] * q[1] - p[1] * q[0];
    }, 0)
  ) / 2;
}
function validateHomography(h, width, height) {
  if (!h || h.length !== 9 || !h.every(Number.isFinite)) return false;
  const det = h[0] * (h[4] * h[8] - h[5] * h[7]) - h[1] * (h[3] * h[8] - h[5] * h[6]) + h[2] * (h[3] * h[7] - h[4] * h[6]);
  if (Math.abs(det) < 1e-10) return false;
  const corners = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1]
  ];
  const denominators = corners.map(([x, y]) => h[6] * x + h[7] * y + h[8]);
  if (!(denominators.every((v) => v > 1e-7) || denominators.every((v) => v < -1e-7))) return false;
  const projected = corners.map((p) => project(h, p));
  return projected.every((p) => p.every(Number.isFinite)) && projected.every((p, i) => cross(p, projected[(i + 1) % 4], projected[(i + 2) % 4]) > 1e-6);
}

// packages/recognition/src/geometry/ransac.ts
function checkInput(pairs, width, height, options) {
  const { iterations, threshold, minInliers, minCoverage } = options;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 4096 || !Number.isFinite(threshold) || threshold <= 0 || threshold > 20 || !Number.isInteger(minInliers) || minInliers < 4 || !Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1) {
    throw new EngineError("INVALID_CONFIG", "INVALID_GEOMETRY_OPTIONS", { isRecoverable: false });
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2 || pairs.length > 512 || pairs.some(
    (p) => ![p.target, p.image].every(
      (q) => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite)
    )
  )) {
    throw new EngineError("FRAME_FAILED", "INVALID_PAIRS", { isRecoverable: false });
  }
}
function verifyGeometry(pairs, width, height, options = {}) {
  const { iterations = 256, threshold = 3, minInliers = 12, minCoverage = 0.08 } = options;
  let seed = options.seed ?? 12345;
  checkInput(pairs, width, height, { iterations, threshold, minInliers, minCoverage });
  const reject2 = (reason) => ({
    accepted: false,
    reason,
    H: null,
    pairs,
    inlierMask: pairs.map(() => false)
  });
  if (pairs.length < minInliers) return reject2("INSUFFICIENT_MATCHES");
  const errors = (h) => pairs.map((p) => {
    const q = project(h, p.target);
    return Math.hypot(q[0] - p.image[0], q[1] - p.image[1]);
  });
  let best = [];
  let bestError = Infinity;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  if (!(seed >>> 0)) seed = 12345;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const indices = /* @__PURE__ */ new Set();
    while (indices.size < 4) indices.add(random() % pairs.length);
    const h = fitHomography([...indices].map((i) => pairs[i]));
    if (!validateHomography(h, width, height)) continue;
    const e = errors(h);
    const indicesIn = e.flatMap((v, i) => v <= threshold ? [i] : []);
    const total = indicesIn.reduce((s, i) => s + e[i] ** 2, 0);
    if (indicesIn.length > best.length || indicesIn.length === best.length && total < bestError) {
      best = indicesIn;
      bestError = total;
    }
  }
  if (best.length < minInliers) return reject2("NO_ROBUST_MODEL");
  return refine(pairs, best, width, height, threshold, minInliers, minCoverage, errors, reject2);
}
function refine(pairs, best, width, height, threshold, minInliers, minCoverage, errors, reject2) {
  let h = fitHomography(best.map((i) => pairs[i]));
  if (!validateHomography(h, width, height)) return reject2("DEGENERATE_MODEL");
  let e = errors(h);
  let mask = e.map((v) => v <= threshold);
  h = fitHomography(pairs.filter((_, i) => mask[i]));
  if (!validateHomography(h, width, height)) return reject2("DEGENERATE_REFINEMENT");
  e = errors(h);
  mask = e.map((v) => v <= threshold);
  const selected = pairs.filter((_, i) => mask[i]);
  const inlierCount2 = selected.length;
  const ratio = inlierCount2 / pairs.length;
  const coverage = hullArea(selected.map((p) => p.target)) / ((width - 1) * (height - 1));
  if (inlierCount2 < minInliers || ratio < 0.35) return reject2("LOW_INLIER_SUPPORT");
  if (coverage < minCoverage) return reject2("LOW_SPATIAL_COVERAGE");
  const inlierErrors = e.filter((_, i) => mask[i]);
  return {
    accepted: true,
    reason: "GEOMETRY_VERIFIED",
    H: h,
    pairs,
    inlierMask: mask,
    inlierCount: inlierCount2,
    inlierRatio: ratio,
    coverage,
    rmsErrorPx: Math.sqrt(inlierErrors.reduce((s, v) => s + v * v, 0) / inlierCount2),
    maxErrorPx: Math.max(...inlierErrors)
  };
}

// packages/recognition/src/matching/packed-matcher.ts
function packDescriptors(features) {
  const packed = new Uint32Array(features.length * 8);
  for (let i = 0; i < features.length; i++) {
    for (let k = 0; k < 8; k++) {
      const d = features[i].descriptor;
      const j = k * 4;
      packed[i * 8 + k] = (d[j] | d[j + 1] << 8 | d[j + 2] << 16 | d[j + 3] << 24) >>> 0;
    }
  }
  return packed;
}
function popcount2(v) {
  v = v - (v >>> 1 & 1431655765);
  v = (v & 858993459) + (v >>> 2 & 858993459);
  return (v + (v >>> 4) & 252645135) * 16843009 >>> 24;
}
function packedDistance(a, ai, b, bi) {
  let d = 0;
  for (let k = 0; k < 8; k++) d += popcount2(a[ai * 8 + k] ^ b[bi * 8 + k]);
  return d;
}
function nibbles(x) {
  x = x - (x >>> 1 & 1431655765) | 0;
  return (x & 858993459) + (x >>> 2 & 858993459) | 0;
}
function byteLanes(v) {
  return (v & 252645135) + (v >>> 4 & 252645135) | 0;
}
var isWords = (a, n) => (a instanceof Uint32Array || a instanceof Int32Array) && a.length >= n;
function pairAt(target, frame, i, index, distance) {
  return {
    target: [target[i].x, target[i].y],
    image: [frame[index].x, frame[index].y],
    distance
  };
}
function matchWords(target, frame, tp, fp, nt, nf) {
  const reverse = new Int32Array(nf).fill(-1);
  const rd = new Uint16Array(nf).fill(257);
  const bests = new Uint16Array(nt);
  const seconds = new Uint16Array(nt);
  const indices = new Int32Array(nt);
  for (let i = 0; i < nt; i++) {
    const o = i * 8;
    const t0 = tp[o] | 0;
    const t1 = tp[o + 1] | 0;
    const t2 = tp[o + 2] | 0;
    const t3 = tp[o + 3] | 0;
    const t4 = tp[o + 4] | 0;
    const t5 = tp[o + 5] | 0;
    const t6 = tp[o + 6] | 0;
    const t7 = tp[o + 7] | 0;
    let best = 257;
    let second = 257;
    let index = -1;
    for (let j = 0, p = 0; j < nf; j++, p += 8) {
      const a = nibbles(t0 ^ fp[p]) + nibbles(t1 ^ fp[p + 1]);
      const b = nibbles(t2 ^ fp[p + 2]) + nibbles(t3 ^ fp[p + 3]);
      const c = nibbles(t4 ^ fp[p + 4]) + nibbles(t5 ^ fp[p + 5]);
      const e = nibbles(t6 ^ fp[p + 6]) + nibbles(t7 ^ fp[p + 7]);
      let s = byteLanes(a) + byteLanes(b) + byteLanes(c) + byteLanes(e) | 0;
      s = (s & 16711935) + (s >>> 8 & 16711935) | 0;
      const d = (s & 65535) + (s >>> 16);
      if (d < best) {
        second = best;
        best = d;
        index = j;
      } else if (d < second) second = d;
      const r = rd[j];
      if (d < r) {
        rd[j] = d;
        reverse[j] = i;
      } else if (d === r) reverse[j] = -1;
    }
    bests[i] = best;
    seconds[i] = second;
    indices[i] = index;
  }
  const out = [];
  for (let i = 0; i < nt; i++) {
    const index = indices[i];
    const best = bests[i];
    if (index >= 0 && best <= 64 && 4 * best < 3 * seconds[i] && reverse[index] === i) {
      out.push(pairAt(target, frame, i, index, best));
    }
  }
  return out;
}
function matchGeneric(target, frame, tp, fp) {
  const reverse = new Int32Array(frame.length).fill(-1);
  const rd = new Uint16Array(frame.length).fill(257);
  const nearest = [];
  for (let i = 0; i < target.length; i++) {
    let best = 257;
    let second = 257;
    let index = -1;
    for (let j = 0; j < frame.length; j++) {
      const d = packedDistance(tp, i, fp, j);
      if (d < best) {
        second = best;
        best = d;
        index = j;
      } else if (d < second) second = d;
      if (d < rd[j]) {
        rd[j] = d;
        reverse[j] = i;
      } else if (d === rd[j]) reverse[j] = -1;
    }
    nearest.push({ best, second, index });
  }
  return nearest.flatMap(
    ({ best, second, index }, i) => index >= 0 && best <= 64 && 4 * best < 3 * second && reverse[index] === i ? [pairAt(target, frame, i, index, best)] : []
  );
}
function matchPacked(target, frame, tp = packDescriptors(target), fp = packDescriptors(frame)) {
  const nt = target.length;
  const nf = frame.length;
  if (Number.isInteger(nt) && Number.isInteger(nf) && nt >= 0 && nf >= 0 && isWords(tp, nt * 8) && isWords(fp, nf * 8)) {
    return matchWords(
      target,
      frame,
      tp,
      fp,
      nt,
      nf
    );
  }
  return matchGeneric(target, frame, tp, fp);
}
var BIT_COUNTS = Uint8Array.from({ length: 256 }, (_, value) => {
  let n = 0;
  while (value) {
    value &= value - 1;
    n++;
  }
  return n;
});
function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < 32; i++) n += BIT_COUNTS[a[i] ^ b[i]];
  return n;
}

// packages/recognition/src/scale/intermediate-scale.ts
var INTERMEDIATE_SCALE = Math.SQRT1_2;
function intermediateScaleImage(image) {
  validateGray(image);
  const scale = INTERMEDIATE_SCALE;
  const widthPx = Math.floor(image.widthPx * scale);
  const heightPx = Math.floor(image.heightPx * scale);
  if (widthPx < 32 || heightPx < 32) return null;
  const source = image.data;
  const data = new Uint8Array(widthPx * heightPx);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < widthPx; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const sy = (y + 0.5) / scale - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      const fx = sx - ix;
      const fy = sy - iy;
      const i = iy * image.widthPx + ix;
      data[y * widthPx + x] = Math.round(
        (1 - fy) * ((1 - fx) * source[i] + fx * source[i + 1]) + fy * ((1 - fx) * source[i + image.widthPx] + fx * source[i + image.widthPx + 1])
      );
    }
  }
  return { widthPx, heightPx, data };
}

// packages/recognition/src/targets/target-validation.ts
var ALGORITHM_VERSION = "m0-harris-anms-brief256-v1";
var COMPILER_VERSION = "webar-gray8-cpu/0.3.0";
var TARGET_MAX_FEATURES = 384;
var TARGET_LEVELS = 3;
var RETIRED_ALGORITHMS = ["m0-harris-brief256-v1", "c-oriented-brief256-v2"];
function preprocessingRecord(levels, maxFeatures) {
  return {
    pixelFormat: "gray8",
    levels,
    maxFeatures,
    downsample: "box2-center",
    smoothing: "box3",
    orientation: "upright-only",
    selection: ANMS_SELECTION_ID
  };
}
var invalid = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}
function diagnoseFeatures(features, widthPx, heightPx) {
  const diagnostics = [];
  const add = (code, message) => {
    diagnostics.push({ code, message, severity: "error" });
  };
  if (features.length < 24)
    add("LOW_TEXTURE", `Only ${features.length} features; require at least 24 for this baseline.`);
  if (hullArea(features.map((f) => [f.x, f.y])) / (widthPx * heightPx) < 0.15) {
    add("LOW_COVERAGE", "Features cover less than 15 percent of target area.");
  }
  const repeated = features.filter(
    (f, i) => features.some((g, j) => i !== j && hamming(f.descriptor, g.descriptor) <= 16)
  ).length;
  if (features.length && repeated / features.length > 0.35) {
    add("REPETITIVE_TEXTURE", "More than 35 percent of descriptors have a near duplicate.");
  }
  return diagnostics;
}
function featuresFromTarget(target) {
  return target.features.points.map(([x, y], i) => ({
    x,
    y,
    level: 0,
    score: 1,
    descriptor: target.features.descriptors.slice(i * 32, (i + 1) * 32)
  }));
}
function preflightTarget(value) {
  const candidate = value;
  if (!candidate || !Array.isArray(candidate.features?.points) || candidate.features.points.length > RECOGNITION_LIMITS.features || !Array.isArray(candidate.features?.descriptors) || candidate.features.descriptors.length > RECOGNITION_LIMITS.features * 32 || !Array.isArray(candidate.pyramid) || candidate.pyramid.length > 8 || candidate.pyramid.some(
    (l) => !Array.isArray(l?.pixels) || l.pixels.length > RECOGNITION_LIMITS.pixels
  )) {
    invalid("Target exceeds CPU baseline bounds");
  }
  validateTargetBundle(value);
  const t = value;
  if (RETIRED_ALGORITHMS.includes(t.algorithmVersion)) {
    invalid(
      `Target was compiled with ${t.algorithmVersion}; recompile it with ${ALGORITHM_VERSION}`
    );
  }
  if (t.algorithmVersion !== ALGORITHM_VERSION || t.compilerVersion !== COMPILER_VERSION || t.features.descriptorType !== t.algorithmVersion || t.features.descriptorLength !== 32 || t.imageHashDomain !== "canonical-gray8" || t.widthPx < 32 || t.heightPx < 32 || t.widthPx > RECOGNITION_LIMITS.dimension || t.heightPx > RECOGNITION_LIMITS.dimension || t.widthPx * t.heightPx > RECOGNITION_LIMITS.pixels || t.features.points.length > RECOGNITION_LIMITS.features || t.pyramid.length < 1 || t.pyramid.length > RECOGNITION_LIMITS.levels || !t.features.descriptors.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) || !t.features.points.every(([x, y]) => x >= 0 && y >= 0 && x < t.widthPx && y < t.heightPx)) {
    invalid("Unsupported algorithm, dimensions or feature data");
  }
}
async function validateTarget(value) {
  preflightTarget(value);
  const t = value;
  const p = t.preprocessing;
  if (p.pixelFormat !== "gray8" || p.downsample !== "box2-center" || p.smoothing !== "box3" || p.orientation !== "upright-only" || typeof p.levels !== "number" || !Number.isInteger(p.levels) || p.levels < 1 || p.levels > RECOGNITION_LIMITS.levels || typeof p.maxFeatures !== "number" || !Number.isInteger(p.maxFeatures) || p.maxFeatures < 16 || p.maxFeatures > RECOGNITION_LIMITS.features || t.features.points.length > p.maxFeatures || p.selection !== ANMS_SELECTION_ID) {
    invalid("Unsupported preprocessing");
  }
  const base = t.pyramid[0];
  if (base.width !== t.widthPx || base.height !== t.heightPx || base.scale !== 1)
    invalid("Invalid pyramid base");
  const expected = buildPyramid(
    { widthPx: base.width, heightPx: base.height, data: new Uint8Array(base.pixels) },
    p.levels
  );
  if (expected.length !== t.pyramid.length || expected.some((l, i) => {
    const level = t.pyramid[i];
    return l.widthPx !== level.width || l.heightPx !== level.height || l.scale !== level.scale || !l.data.every((v, j) => v === level.pixels[j]);
  })) {
    invalid("Inconsistent pyramid");
  }
  if (await sha256Hex(new Uint8Array(base.pixels)) !== t.imageHash)
    invalid("Canonical gray8 hash mismatch");
  return t;
}

// packages/recognition/src/recognizer.ts
var FRAME_MAX_FEATURES = 512;
var FRAME_LEVELS = 3;
function throwIfAborted2(signal) {
  if (signal?.aborted)
    throw new EngineError("ABORTED", "Recognition cancelled", { isRecoverable: true });
}
function passFacts(batch, scale, prepareMs) {
  const d = batch.facts;
  return {
    scale,
    prepareMs,
    featureMs: d.featureMs,
    retrievalMs: d.retrievalMs,
    matchMs: d.matchMs,
    geometryMs: d.geometryMs,
    totalMs: d.totalMs,
    featureCount: d.featureCount,
    candidateCount: d.candidateCount,
    observationCount: batch.observations.length,
    isAmbiguous: batch.isAmbiguous,
    isBudgetExhausted: d.isBudgetExhausted,
    rejected: batch.rejected.map((r) => ({ targetId: r.targetId, reason: r.reason }))
  };
}
var inlierCount = (o) => o.inliers.filter(Boolean).length;
var Recognizer = class {
  #targets = [];
  #disposed = false;
  #generation = 0;
  #cache = [];
  #isPending = false;
  #exactMatcher;
  #scaleRetry;
  #capturePasses;
  constructor(options = {}) {
    if (options.scaleRetry !== void 0 && typeof options.scaleRetry !== "boolean") {
      throw new EngineError("INVALID_CONFIG", "scaleRetry must be a boolean", {
        isRecoverable: false
      });
    }
    if (options.capturePasses !== void 0 && typeof options.capturePasses !== "boolean") {
      throw new EngineError("INVALID_CONFIG", "capturePasses must be a boolean", {
        isRecoverable: false
      });
    }
    this.#exactMatcher = options.exactMatcher;
    this.#scaleRetry = options.scaleRetry ?? true;
    this.#capturePasses = options.capturePasses === true;
  }
  /** Validates and snapshots the targets (1..10, unique ids), then replaces the loaded set. */
  async loadTargets(targets) {
    this.#alive();
    if (this.#isPending) {
      throw new EngineError("INVALID_CONFIG", "Cannot replace targets during recognition", {
        isRecoverable: true
      });
    }
    if (!targets.length || targets.length > RECOGNITION_LIMITS.targets || new Set(targets.map((t) => t.targetId)).size !== targets.length) {
      throw new EngineError("INVALID_TARGET", "Require 1 to 10 unique targets", {
        isRecoverable: false
      });
    }
    const generation = ++this.#generation;
    const next = [];
    targets.forEach(preflightTarget);
    for (const copy of structuredClone(targets)) {
      await validateTarget(copy);
      next.push(copy);
    }
    this.#alive();
    if (generation !== this.#generation) {
      throw new EngineError("ABORTED", "Target load superseded", { isRecoverable: true });
    }
    this.#targets = next;
    this.#cache = next.map((t) => {
      const features = featuresFromTarget(t);
      return {
        features,
        packed: packDescriptors(features),
        bytes: new Uint8Array(t.features.descriptors),
        diagnostics: diagnoseFeatures(features, t.widthPx, t.heightPx)
      };
    });
  }
  #alive() {
    if (this.#disposed)
      throw new EngineError("DISPOSED", "Recognizer disposed", { isRecoverable: false });
  }
  /** Recognizes the loaded targets in one standard gray image; retries a global miss once at a half-octave scale. */
  async recognize(image, identity, options = {}) {
    this.#alive();
    throwIfAborted2(options.signal);
    if (this.#isPending) {
      throw new EngineError("INVALID_CONFIG", "Only one recognition job may be in flight", {
        isRecoverable: true
      });
    }
    this.#isPending = true;
    try {
      const start = performance.now();
      const primary = await this.#recognizeOnce(image, identity, options);
      const first = this.#capturePasses ? passFacts(primary, 1, 0) : null;
      if (first) primary.facts.passes = [first];
      if (!this.#scaleRetry || options.roi || primary.observations.length || primary.isAmbiguous)
        return primary;
      throwIfAborted2(options.signal);
      this.#alive();
      const resampleStart = performance.now();
      const scaled = intermediateScaleImage(image);
      if (!scaled) return primary;
      const resampleMs = performance.now() - resampleStart;
      const secondary = await this.#recognizeOnce(scaled, identity, options, INTERMEDIATE_SCALE);
      const second = first ? passFacts(secondary, INTERMEDIATE_SCALE, resampleMs) : null;
      for (const key of [
        "featureMs",
        "retrievalMs",
        "matchMs",
        "geometryMs",
        "fineComparisons"
      ]) {
        secondary.facts[key] += primary.facts[key];
      }
      secondary.facts.featureMs += resampleMs;
      secondary.facts.totalMs = performance.now() - start;
      secondary.facts.scalePasses = 2;
      if (first && second) secondary.facts.passes = [first, second];
      return secondary;
    } finally {
      this.#isPending = false;
    }
  }
  async #recognizeOnce(image, identity, options, featureImageScale = 1) {
    if (!this.#targets.length)
      throw new EngineError("INVALID_TARGET", "No targets loaded", { isRecoverable: false });
    if (!identity.sessionId || !Number.isSafeInteger(identity.frameId) || identity.frameId < 0) {
      throw new EngineError("FRAME_FAILED", "Invalid frame identity", { isRecoverable: false });
    }
    const start = performance.now();
    const algorithmVersion = this.#targets[0].algorithmVersion;
    const { features } = extractFeatures(image, {
      maxFeatures: FRAME_MAX_FEATURES,
      levels: FRAME_LEVELS,
      roi: options.roi ?? null
    });
    if (featureImageScale !== 1) {
      for (const f of features) {
        f.x = (f.x + 0.5) / featureImageScale - 0.5;
        f.y = (f.y + 0.5) / featureImageScale - 0.5;
      }
    }
    const featureMs = performance.now() - start;
    const retrievalStart = performance.now();
    const indices = this.#targets.map((_, i) => i);
    const packed = packDescriptors(features);
    const facts = {
      algorithmVersion,
      matchingBackend: "cpu",
      scalePasses: 1,
      featureMs,
      retrievalMs: performance.now() - retrievalStart,
      matchMs: 0,
      geometryMs: 0,
      totalMs: 0,
      featureCount: features.length,
      candidateCount: indices.length,
      isBudgetExhausted: false,
      fineComparisons: 0
    };
    const accelerated = await this.#matchExactly(indices, features, facts, options.signal);
    const observations = [];
    const rejected = [];
    for (const index of indices) {
      throwIfAborted2(options.signal);
      const outcome = this.#verifyTarget(index, features, packed, accelerated, identity, facts);
      if ("reason" in outcome) rejected.push(outcome);
      else observations.push(outcome);
    }
    observations.sort(
      (a, b) => inlierCount(b) - inlierCount(a) || a.reprojectionErrorPx - b.reprojectionErrorPx
    );
    const isAmbiguous = observations.length > 1 && inlierCount(observations[1]) >= inlierCount(observations[0]) * 0.85;
    throwIfAborted2(options.signal);
    if (isAmbiguous)
      for (const o of observations)
        rejected.push({ targetId: o.targetId, reason: "AMBIGUOUS_TARGETS" });
    facts.totalMs = performance.now() - start;
    return { observations: isAmbiguous ? [] : observations, isAmbiguous, rejected, facts };
  }
  /** Exact matching by the injected matcher for every usable target, or null when the built-in matcher must run. */
  async #matchExactly(indices, features, facts, signal) {
    const matcher = this.#exactMatcher;
    if (!matcher || !indices.length) return null;
    const requested = indices.filter((i) => !this.#cache[i].diagnostics.length).map((i) => ({ targetId: this.#targets[i].targetId, descriptors: this.#cache[i].bytes }));
    if (!requested.length) return null;
    const matchStart = performance.now();
    const generation = this.#generation;
    const output = await matcher(
      requested,
      new Uint8Array(features.flatMap((f) => f.descriptor)),
      signal
    );
    throwIfAborted2(signal);
    this.#alive();
    if (generation !== this.#generation) {
      throw new EngineError("ABORTED", "Recognition generation changed", { isRecoverable: true });
    }
    if (output === null) return null;
    if (!["cpu", "wasm"].includes(output.backend) || output.matches.length !== requested.length || new Set(output.matches.map((m) => m.targetId)).size !== requested.length || output.matches.some((m) => !requested.some((r) => r.targetId === m.targetId))) {
      throw new EngineError("FRAME_FAILED", "Invalid exact matching batch", {
        isRecoverable: false
      });
    }
    facts.matchingBackend = output.backend;
    facts.matchMs = performance.now() - matchStart;
    return new Map(output.matches.map((m) => [m.targetId, m.pairs]));
  }
  /** Matches and verifies one target; returns its observation or its rejection. */
  #verifyTarget(index, features, packed, accelerated, identity, facts) {
    const target = this.#targets[index];
    const cached = this.#cache[index];
    const targetFeatures = cached.features;
    if (cached.diagnostics.length) {
      return { targetId: target.targetId, reason: cached.diagnostics.map((d) => d.code).join(",") };
    }
    const matchStart = performance.now();
    const external = accelerated?.get(target.targetId);
    if (external && (!Array.isArray(external) || external.length > Math.min(targetFeatures.length, features.length) || new Set(external.map((p) => p.targetIndex)).size !== external.length || new Set(external.map((p) => p.frameIndex)).size !== external.length || external.some(
      (p) => !Number.isInteger(p.targetIndex) || p.targetIndex < 0 || p.targetIndex >= targetFeatures.length || !Number.isInteger(p.frameIndex) || p.frameIndex < 0 || p.frameIndex >= features.length || !Number.isInteger(p.distance) || p.distance < 0 || p.distance > 64
    ))) {
      throw new EngineError("FRAME_FAILED", "Invalid exact match indices", {
        isRecoverable: false
      });
    }
    const pairs = external ? external.map((p) => ({
      target: [targetFeatures[p.targetIndex].x, targetFeatures[p.targetIndex].y],
      image: [features[p.frameIndex].x, features[p.frameIndex].y],
      distance: p.distance
    })) : matchPacked(targetFeatures, features, cached.packed, packed);
    facts.matchMs += performance.now() - matchStart;
    facts.fineComparisons += targetFeatures.length * features.length;
    const geometryStart = performance.now();
    const result = verifyGeometry(pairs, target.widthPx, target.heightPx);
    facts.geometryMs += performance.now() - geometryStart;
    if (!result.accepted || !validateHomography(result.H, target.widthPx + 1, target.heightPx + 1)) {
      return {
        targetId: target.targetId,
        reason: result.accepted ? "INVALID_BOUNDARY" : result.reason
      };
    }
    return {
      sessionId: identity.sessionId,
      frameId: identity.frameId,
      targetId: target.targetId,
      algorithmVersion: target.algorithmVersion,
      H_imageFromTarget: normalizeHomography(result.H),
      targetPoints: pairs.map((p) => p.target),
      imagePoints: pairs.map((p) => p.image),
      inliers: result.inlierMask,
      reprojectionErrorPx: result.rmsErrorPx,
      spatialCoverage: hullArea(pairs.filter((_, i) => result.inlierMask[i]).map((p) => p.target)) / (target.widthPx * target.heightPx)
    };
  }
  dispose() {
    this.#disposed = true;
    this.#generation++;
    this.#targets = [];
    this.#cache = [];
  }
};

// packages/recognition/src/trace.ts
var MAX_TRACE_REJECTIONS = 32;
var MAX_TRACE_TEXT = 64;
var MAX_TRACE_PASSES = 2;
var boundRejections = (rejected) => rejected.slice(0, MAX_TRACE_REJECTIONS).map((r) => ({ targetId: r.targetId, reason: r.reason.slice(0, MAX_TRACE_TEXT) }));
function traceOf(batch, frame) {
  const d = batch.facts;
  const optional = d.passes ? {
    stageMs: {
      featureMs: d.featureMs,
      retrievalMs: d.retrievalMs,
      matchMs: d.matchMs,
      geometryMs: d.geometryMs,
      totalMs: d.totalMs
    },
    passes: d.passes.slice(0, MAX_TRACE_PASSES).map((p) => ({
      scale: p.scale,
      prepareMs: p.prepareMs,
      featureMs: p.featureMs,
      retrievalMs: p.retrievalMs,
      matchMs: p.matchMs,
      geometryMs: p.geometryMs,
      totalMs: p.totalMs,
      featureCount: p.featureCount,
      candidateCount: p.candidateCount,
      observationCount: p.observationCount,
      isAmbiguous: p.isAmbiguous,
      isBudgetExhausted: p.isBudgetExhausted,
      rejected: boundRejections(p.rejected)
    }))
  } : {};
  return {
    sessionId: frame.sessionId,
    frameId: frame.frameId,
    algorithmVersion: d.algorithmVersion,
    featureCount: d.featureCount,
    candidateCount: d.candidateCount,
    scalePasses: d.scalePasses,
    observationCount: batch.observations.length,
    isAmbiguous: batch.isAmbiguous,
    isBudgetExhausted: d.isBudgetExhausted,
    rejected: boundRejections(batch.rejected),
    ...optional
  };
}

// packages/target-compiler/src/compile.ts
var invalid2 = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
async function compileGrayTarget(image, options) {
  validateGray(image);
  const snapshot = { ...image, data: new Uint8Array(image.data) };
  const { targetId, physicalWidthMeters = null } = options;
  const maxFeatures = TARGET_MAX_FEATURES;
  const levels = TARGET_LEVELS;
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(targetId) || physicalWidthMeters !== null && (!Number.isFinite(physicalWidthMeters) || physicalWidthMeters <= 0)) {
    invalid2("Invalid target identity or physical width");
  }
  const { features } = extractFeatures(snapshot, { maxFeatures, levels });
  const result = {
    schemaVersion: 1,
    compilerVersion: COMPILER_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    targetId,
    imageHash: await sha256Hex(snapshot.data),
    imageHashDomain: "canonical-gray8",
    widthPx: snapshot.widthPx,
    heightPx: snapshot.heightPx,
    physicalWidthMeters,
    orientation: "top-left",
    pyramid: buildPyramid(snapshot, levels).map((l) => ({
      width: l.widthPx,
      height: l.heightPx,
      scale: l.scale,
      pixels: Array.from(l.data)
    })),
    features: {
      points: features.map((f) => [f.x, f.y]),
      descriptorType: ALGORITHM_VERSION,
      descriptorLength: 32,
      descriptors: features.flatMap((f) => f.descriptor)
    },
    preprocessing: preprocessingRecord(levels, maxFeatures),
    diagnostics: diagnoseFeatures(features, snapshot.widthPx, snapshot.heightPx)
  };
  validateTargetBundle(result);
  return result;
}

// packages/sdk/src/worker/matching-selection.ts
var MatchingSelection = class {
  matcher = null;
  selection = null;
  /** True after a mid-run WebAssembly failure until the changed capability has been announced. */
  hasUnannouncedChange = false;
  mode;
  constructor(mode) {
    this.mode = mode;
  }
  /** Selects SIMD, then scalar WebAssembly; any failure keeps the JavaScript matcher. */
  async initialize() {
    if (this.mode !== "wasm") return;
    try {
      const selected = await selectWasmExactMatcher();
      this.matcher = selected.matcher;
      this.selection = {
        fallbackReason: selected.fallbackReason,
        attempts: selected.attempts.map((a) => `${a.variant}:${a.outcome}`).join(",")
      };
    } catch {
      this.matcher = null;
      this.selection = { fallbackReason: "WASM_INIT_FAILED", attempts: "*:WASM_INIT_FAILED" };
    }
  }
  /** The operator for the recognizer; undefined keeps the built-in JavaScript matcher. */
  operator() {
    if (!this.matcher) return void 0;
    return createWasmMatchOperator(this.matcher, {
      onFailure: () => {
        this.hasUnannouncedChange = true;
      }
    });
  }
  get hasChangedSinceAnnounced() {
    return this.hasUnannouncedChange;
  }
  /** The current capability; describing it counts as announcing any pending change. */
  describe(execution, generation) {
    this.hasUnannouncedChange = false;
    if (this.mode !== "wasm") {
      return {
        execution,
        generation,
        algorithmVersion: ALGORITHM_VERSION,
        matching: "cpu",
        matchingSelection: "none",
        matchingFallback: "none",
        fallbackReason: null
      };
    }
    const live = this.matcher?.isAvailable === true;
    const reason = this.matcher?.diagnostics.fallbackReason ?? this.selection?.fallbackReason ?? (live ? null : "WASM_UNAVAILABLE");
    return {
      execution,
      generation,
      algorithmVersion: ALGORITHM_VERSION,
      matching: live ? `wasm-${this.matcher.variant}` : "cpu",
      matchingSelection: this.selection?.attempts ?? "none",
      matchingFallback: reason ?? "none",
      fallbackReason: live ? null : "WASM_MATCHING_JS_FALLBACK"
    };
  }
  dispose() {
    this.matcher?.dispose();
    this.matcher = null;
    this.selection = null;
    this.hasUnannouncedChange = false;
  }
};

// packages/sdk/src/worker/protocol.ts
var WORKER_PROTOCOL_VERSION = 1;
var DEFAULT_VISION_OPTIONS = Object.freeze({
  collectMatchedPoints: false,
  observeRecognition: false,
  exactMatching: "wasm",
  scaleRetry: true
});
var WORKER_SAFE_REASONS = Object.freeze([
  SOURCE_TOO_LARGE,
  STANDARD_TOO_LARGE
]);
var WORKER_GENERIC_REASON = "Worker operation failed";
function safeWorkerReason(reason) {
  return typeof reason === "string" && WORKER_SAFE_REASONS.includes(reason) ? reason : WORKER_GENERIC_REASON;
}

// packages/tracking/src/observation-check.ts
var reject = (reason) => {
  throw new EngineError("FRAME_FAILED", reason, { isRecoverable: true });
};
function cross2(o, a, b) {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}
function hullArea2(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (p) => {
    const result = [];
    for (const v of p) {
      while (result.length >= 2 && cross2(result.at(-2), result.at(-1), v) <= 0) result.pop();
      result.push(v);
    }
    result.pop();
    return result;
  };
  const hull = [...half(sorted), ...half([...sorted].reverse())];
  return Math.abs(
    hull.reduce((sum, p, i) => {
      const q = hull[(i + 1) % hull.length];
      return sum + p[0] * q[1] - p[1] * q[0];
    }, 0)
  ) / 2;
}
function project2(h, p) {
  const z = h[6] * p[0] + h[7] * p[1] + h[8];
  if (Math.abs(z) < 1e-9) reject("target-crosses-horizon");
  const result = [
    (h[0] * p[0] + h[1] * p[1] + h[2]) / z,
    (h[3] * p[0] + h[4] * p[1] + h[5]) / z
  ];
  if (!result.every(Number.isFinite)) reject("nonfinite-projection");
  return result;
}
function checkObservation(o, t) {
  if (o.algorithmVersion !== t.algorithmVersion) reject("incompatible-observation");
  const n = o.targetPoints.length;
  if (n < 8 || n > 1e5 || o.imagePoints.length !== n || o.inliers.length !== n)
    reject("invalid-correspondence-lengths");
  const h = normalizeHomography(o.H_imageFromTarget);
  const edges = [
    [0, 0],
    [t.widthPx, 0],
    [t.widthPx, t.heightPx],
    [0, t.heightPx]
  ];
  const denominators = edges.map((p) => h[6] * p[0] + h[7] * p[1] + h[8]);
  if (denominators.some((v) => Math.abs(v) < 1e-9 || Math.sign(v) !== Math.sign(denominators[0]))) {
    reject("target-crosses-horizon");
  }
  const corners = edges.map((p) => project2(h, p));
  if (hullArea2(corners) < 16) reject("collapsed-projection");
  const inliers = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const p = o.targetPoints[i];
    const q = o.imagePoints[i];
    if (p.length !== 2 || q.length !== 2 || ![...p, ...q].every(Number.isFinite) || typeof o.inliers[i] !== "boolean") {
      reject("invalid-correspondence");
    }
    if (p[0] < 0 || p[1] < 0 || p[0] > t.widthPx - 1 || p[1] > t.heightPx - 1)
      reject("feature-outside-target");
    if (o.inliers[i]) {
      const r = project2(h, p);
      sum += (q[0] - r[0]) ** 2 + (q[1] - r[1]) ** 2;
      inliers.push(p);
    }
  }
  const spatialCoverage = hullArea2(inliers) / (t.widthPx * t.heightPx);
  const error = Math.sqrt(sum / inliers.length);
  if (inliers.length < 8 || inliers.length / n < 0.6 || spatialCoverage < 0.2 || !Number.isFinite(error) || error > 2) {
    reject("quality-gate");
  }
  return {
    h,
    corners,
    quality: {
      inlierCount: inliers.length,
      inlierRatio: inliers.length / n,
      reprojectionErrorPx: error,
      spatialCoverage,
      isDegenerate: false,
      isMeasured: true
    }
  };
}

// packages/tracking/src/tracker.ts
var PREDICTION_LIMIT_US = 1e5;
function inlierImagePoints(o) {
  const points = [];
  for (let i = 0; i < o.imagePoints.length; i++) {
    if (o.inliers[i] === true) points.push([o.imagePoints[i][0], o.imagePoints[i][1]]);
  }
  return points.length >= 1 && points.length <= MAX_MATCHED_POINTS ? points : null;
}
var Tracker = class {
  targets = [];
  session = null;
  state = "SEARCHING";
  /** The last measured result: the source of every prediction. It never carries matched points. */
  last = null;
  candidate = null;
  count = 0;
  firstTime = 0;
  candidateTime = 0;
  frameId = -1;
  time = -Infinity;
  seen = /* @__PURE__ */ new Set();
  generation = 0;
  isDisposed = false;
  pending = null;
  job = null;
  recognize;
  acquisitionGapUs;
  collectPoints;
  constructor(options) {
    this.recognize = options.recognize;
    this.acquisitionGapUs = options.maxObservationGapUs ?? 1e6;
    if (options.collectMatchedPoints !== void 0 && typeof options.collectMatchedPoints !== "boolean") {
      throw new EngineError("INVALID_CONFIG", "collectMatchedPoints must be a boolean", {
        isRecoverable: false
      });
    }
    this.collectPoints = options.collectMatchedPoints === true;
    if (!Number.isFinite(this.acquisitionGapUs) || this.acquisitionGapUs < 125e3 || this.acquisitionGapUs > 2e6) {
      throw new EngineError(
        "INVALID_CONFIG",
        "Acquisition observation gap must be within 125000..2000000 us",
        {
          isRecoverable: false
        }
      );
    }
  }
  assertUsable() {
    if (this.isDisposed)
      throw new EngineError("DISPOSED", "Tracking pipeline disposed", { isRecoverable: false });
  }
  /** Replaces the targets (1..10, unique ids) and forgets the session; only while no frame is processed. */
  async loadTargets(targets) {
    this.assertUsable();
    if (this.pending) {
      throw new EngineError("INVALID_CONFIG", "Cannot replace targets during processing", {
        isRecoverable: true
      });
    }
    if (targets.length < 1 || targets.length > 10 || new Set(targets.map((t) => t.targetId)).size !== targets.length) {
      throw new EngineError("INVALID_TARGET", "Require 1..10 unique targets", {
        isRecoverable: false
      });
    }
    targets.forEach(validateTargetBundle);
    this.targets = structuredClone(targets);
    this.clear();
    this.session = null;
  }
  clear() {
    this.state = "SEARCHING";
    this.last = null;
    this.candidate = null;
    this.count = 0;
    this.frameId = -1;
    this.time = -Infinity;
    this.seen.clear();
  }
  /** Starts a new session: cancels and awaits the frame in progress, then clears all tracking state. */
  async reset(sessionId) {
    this.assertUsable();
    if (!sessionId)
      throw new EngineError("INVALID_CONFIG", "Session required", { isRecoverable: false });
    const generation = ++this.generation;
    this.job?.abort();
    await this.pending?.catch(() => {
    });
    this.assertUsable();
    if (generation !== this.generation)
      throw new EngineError("ABORTED", "Reset superseded", { isRecoverable: true });
    this.clear();
    this.session = sessionId;
  }
  async dispose() {
    this.isDisposed = true;
    ++this.generation;
    this.job?.abort();
    await this.pending?.catch(() => {
    });
    this.clear();
    this.targets = [];
    this.session = null;
  }
  /** Tracks one frame. Rejects a second frame while one is in progress. */
  process(frame, signal) {
    this.assertUsable();
    if (this.pending) {
      return Promise.reject(
        new EngineError("INVALID_CONFIG", "Only one tracking frame may be in flight", {
          isRecoverable: true
        })
      );
    }
    const controller = new AbortController();
    this.job = controller;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    this.pending = this.run(frame, controller.signal, this.generation).finally(() => {
      signal.removeEventListener("abort", abort);
      this.pending = null;
      this.job = null;
    });
    return this.pending;
  }
  empty(frame, time, reason) {
    return {
      sessionId: frame.sessionId,
      frameId: frame.frameId,
      observationTimeUs: time,
      targetId: null,
      state: this.state,
      reason,
      H_imageFromTarget: null,
      cornersPx: null,
      quality: {
        inlierCount: 0,
        inlierRatio: 0,
        reprojectionErrorPx: null,
        spatialCoverage: 0,
        isDegenerate: false,
        isMeasured: false
      },
      prediction: { ageUs: 0, lastMeasuredTimeUs: null, expiresAtUs: null }
    };
  }
  /** No valid match in this frame: predict from the last measurement, or lose it once it is too old. */
  miss(frame, time, reason) {
    if (this.last) {
      const age = time - this.last.observationTimeUs;
      if (age >= PREDICTION_LIMIT_US) {
        this.state = "LOST";
        this.last = null;
        this.candidate = null;
        this.count = 0;
        return this.empty(frame, time, "prediction-expired");
      }
      this.state = "LIMITED";
      return structuredClone({
        ...this.last,
        frameId: frame.frameId,
        observationTimeUs: time,
        state: this.state,
        quality: { ...this.last.quality, isMeasured: false },
        prediction: { ...this.last.prediction, ageUs: age },
        reason
      });
    }
    if (reason !== "duplicate-image") {
      this.candidate = null;
      this.count = 0;
      this.state = "SEARCHING";
    }
    return this.empty(frame, time, reason);
  }
  checkFrame(frame) {
    const time = frame.observationTimeUs;
    if (frame.sessionId !== this.session || !Number.isInteger(frame.frameId) || frame.frameId <= this.frameId) {
      throw new EngineError("FRAME_FAILED", "Stale session or frame", { isRecoverable: true });
    }
    if (time == null || !Number.isFinite(time) || time < 0 || time <= this.time) {
      throw new EngineError("FRAME_FAILED", "Require strictly increasing observation time", {
        isRecoverable: true
      });
    }
    if (!frame.pictureKey)
      throw new EngineError("FRAME_FAILED", "Require a picture key", { isRecoverable: true });
    return time;
  }
  async run(frame, signal, generation) {
    const check = () => {
      if (signal.aborted || generation !== this.generation || this.isDisposed) {
        throw new EngineError("ABORTED", "Tracking job cancelled or superseded", {
          isRecoverable: true
        });
      }
    };
    check();
    const time = this.checkFrame(frame);
    const duplicate = this.seen.has(frame.pictureKey);
    let observations;
    try {
      observations = duplicate ? [] : await this.recognize(frame, this.targets, signal);
    } catch (error) {
      if (generation === this.generation && !this.last) {
        this.candidate = null;
        this.count = 0;
        this.state = "SEARCHING";
      }
      throw error;
    }
    check();
    this.frameId = frame.frameId;
    this.time = time;
    this.seen.add(frame.pictureKey);
    if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
    if (this.state === "LOST") this.state = "SEARCHING";
    if (duplicate) return this.miss(frame, time, "duplicate-image");
    const match = this.selectObservation(frame, observations);
    if (!match) return this.miss(frame, time, "no-valid-original-match");
    return this.measure(frame, time, match);
  }
  /** The best valid observation: the tracked target's own when one is tracked, otherwise the one with most inliers. */
  selectObservation(frame, observations) {
    const accepted = [];
    for (const observation of observations) {
      if (observation.sessionId !== frame.sessionId || observation.frameId !== frame.frameId)
        continue;
      const target = this.targets.find((t) => t.targetId === observation.targetId);
      if (!target) continue;
      try {
        accepted.push({ observation, checked: checkObservation(observation, target) });
      } catch {
      }
    }
    accepted.sort(
      (a, b) => b.checked.quality.inlierCount - a.checked.quality.inlierCount || a.observation.targetId.localeCompare(b.observation.targetId)
    );
    return this.last ? accepted.find((x) => x.observation.targetId === this.last.targetId) : accepted[0];
  }
  measure(frame, time, {
    observation: o,
    checked: c
  }) {
    if (!this.last) {
      if (this.candidate !== o.targetId || time - this.candidateTime > this.acquisitionGapUs || time - this.firstTime > 2 * this.acquisitionGapUs) {
        this.candidate = o.targetId;
        this.count = 0;
        this.firstTime = time;
      }
      this.candidateTime = time;
      this.count++;
      this.state = "ACQUIRING";
      if (this.count < 3 || time - this.firstTime < 5e4)
        return this.empty(frame, time, "confirming-original-match");
    }
    this.state = "TRACKING";
    this.last = {
      ...this.empty(frame, time, "original-target-measured"),
      targetId: o.targetId,
      H_imageFromTarget: c.h,
      cornersPx: c.corners,
      quality: c.quality,
      prediction: { ageUs: 0, lastMeasuredTimeUs: time, expiresAtUs: time + PREDICTION_LIMIT_US }
    };
    const result = structuredClone(this.last);
    const pointsPx = this.collectPoints ? inlierImagePoints(o) : null;
    if (!pointsPx) return result;
    return {
      ...result,
      matchedPoints: {
        sessionId: frame.sessionId,
        frameId: frame.frameId,
        targetId: o.targetId,
        pointsPx
      }
    };
  }
};

// packages/sdk/src/worker/vision-core.ts
var VisionCore = class {
  recognizer;
  tracker;
  constructor(options) {
    const observe = options.onRecognition;
    this.recognizer = new Recognizer({
      ...options.exactMatcher ? { exactMatcher: options.exactMatcher } : {},
      scaleRetry: options.scaleRetry,
      capturePasses: observe !== void 0
    });
    this.tracker = new Tracker({
      recognize: async (frame, _targets, signal) => {
        const batch = await this.recognizer.recognize(frame.image, frame, { signal });
        if (observe) observe(batch, { sessionId: frame.sessionId, frameId: frame.frameId });
        return batch.observations;
      },
      collectMatchedPoints: options.collectMatchedPoints
    });
  }
  async loadTargets(targets) {
    await this.recognizer.loadTargets(targets);
    await this.tracker.loadTargets(targets);
  }
  reset(sessionId) {
    return this.tracker.reset(sessionId);
  }
  process(frame, signal) {
    return this.tracker.process(frame, signal);
  }
  async dispose() {
    await this.tracker.dispose();
    this.recognizer.dispose();
  }
};

// packages/sdk/src/worker/vision-runtime.ts
var MAX_ENCODED_TARGET_BYTES = 24e6;
var MAX_DECODED_TARGET_PIXELS = 33554432;
function closeFrame(frame) {
  if (frame.image.kind === "video-frame" || frame.image.kind === "image-bitmap")
    frame.image.image.close();
}
function checkOptions2(options) {
  const invalid3 = !options || typeof options.collectMatchedPoints !== "boolean" || typeof options.observeRecognition !== "boolean" || typeof options.scaleRetry !== "boolean" || options.exactMatching !== "wasm" && options.exactMatching !== "js";
  if (invalid3)
    throw new EngineError("INVALID_CONFIG", "Invalid worker options", { isRecoverable: false });
}
async function compileEncoded(encodedImage, targetId, maxEdgePx) {
  if (!encodedImage.byteLength || encodedImage.byteLength > MAX_ENCODED_TARGET_BYTES || !Number.isInteger(maxEdgePx) || maxEdgePx < 32 || maxEdgePx > 1024 || typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") {
    throw new EngineError("UNSUPPORTED", "Worker image compilation unavailable or over budget", {
      isRecoverable: true
    });
  }
  const bitmap = await createImageBitmap(new Blob([encodedImage]));
  try {
    if (bitmap.width * bitmap.height > MAX_DECODED_TARGET_PIXELS) {
      throw new EngineError("INVALID_TARGET", "Decoded target exceeds limit", {
        isRecoverable: false
      });
    }
    const scale = Math.min(1, maxEdgePx / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new EngineError("UNSUPPORTED", "No worker canvas", { isRecoverable: true });
    context.drawImage(bitmap, 0, 0, width, height);
    const gray = rgbaToGray(
      new Uint8Array(context.getImageData(0, 0, width, height).data),
      width,
      height
    );
    return compileGrayTarget(gray, { targetId });
  } finally {
    bitmap.close();
  }
}
function createVisionRuntime(post) {
  let isBusy = false;
  let generation = -1;
  let core = null;
  let options = null;
  let matching = null;
  const workspace = new StandardImageWorkspace();
  let trace = null;
  const describe2 = () => matching.describe("worker", generation);
  async function initialize(envelope, requested) {
    if (core)
      throw new EngineError("INVALID_CONFIG", "Worker already initialized", {
        isRecoverable: false
      });
    checkOptions2(requested);
    generation = envelope.generation;
    options = requested;
    matching = new MatchingSelection(requested.exactMatching);
    await matching.initialize();
    const exactMatcher = matching.operator();
    core = new VisionCore({
      ...exactMatcher ? { exactMatcher } : {},
      collectMatchedPoints: requested.collectMatchedPoints,
      scaleRetry: requested.scaleRetry,
      ...requested.observeRecognition ? {
        onRecognition: (batch, frame) => {
          trace = traceOf(batch, frame);
        }
      } : {}
    });
    post({ ...envelope, type: "ready", capability: describe2() });
  }
  async function processFrame(envelope, frame) {
    trace = null;
    const stages = options.observeRecognition ? {
      inputPackingDurationUs: 0,
      inputUploadDurationUs: 0,
      standardDrawDurationUs: 0,
      readbackDurationUs: 0,
      grayscaleDurationUs: 0
    } : void 0;
    const started = performance.now();
    const image = standardize(
      { image: frame.image, geometry: frame.geometry },
      workspace,
      rgbaToGray,
      stages
    );
    const prepared = performance.now();
    const result = await core.process({ ...frame.metadata, image }, new AbortController().signal);
    const ended = performance.now();
    const attached = trace;
    trace = null;
    post({
      ...envelope,
      type: "result",
      result,
      timing: {
        ...stages ? { prepareStages: stages } : {},
        prepareDurationUs: (prepared - started) * 1e3,
        computeDurationUs: (ended - prepared) * 1e3,
        totalDurationUs: (ended - started) * 1e3
      },
      ...matching.hasChangedSinceAnnounced ? { capability: describe2() } : {},
      ...attached && attached.sessionId === result.sessionId && attached.frameId === result.frameId ? { trace: attached } : {}
    });
  }
  async function dispose(envelope) {
    let failure;
    for (const release of [() => core?.dispose(), () => matching?.dispose()]) {
      try {
        await release();
      } catch (cause) {
        failure ??= cause;
      }
    }
    workspace.dispose();
    core = null;
    matching = null;
    options = null;
    trace = null;
    if (failure !== void 0) {
      throw failure instanceof EngineError ? failure : new EngineError("RESOURCE_FAILED", "Worker disposal failed", { isRecoverable: true });
    }
    post({ ...envelope, type: "ack" });
  }
  async function dispatch(message, envelope) {
    if (message.type === "init") return initialize(envelope, message.options);
    if (!core || generation !== message.generation) {
      throw new EngineError("FRAME_FAILED", "Stale worker generation", { isRecoverable: true });
    }
    switch (message.type) {
      case "load-targets":
        await core.loadTargets(message.targets);
        post({ ...envelope, type: "ready", capability: describe2() });
        return;
      case "reset":
        await core.reset(message.sessionId);
        post({ ...envelope, type: "ready", capability: describe2() });
        return;
      case "dispose":
        return dispose(envelope);
      case "compile":
        post({
          ...envelope,
          type: "compiled",
          target: await compileEncoded(message.encodedImage, message.targetId, message.maxEdgePx)
        });
        return;
      case "frame":
        return processFrame(envelope, message.frame);
      default:
        throw new EngineError("FRAME_FAILED", "Unknown worker request", { isRecoverable: true });
    }
  }
  return async function handle(message) {
    const envelope = {
      protocol: WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      generation: message.generation
    };
    const refuse = (code = "RESOURCE_FAILED") => post({
      ...envelope,
      type: "error",
      code,
      isRecoverable: true,
      reason: safeWorkerReason(null)
    });
    if (isBusy || message.protocol !== WORKER_PROTOCOL_VERSION || !Number.isSafeInteger(message.requestId) || !Number.isSafeInteger(message.generation)) {
      if (message.type === "frame") closeFrame(message.frame);
      refuse();
      return;
    }
    isBusy = true;
    try {
      await dispatch(message, envelope);
    } catch (cause) {
      post({
        ...envelope,
        type: "error",
        code: cause instanceof EngineError ? cause.code : "RESOURCE_FAILED",
        isRecoverable: true,
        reason: safeWorkerReason(cause instanceof EngineError ? cause.message : null)
      });
    } finally {
      try {
        if (message.type === "frame") closeFrame(message.frame);
      } finally {
        isBusy = false;
      }
    }
  };
}

// packages/sdk/src/worker/start.ts
function startVisionWorker(scope) {
  const handle = createVisionRuntime((message) => scope.postMessage(message));
  const listener = (event) => {
    void handle(event.data);
  };
  scope.addEventListener("message", listener);
  return () => scope.removeEventListener?.("message", listener);
}

// packages/sdk/src/worker/worker-entry.ts
startVisionWorker(globalThis);
