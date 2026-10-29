// SPDX-License-Identifier: Apache-2.0
// A camera for browser tests: `getUserMedia` returns a canvas stream showing a photo on a table, held by an unsteady
// hand (slow drift and a slight perspective). Runs as a page init script; the photo URL comes from `__fakeCamera`.

export interface FakeCameraOptions {
  /** Picture shown on the "table". */
  readonly photo: string;
  /** Canvas size (landscape like a phone sensor, or portrait). */
  readonly width?: number;
  readonly height?: number;
  /** Seconds before the photo enters the view (it is off-screen before). */
  readonly enterAfterS?: number;
  /** Seconds after which the photo leaves the view again (never by default). */
  readonly leaveAfterS?: number;
}

/** The init script for `page.addInitScript` (a function and its argument). */
export function fakeCameraScript(options: FakeCameraOptions): [(o: FakeCameraOptions) => void, FakeCameraOptions] {
  return [
    (o: FakeCameraOptions) => {
      // On the prototype: WebKit may replace an own property of `navigator.mediaDevices` after the page starts.
      const fake = async (): Promise<MediaStream> => {
        const img = new Image();
        img.src = o.photo;
        await img.decode();
        const w = o.width ?? 1280;
        const h = o.height ?? 720;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        const t0 = performance.now();
        const draw = (): void => {
          const t = (performance.now() - t0) / 1000;
          ctx.fillStyle = '#6b5a48';
          ctx.fillRect(0, 0, w, h);
          // A little sensor noise, so every frame differs (some browsers send no frame for an unchanged canvas).
          ctx.fillStyle = `rgb(${100 + Math.round(10 * Math.random())}, 90, 72)`;
          ctx.fillRect(Math.round(Math.random() * (w - 4)), Math.round(Math.random() * (h - 4)), 3, 3);
          const visible = t >= (o.enterAfterS ?? 0) && (o.leaveAfterS === undefined || t < o.leaveAfterS);
          if (visible) {
            const size = Math.min(w, h) * 0.62;
            const pw = (size * img.width) / Math.max(img.width, img.height);
            const ph = (size * img.height) / Math.max(img.width, img.height);
            ctx.save();
            ctx.translate(w / 2 + 14 * Math.sin(0.9 * t), h / 2 + 9 * Math.cos(0.7 * t));
            ctx.rotate(0.05 * Math.sin(0.5 * t));
            ctx.transform(1, 0, 0.08 * Math.sin(0.3 * t), 1, 0, 0);
            ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
            ctx.restore();
          }
          requestAnimationFrame(draw);
        };
        draw();
        return canvas.captureStream(30);
      };
      Object.defineProperty(MediaDevices.prototype, 'getUserMedia', {
        value: fake,
        configurable: true,
        writable: true,
      });
    },
    options,
  ];
}
