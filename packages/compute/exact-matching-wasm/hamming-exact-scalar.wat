;; Copyright 2026 Andy (@andy-mira)
;; SPDX-License-Identifier: Apache-2.0
;;
;; Exact BRIEF Hamming matcher, scalar WebAssembly (MVP instructions only: i64.popcnt).
;; Contract hamming32-mutual-ratio075-max64/1, identical to matchPacked in packages/recognition/src/oriented.mjs:
;;   distance = popcount(target XOR frame) over 32 bytes; best/second start at 257 and are updated by strict "<" in frame order;
;;   accept target i when best <= 64, 4*best < 3*second (strict) and frame index is the unique reverse nearest of i
;;   (an equal reverse distance from a later target clears the reverse winner). Output is in ascending target index.
;;
;; ABI 1, fixed layout in one non-growable 4-page (256 KiB) memory; no allocator, no imports, no memory.grow:
;;   [0, 163840)       resident targets: 10 slots x 512 descriptors x 32 bytes (slot k at k*16384)
;;   [163840, 180224)  frame descriptors, uploaded once per batch (at most 512 x 32 bytes)
;;   [180224, 184320)  reverse nearest distance, i32[516]
;;   [184320, 188416)  reverse nearest target index, i32[516] (-1 = none or tie)
;;   [188416, 194560)  per-target {best, second, index}, i32 x 3 x 512
;;   [194560, 225280)  output: u16 triples {targetIndex, frameIndex, distance}, 10 slots x 512 x 6 bytes
;; match(targetOffset, n, outOffset, m) -> number of triples written, or -1 for arguments outside the layout.
(module
  (memory (export "memory") 4 4)
  (func (export "abi") (result i32) (i32.const 1))

  (func (export "match") (param $t i32) (param $n i32) (param $out i32) (param $m i32) (result i32)
    (local $i i32) (local $j i32) (local $p i32) (local $q i32) (local $r i32)
    (local $a0 i64) (local $a1 i64) (local $a2 i64) (local $a3 i64)
    (local $d i32) (local $best i32) (local $second i32) (local $index i32)
    ;; Argument validation (every operand is below 2^19 after the first checks, so the sums cannot wrap).
    (if (i32.or (i32.or (i32.gt_u (local.get $n) (i32.const 512)) (i32.gt_u (local.get $m) (i32.const 512)))
                (i32.or (i32.gt_u (local.get $t) (i32.const 163840)) (i32.and (local.get $t) (i32.const 31))))
      (then (return (i32.const -1))))
    (if (i32.gt_u (i32.add (local.get $t) (i32.shl (local.get $n) (i32.const 5))) (i32.const 163840))
      (then (return (i32.const -1))))
    (if (i32.or (i32.or (i32.lt_u (local.get $out) (i32.const 194560)) (i32.gt_u (local.get $out) (i32.const 225280)))
                (i32.and (local.get $out) (i32.const 1)))
      (then (return (i32.const -1))))
    (if (i32.gt_u (i32.add (local.get $out) (i32.mul (local.get $n) (i32.const 6))) (i32.const 225280))
      (then (return (i32.const -1))))
    (if (i32.or (i32.eqz (local.get $n)) (i32.eqz (local.get $m)))
      (then (return (i32.const 0))))

    ;; Reverse nearest state: distance 257 (above any 256-bit distance), index -1.
    (loop $init
      (local.set $r (i32.add (i32.const 180224) (i32.shl (local.get $j) (i32.const 2))))
      (i32.store (local.get $r) (i32.const 257))
      (i32.store offset=4096 (local.get $r) (i32.const -1))
      (br_if $init (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (local.get $m))))

    (loop $targets
      (local.set $p (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 5))))
      (local.set $a0 (i64.load (local.get $p)))
      (local.set $a1 (i64.load offset=8 (local.get $p)))
      (local.set $a2 (i64.load offset=16 (local.get $p)))
      (local.set $a3 (i64.load offset=24 (local.get $p)))
      (local.set $best (i32.const 257))
      (local.set $second (i32.const 257))
      (local.set $index (i32.const -1))
      (local.set $j (i32.const 0))
      (local.set $q (i32.const 163840))
      (loop $frames
        (local.set $d (i32.wrap_i64
          (i64.add
            (i64.add (i64.popcnt (i64.xor (local.get $a0) (i64.load (local.get $q))))
                     (i64.popcnt (i64.xor (local.get $a1) (i64.load offset=8 (local.get $q)))))
            (i64.add (i64.popcnt (i64.xor (local.get $a2) (i64.load offset=16 (local.get $q))))
                     (i64.popcnt (i64.xor (local.get $a3) (i64.load offset=24 (local.get $q))))))))
        ;; Forward best/second in frame order.
        (if (i32.lt_u (local.get $d) (local.get $best))
          (then (local.set $second (local.get $best)) (local.set $best (local.get $d)) (local.set $index (local.get $j)))
          (else (if (i32.lt_u (local.get $d) (local.get $second)) (then (local.set $second (local.get $d))))))
        ;; Reverse nearest in target order: strictly closer replaces, equal distance clears.
        (local.set $r (i32.add (i32.const 180224) (i32.shl (local.get $j) (i32.const 2))))
        (if (i32.lt_u (local.get $d) (i32.load (local.get $r)))
          (then (i32.store (local.get $r) (local.get $d)) (i32.store offset=4096 (local.get $r) (local.get $i)))
          (else (if (i32.eq (local.get $d) (i32.load (local.get $r))) (then (i32.store offset=4096 (local.get $r) (i32.const -1))))))
        (local.set $q (i32.add (local.get $q) (i32.const 32)))
        (br_if $frames (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (local.get $m))))
      (local.set $p (i32.add (i32.const 188416) (i32.mul (local.get $i) (i32.const 12))))
      (i32.store (local.get $p) (local.get $best))
      (i32.store offset=4 (local.get $p) (local.get $second))
      (i32.store offset=8 (local.get $p) (local.get $index))
      (br_if $targets (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (call $emit (local.get $n) (local.get $out)))

  ;; Accepted pairs in ascending target index: best <= 64, 4*best < 3*second, unique reverse nearest.
  (func $emit (param $n i32) (param $out i32) (result i32)
    (local $i i32) (local $p i32) (local $best i32) (local $index i32) (local $count i32) (local $o i32)
    (loop $each
      (local.set $p (i32.add (i32.const 188416) (i32.mul (local.get $i) (i32.const 12))))
      (local.set $best (i32.load (local.get $p)))
      (local.set $index (i32.load offset=8 (local.get $p)))
      (if (i32.and (i32.ge_s (local.get $index) (i32.const 0))
                   (i32.and (i32.le_u (local.get $best) (i32.const 64))
                            (i32.lt_u (i32.shl (local.get $best) (i32.const 2)) (i32.mul (i32.load offset=4 (local.get $p)) (i32.const 3)))))
        (then
          (if (i32.eq (i32.load (i32.add (i32.const 184320) (i32.shl (local.get $index) (i32.const 2)))) (local.get $i))
            (then
              (local.set $o (i32.add (local.get $out) (i32.mul (local.get $count) (i32.const 6))))
              (i32.store16 (local.get $o) (local.get $i))
              (i32.store16 offset=2 (local.get $o) (local.get $index))
              (i32.store16 offset=4 (local.get $o) (local.get $best))
              (local.set $count (i32.add (local.get $count) (i32.const 1)))))))
      (br_if $each (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (local.get $count)))
