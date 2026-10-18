/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The whole camera in one call: a session and the default view, both owned by the returned handle.

import { createArSession } from './session.ts';
import type { ArSession, ArSessionOptions } from './types.ts';
import { mountArView, type ArViewHandle, type ArViewOptions } from './view.ts';

export interface ArCameraHandle {
  readonly session: ArSession;
  readonly view: ArViewHandle;
  /** Removes the view, then disposes the session (camera, Worker, videos). Idempotent; calls share one promise. */
  destroy(): Promise<void>;
}

export function mountArCamera(
  container: HTMLElement,
  options: ArSessionOptions & ArViewOptions,
): ArCameraHandle {
  const session = createArSession(options);
  let view: ArViewHandle;
  try {
    view = mountArView(container, session, options);
  } catch (error) {
    void session.dispose();
    throw error;
  }
  let destroying: Promise<void> | null = null;
  return {
    session,
    view,
    destroy() {
      destroying ??= (async () => {
        try {
          view.destroy();
        } finally {
          await session.dispose();
        }
      })();
      return destroying;
    },
  };
}
