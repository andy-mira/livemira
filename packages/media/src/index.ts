/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/media. Only re-exports belong here.
export {
  PRESENTATION_FAILURE_REASONS,
  type MediaConfig,
  type MediaPresentationTelemetry,
  type MediaSnapshot,
  type MediaState,
  type PresentableFrame,
  type PresentableSignal,
  type PresentationFailureReason,
  type VideoSessionEvent,
  type VideoSnapshot,
} from './media-types.ts';
export {
  findRecovery,
  type PlaybackRecovery,
  type RecoveryAttempt,
  type RecoveryOutcome,
} from './playback-recovery.ts';
export {
  DEFAULT_PLAYBACK_RECOVERIES,
  isWechatIosVideo,
  WECHAT_BRIDGE_TIMEOUT_MS,
  wechatIosBridgeRecovery,
} from './adapters/wechat-ios-bridge.ts';
export { VideoSession, validateMediaConfig, type VideoSessionOptions } from './video-session.ts';
