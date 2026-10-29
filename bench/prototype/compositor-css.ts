// SPDX-License-Identifier: Apache-2.0
// F4: DOM fallback. The camera stays a native <video>; one element per target is placed with a CSS matrix3d computed
// in requestAnimationFrame from the newest pose extrapolated to the presented video frame's capture time (F2 late
// binding when the platform reports it, else to "now" minus the measured display latency).

import type { Corners } from '@livemira-next/contracts';

import { viewportFromStandard, type DisplayPose } from '@livemira-next/web';

function homographyFromSquare(c: readonly (readonly [number, number])[]): number[] | null {
  // Unit square → quadrilateral (Heckbert's closed form).
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = c as [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) < 1e-12) return null;
  const g = (sx * dy2 - dx2 * sy) / det;
  const h = (dx1 * sy - sx * dy1) / det;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export interface CssCompositorOptions {
  readonly standardWidth: number;
  readonly standardHeight: number;
  readonly targetSizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  /** Longest extrapolation, µs. */
  readonly maxPredictionUs?: number;
}

export class CssCompositor {
  private readonly elements = new Map<string, HTMLElement>();
  private latest: { poses: readonly DisplayPose[]; receivedUs: number } | null = null;
  private raf = 0;
  /** Capture time of the frame the video shows now (µs, worker clock), set from rVFC; null when unknown. */
  shownCaptureUs: (() => number | null) | null = null;
  onPresent: ((corners: ReadonlyMap<string, Corners>, drawUs: number) => void) | null = null;
  readonly container: HTMLElement;
  private readonly options: CssCompositorOptions;
  /** Standard image size the poses are in; changes when the device turns (`setStandardSize`). */
  private standard: { width: number; height: number };

  constructor(container: HTMLElement, options: CssCompositorOptions) {
    this.container = container;
    this.options = options;
    this.standard = { width: options.standardWidth, height: options.standardHeight };
    for (const [id, size] of options.targetSizes) {
      const el = container.ownerDocument.createElement('div');
      // The element has the target's own size, so the transform scales it by about 1. A 1 px element blown up a few
      // hundred times is rasterised at 1 px and stretched by WebKit (a blurred blob, wrong under strong perspective)
      // and its outline grows with it.
      Object.assign(el.style, {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${size.width}px`,
        height: `${size.height}px`,
        transformOrigin: '0 0',
        willChange: 'transform',
        background: 'rgba(255, 90, 40, 0.55)',
        outline: '2px solid rgba(40, 200, 255, 0.9)',
        display: 'none',
        pointerEvents: 'none',
      });
      container.append(el);
      this.elements.set(id, el);
    }
    this.raf = requestAnimationFrame(() => this.frame());
  }

  update(poses: readonly DisplayPose[]): void {
    this.latest = { poses, receivedUs: performance.now() * 1000 };
  }

  private frame(): void {
    this.raf = requestAnimationFrame(() => this.frame());
    const started = performance.now();
    const latest = this.latest;
    const fit = viewportFromStandard(
      this.standard.width,
      this.standard.height,
      this.container.clientWidth,
      this.container.clientHeight,
      'cover',
    );
    const shown = new Map<string, Corners>();
    for (const [id, el] of this.elements) {
      const size = this.options.targetSizes.get(id)!;
      const pose = latest?.poses.find((p) => p.targetId === id);
      if (!pose) {
        el.style.display = 'none';
        continue;
      }
      const target = this.shownCaptureUs?.() ?? pose.timeUs;
      const dt = Math.max(0, Math.min(this.options.maxPredictionUs ?? 100_000, target - pose.timeUs)) / 1e6;
      const corners = pose.corners.map(
        ([x, y], c) => [x + pose.velocity[2 * c]! * dt, y + pose.velocity[2 * c + 1]! * dt] as [number, number],
      ) as unknown as Corners;
      shown.set(id, corners);
      const h = homographyFromSquare(
        corners.map(([x, y]) => [fit.scale * x + fit.offsetX, fit.scale * y + fit.offsetY] as [number, number]),
      );
      if (!h) {
        el.style.display = 'none';
        continue;
      }
      // Unit square → quad, preceded by target pixels → unit square (the element's x and y columns scaled).
      const sx = 1 / size.width;
      const sy = 1 / size.height;
      const [a, b, c, d, e, f, g, k] = h as [number, number, number, number, number, number, number, number];
      el.style.transform = `matrix3d(${a * sx},${d * sx},0,${g * sx},${b * sy},${e * sy},0,${k * sy},0,0,1,0,${c},${f},0,1)`;
      el.style.display = 'block';
    }
    this.onPresent?.(shown, (performance.now() - started) * 1000);
  }

  /** The shown picture changed shape (the device turned): later poses are in a `width` × `height` standard image. */
  setStandardSize(width: number, height: number): void {
    this.standard = { width, height };
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const el of this.elements.values()) el.remove();
  }
}
