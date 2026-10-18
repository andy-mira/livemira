/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// Regression snapshots: gray conversion, frame geometry, target compilation, recognition with each matcher and
// tracking sequences on the synthetic fixtures must stay bit-identical. After an intended change, regenerate with
// LIVEMIRA_UPDATE_SNAPSHOTS=1 and explain the change in the CHANGELOG.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';

import { fixtureDigests, regressionOutputs } from './outputs.ts';

const FILE = new URL('./regression.json', import.meta.url);

interface Snapshot {
  readonly schema: 'livemira-regression/1';
  readonly fixtures: Record<string, string>;
  readonly outputs: Record<string, { sha256: string; summary: string }>;
}

test('the fixtures and their outputs match the regression snapshot', async () => {
  const current: Snapshot = {
    schema: 'livemira-regression/1',
    fixtures: fixtureDigests(),
    outputs: await regressionOutputs(),
  };
  if (process.env['LIVEMIRA_UPDATE_SNAPSHOTS'] === '1')
    writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);
  const stored = JSON.parse(readFileSync(FILE, 'utf8')) as Snapshot;
  assert.deepEqual(current.fixtures, stored.fixtures, 'the fixture generator changed');
  assert.deepEqual(current.outputs, stored.outputs);
});
