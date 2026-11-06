// SPDX-License-Identifier: Apache-2.0
// Exclusive playback (`media.selectTarget`) in the session, without a browser: players are stand-ins, the camera and
// renderer are absent. Checks which video may play, pause, answer sound/retry, and that the default is unchanged.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EngineEvents } from '../src/api.ts';
import { Session, type SessionHost, type SessionSettings } from '../src/session.ts';

class FakePlayer {
  state = 'ready';
  plays = 0;
  pauses = 0;
  video = { play: async () => {} };
  async play(): Promise<void> {
    this.plays++;
    this.state = 'playing';
  }
  pause(): void {
    this.pauses++;
    if (this.state === 'playing') this.state = 'paused';
  }
  dispose(): void {}
}

interface Inside {
  players: Map<string, FakePlayer>;
  visibility: { update(now: number, seen: string[]): unknown };
  layoutKey: string;
  currentLayoutKey(): string;
  onResult(message: unknown): void;
}

function setup() {
  let selected: string | null | undefined;
  const events: string[] = [];
  const host = {
    emit: <K extends keyof EngineEvents>(type: K, event: EngineEvents[K]) =>
      void events.push(`${type} ${(event as { targetId?: string }).targetId ?? ''}`.trim()),
    media: () => null,
    progress: () => null,
    isMuted: () => true,
    selected: () => selected,
    failed: () => {},
  } as SessionHost;
  const settings = {
    container: { clientWidth: 320, clientHeight: 480 },
    profile: 'swift',
    lossGraceMs: 200,
    presentation: null,
  } as unknown as SessionSettings;
  const session = new Session(settings, host, 'swift');
  const inside = session as unknown as Inside;
  inside.players.set('A', new FakePlayer());
  inside.players.set('B', new FakePlayer());
  inside.layoutKey = inside.currentLayoutKey();
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  /** A processed frame in which these targets are seen. */
  const see = (...ids: string[]): void =>
    inside.onResult({
      type: 'result',
      sequence: 0,
      captureUs: 0,
      state: 'tracking',
      size: [640, 360],
      poses: ids.map((targetId) => ({ targetId, corners, velocity: [], timeUs: 0 })),
      stats: { processUs: 1, lumaUs: 1 },
    });
  return {
    session,
    players: inside.players,
    events,
    select: (id: string | null | undefined) => void (selected = id),
    see,
  };
}

test('by default every target in view plays its video (several targets, as before)', () => {
  const { players, see } = setup();
  see('A', 'B');
  assert.equal(players.get('A')!.plays, 1);
  assert.equal(players.get('B')!.plays, 1);
});

test('once a target is selected only its video plays; the others stay paused with their source', () => {
  const { session, players, see, select } = setup();
  select(null);
  see('A', 'B');
  assert.deepEqual([players.get('A')!.plays, players.get('B')!.plays], [0, 0], 'nothing plays before a selection');

  select('B');
  session.applySelection();
  assert.deepEqual([players.get('A')!.plays, players.get('B')!.plays], [0, 1]);

  // A→B→A: A is selected again, B pauses; the players are the same objects (nothing released).
  select('A');
  session.applySelection();
  assert.equal(players.get('A')!.plays, 1);
  assert.equal(players.get('B')!.state, 'paused');
  assert.equal(players.size, 2);
});

test('a selected target that is already playing makes the previous one pause', () => {
  const { session, players, see, select } = setup();
  select('A');
  see('A', 'B');
  assert.deepEqual([players.get('A')!.plays, players.get('B')!.plays], [1, 0]);
  select('B');
  session.applySelection();
  assert.equal(players.get('A')!.state, 'paused');
  assert.equal(players.get('B')!.state, 'playing');
});

test('sound and retry act on the selected target, not the first one in view', async () => {
  const { session, players, see, select } = setup();
  select('B');
  see('A', 'B');
  assert.equal(session.activePlayer(), players.get('B'));
  select('A');
  assert.equal(session.activePlayer(), players.get('A'));
  select(null);
  assert.equal(session.activePlayer(), null);
  assert.equal(await session.retry(), false);
  select('B');
  players.get('B')!.state = 'paused';
  assert.equal(await session.retry(), true);
  assert.equal(players.get('A')!.plays, 0, 'retry did not touch the other video');
  select(undefined);
  assert.equal(session.activePlayer(), players.get('A'), 'without a selection the first in view answers');
});
