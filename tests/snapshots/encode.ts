/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Bit-exact encoding of algorithm outputs. Every number becomes the hex of its IEEE-754 binary64 pattern (so -0, NaN
// and the last bit of a fraction count), typed arrays keep their element type, object keys are sorted. Timings
// measured with performance.now() are left out.

import { createHash } from 'node:crypto';

const TIMING_KEYS: ReadonlySet<string> = new Set([
  'featureMs',
  'retrievalMs',
  'matchMs',
  'geometryMs',
  'totalMs',
  'prepareMs',
]);

const view = new DataView(new ArrayBuffer(8));

function f64Hex(value: number): string {
  view.setFloat64(0, value);
  return view.getBigUint64(0).toString(16).padStart(16, '0');
}

export function encode(value: unknown, at = '$'): unknown {
  if (value === null) return null;
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return { $f64: f64Hex(value) };
  if (typeof value !== 'object') throw new TypeError(`cannot encode ${typeof value} at ${at}`);
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { $typed: value.constructor.name, hex: Buffer.from(bytes).toString('hex') };
  }
  if (Array.isArray(value)) return value.map((item, i) => encode(item, `${at}[${i}]`));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!TIMING_KEYS.has(key))
      out[key] = encode((value as Record<string, unknown>)[key], `${at}.${key}`);
  }
  return out;
}

/** SHA-256 of the encoding: equal exactly when the values are bit-identical in content and shape. */
export const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(encode(value)))
    .digest('hex');
