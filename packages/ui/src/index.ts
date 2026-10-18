/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Public entry of @livemira/ui. Only re-exports belong here.
export { mountArCamera, type ArCameraHandle } from './camera.ts';
export {
  createTranslator,
  DEFAULT_LOCALE,
  EN,
  resolveLocale,
  ZH_CN,
  type ArMessage,
  type ArMessages,
  type Translator,
  type TranslatorOptions,
} from './messages.ts';
export { createArSession } from './session.ts';
export type {
  ArClassifyError,
  ArEngineOptions,
  ArErrorClassification,
  ArErrorPhase,
  ArLoadMedia,
  ArMediaKind,
  ArNotice,
  ArObservation,
  ArPhase,
  ArSession,
  ArSessionOptions,
  ArState,
  ArStopOptions,
  ArTarget,
  ArVideoOptions,
  ArView,
  EngineModule,
} from './types.ts';
export {
  mountArView,
  type ArSessionLike,
  type ArViewHandle,
  type ArViewOptions,
  type ArViewUpdate,
} from './view.ts';
