/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/renderer. Only re-exports belong here.
export {
  OverlayRenderer,
  type OverlayRendererOptions,
  type RendererDiagnostics,
} from './overlay-renderer.ts';
export type {
  MediaOptions,
  RendererEvent,
  RendererEventContext,
  TargetMediaSource,
  TargetSize,
} from './renderer-types.ts';
export { MAX_LOSS_DISPLAY_GRACE_MS } from './loss-hold.ts';
export {
  REDUCED_REVEAL_MS,
  REVEAL_DEFAULTS,
  PlanePresentation,
  resolveRevealOptions,
  type PresentationPhase,
  type ResolvedRevealOptions,
  type RevealOptions,
} from './reveal/plane-presentation.ts';
export {
  cssMatrix,
  homographyFromCorners,
  mediaRect,
  multiply,
  project,
  validatePlane,
} from './plane/perspective.ts';
export { VideoPlane } from './plane/video-plane.ts';
