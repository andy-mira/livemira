// SPDX-License-Identifier: Apache-2.0
// Targets: compiling photos in a small pool of short-lived Workers, and loading stored target bytes.

import { decodeTarget } from '@livemira-next/features';
import { decodePictureOnPage, PictureError } from '@livemira-next/web/picture';

import type { CompileImageOptions, TargetBundle } from './api.ts';
import type { FromCompiler, ToCompiler } from './compile-worker.ts';
import { EngineError } from './errors.ts';
import { spawnWorker } from './worker-source.ts';

const ID_RULE = /^[A-Za-z0-9_.-]{1,128}$/;

export function isValidTargetId(id: unknown): id is string {
  return typeof id === 'string' && ID_RULE.test(id);
}

function assertTargetId(id: unknown): asserts id is string {
  if (!isValidTargetId(id))
    throw new EngineError('INVALID_TARGET', `Invalid target id ${JSON.stringify(id)}: 1..128 of A–Z a–z 0–9 _ . -`);
}

/** Workers are kept this long after the last compilation, then closed. */
const IDLE_MS = 4000;

type Request = Omit<ToCompiler, 'id'>;
type Answer = Extract<FromCompiler, { type: 'compiled' }>;

interface Job {
  readonly request: Request;
  readonly resolve: (result: Answer) => void;
  readonly reject: (error: EngineError) => void;
  slot: Slot | null;
}

interface Slot {
  readonly worker: Worker;
  job: Job | null;
}

class CompilerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly byId = new Map<number, Job>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly size: number;
  private readonly workerUrl: string | URL | undefined;

  constructor(workerUrl: string | URL | undefined) {
    this.workerUrl = workerUrl;
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    // Leave a core for the page; three Workers already compile ten photos in parallel batches.
    this.size = Math.max(1, Math.min(3, cores - 1));
  }

  run(request: Request, signal?: AbortSignal): Promise<Answer> {
    return new Promise((resolve, reject) => {
      const job: Job = { request, resolve, reject, slot: null };
      if (signal) {
        if (signal.aborted) return reject(new EngineError('ABORTED', 'Compilation aborted'));
        signal.addEventListener(
          'abort',
          () => {
            const i = this.queue.indexOf(job);
            if (i >= 0) this.queue.splice(i, 1);
            // A running job finishes in its Worker; its answer is ignored.
            if (job.slot) {
              job.slot.job = null;
              job.slot = null;
              this.pump();
            }
            reject(new EngineError('ABORTED', 'Compilation aborted'));
          },
          { once: true },
        );
      }
      this.queue.push(job);
      this.pump();
    });
  }

  private pump(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    while (this.queue.length) {
      let slot = this.slots.find((s) => !s.job);
      if (!slot && this.slots.length < this.size) {
        try {
          slot = this.spawn();
        } catch (error) {
          for (const job of this.queue.splice(0))
            job.reject(error instanceof EngineError ? error : new EngineError('WORKER_FAILED', String(error)));
          return;
        }
      }
      if (!slot) break;
      const job = this.queue.shift()!;
      this.assign(slot, job);
    }
    if (!this.queue.length && this.slots.every((s) => !s.job)) this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
  }

  private assign(slot: Slot, job: Job): void {
    const id = this.nextId++;
    slot.job = job;
    job.slot = slot;
    this.byId.set(id, job);
    const message = { ...job.request, id } as ToCompiler;
    slot.worker.postMessage(message);
  }

  private spawn(): Slot {
    const worker = spawnWorker('compiler', this.workerUrl);
    const slot: Slot = { worker, job: null };
    worker.onmessage = (event: MessageEvent<FromCompiler>) => void this.answer(slot, event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      const job = slot.job;
      this.slots.splice(this.slots.indexOf(slot), 1);
      worker.terminate();
      if (job) {
        job.slot = null;
        job.reject(new EngineError('WORKER_FAILED', `The compiler Worker failed: ${event.message}`));
      }
      this.pump();
    };
    this.slots.push(slot);
    return slot;
  }

  private async answer(slot: Slot, m: FromCompiler): Promise<void> {
    const job = this.byId.get(m.id);
    this.byId.delete(m.id);
    if (!job || job.slot !== slot) return this.pump();
    if (m.type === 'need-gray') {
      // This Worker cannot draw pictures: decode on the page and send the gray pixels.
      try {
        const gray = await decodePictureOnPage(job.request.image!, job.request.maxEdgePx);
        if (job.slot !== slot) return this.pump();
        this.byId.set(m.id, job);
        slot.worker.postMessage({ ...job.request, id: m.id, image: null, gray } satisfies ToCompiler, [gray.data]);
      } catch (error) {
        slot.job = null;
        job.slot = null;
        job.reject(
          error instanceof PictureError
            ? new EngineError(error.code, error.message, { cause: error.cause })
            : new EngineError('DECODE_FAILED', String(error)),
        );
        this.pump();
      }
      return;
    }
    slot.job = null;
    job.slot = null;
    if (m.type === 'compiled') job.resolve(m);
    else if (m.type === 'failed') job.reject(new EngineError(m.code, m.message));
    this.pump();
  }

  private close(): void {
    this.idleTimer = null;
    for (const slot of this.slots.splice(0)) slot.worker.terminate();
  }
}

const pools = new Map<string, CompilerPool>();
const poolFor = (workerUrl: string | URL | undefined): CompilerPool => {
  const key = workerUrl ? String(workerUrl) : '';
  let pool = pools.get(key);
  if (!pool) pools.set(key, (pool = new CompilerPool(workerUrl)));
  return pool;
};

/** Decodes and compiles a picture file (JPEG, PNG, WebP, …; its own orientation applied) in a Worker. */
export async function compileTargetImage(image: Blob, options: CompileImageOptions): Promise<TargetBundle> {
  if (!(typeof Blob !== 'undefined' && image instanceof Blob))
    throw new EngineError('INVALID_CONFIG', 'compileTargetImage needs a Blob or File');
  assertTargetId(options?.targetId);
  const maxEdgePx = options.maxEdgePx ?? 640;
  if (!Number.isInteger(maxEdgePx) || maxEdgePx < 64 || maxEdgePx > 2048)
    throw new EngineError('INVALID_CONFIG', 'maxEdgePx must be an integer 64..2048');
  if (image.size === 0) throw new EngineError('DECODE_FAILED', 'The picture file is empty');
  const result = await poolFor(options.workerUrl).run(
    { type: 'compile', targetId: options.targetId, maxEdgePx, image, gray: null },
    options.signal,
  );
  return Object.freeze({
    format: 'livemira-target/2',
    targetId: options.targetId,
    widthPx: result.widthPx,
    heightPx: result.heightPx,
    pointCount: result.pointCount,
    bytes: new Uint8Array(result.bytes),
  });
}

/** Loads stored target bytes; refuses damaged data and targets compiled for another descriptor version. */
export async function parseTarget(bytes: Uint8Array | ArrayBuffer): Promise<TargetBundle> {
  const data = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes.slice(0));
  let asset;
  try {
    asset = await decodeTarget(data);
  } catch (cause) {
    throw new EngineError('INVALID_TARGET', cause instanceof Error ? cause.message : String(cause), { cause });
  }
  const info = asset.compiled.info;
  assertTargetId(info.id);
  return Object.freeze({
    format: 'livemira-target/2',
    targetId: info.id,
    widthPx: info.width,
    heightPx: info.height,
    pointCount: asset.compiled.points.length / 2,
    bytes: data,
  });
}

/** Checks a list of targets for `setTargets`: at most 10, valid bundles, unique ids. */
export function checkTargets(targets: readonly TargetBundle[]): void {
  if (!Array.isArray(targets)) throw new EngineError('INVALID_CONFIG', 'setTargets needs an array');
  if (targets.length > 10) throw new EngineError('INVALID_CONFIG', 'At most 10 targets');
  const ids = new Set<string>();
  for (const t of targets) {
    if (t?.format !== 'livemira-target/2' || !(t.bytes instanceof Uint8Array))
      throw new EngineError('INVALID_TARGET', 'Not a target bundle (use compileTargetImage or parseTarget)');
    assertTargetId(t.targetId);
    if (ids.has(t.targetId)) throw new EngineError('INVALID_CONFIG', `Duplicate target id ${t.targetId}`);
    ids.add(t.targetId);
  }
}
