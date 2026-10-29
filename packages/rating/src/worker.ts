// SPDX-License-Identifier: Apache-2.0
// The rating Worker: a picture is decoded and compiled exactly as the engine compiles it (@livemira-next/web/picture),
// then rated; target bytes are rated as they are. One request at a time.

import type { GrayImage } from '@livemira-next/contracts';
import { canDrawPictures, compilePicture, decodePicture, PictureError } from '@livemira-next/web/picture';

import type { RatingErrorCode, TargetRating } from './api.ts';
import { rateCompiledTarget } from './rating.ts';

export type ToRater = {
  readonly type: 'rate';
  readonly id: number;
  readonly maxEdgePx: number;
  /** A picture file, gray pixels the page decoded (when this Worker cannot draw), or compiled target bytes. */
  readonly image: Blob | null;
  readonly gray: { readonly width: number; readonly height: number; readonly data: ArrayBuffer } | null;
  readonly bytes: ArrayBuffer | null;
};

export type FromRater =
  | { readonly type: 'rated'; readonly id: number; readonly rating: TargetRating }
  | { readonly type: 'failed'; readonly id: number; readonly code: RatingErrorCode; readonly message: string }
  /** This Worker has no 2D OffscreenCanvas: the page decodes and sends gray pixels instead. */
  | { readonly type: 'need-gray'; readonly id: number };

interface RaterScope {
  postMessage(message: FromRater, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToRater>) => void): void;
}

/** A request the Worker refuses, with its code. */
class Failure extends Error {
  readonly code: RatingErrorCode;
  constructor(code: RatingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

async function bytesOf(m: ToRater): Promise<Uint8Array | null> {
  if (m.bytes) return new Uint8Array(m.bytes);
  let image: GrayImage;
  if (m.gray)
    image = { width: m.gray.width, height: m.gray.height, stride: m.gray.width, data: new Uint8Array(m.gray.data) };
  else if (!canDrawPictures()) return null;
  else image = await decodePicture(m.image!, m.maxEdgePx);
  return (await compilePicture('rated', image)).bytes;
}

export function startRater(scope: RaterScope): void {
  let queue: Promise<void> = Promise.resolve();
  scope.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type !== 'rate') return;
    queue = queue.then(async () => {
      try {
        const bytes = await bytesOf(m);
        if (!bytes) {
          scope.postMessage({ type: 'need-gray', id: m.id });
          return;
        }
        let rating: TargetRating;
        try {
          rating = await rateCompiledTarget(bytes);
        } catch (error) {
          if (!m.bytes) throw error;
          throw new Failure('INVALID_TARGET', error instanceof Error ? error.message : String(error));
        }
        scope.postMessage({ type: 'rated', id: m.id, rating }, [rating.points.buffer as ArrayBuffer]);
      } catch (error) {
        scope.postMessage({
          type: 'failed',
          id: m.id,
          code: error instanceof PictureError || error instanceof Failure ? error.code : 'WORKER_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
}
