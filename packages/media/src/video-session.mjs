/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { isWechatIosVideo, createWechatPlaybackRecovery } from './wechat-playback.mjs';

const CANCELLED = Symbol('cancelled');
// The play property read may run host code that cancels this operation; recheck ownership before calling it.
const callPlay = (video, owns) => {
  try {
    const play = video.play;
    if (!owns()) return Promise.resolve(CANCELLED);
    return Promise.resolve(play.call(video));
  } catch (error) { return Promise.reject(error); }
};

// A pending readiness poll must not keep a Node host (tests, tooling) alive; browsers return a number and ignore this.
const unrefTimer = (timer) => { timer?.unref?.(); return timer; };

/** Media owner. No tracking-state inference or automatic network retries. */
export class VideoSession {
  constructor(video, onEvent = () => {}) {
    this.video = video; this.onEvent = onEvent; this.generation = 0;
    this.disposed = false; this.active = false; this.frameCallback = null; this.frameGeneration = 0;
    this.presentableEpoch = 0; this.presentableHandle = null; this.presentableTimer = null;
    this.restoreTime = null;
    this.wechatPlaybackRecovery = 'auto'; this.playOp = null; this.playbackPath = null; this.wechatRecoveryAttempts = 0;
    this.loop = true; this.watchTimer = null; this.watchEpoch = 0; this.recoveryFrames = null; this.watchSignature = null; this.stalledPolls = 0; this.recoveriesSinceProgress = 0; this.loopRecoveries = 0;
    this.onEnded = () => { if (this.active && this.loop && video.ended && this.nearEnd()) this.recoverLoop(); };
    this.onMetadata = () => {
      if(this.active&&this.loop&&this.watchTimer===null)this.watchLoop();
      if(this.restoreTime === null)return;
      const time=this.restoreTime;this.restoreTime=null;
      try{video.currentTime=Number.isFinite(video.duration)?Math.min(time,Math.max(0,video.duration-.001)):time;}catch{/* A nonseekable stream cannot restore time. */}
    };
    this.onError = () => { this.active = false; this.generation++; this.cancelPlayOp(); this.cancelWatch(); this.cancelPresentable(); this.onEvent({ type:'error', code:'MEDIA_LOAD_OR_DECODE', recoverable:true, reason:({1:'media-aborted',2:'media-network-error',3:'media-decode-error',4:'media-source-not-supported'})[video.error?.code] ?? 'media-error' }); };
    video.addEventListener('error', this.onError);
    video.addEventListener('loadedmetadata',this.onMetadata);
    video.addEventListener('ended',this.onEnded);
  }
  configure({ url, muted = true, loop = true, crossOrigin = 'anonymous', resumeBehavior = 'resume', wechatPlaybackRecovery = 'auto' }) {
    if (this.disposed) throw new Error('Media session disposed');
    if (!url || !['resume','restart'].includes(resumeBehavior) || !['auto','off'].includes(wechatPlaybackRecovery)) throw new RangeError('Invalid media configuration');
    this.stop(); this.resumeBehavior = resumeBehavior; this.wechatPlaybackRecovery = wechatPlaybackRecovery; this.playbackPath = null; this.wechatRecoveryAttempts = 0; this.loop = Boolean(loop); this.loopRecoveries = 0; this.recoveriesSinceProgress = 0; this.recoveryFrames = null;
    this.video.muted = muted; this.video.loop = loop; this.video.playsInline = true;
    this.video.defaultMuted = muted;this.video.preload='metadata';
    this.video.crossOrigin = crossOrigin; this.video.src = url; this.video.load();
  }
  async play(restart = true) {
    if (this.disposed) throw new Error('Media session disposed');
    this.cancelPlayOp();
    const generation = ++this.generation; this.active = true;
    const op = { recovery: null, abort: null };
    op.cancelled = new Promise((resolve) => { op.abort = () => resolve(CANCELLED); });
    this.playOp = op;
    // Host property reads/setters and callbacks can cancel this operation synchronously; state is written only while it still owns the session.
    const owns = () => this.playOp === op && generation === this.generation && !this.disposed;
    try {
      let failed = false, error;
      try {
        if (restart && this.resumeBehavior === 'restart') this.video.currentTime = 0;
        if (!owns()) return false;
        this.playbackPath = 'native';
        // Native play() is issued first, in the caller's stack. Cancellation settles this wait; a late rejection is still consumed by the race.
        if (await Promise.race([callPlay(this.video, owns), op.cancelled]) === CANCELLED) return false;
      } catch (e) { failed = true; error = e; }
      if (failed) {
        if (!owns()) return false;
        const eligible = error?.name === 'NotAllowedError' && this.wechatPlaybackRecovery === 'auto' && isWechatIosVideo(this.video);
        // The eligibility reads can run host code; whatever they returned, a cancelled operation must not continue to either path.
        if (!owns()) return false;
        if (eligible) {
          const recovery = createWechatPlaybackRecovery(this.video, { isLive: () => owns() && this.active });
          // Publish for cancellation and count the attempt before any host code runs; nothing is written after start().
          op.recovery = recovery; this.wechatRecoveryAttempts++; this.playbackPath = 'wechat-bridge';
          recovery.start();
          const outcome = await recovery.promise;
          if (outcome.status === 'cancelled') return false;
          if (outcome.status === 'played') failed = false; else if (outcome.error !== undefined) error = outcome.error;
          if (generation !== this.generation || this.disposed) return false;
        }
      }
      if (!failed) {
        // stop/configure already pause the old request; never pause a newer play.
        if (generation !== this.generation || !this.active) return false;
        this.watchLoop();
        return true;
      }
      if (!owns()) return false;
      this.active = false;
      this.onEvent({ type:error?.name === 'NotAllowedError' ? 'playbackBlocked' : 'error', code:error?.name === 'NotAllowedError' ? 'PLAYBACK_BLOCKED' : 'MEDIA_PLAY_FAILED', recoverable:true, reason:error?.name==='NotAllowedError'?'playback-gesture-required':error?.name==='NotSupportedError'?'media-source-not-supported':'media-play-failed' });
      return false;
    } finally {
      // Only clear our own operation; a newer play owns this.playOp.
      if (this.playOp === op) this.playOp = null;
    }
  }
  cancelPlayOp() {
    const op = this.playOp;
    if (!op) return;
    this.playOp = null;
    op.recovery?.cancel(); op.abort();
  }
  /** Call directly within a user gesture after playbackBlocked. */
  resumeFromGesture() { return this.play(false); }
  setMuted(muted) { if(this.disposed)throw new Error('Media session disposed');this.video.muted=Boolean(muted);this.video.defaultMuted=Boolean(muted); }
  retryFromGesture() {
    if(this.disposed)throw new Error('Media session disposed');
    const time=this.video.currentTime;
    this.pause();this.restoreTime=this.resumeBehavior!=='restart'&&Number.isFinite(time)&&time>0?time:null;
    this.video.load();return this.play();
  }
  getDiagnostics() {
    const video=this.video,quality=video.getVideoPlaybackQuality?.();
    return {paused:video.paused,muted:video.muted,playsInline:video.playsInline,currentTime:Number.isFinite(video.currentTime)?video.currentTime:null,duration:Number.isFinite(video.duration)?video.duration:null,readyState:video.readyState,networkState:video.networkState,width:video.videoWidth,height:video.videoHeight,errorCode:video.error?.code??null,decodedFrames:quality?.totalVideoFrames??null,droppedFrames:quality?.droppedVideoFrames??null,loop:Boolean(video.loop),ended:Boolean(video.ended),loopRecoveries:this.loopRecoveries,playbackPath:this.playbackPath,wechatRecoveryAttempts:this.wechatRecoveryAttempts};
  }
  pause() { this.generation++; this.active = false; this.cancelPlayOp(); this.cancelWatch(); this.video.pause(); }
  /**
   * Fallback for browsers whose native loop stalls at the end of a finite clip without an ended event.
   * One timer exists only while playback is active and looping. It acts only near the end after two unchanged polls
   * (currentTime and decoded frames), so slow mid-clip playback is never rewound and play/paused is not progress evidence.
   */
  watchLoop() {
    this.cancelWatch();
    if (this.disposed || !this.active || !this.loop || !Number.isFinite(this.video.duration)) return;
    const generation = this.generation, epoch = ++this.watchEpoch;
    const poll = () => {
      // A cancelled or re-armed watcher must not touch the newer timer reference.
      if (epoch !== this.watchEpoch) return;
      this.watchTimer = null;
      if (this.disposed || !this.active || generation !== this.generation) return;
      const video = this.video, d = video.duration, t = video.currentTime;
      const quality = video.getVideoPlaybackQuality?.();
      const signature = `${t}|${quality?.totalVideoFrames ?? ''}`;
      const nearEnd = this.nearEnd();
      const frames = quality?.totalVideoFrames;
      if (signature !== this.watchSignature) {
        this.watchSignature = signature; this.stalledPolls = 0;
        // A rewind alone is not progress: require decoded frames to advance (or, without the API, time past the rewind point).
        const progressed = this.recoveryFrames === null ? false : Number.isFinite(frames) ? frames > this.recoveryFrames : t > .05;
        if (!nearEnd && progressed) { this.recoveriesSinceProgress = 0; this.recoveryFrames = null; }
      } else if (nearEnd) this.stalledPolls++;
      if (nearEnd && (video.ended || this.stalledPolls >= 2)) { this.recoverLoop(); return; }
      this.watchTimer = globalThis.setTimeout(poll, 400);
    };
    this.watchTimer = globalThis.setTimeout(poll, 400);
  }
  nearEnd() {
    const d = this.video.duration, t = this.video.currentTime;
    return Number.isFinite(d) && d > 0 && Number.isFinite(t) && d - t <= Math.min(.35, d * .2);
  }
  cancelWatch() {
    this.watchEpoch++;
    if (this.watchTimer !== null) globalThis.clearTimeout(this.watchTimer);
    this.watchTimer = null; this.watchSignature = null; this.stalledPolls = 0;
  }
  /** Rewind once and play once; gives up after 3 recoveries without observed progress. Play failures use the normal callback. */
  recoverLoop() {
    this.cancelWatch();
    if (this.disposed || !this.active || !this.loop || this.recoveriesSinceProgress >= 3) return;
    this.recoveriesSinceProgress++; this.loopRecoveries++; this.recoveryFrames = this.video.getVideoPlaybackQuality?.()?.totalVideoFrames ?? 0;
    try { this.video.currentTime = 0; } catch { return; }
    if (this.video.paused || this.video.ended) void this.play(false); else this.watchLoop();
  }
  observeFrames(callback) {
    this.cancelFrames();
    if (this.disposed) throw new Error('Media session disposed');
    if (typeof this.video.requestVideoFrameCallback !== 'function') return false;
    const generation = this.frameGeneration;
    let last = -1;
    const tick = (_now, metadata) => {
      this.frameCallback = null;
      if (this.disposed || generation !== this.frameGeneration) return;
      if (metadata.presentedFrames !== last) { last = metadata.presentedFrames; callback({ presentedFrames:last,mediaTime:metadata.mediaTime }); }
      if (!this.disposed && generation === this.frameGeneration) this.frameCallback = this.video.requestVideoFrameCallback(tick);
    };
    this.frameCallback = this.video.requestVideoFrameCallback(tick);
    return true;
  }
  /**
   * One-shot readiness of the CURRENT media request: calls back once when a decoded picture is actually presentable, never for
   * loadedmetadata/canplay alone. The element must report readyState >= HAVE_CURRENT_DATA, non-zero intrinsic size and no error.
   *  - requestVideoFrameCallback available: the first presented-frame callback that also passes those checks ('video-frame-callback').
   *  - Otherwise a documented conservative fallback ('time-progress'): polled every 100 ms, it needs the same checks, an unpaused element,
   *    currentTime strictly increasing across 2 consecutive polls beyond its value when watching began, and (when getVideoPlaybackQuality
   *    reports a finite count) a higher decoded-frame count than at the start. It can fire up to ~2 polls after the real first frame, never before.
   * Returns the signal in use. A newer call, stop(), configure(), a media error and dispose() cancel it; a cancelled watch never calls back.
   * pause() does not cancel it (a hidden, paused element resumes the same request). Payload: { signal, mediaTime, presentedFrames, decodedFrames }.
   */
  awaitPresentableFrame(callback) {
    if (this.disposed) throw new Error('Media session disposed');
    this.cancelPresentable();
    const video = this.video, epoch = this.presentableEpoch;
    const owns = () => !this.disposed && epoch === this.presentableEpoch;
    const decoded = () => { const n = video.getVideoPlaybackQuality?.()?.totalVideoFrames; return Number.isFinite(n) ? n : null; };
    const hasPicture = () => video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !video.error;
    const finish = (signal, mediaTime, presentedFrames) => {
      if (!owns()) return;
      this.cancelPresentable();
      callback({ signal, mediaTime, presentedFrames, decodedFrames: decoded() });
    };
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick = (_now, metadata) => {
        if (!owns()) return;
        this.presentableHandle = null;
        if (hasPicture()) finish('video-frame-callback', Number.isFinite(metadata?.mediaTime) ? metadata.mediaTime : null, Number.isFinite(metadata?.presentedFrames) ? metadata.presentedFrames : null);
        else if (owns()) this.presentableHandle = video.requestVideoFrameCallback(tick);
      };
      this.presentableHandle = video.requestVideoFrameCallback(tick);
      return 'video-frame-callback';
    }
    const baseTime = Number.isFinite(video.currentTime) ? video.currentTime : 0, baseFrames = decoded();
    let previous = baseTime, streak = 0;
    const poll = () => {
      if (!owns()) return;
      this.presentableTimer = null;
      const t = video.currentTime, advanced = Number.isFinite(t) && t > previous && t > baseTime;
      if (Number.isFinite(t)) previous = Math.max(previous, t);
      streak = hasPicture() && !video.paused && advanced ? streak + 1 : 0;
      const frames = decoded();
      if (streak >= 2 && (baseFrames === null || (frames !== null && frames > baseFrames))) { finish('time-progress', Number.isFinite(t) ? t : null, null); return; }
      if (owns()) this.presentableTimer = unrefTimer(globalThis.setTimeout(poll, 100));
    };
    this.presentableTimer = unrefTimer(globalThis.setTimeout(poll, 100));
    return 'time-progress';
  }
  cancelPresentable() {
    this.presentableEpoch++;
    const handle = this.presentableHandle, timer = this.presentableTimer;
    this.presentableHandle = null; this.presentableTimer = null;
    if (handle !== null) { try { this.video.cancelVideoFrameCallback?.(handle); } catch { /* A stale epoch already ignores the callback. */ } }
    if (timer !== null) globalThis.clearTimeout(timer);
  }
  cancelFrames() {
    this.frameGeneration++;
    if (this.frameCallback !== null) this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback = null;
  }
  stop() {
    this.restoreTime=null;
    this.pause(); this.cancelFrames(); this.cancelPresentable();
    this.video.removeAttribute('src'); this.video.srcObject = null; this.video.load();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stop(); this.video.removeEventListener('error',this.onError);this.video.removeEventListener('loadedmetadata',this.onMetadata);this.video.removeEventListener('ended',this.onEnded);
  }
}
