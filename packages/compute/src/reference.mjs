/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
export const algorithmVersion = 'e-preprocess-u8-v1';
export const MAX_PIXELS = 4096 * 4096;

function layout(data, width, height, stride, channels) {
  if (!(data instanceof Uint8Array) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width * height > MAX_PIXELS ||
      !Number.isSafeInteger(stride) || stride < width * channels ||
      (height - 1) * stride + width * channels > data.length) {
    throw new RangeError('Invalid or oversized image layout');
  }
}

// Encoded RGB luma approximation; no implicit linearization or premultiplication.
export function rgbaToGray(data, width, height, stride = width * 4) {
  layout(data, width, height, stride, 4);
  const output = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * stride + x * 4;
    output[y * width + x] = (77 * data[i] + 150 * data[i + 1] + 29 * data[i + 2] + 128) >>> 8;
  }
  return { data: output, width, height, stride: width };
}

// Separable [1 4 6 4 1], clamp-to-edge, decimate at (2x, 2y), round once.
export function downsample(image) {
  const { data, width, height, stride = width } = image;
  layout(data, width, height, stride, 1);
  const w = Math.ceil(width / 2), h = Math.ceil(height / 2);
  const output = new Uint8Array(w * h), kernel = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let ky = -2; ky <= 2; ky++) for (let kx = -2; kx <= 2; kx++) {
      const ix = Math.max(0, Math.min(width - 1, x * 2 + kx));
      const iy = Math.max(0, Math.min(height - 1, y * 2 + ky));
      sum += data[iy * stride + ix] * kernel[kx + 2] * kernel[ky + 2];
    }
    output[y * w + x] = (sum + 128) >>> 8;
  }
  return { data: output, width: w, height: h, stride: w };
}

export function buildPyramid(image, levels = 4) {
  if (!Number.isInteger(levels) || levels < 1 || levels > 16) throw new RangeError('Invalid level count');
  layout(image.data, image.width, image.height, image.stride ?? image.width, 1);
  const base = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++) base.set(image.data.subarray(y * (image.stride ?? image.width), y * (image.stride ?? image.width) + image.width), y * image.width);
  const result = [{ data: base, width: image.width, height: image.height, stride: image.width }];
  while (result.length < levels) {
    const last = result.at(-1);
    if (last.width === 1 && last.height === 1) break;
    result.push(downsample(last));
  }
  return result;
}

export function hammingDistance(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length || a.length < 1 || a.length > 1024) throw new RangeError('Invalid descriptor lengths');
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    let bits = a[i] ^ b[i];
    while (bits) { bits &= bits - 1; count++; }
  }
  return count;
}
