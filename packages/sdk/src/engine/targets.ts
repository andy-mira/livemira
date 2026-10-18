/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Target preparation for hosts: image files are decoded and compiled in a short-lived Worker, never on the UI thread.

import { EngineError, type TargetBundle } from '@livemira/contracts';

import { defaultWorkerFactory } from '../worker/embedded-worker.ts';
import { VisionClient, type WorkerEndpoint } from '../worker/vision-client.ts';

export interface CompileImageOptions {
  readonly targetId: string;
  /** Long edge the image is scaled to before compiling; default 640. */
  readonly maxEdgePx?: number;
  readonly signal?: AbortSignal;
  /** Default: the engine's embedded Worker. */
  readonly workerFactory?: () => Worker | WorkerEndpoint;
}

/** Decodes and compiles an image file (PNG, JPEG, WebP, …) into a target bundle in a short-lived Worker. */
export async function compileTargetImage(
  image: Blob,
  options: CompileImageOptions,
): Promise<TargetBundle> {
  if (!(image instanceof Blob))
    throw new EngineError('INVALID_TARGET', 'An image file is required', { isRecoverable: false });
  const maxEdgePx = options.maxEdgePx ?? 640;
  if (!Number.isInteger(maxEdgePx) || maxEdgePx < 32 || maxEdgePx > 4096)
    throw new EngineError('INVALID_CONFIG', 'maxEdgePx must be an integer in 32..4096', {
      isRecoverable: false,
    });
  const client = new VisionClient({
    workerFactory:
      (options.workerFactory as (() => WorkerEndpoint) | undefined) ?? defaultWorkerFactory(),
  });
  try {
    return await client.compileEncodedImage(
      await image.arrayBuffer(),
      options.targetId,
      maxEdgePx,
      options.signal,
    );
  } finally {
    await client.dispose();
  }
}
