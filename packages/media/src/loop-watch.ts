/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Fallback for browsers whose native loop stalls at the end of a finite clip without an ended event. One timer exists
// only while playback is active and looping. It acts only near the end after two unchanged polls (current time and
// decoded frames), so slow mid-clip playback is never rewound, and play/paused is not taken as progress.

const POLL_MS = 400;
/** Recoveries allowed without observed progress before giving up. */
const MAX_RECOVERIES_WITHOUT_PROGRESS = 3;

/** What the loop watch needs from the video session that owns it. */
export interface LoopHost {
  readonly video: HTMLVideoElement;
  /** Not disposed and playback active. */
  isPlaying(): boolean;
  isLooping(): boolean;
  /** The session's play generation; a poll from an older one does nothing. */
  generation(): number;
  /** Plays again from the rewound position (a play request without restart). */
  replay(): void;
}

export class LoopWatch {
  /** Rewinds performed since the media was configured. */
  loopRecoveries = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private recoveryFrames: number | null = null;
  private signature: string | null = null;
  private stalledPolls = 0;
  private recoveriesSinceProgress = 0;
  private readonly host: LoopHost;

  constructor(host: LoopHost) {
    this.host = host;
  }

  get isArmed(): boolean {
    return this.timer !== null;
  }

  /** New media: forget recoveries. */
  reset(): void {
    this.loopRecoveries = 0;
    this.recoveriesSinceProgress = 0;
    this.recoveryFrames = null;
  }

  isNearEnd(): boolean {
    const d = this.host.video.duration;
    const t = this.host.video.currentTime;
    return Number.isFinite(d) && d > 0 && Number.isFinite(t) && d - t <= Math.min(0.35, d * 0.2);
  }

  /** Starts (or restarts) polling while playback is active, looping and the duration finite. */
  arm(): void {
    this.cancel();
    const host = this.host;
    if (!host.isPlaying() || !host.isLooping() || !Number.isFinite(host.video.duration)) return;
    const generation = host.generation();
    const epoch = ++this.epoch;
    const poll = (): void => {
      // A cancelled or re-armed watcher must not touch the newer timer reference.
      if (epoch !== this.epoch) return;
      this.timer = null;
      if (!host.isPlaying() || generation !== host.generation()) return;
      const video = host.video;
      const t = video.currentTime;
      const frames = video.getVideoPlaybackQuality?.()?.totalVideoFrames;
      const signature = `${t}|${frames ?? ''}`;
      const isNearEnd = this.isNearEnd();
      if (signature !== this.signature) {
        this.signature = signature;
        this.stalledPolls = 0;
        // A rewind alone is not progress: decoded frames must advance (or, without the API, time past the rewind point).
        const hasProgressed =
          this.recoveryFrames === null
            ? false
            : Number.isFinite(frames)
              ? frames! > this.recoveryFrames
              : t > 0.05;
        if (!isNearEnd && hasProgressed) {
          this.recoveriesSinceProgress = 0;
          this.recoveryFrames = null;
        }
      } else if (isNearEnd) this.stalledPolls++;
      if (isNearEnd && (video.ended || this.stalledPolls >= 2)) {
        this.recover();
        return;
      }
      this.timer = globalThis.setTimeout(poll, POLL_MS);
    };
    this.timer = globalThis.setTimeout(poll, POLL_MS);
  }

  cancel(): void {
    this.epoch++;
    if (this.timer !== null) globalThis.clearTimeout(this.timer);
    this.timer = null;
    this.signature = null;
    this.stalledPolls = 0;
  }

  /** Rewinds once and plays once; gives up after three recoveries without observed progress. */
  recover(): void {
    this.cancel();
    const host = this.host;
    if (
      !host.isPlaying() ||
      !host.isLooping() ||
      this.recoveriesSinceProgress >= MAX_RECOVERIES_WITHOUT_PROGRESS
    )
      return;
    this.recoveriesSinceProgress++;
    this.loopRecoveries++;
    this.recoveryFrames = host.video.getVideoPlaybackQuality?.()?.totalVideoFrames ?? 0;
    try {
      host.video.currentTime = 0;
    } catch {
      return;
    }
    if (host.video.paused || host.video.ended) host.replay();
    else this.arm();
  }
}
