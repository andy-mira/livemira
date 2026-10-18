/*! LiveMira target-quality | Copyright 2026 Andy | SPDX-License-Identifier: Apache-2.0 */

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
  const invalid = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Array.isArray(candidates)) throw invalid("INVALID_ANMS_CANDIDATES");
  if (!Number.isInteger(count) || count < 0 || !Number.isInteger(poolLimit) || poolLimit < 1 || poolLimit > MAX_POOL_LIMIT || !(robustness > 0 && robustness < 1)) {
    throw invalid("INVALID_ANMS_OPTIONS");
  }
  for (const c of candidates) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.score) || c.score <= 0) {
      throw invalid("INVALID_ANMS_CANDIDATE");
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
  const invalid = (message) => new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
  if (!Number.isInteger(maxFeatures) || maxFeatures < 16 || maxFeatures > RECOGNITION_LIMITS.features) {
    throw invalid("INVALID_FEATURE_LIMIT");
  }
  if (roi && (!["x", "y", "width", "height"].every((k) => Number.isFinite(roi[k])) || roi.width <= 0 || roi.height <= 0 || roi.x < 0 || roi.y < 0 || roi.x + roi.width > image.widthPx || roi.y + roi.height > image.heightPx)) {
    throw invalid("INVALID_ROI");
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

// packages/recognition/src/matching/packed-matcher.ts
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

// packages/recognition/src/targets/target-validation.ts
var ALGORITHM_VERSION = "m0-harris-anms-brief256-v1";
var TARGET_MAX_FEATURES = 384;
var TARGET_LEVELS = 3;

// packages/recognition/src/stats/point-distribution.ts
var UNIFORM_AXIS_VARIANCE = 1 / 12;
function pointDistribution(points, widthPx, heightPx) {
  const empty = { count: 0, hullCoverage: 0, dispersion: 0, isotropy: 0 };
  if (!Array.isArray(points) || !(widthPx > 0) || !(heightPx > 0)) return empty;
  const u = [];
  const v = [];
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || p[0] < 0 || p[1] < 0 || p[0] > widthPx || p[1] > heightPx)
      continue;
    u.push(p[0] / widthPx);
    v.push(p[1] / heightPx);
  }
  const n = u.length;
  if (!n) return empty;
  let mu = 0;
  let mv = 0;
  for (let i = 0; i < n; i++) {
    mu += u[i];
    mv += v[i];
  }
  mu /= n;
  mv /= n;
  let suu = 0;
  let svv = 0;
  let suv = 0;
  for (let i = 0; i < n; i++) {
    const du = u[i] - mu;
    const dv = v[i] - mv;
    suu += du * du;
    svv += dv * dv;
    suv += du * dv;
  }
  suu /= n;
  svv /= n;
  suv /= n;
  const trace = suu + svv;
  const det = suu * svv - suv * suv;
  const hull = n >= 3 ? hullArea(u.map((x, i) => [x, v[i]])) : 0;
  return {
    count: n,
    hullCoverage: Math.min(1, hull),
    dispersion: Math.min(1, trace / (2 * UNIFORM_AXIS_VARIANCE)),
    isotropy: n >= 3 && trace > 0 ? Math.min(1, Math.max(0, 4 * det / (trace * trace))) : 0
  };
}

// packages/target-quality/src/target-quality.ts
var SCORER_NAME = "webar-target-suitability";
var SCORER_VERSION = "2.0.0";
var RESULT_SCHEMA = "livemira-target-quality/3";
var MAX_SCORE = 5;
var REPLACE_BELOW = 3;
var MAX_LONG_EDGE = 640;
var MAX_IMAGE_BYTES = 24e6;
var MAX_INPUT_PIXELS = 16777216;
var MAX_INPUT_DIMENSION = 8192;
var MIN_DIMENSION = 32;
var GRID = 4;
var DISCLAIMER = "Heuristic preflight of image suitability only. It is not a calibrated probability of detection, does not guarantee recognition and is not a Vuforia or ARCore rating. A score of 3 or more can still fail on a device.";
var invalidInput = (message) => {
  throw new EngineError("INVALID_CONFIG", message, { isRecoverable: false });
};
var invalidImage = (message) => {
  throw new EngineError("INVALID_TARGET", message, { isRecoverable: false });
};
var ramp = (value, low, high) => value <= low ? 0 : value >= high ? 1 : (value - low) / (high - low);
var round = (value, places) => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};
var WEIGHT = 0.2;
var WEAKEST_LINK_SHARE = 0.5;
var BLOCKER_CAP = 2;
var isInRange = (v, max) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max;
function validateScoringInput(input) {
  const m = input?.metrics;
  const blockers = input?.blockers;
  const levels = m?.featuresPerLevel;
  if (!m || typeof m !== "object" || !Number.isInteger(blockers) || blockers < 0 || blockers > 16 || !Array.isArray(levels) || levels.length !== TARGET_LEVELS || !levels.every((c) => isInRange(c, TARGET_MAX_FEATURES)) || !isInRange(m.featureCount, TARGET_MAX_FEATURES) || !isInRange(m.hullCoverage, 1) || !isInRange(m.occupiedCells, GRID * GRID) || !isInRange(m.effectiveCells, GRID * GRID) || !isInRange(m.nearDuplicateRatio, 1) || !isInRange(m.ambiguousRatio, 1) || !isInRange(m.medianNearestDistance, 256) || !isInRange(m.contrastRange, 255) || !isInRange(m.dispersion, 1) || !isInRange(m.isotropy, 1))
    invalidInput(
      `Invalid scoring input: expected finite metrics within their bounds (featureCount 0..${TARGET_MAX_FEATURES}, ${TARGET_LEVELS} per-level counts, ratios 0..1, effectiveCells 0..${GRID * GRID}, contrastRange 0..255, dispersion and isotropy 0..1) and an integer blocker count 0..16`
    );
  return input;
}
function scoreMetrics(input) {
  const { metrics, blockers } = validateScoringInput(input);
  const subscores = {
    support: ramp(metrics.featureCount, 24, 192),
    coverage: ramp(metrics.hullCoverage, 0.15, 0.6),
    dispersion: ramp(metrics.dispersion, 0.15, 0.55),
    conditioning: ramp(metrics.isotropy, 0.1, 0.5),
    uniqueness: metrics.featureCount < 2 ? 0 : Math.min(
      ramp(-metrics.nearDuplicateRatio, -0.35, -0.05),
      ramp(-metrics.ambiguousRatio, -0.6, -0.15)
    )
  };
  const values = Object.values(subscores);
  const mean = values.reduce((sum, v) => sum + WEIGHT * v, 0);
  let raw = MAX_SCORE * ((1 - WEAKEST_LINK_SHARE) * mean + WEAKEST_LINK_SHARE * Math.min(...values));
  if (blockers > 0) raw = Math.min(raw, BLOCKER_CAP);
  const score = Math.min(MAX_SCORE, Math.max(0, Math.round(raw * 10) / 10));
  return {
    subscores: Object.fromEntries(
      Object.entries(subscores).map(([k, v]) => [k, round(v, 3)])
    ),
    score,
    rawScore: round(raw, 3)
  };
}
function buildReasons(metrics, subscores, normalization) {
  const reasons = [];
  const add = (code, severity, message, metric, value, threshold) => void reasons.push({ code, severity, message, metric, value: round(value, 3), threshold });
  if (metrics.featureCount < 24)
    add(
      "LOW_FEATURE_COUNT",
      "blocker",
      `Only ${metrics.featureCount} usable corner features; the engine needs at least 24 to compile a target. Use a picture with fine, high-contrast detail (text, foliage, texture, edges) over its whole area; avoid plain, blurry or smooth images.`,
      "featureCount",
      metrics.featureCount,
      24
    );
  else if (metrics.featureCount < 96)
    add(
      "LOW_FEATURE_COUNT",
      "warning",
      `Only ${metrics.featureCount} corner features; detail is thin. A picture with more fine detail gives the pose fit more to work with.`,
      "featureCount",
      metrics.featureCount,
      96
    );
  if (metrics.hullCoverage < 0.15)
    add(
      "LOW_COVERAGE",
      "blocker",
      `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image; the engine needs at least 15%. Use a picture whose detail fills the frame instead of a small subject on a plain background.`,
      "hullCoverage",
      metrics.hullCoverage,
      0.15
    );
  else if (metrics.hullCoverage < 0.35)
    add(
      "LOW_COVERAGE",
      "warning",
      `Features span only ${Math.round(metrics.hullCoverage * 100)}% of the image. Crop tighter or choose a picture with detail across the whole area.`,
      "hullCoverage",
      metrics.hullCoverage,
      0.35
    );
  if (metrics.nearDuplicateRatio > 0.35)
    add(
      "REPETITIVE_PATTERN",
      "blocker",
      `${Math.round(metrics.nearDuplicateRatio * 100)}% of features have a near-identical twin (repeating pattern); the engine allows at most 35%. Avoid tiles, grids, stripes and symmetric artwork.`,
      "nearDuplicateRatio",
      metrics.nearDuplicateRatio,
      0.35
    );
  else if (metrics.nearDuplicateRatio > 0.15 || metrics.ambiguousRatio > 0.5)
    add(
      "REPETITIVE_PATTERN",
      "warning",
      `Many features resemble each other (${Math.round(metrics.nearDuplicateRatio * 100)}% near duplicates, ${Math.round(metrics.ambiguousRatio * 100)}% similar); similar patches can be matched to the wrong place. Prefer non-repeating artwork.`,
      "ambiguousRatio",
      metrics.ambiguousRatio,
      0.5
    );
  if (subscores.dispersion < 0.5)
    add(
      "CLUSTERED_FEATURES",
      "warning",
      `Features are concentrated: their spread is ${round(metrics.dispersion, 2)} of an even scatter over the image. Tracking is steadier when detail covers the whole picture; move detail into the empty areas or choose another picture.`,
      "dispersion",
      metrics.dispersion,
      0.35
    );
  if (subscores.conditioning < 0.5)
    add(
      "DEGENERATE_GEOMETRY",
      "warning",
      `Features lie mostly along one direction (isotropy ${round(metrics.isotropy, 2)}); a pose estimated from them is poorly conditioned. Use a picture with detail in both directions.`,
      "isotropy",
      metrics.isotropy,
      0.3
    );
  if (metrics.contrastRange < 50)
    add(
      "LOW_CONTRAST",
      "info",
      `Brightness range is only ${metrics.contrastRange} of 255 levels (reported, not scored). Faded or flat images lose features under camera exposure.`,
      "contrastRange",
      metrics.contrastRange,
      50
    );
  if (Math.max(normalization.widthPx, normalization.heightPx) < 256)
    add(
      "LOW_RESOLUTION",
      "warning",
      `The image is only ${normalization.widthPx}x${normalization.heightPx} px; very small sources hold little detail. Supply at least 512 px on the long edge.`,
      "longEdge",
      Math.max(normalization.widthPx, normalization.heightPx),
      256
    );
  if (normalization.resampling !== "none")
    add(
      "DOWNSCALED",
      "info",
      `The ${normalization.inputWidthPx}x${normalization.inputHeightPx} input was reduced to ${normalization.widthPx}x${normalization.heightPx} (long edge ${MAX_LONG_EDGE}) before scoring, as the engine does.`,
      "scale",
      normalization.scale,
      1
    );
  return reasons;
}
function adviceFor(score, reasons) {
  if (score < REPLACE_BELOW)
    return `Replace this image (score ${score.toFixed(1)} of ${MAX_SCORE}, below ${REPLACE_BELOW}). ${reasons.find((r) => r.severity !== "info")?.message ?? ""}`.trim();
  const warning = reasons.find((r) => r.severity === "warning");
  return `${score >= 4 ? "Good" : "Acceptable"} target candidate (score ${score.toFixed(1)} of ${MAX_SCORE}); this is a preflight, not a guarantee of recognition.${warning ? " Consider: " + warning.message : ""}`;
}
function normalizedSize(widthPx, heightPx) {
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1 || widthPx > MAX_INPUT_DIMENSION || heightPx > MAX_INPUT_DIMENSION)
    invalidInput(`Dimensions must be integers from 1 to ${MAX_INPUT_DIMENSION}`);
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(widthPx, heightPx));
  return scale === 1 ? { widthPx, heightPx, scale } : { widthPx: Math.round(widthPx * scale), heightPx: Math.round(heightPx * scale), scale };
}
function boxReduce(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * fy;
    const y1 = (y + 1) * fy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * fx;
      const x1 = (x + 1) * fx;
      let sum = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.min(sh, Math.ceil(y1)); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.min(sw, Math.ceil(x1)); sx++) {
          const w = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          sum += w * src[sy * sw + sx];
          area += w;
        }
      }
      out[y * dw + x] = Math.round(sum / area);
    }
  }
  return out;
}
function measure(gray, widthPx, heightPx) {
  const { features } = extractFeatures(
    { widthPx, heightPx, data: gray },
    { maxFeatures: TARGET_MAX_FEATURES, levels: TARGET_LEVELS }
  );
  const n = features.length;
  const perLevel = Array(TARGET_LEVELS).fill(0);
  const cells = Array(GRID * GRID).fill(0);
  for (const f of features) {
    perLevel[f.level]++;
    cells[Math.min(GRID - 1, Math.floor(f.y * GRID / heightPx)) * GRID + Math.min(GRID - 1, Math.floor(f.x * GRID / widthPx))]++;
  }
  const concentration = cells.reduce((sum, c) => sum + c / n * (c / n), 0);
  const nearest = features.map((f, i) => {
    let best = 257;
    for (let j = 0; j < n; j++)
      if (j !== i) best = Math.min(best, hamming(f.descriptor, features[j].descriptor));
    return best;
  });
  const sorted = nearest.filter((d) => d <= 256).sort((a, b) => a - b);
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const percentile = (p) => {
    let seen = 0;
    const goal = gray.length * p;
    for (let v = 0; v < 256; v++) {
      seen += hist[v];
      if (seen >= goal) return v;
    }
    return 255;
  };
  const points = features.map((f) => [f.x, f.y]);
  const distribution = pointDistribution(points, widthPx, heightPx);
  const metrics = {
    featureCount: n,
    featuresPerLevel: perLevel,
    hullCoverage: round(hullArea(points) / (widthPx * heightPx), 4),
    occupiedCells: cells.filter((c) => c > 0).length,
    effectiveCells: n ? round(1 / concentration, 3) : 0,
    nearDuplicateRatio: n ? round(nearest.filter((d) => d <= 16).length / n, 4) : 0,
    ambiguousRatio: n ? round(nearest.filter((d) => d <= 32).length / n, 4) : 0,
    medianNearestDistance: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    contrastRange: percentile(0.95) - percentile(0.05),
    dispersion: round(distribution.dispersion, 4),
    isotropy: round(distribution.isotropy, 4)
  };
  return { metrics, features: features.map((f) => ({ x: f.x, y: f.y, level: f.level })) };
}
function assessNormalized(gray, normalization) {
  const { widthPx, heightPx } = normalization;
  if (Math.min(widthPx, heightPx) < MIN_DIMENSION)
    invalidImage(
      `Normalized image ${widthPx}x${heightPx} is below ${MIN_DIMENSION} px on its short edge; the engine cannot compile it. Use a less elongated picture.`
    );
  const { metrics, features } = measure(gray, widthPx, heightPx);
  const preview = {
    algorithmVersion: ALGORITHM_VERSION,
    maxFeatures: TARGET_MAX_FEATURES,
    levels: TARGET_LEVELS,
    widthPx,
    heightPx,
    points: features
  };
  const blockers = buildReasons(
    metrics,
    scoreMetrics({ metrics, blockers: 0 }).subscores,
    normalization
  ).filter((r) => r.severity === "blocker").length;
  const { subscores, score, rawScore } = scoreMetrics({ metrics, blockers });
  const reasons = buildReasons(metrics, subscores, normalization);
  return {
    features: preview,
    result: {
      schema: RESULT_SCHEMA,
      scorer: { name: SCORER_NAME, version: SCORER_VERSION },
      algorithm: {
        version: ALGORITHM_VERSION,
        maxFeatures: TARGET_MAX_FEATURES,
        levels: TARGET_LEVELS
      },
      normalization,
      score,
      rawScore,
      maxScore: MAX_SCORE,
      shouldReplace: score < REPLACE_BELOW,
      advice: adviceFor(score, reasons),
      metrics,
      subscores,
      reasons,
      disclaimer: DISCLAIMER
    }
  };
}
var NORMALIZATION_ID = `gray8-luma-77-150-29-r128;long-edge<=${MAX_LONG_EDGE};no-upscale`;
var GRAY_FORMULA = "(77R+150G+29B+128)>>8";
function assessGrayTarget(image) {
  return analyzeGrayTarget(image).result;
}
function analyzeGrayTarget(image) {
  const { widthPx, heightPx, data } = image ?? {};
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < MIN_DIMENSION || heightPx < MIN_DIMENSION || widthPx > MAX_INPUT_DIMENSION || heightPx > MAX_INPUT_DIMENSION || widthPx * heightPx > MAX_INPUT_PIXELS || !(data instanceof Uint8Array) || data.length !== widthPx * heightPx)
    invalidInput(
      `Expected gray8 {widthPx, heightPx, data: Uint8Array}, ${MIN_DIMENSION}..${MAX_INPUT_DIMENSION} px per side, at most ${MAX_INPUT_PIXELS} pixels, data.length === widthPx*heightPx`
    );
  const w = widthPx;
  const h = heightPx;
  const size = normalizedSize(w, h);
  const reduced = size.scale === 1 ? data : boxReduce(data, w, h, size.widthPx, size.heightPx);
  return assessNormalized(reduced, {
    id: NORMALIZATION_ID,
    grayFormula: GRAY_FORMULA,
    maxLongEdge: MAX_LONG_EDGE,
    inputWidthPx: w,
    inputHeightPx: h,
    widthPx: size.widthPx,
    heightPx: size.heightPx,
    scale: size.scale,
    resampling: size.scale === 1 ? "none" : "box-area"
  });
}
var OPTION_KEYS = /* @__PURE__ */ new Set(["signal", "maxImageBytes", "maxPixels", "environment"]);
function positiveLimit(value, name, cap) {
  if (value === void 0) return cap;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > cap)
    invalidInput(`${name} must be an integer from 1 to ${cap}`);
  return value;
}
var aborted = () => new EngineError("ABORTED", "Target assessment cancelled", { isRecoverable: true });
function raceAbort(promise, signal, dispose) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let isDone = false;
    const release = (value) => {
      try {
        dispose(value);
      } catch {
      }
    };
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      if (!isDone) {
        isDone = true;
        reject(aborted());
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (isDone) release(value);
        else {
          isDone = true;
          resolve(value);
        }
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (!isDone) {
          isDone = true;
          reject(error);
        }
      }
    );
  });
}
async function assessTargetImage(blob, options) {
  return (await analyzeTargetImage(blob, options)).result;
}
async function analyzeTargetImage(blob, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options))
    invalidInput("options must be an object");
  for (const key of Object.keys(options))
    if (!OPTION_KEYS.has(key)) invalidInput(`Unknown option: ${key}`);
  const maxBytes = positiveLimit(options.maxImageBytes, "maxImageBytes", MAX_IMAGE_BYTES);
  const maxPixels = positiveLimit(options.maxPixels, "maxPixels", MAX_INPUT_PIXELS);
  const signal = options.signal;
  if (signal !== void 0 && !(signal && typeof signal.aborted === "boolean" && typeof signal.addEventListener === "function"))
    invalidInput("signal must be an AbortSignal");
  const env = options.environment ?? globalThis;
  if (typeof Blob === "undefined" || !(blob instanceof Blob))
    invalidInput("Expected a Blob or File");
  const bytes = blob.size;
  if (!Number.isSafeInteger(bytes) || bytes < 1) invalidImage("The image is empty");
  if (bytes > maxBytes)
    invalidImage(
      `The image file is ${bytes} bytes; the limit is ${maxBytes}. Export a smaller copy (a 1024 px long edge is plenty).`
    );
  const decode = env.createImageBitmap;
  if (typeof decode !== "function" || typeof env.OffscreenCanvas !== "function" && typeof env.document?.createElement !== "function")
    throw new EngineError(
      "UNSUPPORTED",
      "Image decoding needs createImageBitmap and a canvas (browser page or Worker)",
      {
        isRecoverable: false
      }
    );
  if (signal?.aborted) throw aborted();
  let bitmap;
  try {
    bitmap = await raceAbort(decode.call(env, blob), signal, (b) => b.close());
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw new EngineError(
      "INVALID_TARGET",
      `The image could not be decoded: ${error instanceof Error ? error.message.slice(0, 120) : "unknown error"}`,
      { isRecoverable: false, cause: error }
    );
  }
  let canvas = null;
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1)
      invalidImage("The decoded image has no size");
    if (w > MAX_INPUT_DIMENSION || h > MAX_INPUT_DIMENSION || w * h > maxPixels)
      invalidImage(
        `The decoded image is ${w}x${h}; the limit is ${maxPixels} pixels and ${MAX_INPUT_DIMENSION} px per side. Export a smaller copy.`
      );
    if (Math.min(w, h) < MIN_DIMENSION)
      invalidImage(`The image is ${w}x${h}; at least ${MIN_DIMENSION} px per side is required.`);
    if (signal?.aborted) throw aborted();
    const size = normalizedSize(w, h);
    canvas = typeof env.OffscreenCanvas === "function" ? new env.OffscreenCanvas(size.widthPx, size.heightPx) : env.document.createElement("canvas");
    canvas.width = size.widthPx;
    canvas.height = size.heightPx;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context)
      throw new EngineError("UNSUPPORTED", "No 2D canvas context is available", {
        isRecoverable: false
      });
    context.drawImage(bitmap, 0, 0, size.widthPx, size.heightPx);
    const rgba = context.getImageData(0, 0, size.widthPx, size.heightPx).data;
    if (rgba.length !== size.widthPx * size.heightPx * 4)
      invalidImage("Canvas returned unexpected pixel data");
    const gray = new Uint8Array(size.widthPx * size.heightPx);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4)
      gray[i] = 77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2] + 128 >>> 8;
    if (signal?.aborted) throw aborted();
    return assessNormalized(gray, {
      id: NORMALIZATION_ID,
      grayFormula: GRAY_FORMULA,
      maxLongEdge: MAX_LONG_EDGE,
      inputWidthPx: w,
      inputHeightPx: h,
      widthPx: size.widthPx,
      heightPx: size.heightPx,
      scale: size.scale,
      resampling: size.scale === 1 ? "none" : "canvas-draw-image"
    });
  } finally {
    try {
      bitmap.close();
    } finally {
      if (canvas) {
        try {
          canvas.width = 0;
          canvas.height = 0;
        } catch {
        }
      }
    }
  }
}
var TEMPLATE_PREVIEW_LABEL = "template features (static, not live matches)";
function drawTemplateFeatures(context, preview, box, options = {}) {
  const {
    radius = 3.5,
    color = "rgba(0, 229, 255, 0.95)",
    maxPoints = TARGET_MAX_FEATURES
  } = options;
  if (!context || !preview || !(box?.widthPx > 0) || !(box?.heightPx > 0) || !(preview.widthPx > 0) || !(preview.heightPx > 0) || !Array.isArray(preview.points) || !(radius > 0) || !Number.isInteger(maxPoints) || maxPoints < 0)
    return 0;
  context.clearRect(0, 0, box.widthPx, box.heightPx);
  context.save();
  let drawn = 0;
  try {
    context.lineWidth = 1.5;
    context.strokeStyle = color;
    for (const point of preview.points) {
      if (drawn >= maxPoints) break;
      if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) continue;
      context.beginPath();
      context.arc(
        (point.x + 0.5) * box.widthPx / preview.widthPx,
        (point.y + 0.5) * box.heightPx / preview.heightPx,
        radius,
        0,
        Math.PI * 2
      );
      context.stroke();
      drawn++;
    }
  } finally {
    context.restore();
  }
  return drawn;
}
export {
  BLOCKER_CAP,
  DISCLAIMER,
  MAX_IMAGE_BYTES,
  MAX_INPUT_DIMENSION,
  MAX_INPUT_PIXELS,
  MAX_LONG_EDGE,
  MAX_SCORE,
  MIN_DIMENSION,
  REPLACE_BELOW,
  RESULT_SCHEMA,
  SCORER_NAME,
  SCORER_VERSION,
  TEMPLATE_PREVIEW_LABEL,
  WEIGHT,
  analyzeGrayTarget,
  analyzeTargetImage,
  assessGrayTarget,
  assessTargetImage,
  drawTemplateFeatures,
  normalizedSize,
  scoreMetrics
};
