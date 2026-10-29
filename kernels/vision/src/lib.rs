// SPDX-License-Identifier: Apache-2.0
//! WASM kernels of LiveMira Next. No allocator and no runtime: JavaScript reserves the buffers through `reserve` and
//! passes offsets into linear memory. Built with `-C target-feature=+simd128`; the scalar fallback is the JavaScript
//! reference in `packages/features/src/hamming.ts`, which must give identical results.
#![no_std]

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

static mut HEAP_TOP: usize = 0;

extern "C" {
    static __heap_base: u8;
}

/// Bump-reserves `bytes` (16-byte aligned) and returns the offset; `reset_heap` frees everything.
#[no_mangle]
pub unsafe extern "C" fn reserve(bytes: usize) -> usize {
    if HEAP_TOP == 0 {
        HEAP_TOP = (&__heap_base as *const u8 as usize + 15) & !15;
    }
    let at = HEAP_TOP;
    let end = (at + bytes + 15) & !15;
    let pages_needed = (end + 65535) / 65536;
    let pages = core::arch::wasm32::memory_size(0);
    if pages_needed > pages {
        if core::arch::wasm32::memory_grow(0, pages_needed - pages) == usize::MAX {
            return 0;
        }
    }
    HEAP_TOP = end;
    at
}

#[no_mangle]
pub unsafe extern "C" fn reset_heap() {
    HEAP_TOP = (&__heap_base as *const u8 as usize + 15) & !15;
}

#[inline(always)]
unsafe fn distance(a: *const u8, b: *const u8) -> u32 {
    let lo = v128_xor(v128_load(a as *const v128), v128_load(b as *const v128));
    let hi = v128_xor(v128_load(a.add(16) as *const v128), v128_load(b.add(16) as *const v128));
    let counts = u8x16_add(u8x16_popcnt(lo), u8x16_popcnt(hi));
    let pairs = u16x8_extadd_pairwise_u8x16(counts);
    let quads = u32x4_extadd_pairwise_u16x8(pairs);
    u32x4_extract_lane::<0>(quads) + u32x4_extract_lane::<1>(quads) + u32x4_extract_lane::<2>(quads) + u32x4_extract_lane::<3>(quads)
}

/// For each of `m` query descriptors (32 bytes each at `queries`), the nearest and second-nearest of `n` reference
/// descriptors at `refs`. Writes u32 triples (index, best, second) to `out`. Ties keep the lower index.
#[no_mangle]
pub unsafe extern "C" fn nearest2(queries: *const u8, m: usize, refs: *const u8, n: usize, out: *mut u32) {
    for q in 0..m {
        let a = queries.add(32 * q);
        let mut best = 257u32;
        let mut second = 257u32;
        let mut index = u32::MAX;
        for r in 0..n {
            let d = distance(a, refs.add(32 * r));
            if d < best {
                second = best;
                best = d;
                index = r as u32;
            } else if d < second {
                second = d;
            }
        }
        *out.add(3 * q) = index;
        *out.add(3 * q + 1) = best;
        *out.add(3 * q + 2) = second;
    }
}

/// Like `nearest2`, but `groups[r]` labels each reference (e.g. several descriptors of one target point): the second
/// distance is the best one among references of a different group than the nearest. Ties keep the lower index.
#[no_mangle]
pub unsafe extern "C" fn nearest2_grouped(queries: *const u8, m: usize, refs: *const u8, groups: *const u32, n: usize, out: *mut u32) {
    for q in 0..m {
        let a = queries.add(32 * q);
        let mut best = 257u32;
        let mut best_group = u32::MAX;
        let mut second = 257u32;
        let mut index = u32::MAX;
        for r in 0..n {
            let d = distance(a, refs.add(32 * r));
            let g = *groups.add(r);
            if g == best_group {
                if d < best {
                    best = d;
                    index = r as u32;
                }
            } else if d < best {
                second = best;
                best = d;
                best_group = g;
                index = r as u32;
            } else if d < second {
                second = d;
            }
        }
        *out.add(3 * q) = index;
        *out.add(3 * q + 1) = best;
        *out.add(3 * q + 2) = second;
    }
}

/// Offsets (dx, dy) of the 16-pixel Bresenham circle of radius 3, clockwise from the top.
const CIRCLE: [(isize, isize); 16] = [
    (0, -3), (1, -3), (2, -2), (3, -1), (3, 0), (3, 1), (2, 2), (1, 3),
    (0, 3), (-1, 3), (-2, 2), (-3, 1), (-3, 0), (-3, -1), (-2, -2), (-1, -3),
];

/// Lanes where some 9 contiguous circle masks (cyclically) are all set.
#[inline(always)]
fn arc9(m: &[v128; 16]) -> v128 {
    let mut a2 = [u8x16_splat(0); 16];
    for i in 0..16 {
        a2[i] = v128_and(m[i], m[(i + 1) & 15]);
    }
    let mut a4 = [u8x16_splat(0); 16];
    for i in 0..16 {
        a4[i] = v128_and(a2[i], a2[(i + 2) & 15]);
    }
    let mut any = u8x16_splat(0);
    for i in 0..16 {
        any = v128_or(any, v128_and(v128_and(a4[i], a4[(i + 4) & 15]), m[(i + 8) & 15]));
    }
    any
}

/// Sum of the 16 lanes' u8 values per lane position, as two u16x8 halves (lanes 0–7, 8–15).
#[inline(always)]
fn sum16(v: &[v128; 16]) -> (v128, v128) {
    let mut lo = u16x8_splat(0);
    let mut hi = u16x8_splat(0);
    for x in v.iter() {
        lo = u16x8_add(lo, u16x8_extend_low_u8x16(*x));
        hi = u16x8_add(hi, u16x8_extend_high_u8x16(*x));
    }
    (lo, hi)
}

/// FAST-9 over the pixels x0 ≤ x < x1, y0 ≤ y < y1 of the 8-bit image at `img` (row length `stride`; the caller keeps
/// 3 pixels plus 15 columns of slack inside the image) with threshold `t`. A corner's score is 1 + the sum, over the
/// circle pixels beyond the threshold on the corner's side, of their excess (bright side first), exactly as
/// `fastScore` in packages/features/src/orb.ts. Writes the non-zero u16 scores into `scores` (row length `w`), appends
/// their indices y·w + x to `found` in raster order and returns how many there are.
#[no_mangle]
pub unsafe extern "C" fn fast9(
    img: *const u8,
    stride: usize,
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    t: u32,
    scores: *mut u16,
    w: usize,
    found: *mut u32,
) -> usize {
    let mut offsets = [0isize; 16];
    for i in 0..16 {
        offsets[i] = CIRCLE[i].1 * stride as isize + CIRCLE[i].0;
    }
    let tv = u8x16_splat(t.min(255) as u8);
    let mut count = 0usize;
    let mut q = [u8x16_splat(0); 16];
    let mut bright = [u8x16_splat(0); 16];
    let mut dark = [u8x16_splat(0); 16];
    for y in y0..y1 {
        let row = img.add(y * stride);
        let mut x = x0;
        while x < x1 {
            let p = row.add(x);
            let c = v128_load(p as *const v128);
            let hi = u8x16_add_sat(c, tv);
            let lo = u8x16_sub_sat(c, tv);
            for i in 0..16 {
                q[i] = v128_load(p.offset(offsets[i]) as *const v128);
            }
            // Any 9-arc covers two neighbouring compass pixels (0/4, 4/8, 8/12, 12/0).
            let (b0, b4, b8, b12) = (u8x16_gt(q[0], hi), u8x16_gt(q[4], hi), u8x16_gt(q[8], hi), u8x16_gt(q[12], hi));
            let (d0, d4, d8, d12) = (u8x16_lt(q[0], lo), u8x16_lt(q[4], lo), u8x16_lt(q[8], lo), u8x16_lt(q[12], lo));
            let maybe = v128_or(
                v128_or(v128_or(v128_and(b0, b4), v128_and(b4, b8)), v128_or(v128_and(b8, b12), v128_and(b12, b0))),
                v128_or(v128_or(v128_and(d0, d4), v128_and(d4, d8)), v128_or(v128_and(d8, d12), v128_and(d12, d0))),
            );
            let lanes = if x1 - x >= 16 { 0xffffu32 } else { (1u32 << (x1 - x)) - 1 };
            if (i8x16_bitmask(maybe) as u32) & lanes != 0 {
                for i in 0..16 {
                    bright[i] = u8x16_gt(q[i], hi);
                    dark[i] = u8x16_lt(q[i], lo);
                }
                let is_bright = arc9(&bright);
                let is_dark = arc9(&dark);
                let mb = (i8x16_bitmask(is_bright) as u32) & lanes;
                let md = (i8x16_bitmask(is_dark) as u32) & lanes & !mb;
                if mb | md != 0 {
                    let mut excess = [u8x16_splat(0); 16];
                    for i in 0..16 {
                        excess[i] = u8x16_sub_sat(q[i], hi);
                    }
                    let (sb_lo, sb_hi) = sum16(&excess);
                    for i in 0..16 {
                        excess[i] = u8x16_sub_sat(lo, q[i]);
                    }
                    let (sd_lo, sd_hi) = sum16(&excess);
                    let mut sb = [0u16; 16];
                    let mut sd = [0u16; 16];
                    v128_store(sb.as_mut_ptr() as *mut v128, sb_lo);
                    v128_store(sb.as_mut_ptr().add(8) as *mut v128, sb_hi);
                    v128_store(sd.as_mut_ptr() as *mut v128, sd_lo);
                    v128_store(sd.as_mut_ptr().add(8) as *mut v128, sd_hi);
                    let mut m = mb | md;
                    while m != 0 {
                        let k = m.trailing_zeros() as usize;
                        m &= m - 1;
                        let s = if mb & (1 << k) != 0 { sb[k] } else { sd[k] } + 1;
                        let i = y * w + x + k;
                        *scores.add(i) = s;
                        *found.add(count) = i as u32;
                        count += 1;
                    }
                }
            }
            x += 16;
        }
    }
    count
}
