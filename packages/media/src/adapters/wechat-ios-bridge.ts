/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Bounded iOS WeChat playback recovery, used only after a native video.play() rejected with NotAllowedError: one
// WeixinJSBridge getNetworkType invoke whose callback calls video.play() synchronously for the current element.
// getNetworkType is a compatibility workaround, not a documented media-authorization API. No retries,
// no polling: a single operation bounded by one timer, cancellable at any time.
//
// Host objects (document, window, bridge, video) may run arbitrary code on property reads and calls, including
// cancelling this operation. Every host read is followed by a liveness check before the next external call, and any
// host fault ends the operation as 'failed' without an error, so the caller keeps the original native denial.

import type { PlaybackRecovery, RecoveryAttempt, RecoveryOutcome } from '../playback-recovery.ts';

export const WECHAT_BRIDGE_TIMEOUT_MS = 1500;
const BRIDGE_METHOD = 'getNetworkType';

interface HostTarget {
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}
interface HostDocument extends HostTarget {
  readonly hidden?: boolean;
  readonly visibilityState?: string;
  readonly defaultView?: HostWindow | null;
}
interface HostWindow extends HostTarget {
  readonly navigator?: { readonly userAgent?: string };
  readonly WeixinJSBridge?: {
    invoke?(method: string, params: object, callback: () => void): void;
  };
}

/** iOS WeChat only, judged from the video's own window; never from globals. */
export function isWechatIosVideo(video: HTMLVideoElement): boolean {
  try {
    const ua = (video?.ownerDocument as unknown as HostDocument | null)?.defaultView?.navigator
      ?.userAgent;
    return (
      typeof ua === 'string' && /\b(?:iPhone|iPad|iPod)\b/.test(ua) && /MicroMessenger/i.test(ua)
    );
  } catch {
    return false;
  }
}

function prepareBridgePlay(
  video: HTMLVideoElement,
  isLive: () => boolean,
  timeoutMs = WECHAT_BRIDGE_TIMEOUT_MS,
): RecoveryAttempt {
  let doc: HostDocument | null | undefined;
  let win: HostWindow | null | undefined;
  let isStarted = false;
  let isSettled = false;
  let isInvoked = false;
  let isCalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveResult: (outcome: RecoveryOutcome) => void = () => {};
  const result = new Promise<RecoveryOutcome>((resolve) => {
    resolveResult = resolve;
  });
  const undo: (() => void)[] = [];
  const isHidden = (): boolean => doc?.hidden === true || doc?.visibilityState === 'hidden';
  const live = (): boolean => {
    try {
      return !isSettled && Boolean(isLive()) && !isHidden();
    } catch {
      return false;
    }
  };
  const finish = (outcome: RecoveryOutcome): void => {
    if (isSettled) return;
    isSettled = true;
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
    for (const fn of undo.splice(0)) {
      try {
        fn();
      } catch {
        // Listener removal must not leak.
      }
    }
    resolveResult(outcome);
  };
  const listen = (
    target: HostTarget | null | undefined,
    name: string,
    handler: () => void,
  ): void => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(name, handler);
    if (isSettled) {
      // Cancelled by the registration itself.
      target.removeEventListener?.(name, handler);
      return;
    }
    undo.push(() => target.removeEventListener?.(name, handler));
  };

  const onCallback = (): void => {
    // A duplicate or late callback never plays.
    if (isCalled || isSettled) return;
    if (!live()) return finish({ status: 'cancelled' });
    isCalled = true;
    // An issued play() is not a load failure.
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
    let play: HTMLVideoElement['play'];
    try {
      play = video.play;
    } catch {
      return finish({ status: 'failed' });
    }
    if (!live()) return finish({ status: 'cancelled' });
    let pending: Promise<unknown>;
    try {
      // Same stack as the host callback.
      pending = Promise.resolve(play.call(video));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => finish({ status: 'played' }),
      (error: unknown) => finish({ status: 'failed', error }),
    );
  };
  const tryInvoke = (): void => {
    if (isSettled || isInvoked) return;
    if (!live()) return finish({ status: 'cancelled' });
    let bridge: HostWindow['WeixinJSBridge'];
    let invoke: unknown;
    try {
      bridge = win?.WeixinJSBridge;
      invoke = bridge?.invoke;
    } catch {
      return finish({ status: 'failed' });
    }
    if (!bridge || typeof invoke !== 'function') return;
    if (!live()) return finish({ status: 'cancelled' });
    isInvoked = true;
    try {
      (invoke as NonNullable<typeof bridge.invoke>).call(bridge, BRIDGE_METHOD, {}, onCallback);
    } catch {
      // Bridge faults keep the native NotAllowed outcome.
      if (!isCalled) finish({ status: 'failed' });
    }
  };
  const onReady = (): void => {
    try {
      tryInvoke();
    } catch {
      finish({ status: 'failed' });
    }
  };

  return {
    result,
    start() {
      if (isStarted || isSettled) return;
      isStarted = true;
      try {
        doc = video.ownerDocument as unknown as HostDocument | null;
        win = doc?.defaultView;
        if (!live()) return finish({ status: 'cancelled' });
        listen(doc, 'WeixinJSBridgeReady', onReady);
        listen(doc, 'visibilitychange', () => {
          if (isHidden()) finish({ status: 'cancelled' });
        });
        listen(win, 'pagehide', () => finish({ status: 'cancelled' }));
        if (!isSettled) {
          timer = globalThis.setTimeout(() => {
            timer = null;
            finish({ status: 'failed' });
          }, timeoutMs);
        }
        tryInvoke();
      } catch {
        finish({ status: 'failed' });
      }
    },
    cancel() {
      finish({ status: 'cancelled' });
    },
  };
}

/** The default playback recovery: the WeChat bridge on iOS WeChat. */
export const wechatIosBridgeRecovery: PlaybackRecovery = Object.freeze({
  id: 'wechat-bridge',
  isApplicable: isWechatIosVideo,
  prepare: (video: HTMLVideoElement, isLive: () => boolean) => prepareBridgePlay(video, isLive),
});

export const DEFAULT_PLAYBACK_RECOVERIES: readonly PlaybackRecovery[] = Object.freeze([
  wechatIosBridgeRecovery,
]);
