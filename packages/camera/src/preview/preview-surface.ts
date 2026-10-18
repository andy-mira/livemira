/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Preview surfaces: the element that actually shows the camera picture above the playing <video>.
//
// After the video element is resized, a browser's native video layer can keep fitting new frames with its previous
// size or rotation for a while (seen on iOS WebKit as a centred zoom or shrink while the geometry and the captured
// frames were already right). The canvas surface therefore draws the current frame with the same box and transform
// as the video, so what is shown never depends on the native layer re-fitting itself. The video keeps playing
// underneath; without a 2D context, or after a drawing failure, the video itself remains the picture.

import type { PreviewStyle } from './preview-style.ts';

/** The minimal DOM the preview needs; a real document satisfies it. */
export interface PreviewElement {
  readonly style: Record<string, string>;
  /** The document new elements of the preview are created in. */
  readonly ownerDocument?: PreviewDocument | null;
  setAttribute?(name: string, value: string): void;
  appendChild(child: PreviewElement): unknown;
  remove?(): void;
}

export interface PreviewDocument {
  createElement(tag: string): PreviewElement;
}

export interface PreviewVideo extends PreviewElement {
  readonly videoWidth: number;
  readonly videoHeight: number;
}

export interface PreviewSurface {
  /** What shows the picture: 'video' once the surface has been disabled. */
  readonly kind: 'canvas' | 'video';
  /**
   * Applies this frame's preview transform and draws the current picture when the video still has exactly this
   * size. Returns false while the surface holds no picture of this size (it must then stay hidden).
   */
  update(video: PreviewVideo, style: PreviewStyle, widthPx: number, heightPx: number): boolean;
  setVisible(isVisible: boolean): void;
  remove(): void;
}

/** Creates a surface inside the preview layer, or returns null to use the video itself. */
export type PreviewSurfaceFactory = (
  layer: PreviewElement,
  video: PreviewVideo,
) => PreviewSurface | null;

interface CanvasLike extends PreviewElement {
  width: number;
  height: number;
  getContext?(
    type: '2d',
    options: { alpha: boolean },
  ): { drawImage(image: unknown, x: number, y: number, w: number, h: number): void } | null;
}

/** The default surface: a 2D canvas drawn with the same frame as recognition, above the video. */
export const canvasPreviewSurface: PreviewSurfaceFactory = (layer) => {
  let canvas: CanvasLike | null = null;
  let context: ReturnType<NonNullable<CanvasLike['getContext']>>;
  try {
    canvas = (layer.ownerDocument?.createElement('canvas') as CanvasLike | undefined) ?? null;
    context =
      typeof canvas?.getContext === 'function' ? canvas.getContext('2d', { alpha: false }) : null;
  } catch {
    context = null;
  }
  if (!canvas || !context || typeof context.drawImage !== 'function') return null;
  Object.assign(canvas.style, { visibility: 'hidden', zIndex: '1' });
  canvas.setAttribute?.('aria-hidden', 'true');
  layer.appendChild(canvas);
  let alive: CanvasLike | null = canvas;
  // The canvas holds a frame of exactly the size its current geometry was built for.
  let isDrawn = false;
  const drawing = context;
  const disable = (): void => {
    if (!alive) return;
    const element = alive;
    alive = null;
    isDrawn = false;
    try {
      element.remove?.();
      element.width = element.height = 0;
    } catch {
      // The video stays the picture.
    }
  };
  const draw = (video: PreviewVideo, widthPx: number, heightPx: number): boolean => {
    // Never draw a frame of another size into this geometry (a newer frame of a turned camera may already be current).
    if (video.videoWidth !== widthPx || video.videoHeight !== heightPx) return false;
    try {
      drawing.drawImage(video, 0, 0, widthPx, heightPx);
      return true;
    } catch {
      disable();
      return false;
    }
  };
  return {
    get kind() {
      return alive ? 'canvas' : 'video';
    },
    update(video, style, widthPx, heightPx) {
      if (!alive) return false;
      // Resizing clears the bitmap, so the canvas counts as drawn again only once this frame is in it.
      if (alive.width !== widthPx || alive.height !== heightPx) {
        alive.width = widthPx;
        alive.height = heightPx;
        isDrawn = false;
      }
      if (draw(video, widthPx, heightPx)) isDrawn = true;
      if (!alive) return false;
      Object.assign(alive.style, style, { zIndex: '1' });
      return isDrawn;
    },
    setVisible(isVisible) {
      if (alive) alive.style.visibility = isVisible ? 'visible' : 'hidden';
    },
    remove: disable,
  };
};

/** No extra surface: the native video is the picture. */
export const videoPreviewSurface: PreviewSurfaceFactory = () => null;
