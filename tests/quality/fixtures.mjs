// Deterministic synthetic gray8 images for the target-quality tests. Generated, not photographs; no files are read.
export function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
export const blank = (width = 512, height = 384, value = 128) => ({ width, height, data: new Uint8Array(width * height).fill(value) });
/** Random filled rectangles over a background; `region` [x, y, w, h] confines them, [lo, hi] bounds their brightness. */
export function rects(seed, width = 512, height = 384, count = 900, { region = [0, 0, width, height], base = 80, lo = 0, hi = 255 } = {}) {
  const random = rng(seed), data = new Uint8Array(width * height).fill(base), [rx, ry, rw, rh] = region;
  for (let i = 0; i < count; i++) {
    const x = rx + Math.floor(random() * rw), y = ry + Math.floor(random() * rh), w = 3 + Math.floor(random() * 20), h = 3 + Math.floor(random() * 20), c = Math.floor(lo + random() * (hi - lo));
    for (let dy = 0; dy < h && y + dy < Math.min(height, ry + rh); dy++) for (let dx = 0; dx < w && x + dx < Math.min(width, rx + rw); dx++) data[(y + dy) * width + x + dx] = c;
  }
  return { width, height, data };
}
/** One random tile repeated over the whole image: textured everywhere, but every patch has identical twins. */
export function tiled(seed, tile = 32, width = 512, height = 384) {
  const t = rects(seed, tile, tile, 40).data, data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = t[(y % tile) * tile + (x % tile)];
  return { width, height, data };
}
/** Multi-octave value noise stretched to 0..255: smooth, photograph-like gradients with texture at several scales. */
export function natural(seed, width = 512, height = 384) {
  const random = rng(seed), acc = new Float64Array(width * height);
  for (const [cell, amp] of [[64, 70], [32, 50], [16, 35], [8, 25]]) {
    const gw = Math.ceil(width / cell) + 2, gh = Math.ceil(height / cell) + 2, g = Array.from({ length: gw * gh }, () => random());
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      acc[y * width + x] += amp * ((g[iy * gw + ix] * (1 - tx) + g[iy * gw + ix + 1] * tx) * (1 - ty) + (g[(iy + 1) * gw + ix] * (1 - tx) + g[(iy + 1) * gw + ix + 1] * tx) * ty);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of acc) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  return { width, height, data: Uint8Array.from(acc, v => Math.round(255 * (v - lo) / (hi - lo))) };
}
export const toRgba = ({ width, height, data }) => { const out = new Uint8ClampedArray(width * height * 4); for (let i = 0; i < data.length; i++) { out[4 * i] = out[4 * i + 1] = out[4 * i + 2] = data[i]; out[4 * i + 3] = 255; } return out; };
