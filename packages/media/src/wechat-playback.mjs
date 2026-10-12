/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Bounded iOS WeChat playback recovery. Only used after a native video.play() rejected with NotAllowedError.
 * One WeixinJSBridge getNetworkType invoke whose callback calls video.play() synchronously for the current element.
 * getNetworkType is a compatibility trick observed on a phone, not a documented media-authorization API.
 * No retries, no polling: a single operation bounded by one timer, cancellable at any time.
 *
 * Host objects (document, window, bridge, video) may run arbitrary code on property reads and calls, including
 * cancelling this operation. Every host read is followed by a liveness check before the next external call, and any
 * host fault ends the operation as 'failed' without an error, so the caller keeps the original native denial.
 */
export const WECHAT_BRIDGE_TIMEOUT_MS = 1500;
const BRIDGE_METHOD = 'getNetworkType';

/** iOS WeChat only, judged from the video's own window; never from globals. */
export function isWechatIosVideo(video) {
  try {
    const ua = video?.ownerDocument?.defaultView?.navigator?.userAgent;
    return typeof ua === 'string' && /\b(?:iPhone|iPad|iPod)\b/.test(ua) && /MicroMessenger/i.test(ua);
  } catch { return false; }
}

/**
 * Creates the operation without touching any host object, so the caller can publish it (and so make it cancellable)
 * before start() runs code that may call back synchronously.
 * @param video current media element
 * @param options.isLive returns false once this operation is no longer current (checked before every side effect)
 * @returns {{promise:Promise<{status:'played'|'failed'|'cancelled', error?:unknown}>, start():void, cancel():void}}
 *   The promise never rejects. 'played' means play() resolved, not that frames are decoding.
 */
export function createWechatPlaybackRecovery(video, { isLive = () => true, timeoutMs = WECHAT_BRIDGE_TIMEOUT_MS } = {}) {
  let doc, win, started = false, settled = false, invoked = false, called = false, timer = null, resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const undo = [];
  const hidden = () => doc?.hidden === true || doc?.visibilityState === 'hidden';
  const live = () => { try { return !settled && Boolean(isLive()) && !hidden(); } catch { return false; } };
  const finish = (result) => {
    if (settled) return;
    settled = true;
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
    for (const fn of undo.splice(0)) { try { fn(); } catch { /* Listener removal must not leak. */ } }
    resolveResult(result);
  };
  const listen = (target, name, handler) => {
    if (typeof target?.addEventListener !== 'function') return;
    target.addEventListener(name, handler);
    if (settled) { target.removeEventListener(name, handler); return; } // cancelled by the registration itself
    undo.push(() => target.removeEventListener(name, handler));
  };

  const onCallback = () => {
    if (called || settled) return; // duplicate or late callback never plays
    if (!live()) { finish({ status: 'cancelled' }); return; }
    called = true;
    if (timer !== null) { globalThis.clearTimeout(timer); timer = null; } // an issued play() is not a load failure
    let play;
    try { play = video.play; } catch { finish({ status: 'failed' }); return; }
    if (!live()) { finish({ status: 'cancelled' }); return; }
    let pending;
    try { pending = Promise.resolve(play.call(video)); } catch (error) { pending = Promise.reject(error); } // same stack as the host callback
    pending.then(() => finish({ status: 'played' }), (error) => finish({ status: 'failed', error }));
  };
  const tryInvoke = () => {
    if (settled || invoked) return;
    if (!live()) { finish({ status: 'cancelled' }); return; }
    let bridge, invoke;
    try { bridge = win?.WeixinJSBridge; invoke = bridge?.invoke; } catch { finish({ status: 'failed' }); return; }
    if (!bridge || typeof invoke !== 'function') return;
    if (!live()) { finish({ status: 'cancelled' }); return; }
    invoked = true;
    try { invoke.call(bridge, BRIDGE_METHOD, {}, onCallback); }
    catch { if (!called) finish({ status: 'failed' }); } // bridge faults keep the native NotAllowed outcome
  };
  const onReady = () => { try { tryInvoke(); } catch { finish({ status: 'failed' }); } };

  const start = () => {
    if (started || settled) return;
    started = true;
    try {
      doc = video.ownerDocument; win = doc?.defaultView;
      if (!live()) { finish({ status: 'cancelled' }); return; }
      listen(doc, 'WeixinJSBridgeReady', onReady);
      listen(doc, 'visibilitychange', () => { if (hidden()) finish({ status: 'cancelled' }); });
      listen(win, 'pagehide', () => finish({ status: 'cancelled' }));
      if (!settled) timer = globalThis.setTimeout(() => { timer = null; finish({ status: 'failed' }); }, timeoutMs);
      tryInvoke();
    } catch { finish({ status: 'failed' }); }
  };
  return { promise, start, cancel() { finish({ status: 'cancelled' }); } };
}

export function startWechatPlaybackRecovery(video, options) {
  const recovery = createWechatPlaybackRecovery(video, options);
  recovery.start();
  return recovery;
}
