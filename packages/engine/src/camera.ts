// SPDX-License-Identifier: Apache-2.0
// Opening the camera: constraints, error meaning, and the <video> that carries the stream.

import { EngineError } from './errors.ts';

export interface CameraRequest {
  readonly facingMode: 'environment' | 'user';
  readonly deviceId?: string;
}

export interface OpenCamera {
  readonly stream: MediaStream;
  readonly track: MediaStreamTrack;
  readonly video: HTMLVideoElement;
}

/** The engine error for a failed `getUserMedia`. */
export function cameraError(cause: unknown): EngineError {
  const name = (cause as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new EngineError('CAMERA_PERMISSION_DENIED', 'Camera access was not granted', { cause });
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
    return new EngineError('CAMERA_UNAVAILABLE', 'No camera matches the request', { cause });
  return new EngineError('CAMERA_START_FAILED', `The camera could not start (${name || String(cause)})`, { cause });
}

/** Opens the camera into a muted inline <video> appended to `parent` (under the drawing canvas). */
export async function openCamera(request: CameraRequest, parent: HTMLElement): Promise<OpenCamera> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia)
    throw new EngineError('UNSUPPORTED_DEVICE', 'No camera API (the page must be served over HTTPS)', {
      missing: ['secure-context'],
    });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        ...(request.deviceId
          ? { deviceId: { exact: request.deviceId } }
          : { facingMode: { ideal: request.facingMode } }),
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
  } catch (cause) {
    throw cameraError(cause);
  }
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new EngineError('CAMERA_UNAVAILABLE', 'The camera stream has no video track');
  }
  const video = parent.ownerDocument.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.srcObject = stream;
  // Under the opaque canvas: playing and "visible" for the browser, never seen.
  Object.assign(video.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    zIndex: '0',
    pointerEvents: 'none',
  });
  parent.append(video);
  try {
    await video.play();
    if (!video.videoWidth)
      await new Promise<void>((resolve) => video.addEventListener('loadedmetadata', () => resolve(), { once: true }));
  } catch (cause) {
    for (const t of stream.getTracks()) t.stop();
    video.remove();
    throw new EngineError('CAMERA_START_FAILED', 'The camera picture could not be played', { cause });
  }
  return { stream, track, video };
}

/**
 * Standard (processing) image size for a shown picture: `scale` of its size (even numbers), the shape of what the
 * user sees. The video element's size is the shown one; track settings can report the sensor orientation instead
 * (iOS). Before the picture's size is known, a 1280 × 720 camera is assumed.
 */
export function standardSize(shownWidth: number, shownHeight: number, scale: number): [number, number] {
  const w = shownWidth || 1280;
  const h = shownHeight || 720;
  return [2 * Math.max(8, Math.round((w * scale) / 2)), 2 * Math.max(8, Math.round((h * scale) / 2))];
}
