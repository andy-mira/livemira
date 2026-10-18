/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// A scripted browser for camera tests: elements with recorded styles, a container, window and orientation events,
// a camera stream whose video reports new frames on demand, VideoFrame, ImageBitmap, 2D canvases, animation frames,
// intervals and a clock.

import type { CameraEnvironment } from '@livemira/camera';

type Listener = (...args: unknown[]) => void;

class Listeners {
  private readonly map = new Map<string, Set<Listener>>();
  readonly add = (type: string, fn: Listener): void => {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(fn);
  };
  readonly remove = (type: string, fn: Listener): void => void this.map.get(type)?.delete(fn);
  fire(type: string, ...args: unknown[]): void {
    for (const fn of [...(this.map.get(type) ?? [])]) fn(...args);
  }
  get size(): number {
    let n = 0;
    for (const set of this.map.values()) n += set.size;
    return n;
  }
}

export interface FakeElement {
  readonly tag: string;
  readonly ownerDocument: unknown;
  readonly style: Record<string, string>;
  readonly children: FakeElement[];
  parent: FakeElement | null;
  width: number;
  height: number;
  setAttribute(name: string, value: string): void;
  appendChild(child: FakeElement): FakeElement;
  remove(): void;
  getContext?(type: string, options?: unknown): unknown;
}

export interface FakeVideo extends FakeElement {
  videoWidth: number;
  videoHeight: number;
  currentTime: number;
  readonly callbacks: Map<number, Listener>;
}

export interface FakeBrowserOptions {
  readonly hasVideoFrame?: boolean;
  readonly videoFrameThrows?: boolean;
  readonly hasImageBitmap?: boolean;
  readonly hasFrameCallback?: boolean;
  readonly previewContext?: boolean;
  readonly drawThrows?: boolean;
  readonly permission?: 'granted' | 'denied';
  /** createImageBitmap waits for releaseBitmaps(). */
  readonly holdBitmaps?: boolean;
  /** The media time never advances; presented frames still do. */
  readonly isMediaTimeFrozen?: boolean;
}

export class FakeBrowser {
  nowMs = 1000;
  presented = 0;
  closedPictures = 0;
  readonly draws: string[] = [];
  readonly constraints: unknown[] = [];
  readonly window = new Listeners();
  readonly document = new Listeners();
  readonly orientation = new Listeners();
  readonly frames = new Map<number, Listener>();
  readonly intervals = new Map<number, Listener>();
  readonly tracks: { stopped: boolean; listeners: Listeners }[] = [];
  readonly container: FakeElement & { getBoundingClientRect(): unknown };
  readonly env: CameraEnvironment;
  video: FakeVideo | null = null;
  getUserMediaCalls = 0;
  private readonly heldBitmaps: (() => void)[] = [];
  private nextId = 1;
  private readonly options: FakeBrowserOptions;
  private readonly doc: Record<string, unknown>;

  constructor(options: FakeBrowserOptions = {}) {
    this.options = options;
    this.doc = {
      hidden: false,
      addEventListener: this.document.add,
      removeEventListener: this.document.remove,
      createElement: (tag: string) => this.createElement(tag),
    };
    this.container = Object.assign(this.element('container'), {
      getBoundingClientRect: () => ({ width: 400, height: 800 }),
    });
    const onClose = (): void => void this.closedPictures++;
    const VideoFrame = class {
      readonly displayWidth: number;
      readonly displayHeight: number;
      constructor(video: { videoWidth: number; videoHeight: number }) {
        if (options.videoFrameThrows) throw new Error('unsupported');
        this.displayWidth = video.videoWidth;
        this.displayHeight = video.videoHeight;
      }
      close(): void {
        onClose();
      }
    };
    const env: Record<string, unknown> = {
      isSecureContext: true,
      performance: { now: () => this.nowMs },
      document: this.doc,
      innerWidth: 400,
      innerHeight: 800,
      devicePixelRatio: 2,
      screen: {
        orientation: {
          angle: 0,
          addEventListener: this.orientation.add,
          removeEventListener: this.orientation.remove,
        },
      },
      addEventListener: this.window.add,
      removeEventListener: this.window.remove,
      requestAnimationFrame: (fn: Listener) => {
        const id = this.nextId++;
        this.frames.set(id, fn);
        return id;
      },
      cancelAnimationFrame: (id: number) => void this.frames.delete(id),
      setInterval: (fn: Listener) => {
        const id = this.nextId++;
        this.intervals.set(id, fn);
        return id;
      },
      clearInterval: (id: number) => void this.intervals.delete(id),
      navigator: {
        mediaDevices: {
          getUserMedia: async (constraints: unknown) => {
            this.getUserMediaCalls++;
            this.constraints.push(constraints);
            if (options.permission === 'denied')
              throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
            const track = {
              stopped: false,
              listeners: new Listeners(),
              stop() {
                track.stopped = true;
              },
              getSettings: () => ({ deviceId: 'cam', width: 1280, height: 720 }),
              addEventListener: (type: string, fn: Listener) => track.listeners.add(type, fn),
              removeEventListener: (type: string, fn: Listener) => track.listeners.remove(type, fn),
            };
            this.tracks.push(track);
            return { getTracks: () => [track], getVideoTracks: () => [track] };
          },
          enumerateDevices: async () => [
            { kind: 'videoinput', deviceId: 'a' },
            { kind: 'audioinput', deviceId: 'b' },
          ],
        },
      },
    };
    if (options.hasVideoFrame !== false) env.VideoFrame = VideoFrame;
    if (options.hasImageBitmap) {
      env.createImageBitmap = async (video: { videoWidth: number; videoHeight: number }) => {
        const picture = {
          width: video.videoWidth,
          height: video.videoHeight,
          close: () => this.closedPictures++,
        };
        if (options.holdBitmaps)
          await new Promise<void>((resolve) => this.heldBitmaps.push(resolve));
        return picture;
      };
    }
    this.env = env as CameraEnvironment;
  }

  private element(tag: string): FakeElement {
    const node: FakeElement = {
      tag,
      ownerDocument: this.doc,
      style: {},
      children: [],
      parent: null,
      width: 300,
      height: 150,
      setAttribute() {},
      appendChild(child) {
        child.parent = node;
        node.children.push(child);
        return child;
      },
      remove() {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
      },
    };
    return node;
  }

  private createElement(tag: string): FakeElement {
    const node = this.element(tag);
    if (tag === 'canvas') {
      node.getContext = (_type, options) => {
        const isPreview = (options as { alpha?: boolean }).alpha === false;
        if (isPreview && this.options.previewContext === false) return null;
        let transform = [1, 0, 0, 1, 0, 0];
        return {
          setTransform: (...m: number[]) => void (transform = m),
          clearRect: () => {},
          drawImage: (_video: unknown, _x: number, _y: number, w?: number, h?: number) => {
            if (isPreview && this.options.drawThrows) throw new Error('draw failed');
            // Drawn at its own size with a transform: the standard readback.
            if (w === undefined) {
              const canvas = node as unknown as { width: number; height: number };
              this.draws.push(`standard:${canvas.width}x${canvas.height}:${transform.join(',')}`);
            } else this.draws.push(`${isPreview ? 'preview' : 'readback'}:${w}x${h}`);
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4),
          }),
        };
      };
    }
    if (tag === 'video') {
      const listeners = new Listeners();
      const callbacks = new Map<number, Listener>();
      const video = Object.assign(node, {
        videoWidth: 720,
        videoHeight: 1280,
        currentTime: 0,
        callbacks,
        listeners,
        play: async () => {},
        pause: () => {},
        addEventListener: listeners.add,
        removeEventListener: listeners.remove,
        getVideoPlaybackQuality: () => ({
          totalVideoFrames: this.presented,
          droppedVideoFrames: 0,
        }),
        getBoundingClientRect: () => ({ width: 400, height: 800 }),
      });
      if (this.options.hasFrameCallback !== false) {
        Object.assign(video, {
          requestVideoFrameCallback: (fn: Listener) => {
            const id = this.nextId++;
            callbacks.set(id, fn);
            return id;
          },
          cancelVideoFrameCallback: (id: number) => void callbacks.delete(id),
        });
      }
      this.video = video;
    }
    return node;
  }

  /** Lets every held createImageBitmap call finish. */
  releaseBitmaps(): void {
    for (const resolve of this.heldBitmaps.splice(0)) resolve();
  }

  /** One new camera frame after `ms`. */
  frame(ms = 33): void {
    this.nowMs += ms;
    this.presented++;
    const video = this.video!;
    const callbacks = video.callbacks;
    const first = [...callbacks][0];
    const mediaTime = this.options.isMediaTimeFrozen ? 1 : this.nowMs / 1000;
    if (first) {
      callbacks.delete(first[0]);
      first[1](0, { mediaTime, presentedFrames: this.presented });
    } else {
      video.currentTime = mediaTime;
      this.flushFrames();
    }
  }

  flushFrames(): void {
    const queued = [...this.frames.values()];
    this.frames.clear();
    for (const fn of queued) fn(this.nowMs);
  }

  advance(ms: number): void {
    this.nowMs += ms;
    for (const fn of [...this.intervals.values()]) fn();
  }

  setHidden(hidden: boolean): void {
    this.doc.hidden = hidden;
    this.document.fire('visibilitychange');
  }

  /** Listeners still attached to the window, orientation and document. */
  attached(): number {
    return this.window.size + this.orientation.size + this.document.size;
  }
}

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
