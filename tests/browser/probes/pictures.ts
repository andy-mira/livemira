/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Pictures the browser probes show to the synthetic camera and videos they play, generated in the page.

/** A deterministic, feature-rich picture: seeded blocks and circles. */
export function targetPicture(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 360;
  const g = canvas.getContext('2d')!;
  let seed = 12345;
  const random = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 480, 360);
  for (let i = 0; i < 220; i++) {
    const shade = Math.floor(random() * 256);
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    const x = random() * 480;
    const y = random() * 360;
    if (random() < 0.5) g.fillRect(x, y, 8 + random() * 40, 8 + random() * 40);
    else {
      g.beginPath();
      g.arc(x, y, 4 + random() * 22, 0, Math.PI * 2);
      g.fill();
    }
  }
  return canvas;
}

/** A short recorded clip of an animated canvas, or null where MediaRecorder cannot record one. */
export async function recordClip(): Promise<Blob | null> {
  if (typeof MediaRecorder === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const g = canvas.getContext('2d')!;
  let n = 0;
  const timer = setInterval(() => {
    g.fillStyle = `hsl(${(n++ * 25) % 360} 70% 50%)`;
    g.fillRect(0, 0, 320, 240);
  }, 40);
  const type = ['video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) {
    clearInterval(timer);
    return null;
  }
  const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: type });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  recorder.stop();
  await stopped;
  clearInterval(timer);
  return new Blob(chunks, { type });
}
