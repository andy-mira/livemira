// SPDX-License-Identifier: Apache-2.0
// Which targets are in view, from the poses of each processed frame. A target that disappears stays "in view" for a
// short grace (it fades out meanwhile) so a single missed frame never flickers its video.

export interface VisibilityChange {
  readonly found: readonly string[];
  readonly lost: readonly string[];
}

export class TargetVisibility {
  /** Per target in view: the processed-frame time it was first missing at, or null while it is seen. */
  private readonly missingSince = new Map<string, number | null>();
  private readonly graceMs: number;

  constructor(graceMs: number) {
    this.graceMs = graceMs;
  }

  /** Targets with a pose in the frame processed at `nowMs`. */
  update(nowMs: number, seen: Iterable<string>): VisibilityChange {
    const found: string[] = [];
    const lost: string[] = [];
    const present = new Set(seen);
    for (const id of present) {
      if (!this.missingSince.has(id)) found.push(id);
      this.missingSince.set(id, null);
    }
    for (const [id, since] of this.missingSince) {
      if (present.has(id)) continue;
      if (since === null) this.missingSince.set(id, nowMs);
      if (nowMs - (since ?? nowMs) >= this.graceMs) {
        this.missingSince.delete(id);
        lost.push(id);
      }
    }
    return { found, lost };
  }

  /** 1 while seen; after a miss it falls to 0 over the grace. */
  presence(id: string, nowMs: number): number {
    if (!this.missingSince.has(id)) return 0;
    const since = this.missingSince.get(id);
    if (since === null || since === undefined) return 1;
    if (this.graceMs <= 0) return 0;
    return Math.max(0, Math.min(1, 1 - (nowMs - since) / this.graceMs));
  }

  isVisible(id: string): boolean {
    return this.missingSince.has(id);
  }

  visible(): string[] {
    return [...this.missingSince.keys()];
  }

  /** Everything counts as lost at once (a stop or a view change); returns the targets that were in view. */
  clear(): string[] {
    const ids = [...this.missingSince.keys()];
    this.missingSince.clear();
    return ids;
  }
}
