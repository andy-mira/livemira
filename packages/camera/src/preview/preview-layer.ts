/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FrameGeometry } from '@livemira/contracts';

import { previewStyle } from './preview-style.ts';
import {
  canvasPreviewSurface,
  type PreviewDocument,
  type PreviewElement,
  type PreviewSurfaceFactory,
  type PreviewVideo,
} from './preview-surface.ts';

export interface PreviewLayer {
  /** Applies a frame's geometry to the video and the surface, drawing the current frame into the surface. */
  update(geometry: FrameGeometry, widthPx: number, heightPx: number): void;
  /** Shows or hides the opaque curtain over the camera region. */
  mask(isMasked: boolean): void;
  /** What currently shows the picture. */
  readonly surface: 'canvas' | 'video';
  remove(): void;
}

/**
 * Mounts the camera preview inside `container`: an isolated layer holding the video, an opaque curtain and the
 * preview surface. Unmasking never shows a geometry from before the mask: the picture becomes visible only once a
 * geometry was applied after the last mask(true), and the surface only once it holds a frame of exactly that size.
 */
export function mountPreviewLayer(
  video: PreviewVideo,
  container: PreviewElement & { readonly ownerDocument: PreviewDocument },
  createSurface: PreviewSurfaceFactory = canvasPreviewSurface,
): PreviewLayer {
  const doc = container.ownerDocument;
  const layer = doc.createElement('div');
  // isolation keeps the z-order below inside this layer, so host overlays after the container still paint above it.
  Object.assign(layer.style, {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    pointerEvents: 'none',
    isolation: 'isolate',
  });
  layer.setAttribute?.('aria-hidden', 'true');
  video.style.visibility = 'hidden';
  layer.appendChild(video);
  // Opaque curtain inside the owned layer only; it covers the camera region while the view settles.
  const curtain = doc.createElement('div');
  Object.assign(curtain.style, {
    position: 'absolute',
    inset: '0',
    background: '#000',
    pointerEvents: 'none',
    display: 'none',
    zIndex: '2',
  });
  curtain.setAttribute?.('aria-hidden', 'true');
  layer.appendChild(curtain);
  let surface = createSurface(layer, video);
  container.appendChild(layer);
  // isFresh: the video carries a geometry applied after the last mask(true).
  // isDrawn: the surface holds a frame of exactly the size its current geometry was built for.
  let isMasked = false;
  let isFresh = false;
  let isDrawn = false;
  const showSurface = (): void => {
    surface?.setVisible(!isMasked && isFresh && isDrawn);
  };
  return {
    update(geometry, widthPx, heightPx) {
      isFresh = true;
      const style = previewStyle(geometry, widthPx, heightPx);
      Object.assign(video.style, style, { visibility: isMasked ? 'hidden' : 'visible' });
      if (!surface) return;
      isDrawn = surface.update(video, style, widthPx, heightPx);
      // A surface that failed is the video now; it is never shown again.
      if (surface.kind === 'video') {
        surface = null;
        isDrawn = false;
        return;
      }
      showSurface();
    },
    mask(on) {
      isMasked = on;
      curtain.style.display = on ? 'block' : 'none';
      if (on) {
        isFresh = false;
        video.style.visibility = 'hidden';
      } else if (isFresh) video.style.visibility = 'visible';
      showSurface();
    },
    get surface() {
      return surface?.kind ?? 'video';
    },
    remove() {
      layer.remove?.();
      surface?.remove();
      surface = null;
      isDrawn = false;
    },
  };
}
