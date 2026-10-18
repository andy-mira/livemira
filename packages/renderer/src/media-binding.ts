/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Per-target media configurations and the object URLs the renderer created for media files (revoked when replaced,
// cleared or disposed).

import type { MediaConfig } from '@livemira/media';

export class MediaBindings {
  private readonly configs = new Map<string, MediaConfig>();
  private readonly ownedUrls = new Map<string, string>();

  get(targetId: string): MediaConfig | undefined {
    return this.configs.get(targetId);
  }

  get ownedUrlCount(): number {
    return this.ownedUrls.size;
  }

  /** Sets a target's configuration; an owned object URL that is no longer used is revoked. */
  set(targetId: string, config: MediaConfig): void {
    const owned = this.ownedUrls.get(targetId);
    if (owned && owned !== config.url) {
      URL.revokeObjectURL(owned);
      this.ownedUrls.delete(targetId);
    }
    this.configs.set(targetId, { ...config });
  }

  /** Records that the renderer created `url` for this target. */
  own(targetId: string, url: string): void {
    this.ownedUrls.set(targetId, url);
  }

  update(targetId: string, change: Partial<MediaConfig>): void {
    const config = this.configs.get(targetId);
    if (config) this.configs.set(targetId, { ...config, ...change });
  }

  delete(targetId: string): void {
    this.configs.delete(targetId);
    const url = this.ownedUrls.get(targetId);
    if (url) URL.revokeObjectURL(url);
    this.ownedUrls.delete(targetId);
  }

  dispose(): void {
    for (const url of this.ownedUrls.values()) URL.revokeObjectURL(url);
    this.ownedUrls.clear();
    this.configs.clear();
  }
}
