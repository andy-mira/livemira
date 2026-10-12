// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
#include "preprocess.h"
#include <algorithm>
#include <limits>

namespace {
bool valid(const uint8_t* src, size_t size, uint32_t w, uint32_t h, size_t stride,
           uint8_t* dst, size_t capacity, size_t channels, size_t required) {
  if (!src || !dst || !w || !h || uint64_t(w) * h > 4096u * 4096u ||
      stride < size_t(w) * channels || capacity < required) return false;
  const size_t row = size_t(w) * channels;
  if (h > 1 && stride > (std::numeric_limits<size_t>::max() - row) / (h - 1)) return false;
  return size >= (h - 1) * stride + row;
}
}
int e_rgba_gray(const uint8_t* src, size_t size, uint32_t w, uint32_t h,
                size_t stride, uint8_t* dst, size_t capacity) {
  if (!valid(src, size, w, h, stride, dst, capacity, 4, size_t(w) * h)) return 1;
  for (uint32_t y = 0; y < h; ++y) for (uint32_t x = 0; x < w; ++x) {
    const auto* p = src + y * stride + x * 4;
    dst[y * w + x] = uint8_t((77u * p[0] + 150u * p[1] + 29u * p[2] + 128u) >> 8);
  }
  return 0;
}
int e_pyr_down(const uint8_t* src, size_t size, uint32_t w, uint32_t h,
               size_t stride, uint8_t* dst, size_t capacity) {
  if (!w || !h || uint64_t(w) * h > 4096u * 4096u) return 1;
  const uint32_t ow = (w + 1) / 2, oh = (h + 1) / 2;
  if (!valid(src, size, w, h, stride, dst, capacity, 1, size_t(ow) * oh)) return 1;
  const int k[] = {1, 4, 6, 4, 1};
  for (uint32_t y = 0; y < oh; ++y) for (uint32_t x = 0; x < ow; ++x) {
    unsigned sum = 0;
    for (int dy = -2; dy <= 2; ++dy) for (int dx = -2; dx <= 2; ++dx) {
      const int ix = std::clamp(int(2 * x) + dx, 0, int(w) - 1);
      const int iy = std::clamp(int(2 * y) + dy, 0, int(h) - 1);
      sum += src[size_t(iy) * stride + ix] * k[dx + 2] * k[dy + 2];
    }
    dst[y * ow + x] = uint8_t((sum + 128) >> 8);
  }
  return 0;
}
