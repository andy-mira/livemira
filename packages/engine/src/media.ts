// SPDX-License-Identifier: Apache-2.0
// One target's video: a muted inline <video> under the drawing canvas, played only while its photo is in view. Its
// frames are uploaded to a texture by the renderer when new ones arrive. A URL is left to the browser: it fetches the
// file in ranges and starts playing as soon as enough has arrived. Autoplay refusals become 'blocked' (with one WeChat
// bridge retry on iOS WeChat); a tap then retries.

import type { MediaState, TargetMedia } from './api.ts';

type VideoWithCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?(callback: () => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

interface WeixinBridge {
  invoke(name: string, args: object, callback: () => void): void;
}

const MEDIA_ERROR_CODES: Readonly<Record<number, string>> = {
  1: 'aborted',
  2: 'network',
  3: 'decode',
  4: 'unsupported',
};

/**
 * The file with a video type. Servers that send `application/octet-stream` (or nothing) leave a Blob that some
 * browsers (WebKit) will not play; the container is recognised from its first bytes instead.
 */
export async function withVideoType(file: Blob): Promise<Blob> {
  if (/^video\//.test(file.type)) return file;
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number): string => String.fromCharCode(...head.subarray(from, to));
  let type = '';
  if (ascii(4, 8) === 'ftyp') type = ascii(8, 10) === 'qt' ? 'video/quicktime' : 'video/mp4';
  else if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) type = 'video/webm';
  return type ? new Blob([file], { type }) : file;
}

export class MediaPlayer {
  readonly video: VideoWithCallbacks;
  private stateValue: MediaState = 'loading';
  /** Frames have reached the screen since the last `play()`. */
  private flowing = false;
  /** A new video frame is ready to upload. */
  frameDirty = true;
  private objectUrl: string | null = null;
  private frameHandle = 0;
  private wantsPlay = false;
  /** The browser waits for more data while playback is wanted (its 'waiting' event, until 'playing'). */
  isBuffering = false;
  private disposed = false;
  private readonly onState: (state: MediaState, code?: string) => void;

  constructor(
    parent: HTMLElement,
    media: TargetMedia,
    isMuted: boolean,
    onState: (state: MediaState, code?: string) => void,
  ) {
    this.onState = onState;
    const video = parent.ownerDocument.createElement('video') as VideoWithCallbacks;
    video.muted = isMuted;
    video.defaultMuted = isMuted;
    video.loop = media.isLooping ?? true;
    video.playsInline = true;
    video.preload = 'auto';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('aria-hidden', 'true');
    if (media.url) video.crossOrigin = media.crossOrigin ?? 'anonymous';
    Object.assign(video.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      zIndex: '0',
      pointerEvents: 'none',
    });
    this.video = video;
    video.addEventListener('loadeddata', () => {
      if (this.stateValue === 'loading') this.set('ready');
    });
    video.addEventListener('error', () => {
      const code = MEDIA_ERROR_CODES[video.error?.code ?? 0] ?? 'unknown';
      this.set('error', code);
    });
    video.addEventListener('playing', () => {
      this.isBuffering = false;
      if (!this.disposed && this.wantsPlay) this.set('playing');
    });
    video.addEventListener('waiting', () => {
      this.isBuffering = this.wantsPlay;
    });
    parent.append(video);
    this.watchFrames();
    if (media.url) this.load(media.url);
    else
      void withVideoType(media.file!).then(
        (file) => {
          if (this.disposed) return;
          this.objectUrl = URL.createObjectURL(file);
          this.load(this.objectUrl);
        },
        () => this.set('error', 'unknown'),
      );
  }

  private load(src: string): void {
    this.video.src = src;
    this.video.load();
    // A play() asked for before the source was set.
    if (this.wantsPlay) void this.play();
  }

  get state(): MediaState {
    return this.stateValue;
  }

  /** Playing, with frames on screen. */
  get isFlowing(): boolean {
    return this.stateValue === 'playing' && this.flowing;
  }

  get aspect(): number {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 0;
  }

  get hasPicture(): boolean {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  private set(state: MediaState, code?: string): void {
    if (this.disposed || this.stateValue === state) return;
    this.stateValue = state;
    this.onState(state, code);
  }

  private watchFrames(): void {
    const video = this.video;
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = (): void => {
        if (this.disposed) return;
        this.frameDirty = true;
        if (this.wantsPlay) this.flowing = true;
        this.frameHandle = video.requestVideoFrameCallback!(onFrame);
      };
      this.frameHandle = video.requestVideoFrameCallback(onFrame);
    } else {
      // No frame callbacks: upload every draw, and count time moving as frames flowing.
      video.addEventListener('timeupdate', () => {
        this.frameDirty = true;
        if (this.wantsPlay && video.currentTime > 0) this.flowing = true;
      });
    }
  }

  /** Starts (or resumes) playback; the state tells how it went. */
  async play(): Promise<void> {
    if (this.disposed || this.stateValue === 'error' || (this.wantsPlay && this.stateValue === 'playing')) return;
    this.wantsPlay = true;
    this.flowing = false;
    // No source yet (its type is being recognised): `load()` plays once it is set.
    if (!this.video.getAttribute('src')) return;
    try {
      await this.video.play();
      if (!this.disposed && this.wantsPlay) this.set('playing');
    } catch (cause) {
      if (this.disposed || !this.wantsPlay) return;
      if ((cause as { name?: string }).name === 'NotAllowedError') {
        this.set('blocked');
        this.retryThroughWeChat();
      } else if ((cause as { name?: string }).name !== 'AbortError') this.set('error', 'unknown');
    }
  }

  pause(): void {
    this.wantsPlay = false;
    this.flowing = false;
    this.isBuffering = false;
    if (!this.video.paused) this.video.pause();
    if (this.stateValue === 'playing' || this.stateValue === 'blocked') this.set('paused');
  }

  /** iOS WeChat lets a video start from its bridge's callback; tried once per refusal. */
  private retryThroughWeChat(): void {
    if (typeof navigator === 'undefined' || !/MicroMessenger/i.test(navigator.userAgent)) return;
    const again = (): void => {
      if (!this.disposed && this.wantsPlay && this.stateValue === 'blocked') void this.play();
    };
    const bridge = (globalThis as { WeixinJSBridge?: WeixinBridge }).WeixinJSBridge;
    if (bridge) bridge.invoke('getNetworkType', {}, again);
    else this.video.ownerDocument.addEventListener('WeixinJSBridgeReady', again, { once: true });
  }

  setMuted(isMuted: boolean): void {
    this.video.muted = isMuted;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wantsPlay = false;
    if (this.frameHandle) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
