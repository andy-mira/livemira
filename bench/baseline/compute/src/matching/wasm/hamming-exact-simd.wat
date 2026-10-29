;; Copyright 2026 Andy
;; SPDX-License-Identifier: Apache-2.0
;;
;; Exact BRIEF Hamming matcher, WebAssembly SIMD128 (fixed-width SIMD, no relaxed SIMD, no threads).
;; Same contract, ABI, memory layout, exports and output as hamming-exact-scalar.wat; read that file first.
;;
;; Four frame descriptors are compared per step (i8x16.popcnt, then a pairwise reduction to four i32 distances).
;; Lane k keeps the frame-order best, second and FIRST index among frames j = k (mod 4); padded lanes beyond m get
;; distance 257 and change nothing. The lane states combine to the sequential result: best = min over lanes;
;; index = smallest lane index whose lane best equals best; second = best when two lanes share best, otherwise the
;; minimum of the other lanes' bests and the winning lane's second. The reverse nearest update is independent per
;; frame and is applied to four frames at once. The reverse arrays hold 516 entries so a padded step stays in range.
(module
  (memory (export "memory") 4 4)
  (func (export "abi") (result i32) (i32.const 1))

  ;; Unsigned minimum of the four i32 lanes.
  (func $hmin (param $v v128) (result i32)
    (local.set $v (i32x4.min_u (local.get $v) (i8x16.shuffle 8 9 10 11 12 13 14 15 0 1 2 3 4 5 6 7 (local.get $v) (local.get $v))))
    (local.set $v (i32x4.min_u (local.get $v) (i8x16.shuffle 4 5 6 7 0 1 2 3 12 13 14 15 8 9 10 11 (local.get $v) (local.get $v))))
    (i32x4.extract_lane 0 (local.get $v)))

  (func (export "match") (param $t i32) (param $n i32) (param $out i32) (param $m i32) (result i32)
    (local $i i32) (local $j i32) (local $p i32) (local $q i32) (local $r i32)
    (local $best i32) (local $eq v128)
    (local $tlo v128) (local $thi v128) (local $mv v128) (local $iv v128) (local $jv v128)
    (local $bestv v128) (local $secondv v128) (local $idxv v128) (local $dv v128) (local $lt v128) (local $rd v128)
    (local $q0 v128) (local $q1 v128) (local $q2 v128) (local $q3 v128) (local $h01 v128) (local $h23 v128)
    ;; Argument validation, identical to the scalar module.
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

    ;; Reverse nearest state for every padded step: distance 257, index -1.
    (loop $init
      (local.set $r (i32.add (i32.const 180224) (i32.shl (local.get $j) (i32.const 2))))
      (v128.store (local.get $r) (v128.const i32x4 257 257 257 257))
      (v128.store offset=4096 (local.get $r) (v128.const i32x4 -1 -1 -1 -1))
      (br_if $init (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 4))) (local.get $m))))

    (local.set $mv (i32x4.splat (local.get $m)))
    (loop $targets
      (local.set $p (i32.add (local.get $t) (i32.shl (local.get $i) (i32.const 5))))
      (local.set $tlo (v128.load (local.get $p)))
      (local.set $thi (v128.load offset=16 (local.get $p)))
      (local.set $iv (i32x4.splat (local.get $i)))
      (local.set $bestv (v128.const i32x4 257 257 257 257))
      (local.set $secondv (v128.const i32x4 257 257 257 257))
      (local.set $idxv (v128.const i32x4 -1 -1 -1 -1))
      (local.set $jv (v128.const i32x4 0 1 2 3))
      (local.set $j (i32.const 0))
      (local.set $q (i32.const 163840))
      (loop $frames
        ;; Per-descriptor byte popcounts (each byte <= 16), widened to eight u16 lanes (each <= 32).
        (local.set $q0 (i16x8.extadd_pairwise_i8x16_u (i8x16.add
          (i8x16.popcnt (v128.xor (local.get $tlo) (v128.load (local.get $q))))
          (i8x16.popcnt (v128.xor (local.get $thi) (v128.load offset=16 (local.get $q)))))))
        (local.set $q1 (i16x8.extadd_pairwise_i8x16_u (i8x16.add
          (i8x16.popcnt (v128.xor (local.get $tlo) (v128.load offset=32 (local.get $q))))
          (i8x16.popcnt (v128.xor (local.get $thi) (v128.load offset=48 (local.get $q)))))))
        (local.set $q2 (i16x8.extadd_pairwise_i8x16_u (i8x16.add
          (i8x16.popcnt (v128.xor (local.get $tlo) (v128.load offset=64 (local.get $q))))
          (i8x16.popcnt (v128.xor (local.get $thi) (v128.load offset=80 (local.get $q)))))))
        (local.set $q3 (i16x8.extadd_pairwise_i8x16_u (i8x16.add
          (i8x16.popcnt (v128.xor (local.get $tlo) (v128.load offset=96 (local.get $q))))
          (i8x16.popcnt (v128.xor (local.get $thi) (v128.load offset=112 (local.get $q)))))))
        ;; Horizontal adds of u16 lanes (even + odd lanes of the concatenation): h01 = [q0 pair sums, q1 pair sums], etc.
        (local.set $h01 (i16x8.add
          (i8x16.shuffle 0 1 4 5 8 9 12 13 16 17 20 21 24 25 28 29 (local.get $q0) (local.get $q1))
          (i8x16.shuffle 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 31 (local.get $q0) (local.get $q1))))
        (local.set $h23 (i16x8.add
          (i8x16.shuffle 0 1 4 5 8 9 12 13 16 17 20 21 24 25 28 29 (local.get $q2) (local.get $q3))
          (i8x16.shuffle 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 31 (local.get $q2) (local.get $q3))))
        ;; [q0 halves, q1 halves, q2 halves, q3 halves] (each <= 128) -> four i32 distances (each <= 256).
        (local.set $dv (i32x4.extadd_pairwise_i16x8_u (i16x8.add
          (i8x16.shuffle 0 1 4 5 8 9 12 13 16 17 20 21 24 25 28 29 (local.get $h01) (local.get $h23))
          (i8x16.shuffle 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 31 (local.get $h01) (local.get $h23)))))
        ;; Padded lanes (j >= m) get 257: never below best/second, and their reverse entries are never read.
        (local.set $dv (v128.bitselect (local.get $dv) (v128.const i32x4 257 257 257 257) (i32x4.lt_u (local.get $jv) (local.get $mv))))
        ;; Per-lane forward update in frame order.
        (local.set $lt (i32x4.lt_u (local.get $dv) (local.get $bestv)))
        (local.set $secondv (v128.bitselect (local.get $bestv) (i32x4.min_u (local.get $secondv) (local.get $dv)) (local.get $lt)))
        (local.set $bestv (v128.bitselect (local.get $dv) (local.get $bestv) (local.get $lt)))
        (local.set $idxv (v128.bitselect (local.get $jv) (local.get $idxv) (local.get $lt)))
        ;; Reverse nearest of the four frames: strictly closer replaces, equal distance clears.
        (local.set $r (i32.add (i32.const 180224) (i32.shl (local.get $j) (i32.const 2))))
        (local.set $rd (v128.load (local.get $r)))
        (v128.store offset=4096 (local.get $r)
          (v128.bitselect (local.get $iv)
            (v128.bitselect (v128.const i32x4 -1 -1 -1 -1) (v128.load offset=4096 (local.get $r)) (i32x4.eq (local.get $dv) (local.get $rd)))
            (i32x4.lt_u (local.get $dv) (local.get $rd))))
        (v128.store (local.get $r) (i32x4.min_u (local.get $dv) (local.get $rd)))
        (local.set $jv (i32x4.add (local.get $jv) (v128.const i32x4 4 4 4 4)))
        (local.set $q (i32.add (local.get $q) (i32.const 128)))
        (br_if $frames (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 4))) (local.get $m))))
      ;; Combine the four lane states into the sequential best, second and first index.
      (local.set $best (call $hmin (local.get $bestv)))
      (local.set $eq (i32x4.eq (local.get $bestv) (i32x4.splat (local.get $best))))
      (local.set $p (i32.add (i32.const 188416) (i32.mul (local.get $i) (i32.const 12))))
      (i32.store (local.get $p) (local.get $best))
      (i32.store offset=4 (local.get $p)
        (if (result i32) (i32.gt_u (i32.popcnt (i32x4.bitmask (local.get $eq))) (i32.const 1))
          (then (local.get $best))
          (else (call $hmin (v128.bitselect (local.get $secondv) (local.get $bestv) (local.get $eq))))))
      (i32.store offset=8 (local.get $p) (call $hmin (v128.bitselect (local.get $idxv) (v128.const i32x4 -1 -1 -1 -1) (local.get $eq))))
      (br_if $targets (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
    (call $emit (local.get $n) (local.get $out)))

  ;; Identical to the scalar module's $emit.
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
