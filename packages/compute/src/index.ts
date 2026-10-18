/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/compute. Only re-exports belong here.
export { MAX_GRAY_PIXELS, rgbaToGray, type GrayPixels } from './gray/rgba-to-gray.ts';
export {
  DESCRIPTOR_BYTES,
  EXACT_MATCHING_VERSION,
  MAX_DESCRIPTORS,
  matchHammingReference,
  type MatchPair,
} from './matching/hamming-reference.ts';
export {
  createWasmMatchOperator,
  selectWasmExactMatcher,
  WASM_MATCHER_VARIANTS,
  WasmExactMatcher,
  type ExactMatchOperator,
  type ExactMatchRequest,
  type ResidentTarget,
  type TargetMatches,
  type WasmMatchBatch,
  type WasmMatcherAttempt,
  type WasmMatcherDiagnostics,
  type WasmMatcherSelection,
  type WasmMatcherSelectionOptions,
  type WasmMatcherVariant,
  type WebAssemblyApi,
} from './matching/wasm-exact-matcher.ts';
export {
  SOURCE_TOO_LARGE,
  STANDARD_MAX_EDGE,
  STANDARD_MAX_PIXELS,
  STANDARD_TOO_LARGE,
  standardize,
  type GrayConversion,
  type PrepareStages,
  type StandardizeInput,
  type TransferredImage,
} from './standard-image/standardize.ts';
export {
  StandardImageWorkspace,
  type Surface,
  type SurfaceFactory,
} from './standard-image/workspace.ts';
