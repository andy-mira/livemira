/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EngineError, type FrameGeometry, type TrackingResult } from '@livemira/contracts';
import type { ClearReason, ExtensionHost } from '@livemira/engine';
import { createTrackingVisuals, currentMatchedPoints } from '@livemira/tracking-visuals';

interface FakeNode {
  readonly tag: string;
  readonly attrs: Map<string, string>;
  readonly style: Record<string, string>;
  readonly children: FakeNode[];
  isRemoved: boolean;
}

function fakeHost() {
  const node = (tag: string): FakeNode & Record<string, unknown> => {
    const n: FakeNode & Record<string, unknown> = {
      tag,
      attrs: new Map(),
      style: {},
      children: [],
      isRemoved: false,
      setAttribute: (k: string, v: string) => void n.attrs.set(k, v),
      removeAttribute: (k: string) => void n.attrs.delete(k),
      append: (...c: FakeNode[]) => void n.children.push(...c),
      remove: () => void (n.isRemoved = true),
    };
    return n;
  };
  const layer = node('layer');
  (layer as Record<string, unknown>).ownerDocument = {
    createElementNS: (_ns: string, tag: string) => node(tag),
  };
  let presented: ((r: TrackingResult, g: FrameGeometry) => boolean | void) | null = null;
  let cleared: ((reason: ClearReason) => void) | null = null;
  const host = {
    overlayLayer: layer,
    onPresented: (l: typeof presented) => ((presented = l), () => void (presented = null)),
    onCleared: (l: typeof cleared) => ((cleared = l), () => void (cleared = null)),
    onRecognitionTrace: () => () => {},
    onResult: () => () => {},
    getTargets: () => [{ targetId: 't1', widthPx: 600, heightPx: 450 }],
  } as unknown as ExtensionHost;
  return {
    host,
    layer,
    present: (r: TrackingResult) =>
      presented?.(r, {
        H_viewportFromStandard: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      } as unknown as FrameGeometry),
    clear: (reason: ClearReason) => cleared?.(reason),
  };
}

function result(extra: Partial<TrackingResult> = {}): TrackingResult {
  return {
    sessionId: 's1',
    frameId: 1,
    observationTimeUs: 0,
    state: 'TRACKING',
    reason: 'original-target-measured',
    targetId: 't1',
    H_imageFromTarget: null,
    cornersPx: [
      [10, 10],
      [100, 10],
      [100, 80],
      [10, 80],
    ],
    quality: {
      inlierCount: 20,
      inlierRatio: 0.8,
      reprojectionErrorPx: 1,
      spatialCoverage: 0.5,
      isDegenerate: false,
      isMeasured: true,
    },
    prediction: { ageUs: 0, lastMeasuredTimeUs: 0, expiresAtUs: 1 },
    matchedPoints: { sessionId: 's1', frameId: 1, targetId: 't1', pointsPx: [[50, 40]] },
    ...extra,
  };
}

test('the boundary and the current points are drawn into the extension layer', () => {
  const visuals = createTrackingVisuals({ boundary: true, points: true });
  assert.deepEqual(visuals.needs, { matchedPoints: true });
  const { host, layer, present } = fakeHost();
  visuals.attach(host);
  assert.equal(present(result()), true);
  const svg = layer.children[0]!;
  const [polygon, dots] = svg.children as [FakeNode, FakeNode];
  assert.equal(polygon.attrs.get('points'), '10,10 100,10 100,80 10,80');
  assert.equal(polygon.attrs.get('stroke'), '#00ff88');
  assert.equal(dots.attrs.get('d'), 'M50.0 40.0h0');
  assert.deepEqual(visuals.getDiagnostics().shownPoints, 1);
  // A prediction: amber dashed boundary, no points.
  present(
    result({
      state: 'LIMITED',
      quality: { ...result().quality, isMeasured: false },
      prediction: { ageUs: 30000, lastMeasuredTimeUs: 0, expiresAtUs: 1 },
    }),
  );
  assert.equal(polygon.attrs.get('stroke-dasharray'), '7 5');
  assert.equal(dots.style.display, 'none');
});

test('clears on host notifications and removes the layer at stop', () => {
  const visuals = createTrackingVisuals({ boundary: true });
  const { host, layer, present, clear } = fakeHost();
  const handle = visuals.attach(host);
  present(result());
  const svg = layer.children[0]!;
  clear('loss');
  assert.equal(svg.style.display, 'none');
  assert.equal(svg.isRemoved, false);
  clear('stop');
  assert.equal(svg.isRemoved, true);
  handle.detach();
  assert.equal(visuals.getDiagnostics().isLayerAttached, false);
});

test('switches off draw nothing; matched points of another frame are ignored', () => {
  const visuals = createTrackingVisuals();
  const { host, layer, present } = fakeHost();
  visuals.attach(host);
  assert.equal(present(result()), false);
  assert.equal(layer.children.length, 0);
  assert.equal(
    currentMatchedPoints(
      result({
        matchedPoints: { sessionId: 's1', frameId: 2, targetId: 't1', pointsPx: [[1, 1]] },
      }),
    ),
    null,
  );
  assert.throws(
    () => createTrackingVisuals({ outline: true } as never),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
});
