// SPDX-License-Identifier: Apache-2.0
// The page side: one rating Worker, started on the first request and closed when idle. The release embeds the Worker
// script as text and starts it from a `blob:` URL; a page whose CSP forbids that passes the Worker file's URL.

import { decodePictureOnPage, PictureError } from '@livemira-next/web/picture';

import type { RateImageOptions, RateOptions, TargetRating } from './api.ts';
import { RatingError } from './errors.ts';
import type { FromRater, ToRater } from './worker.ts';

declare const __LIVEMIRA_RATING_WORKER_CODE__: string | undefined;

/** The Worker is closed this long after the last rating. */
const IDLE_MS = 4000;

type Request = Omit<ToRater, 'id'>;

interface Job {
  readonly id: number;
  readonly request: Request;
  readonly resolve: (rating: TargetRating) => void;
  readonly reject: (error: RatingError) => void;
}

let blobUrl: string | null = null;

function embeddedUrl(): string {
  if (blobUrl) return blobUrl;
  if (typeof __LIVEMIRA_RATING_WORKER_CODE__ !== 'string')
    throw new RatingError('INVALID_INPUT', 'This build has no embedded Worker: pass `workerUrl`');
  blobUrl = URL.createObjectURL(new Blob([__LIVEMIRA_RATING_WORKER_CODE__], { type: 'text/javascript' }));
  return blobUrl;
}

class Rater {
  private worker: Worker | null = null;
  private readonly queue: Job[] = [];
  private current: Job | null = null;
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly workerUrl: string | URL | undefined;

  constructor(workerUrl: string | URL | undefined) {
    this.workerUrl = workerUrl;
  }

  run(request: Request, signal?: AbortSignal): Promise<TargetRating> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new RatingError('ABORTED', 'Rating aborted'));
      const job: Job = { id: this.nextId++, request, resolve, reject };
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.queue.indexOf(job);
          if (i >= 0) this.queue.splice(i, 1);
          // A running rating finishes in the Worker; its answer is ignored.
          if (this.current === job) {
            this.current = null;
            this.pump();
          }
          reject(new RatingError('ABORTED', 'Rating aborted'));
        },
        { once: true },
      );
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.current) return;
    const job = this.queue.shift();
    if (!job) {
      this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
      return;
    }
    try {
      this.worker ??= this.spawn();
    } catch (error) {
      for (const j of [job, ...this.queue.splice(0)])
        j.reject(error instanceof RatingError ? error : new RatingError('WORKER_FAILED', String(error)));
      return;
    }
    this.current = job;
    this.worker.postMessage({ ...job.request, id: job.id } satisfies ToRater);
  }

  private spawn(): Worker {
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl ?? embeddedUrl(), { name: 'LiveMira rating' });
    } catch (cause) {
      if (cause instanceof RatingError) throw cause;
      throw new RatingError('WORKER_FAILED', 'Cannot start the rating Worker (a CSP may forbid blob: Workers)', {
        cause,
      });
    }
    worker.onmessage = (event: MessageEvent<FromRater>) => void this.answer(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      worker.terminate();
      if (this.worker === worker) this.worker = null;
      const job = this.current;
      this.current = null;
      job?.reject(new RatingError('WORKER_FAILED', `The rating Worker failed: ${event.message}`));
      this.pump();
    };
    return worker;
  }

  private async answer(m: FromRater): Promise<void> {
    const job = this.current;
    if (!job || job.id !== m.id) return;
    if (m.type === 'need-gray') {
      // This Worker cannot draw pictures: decode on the page and send the gray pixels.
      try {
        const gray = await decodePictureOnPage(job.request.image!, job.request.maxEdgePx);
        if (this.current !== job) return;
        this.worker!.postMessage({ ...job.request, id: job.id, image: null, gray } satisfies ToRater, [gray.data]);
      } catch (error) {
        this.current = null;
        job.reject(
          error instanceof PictureError
            ? new RatingError(error.code, error.message, { cause: error.cause })
            : new RatingError('DECODE_FAILED', String(error)),
        );
        this.pump();
      }
      return;
    }
    this.current = null;
    if (m.type === 'rated') job.resolve(Object.freeze(m.rating));
    else job.reject(new RatingError(m.code, m.message));
    this.pump();
  }

  private close(): void {
    this.idleTimer = null;
    this.worker?.terminate();
    this.worker = null;
  }
}

const raters = new Map<string, Rater>();
const raterFor = (workerUrl: string | URL | undefined): Rater => {
  const key = workerUrl ? String(workerUrl) : '';
  let rater = raters.get(key);
  if (!rater) raters.set(key, (rater = new Rater(workerUrl)));
  return rater;
};

/**
 * Rates a picture file (JPEG, PNG, WebP, …; its own orientation applied) as a target: it is decoded and compiled as
 * the engine's `compileTargetImage` would, in a Worker. Rejects with `UNSUITABLE_TARGET` for a picture the engine
 * would refuse (too small, too little detail).
 */
export function rateTargetImage(image: Blob, options: RateImageOptions = {}): Promise<TargetRating> {
  if (!(typeof Blob !== 'undefined' && image instanceof Blob))
    return Promise.reject(new RatingError('INVALID_INPUT', 'rateTargetImage needs a Blob or File'));
  const maxEdgePx = options.maxEdgePx ?? 640;
  if (!Number.isInteger(maxEdgePx) || maxEdgePx < 64 || maxEdgePx > 2048)
    return Promise.reject(new RatingError('INVALID_INPUT', 'maxEdgePx must be an integer 64..2048'));
  if (image.size === 0) return Promise.reject(new RatingError('DECODE_FAILED', 'The picture file is empty'));
  return raterFor(options.workerUrl).run({ type: 'rate', maxEdgePx, image, gray: null, bytes: null }, options.signal);
}

/** Rates an already compiled target: the engine's target bundle (`compileTargetImage`, `parseTarget`) or its bytes. */
export function rateTarget(
  target: { readonly bytes: Uint8Array } | Uint8Array,
  options: RateOptions = {},
): Promise<TargetRating> {
  const bytes = target instanceof Uint8Array ? target : target?.bytes;
  if (!(bytes instanceof Uint8Array))
    return Promise.reject(new RatingError('INVALID_INPUT', 'rateTarget needs a target bundle or its bytes'));
  return raterFor(options.workerUrl).run(
    { type: 'rate', maxEdgePx: 640, image: null, gray: null, bytes: bytes.slice().buffer as ArrayBuffer },
    options.signal,
  );
}
