/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Measurements of the preview container and the page viewport, taken from the environment each time.

/** The parts of a window the camera reads; injectable for tests. */
export interface ViewportEnvironment {
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly devicePixelRatio?: number;
  /** Legacy orientation angle. */
  readonly orientation?: number;
  readonly screen?: { readonly orientation?: { readonly angle?: number } & Partial<EventTarget> };
  readonly visualViewport?:
    ({ readonly width?: number; readonly height?: number } & Partial<EventTarget>) | null;
  readonly ResizeObserver?: new (callback: () => void) => {
    observe(target: Element): void;
    disconnect(): void;
  };
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** The parts of the container element the camera reads. */
export interface MeasuredElement {
  getBoundingClientRect?(): { readonly width: number; readonly height: number };
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}

const round2 = (n: number | undefined): number => Math.round((n ?? 0) * 100) / 100;

/** A comparable snapshot of everything that changes the camera view: container size, viewport size, angle, pixel ratio. */
export function measureView(container: MeasuredElement | null, env: ViewportEnvironment): string {
  const rect = container?.getBoundingClientRect?.();
  const vv = env.visualViewport;
  return JSON.stringify([
    round2(rect?.width ?? container?.clientWidth),
    round2(rect?.height ?? container?.clientHeight),
    round2(vv?.width ?? env.innerWidth),
    round2(vv?.height ?? env.innerHeight),
    env.screen?.orientation?.angle ?? env.orientation ?? null,
    env.devicePixelRatio ?? 1,
  ]);
}

/** The container's CSS size and the pixel ratio, or null for a missing or collapsed container. */
export function containerGeometry(
  container: MeasuredElement | null,
  env: ViewportEnvironment,
): { viewportWidthCss: number; viewportHeightCss: number; devicePixelRatio: number } | null {
  if (!container) return null;
  const rect = container.getBoundingClientRect?.();
  const cssWidth = rect?.width ?? container.clientWidth;
  const cssHeight = rect?.height ?? container.clientHeight;
  if (
    !Number.isFinite(cssWidth) ||
    !Number.isFinite(cssHeight) ||
    cssWidth! <= 0 ||
    cssHeight! <= 0
  )
    return null;
  return {
    viewportWidthCss: cssWidth!,
    viewportHeightCss: cssHeight!,
    devicePixelRatio: env.devicePixelRatio ?? 1,
  };
}

/**
 * Layout viewport size: innerWidth/innerHeight first (unlike visualViewport they do not follow the keyboard or pinch
 * zoom as closely), then visualViewport; null when neither is known.
 */
export function layoutSize(env: ViewportEnvironment): readonly [number, number] | null {
  const vv = env.visualViewport;
  const ok = (w: number | undefined, h: number | undefined): boolean =>
    Number.isFinite(w) && Number.isFinite(h) && w! > 0 && h! > 0;
  if (ok(env.innerWidth, env.innerHeight)) return [env.innerWidth!, env.innerHeight!];
  return ok(vv?.width, vv?.height) ? [vv!.width!, vv!.height!] : null;
}

/**
 * Evidence of a turn from the viewport alone: the orientation class flipped and the axes swapped (the new width is
 * nearer the old height than the old width, and the new height nearer the old width than the old height). Keyboard,
 * address bar and slight zoom changes never satisfy both. The camera's real size is never guessed from this.
 */
export function hasLayoutTurned(
  before: readonly [number, number] | null,
  after: readonly [number, number] | null,
): boolean {
  if (!before || !after) return false;
  const [w0, h0] = before;
  const [w, h] = after;
  return (
    w >= h !== w0 >= h0 &&
    Math.abs(w - h0) < Math.abs(w - w0) &&
    Math.abs(h - w0) < Math.abs(h - h0)
  );
}
