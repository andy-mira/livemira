/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  EngineError,
  IDENTITY_3,
  type FrameGeometry,
  type TrackingResult,
} from '@livemira/contracts';
import {
  cssMatrix,
  homographyFromCorners,
  OverlayRenderer,
  project,
  resolveRevealOptions,
  type RendererEvent,
} from '@livemira/renderer';

type Listener = () => void;

interface FakeNode {
  readonly tag: string;
  readonly ownerDocument: unknown;
  readonly style: Record<string, string>;
  readonly children: FakeNode[];
  parent: FakeNode | null;
  paused?: boolean;
  muted?: boolean;
  error?: { code: number } | null;
  fire?(type: string): void;
  [key: string]: unknown;
}

/** A minimal page: elements with styles and children, video elements with scripted play(). */
function fakePage() {
  const docListeners = new Map<string, Set<Listener>>();
  const videos: FakeNode[] = [];
  const playOutcomes: string[] = [];
  const doc: Record<string, unknown> = {
    hidden: false,
    defaultView: { addEventListener() {}, removeEventListener() {} },
    addEventListener: (t: string, l: Listener) => {
      if (!docListeners.has(t)) docListeners.set(t, new Set());
      docListeners.get(t)!.add(l);
    },
    removeEventListener: (t: string, l: Listener) => void docListeners.get(t)?.delete(l),
    createElement: (tag: string) => element(tag),
  };
  function element(tag: string): FakeNode {
    const node: FakeNode = {
      tag,
      ownerDocument: doc,
      style: {},
      children: [],
      parent: null,
      setAttribute() {},
      append(child: FakeNode) {
        child.parent = node;
        node.children.push(child);
      },
      remove() {
        if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
        node.parent = null;
      },
    };
    if (tag === 'video') {
      const listeners = new Map<string, Set<Listener>>();
      Object.assign(node, {
        paused: true,
        readyState: 0,
        videoWidth: 0,
        videoHeight: 0,
        error: null,
        currentTime: 0,
        duration: NaN,
        play() {
          const outcome = playOutcomes.shift() ?? 'ok';
          if (outcome === 'ok') {
            node.paused = false;
            return Promise.resolve();
          }
          return Promise.reject(Object.assign(new Error(outcome), { name: outcome }));
        },
        pause() {
          node.paused = true;
        },
        load() {},
        removeAttribute() {},
        addEventListener: (t: string, l: Listener) => {
          if (!listeners.has(t)) listeners.set(t, new Set());
          listeners.get(t)!.add(l);
        },
        removeEventListener: (t: string, l: Listener) => void listeners.get(t)?.delete(l),
        fire: (t: string) => {
          for (const l of [...(listeners.get(t) ?? [])]) l();
        },
      });
      videos.push(node);
    }
    return node;
  }
  const container = element('div');
  return { doc, container, videos, playOutcomes, docListeners };
}

const GEOMETRY = { H_viewportFromStandard: IDENTITY_3 } as unknown as FrameGeometry;

function result(frameId: number, extra: Partial<TrackingResult> = {}): TrackingResult {
  return {
    sessionId: 's1',
    frameId,
    observationTimeUs: 0,
    state: 'TRACKING',
    reason: 'original-target-measured',
    targetId: 't1',
    H_imageFromTarget: null,
    cornersPx: [
      [100, 120],
      [380, 110],
      [400, 330],
      [90, 340],
    ],
    quality: {
      inlierCount: 30,
      inlierRatio: 0.8,
      reprojectionErrorPx: 1,
      spatialCoverage: 0.5,
      isDegenerate: false,
      isMeasured: true,
    },
    prediction: { ageUs: 0, lastMeasuredTimeUs: 0, expiresAtUs: 100000 },
    ...extra,
  };
}

async function started(options: ConstructorParameters<typeof OverlayRenderer>[0] = {}) {
  const page = fakePage();
  let nowUs = 0;
  const renderer = new OverlayRenderer({ nowUs: () => nowUs, ...options });
  const events: RendererEvent[] = [];
  renderer.onEvent((e) => events.push(e));
  renderer.setTargets([{ targetId: 't1', widthPx: 400, heightPx: 300 }]);
  renderer.setTargetMedia('t1', 'https://example.test/a.mp4');
  await renderer.start(page.container as never, 's1');
  const states = (): string[] =>
    events.filter((e) => e.type === 'mediaState').map((e) => (e as { state: string }).state);
  return { ...page, renderer, events, states, advance: (ms: number) => (nowUs += ms * 1000) };
}

test('corners map to a CSS matrix3d that reproduces them', () => {
  const corners = [
    [100, 120],
    [380, 110],
    [400, 330],
    [90, 340],
  ] as const;
  const h = homographyFromCorners(400, 300, corners);
  const projected = [
    [0, 0],
    [400, 0],
    [400, 300],
    [0, 300],
  ].map(([x, y]) => project(h, x!, y!));
  projected.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - corners[i]![0]) < 1e-9);
    assert.ok(Math.abs(p[1] - corners[i]![1]) < 1e-9);
  });
  assert.match(cssMatrix(h), /^matrix3d\(/);
  assert.throws(
    () =>
      homographyFromCorners(400, 300, [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ]),
    RangeError,
  );
});

test('presentation options are validated', () => {
  assert.equal(resolveRevealOptions(false), null);
  assert.deepEqual(resolveRevealOptions(undefined), {
    revealMs: 420,
    loadingTimeoutMs: 15000,
    overlayOpacity: 0.55,
  });
  assert.throws(
    () => resolveRevealOptions({ revealMs: 5000 }),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONFIG',
  );
});

test('a valid result shows the plane, starts loading and plays the media', async () => {
  const { container, videos, renderer, states } = await started();
  await renderer.update(result(1), GEOMETRY);
  const plane = container.children[0]!;
  assert.match(plane.style.transform ?? '', /^matrix3d\(/);
  assert.equal(plane.style.display, 'block');
  assert.deepEqual(states(), ['shown', 'loading']);
  assert.equal(videos[0]!.paused, false);
  assert.equal(videos[0]!.muted, true, 'muted by default');
  await renderer.update(result(2, { state: 'LOST', targetId: null, cornersPx: null }), GEOMETRY);
  assert.equal(plane.style.display, 'none');
  assert.equal(videos[0]!.paused, true, 'paused on loss by default');
  assert.deepEqual(states(), ['shown', 'loading', 'hidden']);
  await renderer.dispose();
  assert.equal(container.children.length, 0);
});

test('stale predictions, degenerate results and old frames are not shown', async () => {
  const { container, renderer } = await started();
  await renderer.update(
    result(1, {
      quality: { ...result(1).quality, isMeasured: false },
      prediction: { ageUs: 100000, lastMeasuredTimeUs: 0, expiresAtUs: 100000 },
    }),
    GEOMETRY,
  );
  assert.equal(container.children.length, 0);
  await renderer.update(
    result(2, { quality: { ...result(2).quality, isDegenerate: true } }),
    GEOMETRY,
  );
  assert.equal(container.children.length, 0);
  await renderer.update(result(3), GEOMETRY);
  assert.equal(container.children.length, 1);
  await renderer.update(result(3, { state: 'LOST' }), GEOMETRY);
  assert.equal(container.children[0]!.style.display, 'block', 'a repeated frame id is ignored');
});

test('a loss hold keeps the plane for the grace period, then hides and pauses', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { container, videos, renderer, states } = await started();
    await renderer.update(result(1), GEOMETRY);
    assert.equal(renderer.holdAfterLoss(300), true);
    assert.equal(renderer.holdAfterLoss(300), true, 'idempotent');
    assert.equal(renderer.holdAfterLoss(2000), false, 'above the maximum grace');
    mock.timers.tick(299);
    assert.equal(container.children[0]!.style.display, 'block');
    mock.timers.tick(1);
    assert.equal(container.children[0]!.style.display, 'none');
    assert.equal(videos[0]!.paused, true);
    assert.deepEqual(states().slice(-2), ['held', 'hidden']);
  } finally {
    mock.timers.reset();
  }
});

test('blocked playback is reported and resumed from a gesture', async () => {
  const { playOutcomes, renderer, events, videos } = await started();
  playOutcomes.push('NotAllowedError');
  await renderer.update(result(1), GEOMETRY);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((e) => e.type === 'playbackBlocked'));
  assert.equal(await renderer.resumeBlockedFromGesture(), true);
  assert.equal(videos[0]!.paused, false);
});

test('a media error is reported as MEDIA_FAILED and hides the plane until a retry', async () => {
  const { container, videos, renderer, events } = await started();
  await renderer.update(result(1), GEOMETRY);
  videos[0]!.error = { code: 3 };
  videos[0]!.fire!('error');
  const error = events.find((e) => e.type === 'error') as Extract<RendererEvent, { type: 'error' }>;
  assert.equal(error.error.code, 'MEDIA_FAILED');
  assert.equal(error.error.message, 'media-decode-error');
  assert.equal(container.children[0]!.style.display, 'none');
  await renderer.update(result(2), GEOMETRY);
  assert.equal(container.children[0]!.style.display, 'none', 'stays hidden while failed');
  assert.equal(renderer.getDiagnostics().isFailed, true);
});

test('media files get an object URL that is revoked when replaced', async () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  URL.createObjectURL = () => {
    const url = `blob:${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => void revoked.push(url);
  try {
    const renderer = new OverlayRenderer();
    renderer.setTargetMedia('t1', new Blob(['x']));
    renderer.setTargetMedia('t1', 'https://example.test/b.mp4');
    assert.deepEqual(revoked, ['blob:0']);
    renderer.setTargetMedia('t1', new Blob(['y']));
    await renderer.dispose();
    assert.deepEqual(revoked, ['blob:0', 'blob:1']);
    assert.throws(
      () => renderer.setTargetMedia('t1', 'x'),
      (e) => e instanceof EngineError && e.code === 'DISPOSED',
    );
  } finally {
    URL.createObjectURL = saved.create;
    URL.revokeObjectURL = saved.revoke;
  }
});
