/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Optional drawing of the recognized target boundary and the current matched inlier points, in CSS pixels through the
// frame's H_viewportFromStandard. The boundary is drawn for every presented TRACKING/LIMITED result (a prediction as an
// amber dashed line); points only for measured results, from that same result's own matched points. The engine host
// decides when what is shown must be cleared (hide, loss hold, stop, new session, hidden page, media failure or
// replacement of the shown target, invalid result). Nothing in the engine imports this module.

import {
  EngineError,
  MAX_MATCHED_POINTS,
  type Point2,
  type TrackingResult,
} from '@livemira/contracts';
import type { EngineExtension, ExtensionHandle, ExtensionHost } from '@livemira/engine';

import { SvgLayer } from './svg-layer.ts';

export interface TrackingVisualization {
  /** Recognized target quadrilateral. Default false. */
  readonly boundary?: boolean;
  /** Current matched inlier points. Default false. */
  readonly points?: boolean;
}

export interface TrackingVisualsDiagnostics {
  readonly boundary: boolean;
  readonly points: boolean;
  readonly isBoundaryShown: boolean;
  readonly shownPoints: number;
  readonly isLayerAttached: boolean;
}

export interface TrackingVisuals extends EngineExtension {
  /** Replaces the switches. Turning one off clears it now; turning one on draws from the next presented result. */
  setVisualization(options: TrackingVisualization): void;
  getVisualization(): Readonly<Required<TrackingVisualization>>;
  /** Counts only, never coordinates. */
  getDiagnostics(): TrackingVisualsDiagnostics;
}

function parseFlags(value: unknown): { boundary: boolean; points: boolean } {
  const fail = (): never => {
    throw new EngineError(
      'INVALID_CONFIG',
      'visualization must be { boundary?: boolean, points?: boolean }',
      {
        isRecoverable: false,
      },
    );
  };
  if (value === undefined) return { boundary: false, points: false };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (key !== 'boundary' && key !== 'points') fail();
  for (const key of ['boundary', 'points'])
    if (record[key] !== undefined && typeof record[key] !== 'boolean') fail();
  return { boundary: record.boundary === true, points: record.points === true };
}

function project(h: readonly number[], x: number, y: number): Point2 | null {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  if (!Number.isFinite(w) || Math.abs(w) < 1e-10) return null;
  const q: Point2 = [(h[0]! * x + h[1]! * y + h[2]!) / w, (h[3]! * x + h[4]! * y + h[5]!) / w];
  return Number.isFinite(q[0]) && Number.isFinite(q[1]) ? q : null;
}

/**
 * The current measured inlier points of this result, or null: only for a measured, non-degenerate TRACKING/LIMITED
 * result whose matched points carry the same session, frame and target and at most MAX_MATCHED_POINTS finite pairs.
 */
export function currentMatchedPoints(result: TrackingResult): readonly Point2[] | null {
  const m = result?.matchedPoints;
  if (
    !m ||
    typeof m !== 'object' ||
    (result.state !== 'TRACKING' && result.state !== 'LIMITED') ||
    !result.quality?.isMeasured ||
    result.quality.isDegenerate
  )
    return null;
  if (
    !result.targetId ||
    m.sessionId !== result.sessionId ||
    m.frameId !== result.frameId ||
    m.targetId !== result.targetId
  )
    return null;
  const p = m.pointsPx;
  if (!Array.isArray(p) || p.length < 1 || p.length > MAX_MATCHED_POINTS) return null;
  for (const q of p)
    if (!Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))
      return null;
  return p;
}

/** The extension. `points` needs matched points from the Worker, which is decided when the engine is created. */
export function createTrackingVisuals(options: TrackingVisualization = {}): TrackingVisuals {
  let flags = parseFlags(options);
  let layer: SvgLayer | null = null;
  let host: ExtensionHost | null = null;
  const clear = (): void => layer?.draw(null, null, true);
  const drop = (): void => {
    layer?.dispose();
    layer = null;
  };

  const draw = (result: TrackingResult, h: readonly number[]): boolean => {
    let boundary: Point2[] | null = null;
    let points: Point2[] | null = null;
    try {
      if (h.length !== 9 || !h.every(Number.isFinite)) {
        clear();
        return false;
      }
      const map = (list: readonly Point2[]): Point2[] =>
        list.flatMap((p) => {
          const q = project(h, p[0], p[1]);
          return q ? [q] : [];
        });
      if (flags.boundary) {
        const size = host!.getTargets().find((t) => t.targetId === result.targetId);
        const corners =
          result.cornersPx ??
          (size && result.H_imageFromTarget
            ? (
                [
                  [0, 0],
                  [size.widthPx, 0],
                  [size.widthPx, size.heightPx],
                  [0, size.heightPx],
                ] as const
              ).flatMap(([x, y]) => {
                const q = project(result.H_imageFromTarget!, x, y);
                return q ? [q] : [];
              })
            : null);
        if (corners && corners.length === 4) {
          const q = map(corners as readonly Point2[]);
          boundary = q.length === 4 ? q : null;
        }
      }
      const current = flags.points ? currentMatchedPoints(result) : null;
      if (current) {
        const q = map(current);
        points = q.length ? q : null;
      }
    } catch {
      boundary = points = null;
    }
    if (!boundary && !points) {
      clear();
      return false;
    }
    layer ??= new SvgLayer(host!.overlayLayer);
    layer.draw(boundary, points, result.quality.isMeasured);
    return true;
  };

  return {
    name: 'tracking-visuals',
    needs: { matchedPoints: flags.points },
    attach(next: ExtensionHost): ExtensionHandle {
      host = next;
      const offPresented = next.onPresented((result, geometry) => {
        if (!flags.boundary && !flags.points) {
          clear();
          return false;
        }
        return draw(result, geometry.H_viewportFromStandard);
      });
      const offCleared = next.onCleared((reason) => {
        if (reason === 'stop' || reason === 'session') drop();
        else clear();
      });
      return {
        detach() {
          offPresented();
          offCleared();
          drop();
          host = null;
        },
      };
    },
    setVisualization(next) {
      flags = parseFlags(next);
      clear();
      if (!flags.boundary && !flags.points) drop();
    },
    getVisualization: () => ({ ...flags }),
    getDiagnostics: () => ({
      ...flags,
      isBoundaryShown: layer?.isBoundaryShown ?? false,
      shownPoints: layer?.shownDots ?? 0,
      isLayerAttached: layer !== null,
    }),
  };
}
