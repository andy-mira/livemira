/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The perspective video plane: a box of the target's size holding the video, placed over the camera picture with a
// CSS matrix3d. The browser composites the video frames; no camera pixels are read.

import {
  cssMatrix,
  homographyFromCorners,
  mediaRect,
  multiply,
  validatePlane,
} from './perspective.ts';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

export class VideoPlane {
  /** The plane element; the video is its first child. */
  readonly element: HTMLElement;
  private readonly widthPx: number;
  private readonly heightPx: number;

  constructor(
    container: HTMLElement,
    video: HTMLVideoElement,
    options: { widthPx: number; heightPx: number; fit?: 'contain' | 'cover' },
  ) {
    const fit = options.fit ?? 'contain';
    mediaRect(options.widthPx, options.heightPx, 1, 1, fit);
    this.widthPx = options.widthPx;
    this.heightPx = options.heightPx;
    this.element = container.ownerDocument.createElement('div');
    Object.assign(this.element.style, {
      position: 'absolute',
      left: '0',
      top: '0',
      width: `${options.widthPx}px`,
      height: `${options.heightPx}px`,
      transformOrigin: '0 0',
      overflow: 'hidden',
      pointerEvents: 'none',
      display: 'none',
    });
    Object.assign(video.style, { width: '100%', height: '100%', objectFit: fit, display: 'block' });
    this.element.append(video);
    container.append(this.element);
  }

  /** Places the plane on the target corners (standard-image pixels) mapped into the viewport; hides it on failure. */
  place(
    corners: readonly (readonly number[])[],
    viewportFromImage: readonly number[] = IDENTITY,
  ): void {
    try {
      const h = multiply(
        viewportFromImage,
        homographyFromCorners(this.widthPx, this.heightPx, corners),
      );
      validatePlane(h, this.widthPx, this.heightPx);
      this.element.style.transform = cssMatrix(h);
      this.element.style.display = 'block';
    } catch (error) {
      this.hide();
      throw error;
    }
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  /** Shows the plane again where it was last placed. */
  show(): void {
    if (this.element.style.transform) this.element.style.display = 'block';
  }

  dispose(): void {
    this.element.remove();
  }
}
