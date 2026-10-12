import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticRecorder } from '../../../dist/sdk/src/diagnostics.js';

const good = { requestGeneration: 3, phase: 'revealing', readySignal: 'video-frame-callback', elapsedMs: 120.5, firstFrameMs: 100, revealElapsedMs: 0, revealDurationMs: 420, reducedMotion: false };
const event = (presentation, state = 'first-frame') => ({ sessionId: 's', targetId: 'one', timestampUs: 5, state, media: { currentTime: 0.04, decodedFrames: 2, droppedFrames: 0, readyState: 4, paused: false, errorCode: null, ...(presentation === undefined ? {} : { presentation }) } });
const exported = (presentation, state) => { const r = new DiagnosticRecorder('fixture'); r.event('mediaState', event(presentation, state)); return r.export().events[0]; };

test('presentation telemetry is retained in the log export as a closed, bounded set', () => {
  const e = exported(good);
  assert.equal(e.state, 'first-frame'); assert.deepEqual(e.media.presentation, good); assert.equal(e.media.currentTime, 0.04);
  const failed = exported({ ...good, phase: 'failed', readySignal: null, firstFrameMs: null, revealElapsedMs: null, failureReason: 'loading-timeout' }, 'loading-failed');
  assert.equal(failed.media.presentation.failureReason, 'loading-timeout'); assert.equal(failed.state, 'loading-failed');
});

test('URLs, pixels, free text and unknown keys never reach the export; numbers are bounded; the input event is untouched', () => {
  const dirty = { ...good, url: 'https://example.invalid/secret.mp4?token=abc', pixels: [1, 2, 3], note: 'x', readySignal: 'https://example.invalid/x', failureReason: 'https://example.invalid/y', elapsedMs: 1e12, revealDurationMs: 1e9 };
  const input = event(dirty), r = new DiagnosticRecorder('fixture');
  r.event('mediaState', input);
  const out = r.export();
  const p = out.events[0].media.presentation;
  assert.deepEqual(Object.keys(p).sort(), ['elapsedMs', 'firstFrameMs', 'phase', 'readySignal', 'reducedMotion', 'requestGeneration', 'revealDurationMs', 'revealElapsedMs']);
  assert.equal(p.readySignal, null); assert.equal(p.elapsedMs, 3.6e6); assert.equal(p.revealDurationMs, 1e4);
  assert.equal(JSON.stringify(out).includes('secret'), false); assert.equal(JSON.stringify(out).includes('example.invalid'), false);
  assert.equal(input.media.presentation.url, dirty.url, 'caller event is not mutated');
});

test('malformed presentation telemetry is dropped but the rest of the media state is kept', () => {
  for (const bad of [{ ...good, requestGeneration: NaN }, { ...good, requestGeneration: 1.5 }, { ...good, elapsedMs: -1 }, { ...good, revealDurationMs: Infinity }, { ...good, phase: 'weird' }, 'text', 7, null]) {
    const e = exported(bad);
    assert.equal('presentation' in e.media, false, JSON.stringify(bad)); assert.equal(e.media.currentTime, 0.04); assert.equal(e.media.readyState, 4);
  }
  const plain = exported(undefined, 'shown'); assert.equal('presentation' in plain.media, false);
});

test('export retains presentation transitions in order and reports no truncation', () => {
  const r = new DiagnosticRecorder('fixture');
  const gen = (n, phase) => ({ ...good, requestGeneration: n, phase });
  for (const [state, g, phase] of [['loading', 1, 'loading'], ['first-frame', 1, 'revealing'], ['reveal-start', 1, 'revealing'], ['reveal-end', 1, 'revealed'], ['loading', 2, 'loading'], ['reveal-cancel', 2, 'cancelled']]) r.event('mediaState', event(gen(g, phase), state));
  const out = r.export();
  assert.deepEqual(out.events.map(e => [e.state, e.media.presentation.requestGeneration]), [['loading', 1], ['first-frame', 1], ['reveal-start', 1], ['reveal-end', 1], ['loading', 2], ['reveal-cancel', 2]]);
  assert.equal(out.truncated, false);
});
