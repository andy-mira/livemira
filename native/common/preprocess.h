// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
#pragma once
#include <cstddef>
#include <cstdint>

// Return 0 on success, 1 on invalid layout/capacity. Buffers must not overlap.
extern "C" {
int e_rgba_gray(const uint8_t* src, size_t src_size, uint32_t width, uint32_t height,
                size_t stride, uint8_t* dst, size_t dst_size);
int e_pyr_down(const uint8_t* src, size_t src_size, uint32_t width, uint32_t height,
               size_t stride, uint8_t* dst, size_t dst_size);
}
