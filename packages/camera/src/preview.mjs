/*! Copyright 2026 Andy (@andy-mira)
 * SPDX-License-Identifier: Apache-2.0
 */
import { multiply3 } from './geometry.mjs';

/** Compose the same input/standard/viewport mappings used for vision and overlays. */
export function previewStyle(geometry, width, height) {
  const h = multiply3(geometry.H_viewportFromStandard, geometry.H_standardFromInput);
  const crop = geometry.crop;
  return { position: 'absolute', left: '0px', top: '0px', width: `${width}px`, height: `${height}px`,
    minWidth: '0px', minHeight: '0px', maxWidth: 'none', maxHeight: 'none', padding: '0px', border: '0px',
    boxSizing: 'content-box', aspectRatio: 'auto', objectFit: 'fill', objectPosition: '0 0', transformOrigin: '0 0',
    transform: `matrix(${h[0]},${h[3]},${h[1]},${h[4]},${h[2]},${h[5]})`,
    clipPath: `inset(${crop.y}px ${width - crop.x - crop.width}px ${height - crop.y - crop.height}px ${crop.x}px)` };
}

export function mountCameraPreview(video, container) {
  const layer = container.ownerDocument.createElement('div');
  Object.assign(layer.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none' });
  layer.setAttribute('aria-hidden', 'true');
  video.style.visibility = 'hidden';
  layer.appendChild(video);
  // Opaque curtain inside the owned layer only; covers the camera region while orientation/viewport geometry settles.
  const curtain = container.ownerDocument.createElement('div');
  Object.assign(curtain.style, { position: 'absolute', inset: '0', background: '#000', pointerEvents: 'none', display: 'none' });
  curtain.setAttribute('aria-hidden', 'true');
  layer.appendChild(curtain);
  container.appendChild(layer);
  let masked = false;
  return { update(geometry, width, height) { Object.assign(video.style, previewStyle(geometry, width, height), { visibility: masked ? 'hidden' : 'visible' }); },
    mask(on) { masked = on; curtain.style.display = on ? 'block' : 'none'; if (on) video.style.visibility = 'hidden'; },
    remove() { layer.remove(); } };
}

const frameGeometry = new WeakMap();
export function bindFrameGeometry(frame, geometry) {
  const bound = Object.freeze({ ...geometry, crop: Object.freeze({ ...geometry.crop }),
    H_standardFromInput: Object.freeze([...geometry.H_standardFromInput]),
    H_viewportFromStandard: Object.freeze([...geometry.H_viewportFromStandard]) });
  frameGeometry.set(frame, bound);
  return frame;
}
/** Geometry is associated with the specific captured frame, never global latest state. */
export function getFrameGeometry(frame) { return frameGeometry.get(frame) ?? null; }
