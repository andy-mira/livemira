// SPDX-License-Identifier: Apache-2.0
// The compiler role: a photo becomes a target (@livemira-next/web/picture), off the page's thread.

import type { GrayImage } from '@livemira-next/contracts';
import { canDrawPictures, compilePicture, decodePicture, PictureError } from '@livemira-next/web/picture';

import type { ErrorCode } from './api.ts';

export type ToCompiler = {
  readonly type: 'compile';
  readonly id: number;
  readonly targetId: string;
  readonly maxEdgePx: number;
  /** A picture file, or gray pixels the page decoded (when this Worker cannot draw). */
  readonly image: Blob | null;
  readonly gray: { readonly width: number; readonly height: number; readonly data: ArrayBuffer } | null;
};

export type FromCompiler =
  | {
      readonly type: 'compiled';
      readonly id: number;
      readonly bytes: ArrayBuffer;
      readonly widthPx: number;
      readonly heightPx: number;
      readonly pointCount: number;
    }
  | { readonly type: 'failed'; readonly id: number; readonly code: ErrorCode; readonly message: string }
  /** This Worker has no 2D OffscreenCanvas: the page decodes and sends gray pixels instead. */
  | { readonly type: 'need-gray'; readonly id: number };

interface CompilerScope {
  postMessage(message: FromCompiler, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToCompiler>) => void): void;
}

/** Installs the compiler role on `scope` (a Worker's global scope). Requests are handled one at a time. */
export function startCompiler(scope: CompilerScope): void {
  let queue: Promise<void> = Promise.resolve();
  scope.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type !== 'compile') return;
    queue = queue.then(async () => {
      try {
        let image: GrayImage;
        if (m.gray)
          image = {
            width: m.gray.width,
            height: m.gray.height,
            stride: m.gray.width,
            data: new Uint8Array(m.gray.data),
          };
        else if (!canDrawPictures()) {
          scope.postMessage({ type: 'need-gray', id: m.id });
          return;
        } else image = await decodePicture(m.image!, m.maxEdgePx);
        const { bytes, pointCount } = await compilePicture(m.targetId, image);
        const buffer = bytes.buffer as ArrayBuffer;
        scope.postMessage(
          { type: 'compiled', id: m.id, bytes: buffer, widthPx: image.width, heightPx: image.height, pointCount },
          [buffer],
        );
      } catch (error) {
        scope.postMessage({
          type: 'failed',
          id: m.id,
          code: error instanceof PictureError ? error.code : 'INVALID_TARGET',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}
