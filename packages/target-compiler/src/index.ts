/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/target-compiler. Only re-exports belong here.
export { compileGrayTarget, type CompileOptions } from './compile.ts';
export { MAX_SERIALIZED_BYTES, parseTarget, serializeTarget } from './serialize.ts';
