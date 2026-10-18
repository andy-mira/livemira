/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import { EngineError, type FrameImage } from '@livemira/contracts';

type ImageOf<F extends FrameImage['format']> = ReturnType<
  Extract<FrameImage, { format: F }>['data']
>;

/**
 * Owns one picture. `release` runs `close` exactly once (later calls do nothing); `data` throws after release.
 * Borrowers must finish all work on the picture, including GPU work, before the owner releases it.
 */
export function createOwnedImage<F extends FrameImage['format']>(
  format: F,
  value: ImageOf<F>,
  close: () => void = () => (value as { close?: () => void }).close?.(),
): Extract<FrameImage, { format: F }> {
  let isReleased = false;
  const image = {
    format,
    get isReleased() {
      return isReleased;
    },
    data() {
      if (isReleased)
        throw new EngineError('RESOURCE_FAILED', 'Image has been released', {
          isRecoverable: false,
        });
      return value;
    },
    release() {
      if (isReleased) return;
      isReleased = true;
      close();
    },
  };
  return image as unknown as Extract<FrameImage, { format: F }>;
}
