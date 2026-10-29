// SPDX-License-Identifier: Apache-2.0
// The look of one target's plane over time: a recognition glow when the photo is found; while its video is on the way,
// a dark see-through region in the video's shape with a loading ring (a play mark when playback needs a tap); then the
// reveal: a soft circle growing from the region's centre to past its farthest corner, with a light wavefront on its
// edge. A playing video that runs out of data shows the ring again. Pure timing; the renderer draws it.

export interface PlaneInputs {
  /** 1 while the photo is seen, falling to 0 over the loss grace; 0: not in view. */
  readonly presence: number;
  /** The video is playing and its frames reach the screen. */
  readonly isPlaying: boolean;
  /** A video is on its way: downloading, decoding, or waiting for a tap. */
  readonly isWaiting: boolean;
  readonly isBlocked: boolean;
  /** The playing video waits for more data. */
  readonly isBuffering: boolean;
  /** Download progress 0..1, NaN when the size is unknown, null when not downloading. */
  readonly progress: number | null;
  /** Width / height of the photo, and of the video once the browser knows it (0 before). */
  readonly targetAspect: number;
  readonly videoAspect: number;
}

export interface PlaneLook {
  readonly alpha: number;
  /** Width / height of the video region: the photo's until the video's is known, then easing to it. */
  readonly aspect: number;
  /** Darkening of the video region outside the revealed circle. */
  readonly veil: number;
  /** Reveal radius, 0 (nothing) .. 1 (past the farthest corner). */
  readonly reveal: number;
  readonly wave: number;
  readonly ring: number;
  /** 0..1, or -1 for the indeterminate spinner. */
  readonly ringProgress: number;
  /** Spinner phase in turns. */
  readonly spin: number;
  readonly play: number;
  readonly glow: number;
  readonly showVideo: boolean;
  /** Something moves: the plane must be redrawn every display frame. */
  readonly isAnimating: boolean;
}

export interface PresenterTiming {
  readonly revealMs: number;
  readonly resumeRevealMs: number;
  readonly veilOpacity: number;
  readonly isReducedMotion: () => boolean;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Recognition glow: rises and falls once over this time. */
const PULSE_MS = 700;
/** The veil fades in over this time; the ring follows a little later. */
const VEIL_MS = 220;
const RING_DELAY_MS = 120;
const RING_MS = 240;
/** With reduced motion: no wavefront, no spinning, a short fade instead of a long reveal. */
const REDUCED_REVEAL_MS = 200;
/** The region eases to the video's shape over this time once the browser knows it. */
const SHAPE_MS = 260;
/** A playing video short of data for less than this shows nothing (loops, brief network stalls). */
const BUFFERING_DELAY_MS = 400;

export class PlanePresenter {
  private visibleSince: number | null = null;
  private waitingSince: number | null = null;
  private revealStart: number | null = null;
  private revealMs = 0;
  /** This video was revealed on this photo before: it comes back with the shorter reveal. */
  private hasRevealed = false;
  private veilAtReveal = 0;
  private ringAtReveal = 0;
  private shape: { from: number; to: number; at: number } | null = null;
  private bufferingSince: number | null = null;
  private readonly timing: PresenterTiming;

  constructor(timing: PresenterTiming) {
    this.timing = timing;
  }

  /** A different video (or none): the next reveal is a first one. */
  mediaChanged(): void {
    this.hasRevealed = false;
    this.revealStart = null;
    this.shape = null;
  }

  /** The region's shape now: the photo's until the video's is known, then easing to it. */
  private aspect(now: number, inputs: PlaneInputs, reduced: boolean): { aspect: number; isMoving: boolean } {
    const goal = inputs.videoAspect > 0 ? inputs.videoAspect : inputs.targetAspect;
    const at = (shape: { from: number; to: number; at: number }): number => {
      const t = reduced ? 1 : clamp01((now - shape.at) / SHAPE_MS);
      return shape.from + (shape.to - shape.from) * smooth(t);
    };
    if (!this.shape) this.shape = { from: goal, to: goal, at: now };
    else if (goal !== this.shape.to) this.shape = { from: at(this.shape), to: goal, at: now };
    const aspect = at(this.shape);
    return { aspect, isMoving: aspect !== goal };
  }

  look(now: number, inputs: PlaneInputs): PlaneLook | null {
    if (inputs.presence <= 0) {
      this.visibleSince = null;
      this.waitingSince = null;
      this.revealStart = null;
      this.shape = null;
      this.bufferingSince = null;
      return null;
    }
    const reduced = this.timing.isReducedMotion();
    this.visibleSince ??= now;
    const sinceVisible = now - this.visibleSince;
    const pulse = !reduced && sinceVisible < PULSE_MS ? Math.sin((Math.PI * sinceVisible) / PULSE_MS) : 0;

    let veil = 0;
    let ring = 0;
    let play = 0;
    let glow = 0.9 * pulse;
    let isAnimating = pulse > 0;
    // The veil keeps its level when playback starts: the reveal opens it from the centre.
    if (inputs.isWaiting && !inputs.isPlaying) this.waitingSince ??= now;
    else if (!inputs.isPlaying) this.waitingSince = null;
    if (this.waitingSince !== null) {
      const t = now - this.waitingSince;
      veil = this.timing.veilOpacity * smooth(clamp01(t / VEIL_MS));
      ring = inputs.isBlocked ? 0 : smooth(clamp01((t - RING_DELAY_MS) / RING_MS));
      play = inputs.isBlocked ? smooth(clamp01(t / VEIL_MS)) : 0;
      // A gentle breathing edge while waiting: the photo is recognised, its video is coming.
      if (!reduced) glow = Math.max(glow, 0.22 + 0.1 * Math.sin((now / 1000) * 2 * Math.PI * 0.7));
      isAnimating = true;
    }

    const progress = inputs.progress;
    const ringProgress = progress !== null && Number.isFinite(progress) ? clamp01(progress) : -1;
    const spin = reduced ? 0.12 : (now / 1000) * 0.9;
    const shape = this.aspect(now, inputs, reduced);
    const aspect = shape.aspect;
    isAnimating ||= shape.isMoving;

    if (!inputs.isPlaying) this.revealStart = null;
    else if (this.revealStart === null) {
      this.revealStart = now;
      const ms = this.hasRevealed ? this.timing.resumeRevealMs : this.timing.revealMs;
      this.revealMs = reduced ? Math.min(ms, REDUCED_REVEAL_MS) : ms;
      this.veilAtReveal = veil;
      this.ringAtReveal = ring;
    }
    if (this.revealStart === null)
      return {
        alpha: inputs.presence,
        aspect,
        veil,
        reveal: 0,
        wave: 0,
        ring,
        ringProgress,
        spin,
        play,
        glow,
        showVideo: false,
        isAnimating,
      };

    // A stall while playing: the spinner over the video, after a short delay.
    if (inputs.isBuffering) this.bufferingSince ??= now;
    else this.bufferingSince = null;
    const buffering =
      this.bufferingSince === null ? 0 : smooth(clamp01((now - this.bufferingSince - BUFFERING_DELAY_MS) / RING_MS));

    const p = this.revealMs > 0 ? clamp01((now - this.revealStart) / this.revealMs) : 1;
    if (p >= 1) {
      this.hasRevealed = true;
      this.waitingSince = null;
      return {
        alpha: inputs.presence,
        aspect,
        veil: 0,
        reveal: 1,
        wave: 0,
        ring: buffering,
        ringProgress: -1,
        spin,
        play: 0,
        glow: 0.9 * pulse,
        showVideo: true,
        isAnimating: pulse > 0 || shape.isMoving || this.bufferingSince !== null,
      };
    }
    return {
      alpha: inputs.presence,
      aspect,
      veil: this.veilAtReveal,
      reveal: reduced ? 1 : easeOutCubic(p),
      wave: reduced ? 0 : Math.min(1, 2.4 * p) * (1 - p) ** 1.4,
      ring: Math.max(this.ringAtReveal * (1 - smooth(clamp01(p / 0.3))), buffering),
      ringProgress: buffering > 0 ? -1 : ringProgress,
      spin,
      play: 0,
      glow: 0.9 * pulse,
      showVideo: true,
      // With reduced motion the "reveal" is a fade of the whole plane.
      ...(reduced ? { alpha: inputs.presence * p } : {}),
      isAnimating: true,
    };
  }
}
