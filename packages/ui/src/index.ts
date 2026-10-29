// SPDX-License-Identifier: Apache-2.0
// Public entry of the LiveMira camera UI (`@livemira/ui`). It contains no engine: `loadEngine` hands it the engine
// module (for example a dynamic import of the single-file engine).

import type { ArCameraHandle, ArSessionOptions, ArViewOptions } from './api.ts';
import { createArSession } from './session.ts';
import { mountArView } from './view.ts';

export type * from './api.ts';
export { DEFAULT_LOCALE, EN, ZH_CN } from './messages.ts';
export { createArSession, fetchMedia } from './session.ts';
export { createTranslator, resolveLocale } from './translator.ts';
export { mountArView } from './view.ts';

declare const __LIVEMIRA_UI_VERSION__: string | undefined;

export const UI_VERSION: string = typeof __LIVEMIRA_UI_VERSION__ === 'string' ? __LIVEMIRA_UI_VERSION__ : '0.0.0-dev';

/**
 * The camera in one call: a session and the default view in `container`. The run starts once the stage has a size
 * (unless `isAutoStart` is false). `destroy()` removes the view, then stops and disposes everything.
 */
export function mountArCamera(container: HTMLElement, options: ArSessionOptions & ArViewOptions): ArCameraHandle {
  const session = createArSession(options);
  let view;
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
        view.destroy();
        await session.dispose();
      })();
      return destroying;
    },
  };
}
