/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXPERIMENT_DEFAULTS, selectedExperiments } from '../src/engine/experiments.ts';

test('experiments take an explicit true or false from the page global, otherwise their default', () => {
  assert.deepEqual(selectedExperiments({}), EXPERIMENT_DEFAULTS);
  assert.deepEqual(selectedExperiments({ __livemiraExperiments: 'yes' }), EXPERIMENT_DEFAULTS);
  const names = Object.keys(EXPERIMENT_DEFAULTS) as (keyof typeof EXPERIMENT_DEFAULTS)[];
  const flipped = Object.fromEntries(names.map((name) => [name, !EXPERIMENT_DEFAULTS[name]]));
  assert.deepEqual(
    selectedExperiments({ __livemiraExperiments: { ...flipped, unknown: true } }),
    flipped,
  );
  assert.deepEqual(
    selectedExperiments({ __livemiraExperiments: { [names[0]!]: 'on' } }),
    EXPERIMENT_DEFAULTS,
    'only booleans switch an experiment',
  );
  assert.ok(Object.isFrozen(selectedExperiments({})));
});
