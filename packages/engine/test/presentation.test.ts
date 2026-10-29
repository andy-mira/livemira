// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PlanePresenter, type PlaneInputs } from '../src/presenter.ts';
import { videoRect } from '../src/renderer.ts';
import { TargetVisibility } from '../src/visibility.ts';

const timing = { revealMs: 900, resumeRevealMs: 320, veilOpacity: 0.5, isReducedMotion: () => false };
const seen: PlaneInputs = {
  presence: 1,
  isPlaying: false,
  isWaiting: false,
  isBlocked: false,
  isBuffering: false,
  progress: null,
  targetAspect: 1.5,
  videoAspect: 0,
};

test('a found photo glows once; while its video comes, a veil and a progress ring appear', () => {
  const p = new PlanePresenter(timing);
  const first = p.look(0, seen)!;
  assert.equal(first.veil, 0);
  assert.equal(first.showVideo, false);
  assert.ok(p.look(350, seen)!.glow > 0.8, 'glow peaks mid-pulse');
  assert.equal(p.look(800, seen)!.glow, 0);
  const waiting = { ...seen, isWaiting: true, progress: 0.4 };
  p.look(1000, waiting);
  const later = p.look(1500, waiting)!;
  assert.equal(later.veil, 0.5);
  assert.equal(later.ring, 1);
  assert.equal(later.ringProgress, 0.4);
  assert.equal(p.look(1600, { ...waiting, progress: Number.NaN })!.ringProgress, -1, 'unknown size: spinner');
});

test('the reveal grows from the centre once frames flow, keeping the veil outside, then the video is whole', () => {
  const p = new PlanePresenter(timing);
  const waiting = { ...seen, isWaiting: true, progress: 0.9 };
  p.look(0, waiting);
  p.look(500, waiting);
  const playing = { ...seen, isPlaying: true };
  const start = p.look(1000, playing)!;
  assert.equal(start.reveal, 0);
  assert.equal(start.veil, 0.5);
  const mid = p.look(1450, playing)!;
  assert.ok(mid.reveal > 0.8 && mid.reveal < 1, `eased out: ${mid.reveal}`);
  assert.ok(mid.wave > 0, 'wavefront on the edge');
  assert.ok(mid.ring < start.ring, 'ring fades');
  const end = p.look(1900, playing)!;
  assert.deepEqual([end.reveal, end.veil, end.wave, end.isAnimating], [1, 0, 0, false]);
});

test('after a loss the same video comes back with the short reveal; a new video gets the full one', () => {
  const p = new PlanePresenter(timing);
  const playing = { ...seen, isPlaying: true };
  p.look(0, playing);
  p.look(1000, playing);
  assert.equal(p.look(1100, { ...seen, presence: 0 }), null);
  p.look(2000, playing);
  assert.equal(p.look(2320, playing)!.reveal, 1, 'resume reveal: 320 ms');
  p.mediaChanged();
  p.look(3000, { ...seen, presence: 0 });
  p.look(4000, playing);
  assert.ok(p.look(4320, playing)!.reveal < 1, 'a new video: full reveal');
});

test('reduced motion: no glow pulse, no wavefront, a short fade', () => {
  const p = new PlanePresenter({ ...timing, isReducedMotion: () => true });
  assert.equal(p.look(0, seen)!.glow, 0);
  const playing = { ...seen, isPlaying: true };
  p.look(100, playing);
  const mid = p.look(200, playing)!;
  assert.equal(mid.wave, 0);
  assert.equal(mid.reveal, 1);
  assert.ok(mid.alpha > 0 && mid.alpha < 1);
  assert.equal(p.look(320, playing)!.alpha, 1);
});

test('blocked playback shows a play mark instead of the ring', () => {
  const p = new PlanePresenter(timing);
  const blocked = { ...seen, isWaiting: true, isBlocked: true };
  p.look(0, blocked);
  const look = p.look(400, blocked)!;
  assert.equal(look.ring, 0);
  assert.equal(look.play, 1);
});

test("the loading region has the photo's shape until the video's is known, then eases to it", () => {
  const p = new PlanePresenter(timing);
  const waiting = { ...seen, isWaiting: true };
  assert.equal(p.look(0, waiting)!.aspect, 1.5);
  const known = { ...waiting, videoAspect: 16 / 9 };
  const easing = p.look(100, known)!;
  assert.equal(easing.aspect, 1.5, 'starts from the shape on screen');
  assert.ok(easing.isAnimating);
  const mid = p.look(230, known)!.aspect;
  assert.ok(mid > 1.5 && mid < 16 / 9, `between: ${mid}`);
  assert.equal(p.look(400, known)!.aspect, 16 / 9);
  // Seen again later with the size known: the video's shape at once.
  p.look(500, { ...known, presence: 0 });
  assert.equal(p.look(600, known)!.aspect, 16 / 9);
});

test('a playing video short of data shows the spinner again after a short delay', () => {
  const p = new PlanePresenter(timing);
  const playing = { ...seen, isPlaying: true, videoAspect: 1.5 };
  p.look(0, playing);
  assert.equal(p.look(1000, playing)!.ring, 0);
  const stalled = { ...playing, isBuffering: true };
  assert.equal(p.look(1100, stalled)!.ring, 0);
  assert.equal(p.look(1300, stalled)!.ring, 0, 'brief stalls show nothing');
  const look = p.look(1900, stalled)!;
  assert.deepEqual([look.ring, look.ringProgress, look.isAnimating, look.showVideo], [1, -1, true, true]);
  assert.equal(p.look(2000, playing)!.ring, 0);
});

test('visibility: a missed frame fades within the grace; a longer absence is a loss', () => {
  const v = new TargetVisibility(200);
  assert.deepEqual(v.update(0, ['a']), { found: ['a'], lost: [] });
  assert.equal(v.presence('a', 30), 1);
  assert.deepEqual(v.update(33, []), { found: [], lost: [] });
  assert.ok(Math.abs(v.presence('a', 133) - 0.5) < 1e-9);
  assert.deepEqual(v.update(66, ['a']), { found: [], lost: [] }, 'back within the grace: no new find');
  assert.equal(v.presence('a', 70), 1);
  v.update(100, []);
  assert.deepEqual(v.update(300, []), { found: [], lost: ['a'] });
  assert.equal(v.presence('a', 300), 0);
  const instant = new TargetVisibility(0);
  instant.update(0, ['b']);
  assert.deepEqual(instant.update(33, []).lost, ['b']);
});

test('video placement inside the target: contain, cover, fill', () => {
  // A 4:3 video on a 3:2 photo: contain leaves bands left and right, cover crops top and bottom.
  const contain = videoRect(1.5, 4 / 3, 'contain');
  assert.deepEqual(
    contain.map((v) => +v.toFixed(4)),
    [0.0556, 0, 0.9444, 1],
  );
  const cover = videoRect(1.5, 4 / 3, 'cover');
  assert.deepEqual(
    cover.map((v) => +v.toFixed(4)),
    [0, -0.0625, 1, 1.0625],
  );
  // A wide video on a portrait photo.
  const wide = videoRect(0.75, 16 / 9, 'contain');
  assert.deepEqual(
    wide.map((v) => +v.toFixed(4)),
    [0, 0.2891, 1, 0.7109],
  );
  assert.deepEqual(videoRect(1.5, 4 / 3, 'fill'), [0, 0, 1, 1]);
  assert.deepEqual(videoRect(1.5, 0, 'contain'), [0, 0, 1, 1], 'unknown video size');
});
