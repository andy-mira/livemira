// SPDX-License-Identifier: Apache-2.0
// Small dense linear algebra for the geometry kernels: row-major Float64Array matrices, fixed operation order, no
// allocation beyond the caller's buffers where it matters.

/**
 * Solves the n×n system A·x = b in place by Gaussian elimination with partial pivoting. `a` (n·n) and `b` (n) are
 * overwritten; the solution is written to `b`. Returns false for a (near-)singular system.
 */
export function solveInPlace(a: Float64Array, b: Float64Array, n: number): boolean {
  for (let c = 0; c < n; c++) {
    let pivot = c;
    let best = Math.abs(a[c * n + c]!);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(a[r * n + c]!);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < 1e-12) return false;
    if (pivot !== c) {
      for (let k = 0; k < n; k++) {
        const t = a[c * n + k]!;
        a[c * n + k] = a[pivot * n + k]!;
        a[pivot * n + k] = t;
      }
      const t = b[c]!;
      b[c] = b[pivot]!;
      b[pivot] = t;
    }
    const d = a[c * n + c]!;
    for (let r = c + 1; r < n; r++) {
      const f = a[r * n + c]! / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[r * n + k]! -= f * a[c * n + k]!;
      b[r]! -= f * b[c]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= a[r * n + k]! * b[k]!;
    b[r] = s / a[r * n + r]!;
  }
  return b.every(Number.isFinite);
}

/** Inverse of a symmetric positive-definite n×n matrix by Gauss–Jordan; null when singular. */
export function invertSymmetric(a: Float64Array, n: number): Float64Array | null {
  const m = new Float64Array(a);
  const inv = new Float64Array(n * n);
  for (let i = 0; i < n; i++) inv[i * n + i] = 1;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r * n + c]!) > Math.abs(m[pivot * n + c]!)) pivot = r;
    if (Math.abs(m[pivot * n + c]!) < 1e-15) return null;
    if (pivot !== c)
      for (let k = 0; k < n; k++) {
        let t = m[c * n + k]!;
        m[c * n + k] = m[pivot * n + k]!;
        m[pivot * n + k] = t;
        t = inv[c * n + k]!;
        inv[c * n + k] = inv[pivot * n + k]!;
        inv[pivot * n + k] = t;
      }
    const d = m[c * n + c]!;
    for (let k = 0; k < n; k++) {
      m[c * n + k]! /= d;
      inv[c * n + k]! /= d;
    }
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r * n + c]!;
      if (f === 0) continue;
      for (let k = 0; k < n; k++) {
        m[r * n + k]! -= f * m[c * n + k]!;
        inv[r * n + k]! -= f * inv[c * n + k]!;
      }
    }
  }
  return inv;
}

/**
 * Eigenvector of the smallest eigenvalue of a symmetric n×n matrix (cyclic Jacobi rotations, fixed sweep order).
 * Used for the null vector of the DLT normal matrix.
 */
export function smallestEigenvector(sym: Float64Array, n: number): Float64Array {
  const a = new Float64Array(sym);
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * n + q]! - a[p * n + p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]!;
          const akq = a[k * n + q]!;
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]!;
          const aqk = a[q * n + k]!;
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!;
          const vkq = v[k * n + q]!;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  let min = 0;
  for (let i = 1; i < n; i++) if (a[i * n + i]! < a[min * n + min]!) min = i;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = v[k * n + min]!;
  return out;
}
