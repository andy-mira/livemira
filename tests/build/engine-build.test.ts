/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ENGINE_VERSION, engineBuildInfo, type EngineBuildInfo } from '@livemira/engine';

import {
  buildEngineVariant,
  buildExtension,
  EXTENSIONS,
  type EngineOutput,
} from '../../tools/build-engine.ts';

const importModule = async (text: string): Promise<{ engineBuildInfo: EngineBuildInfo }> =>
  (await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)) as {
    engineBuildInfo: EngineBuildInfo;
  };

const mainFile = (output: EngineOutput): string => {
  const name = output.variant === 'minified' ? 'livemira-engine.min.mjs' : 'livemira-engine.mjs';
  const text = output.files[name];
  assert.ok(text !== undefined, `missing ${name}`);
  return text;
};

test('the engine version matches the package version', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../packages/sdk/package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  assert.equal(ENGINE_VERSION, manifest.version);
});

test('workspace sources report the modules format', () => {
  assert.deepEqual(engineBuildInfo, {
    version: ENGINE_VERSION,
    format: 'modules',
    variant: null,
    buildId: null,
  });
});

for (const variant of ['readable', 'minified'] as const) {
  test(`the ${variant} single-file engine reports its own build`, async () => {
    const output = await buildEngineVariant(variant);
    assert.match(output.buildId, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(output.files).sort(), [
      variant === 'minified' ? 'livemira-engine-worker.min.mjs' : 'livemira-engine-worker.mjs',
      variant === 'minified' ? 'livemira-engine.min.mjs' : 'livemira-engine.mjs',
    ]);
    const { engineBuildInfo: info } = await importModule(mainFile(output));
    assert.deepEqual(info, {
      version: ENGINE_VERSION,
      format: 'single',
      variant,
      buildId: output.buildId,
    });
  });
}

test('builds are reproducible and contain no Node imports or absolute paths', async () => {
  const first = await buildEngineVariant('minified');
  const second = await buildEngineVariant('minified');
  assert.deepEqual(first, second);
  for (const text of Object.values(first.files)) {
    assert.ok(!text.includes('node:'), 'bundle must not import Node modules');
    assert.ok(!text.includes(process.cwd()), 'bundle must not contain absolute paths');
    assert.ok(
      text.startsWith('/*! LiveMira engine | Copyright 2026 Andy'),
      'bundle keeps the license banner',
    );
  }
});

test('the engine contains no network requests, dynamic imports or optional extensions', async () => {
  const { files } = await buildEngineVariant('readable');
  for (const [name, text] of Object.entries(files)) {
    for (const word of [
      'fetch(',
      'XMLHttpRequest',
      'sendBeacon',
      'WebSocket',
      'EventSource',
      'import(',
      'createTrackingVisuals',
      'createRecognitionDiagnostics',
      'assessGrayTarget',
    ])
      assert.ok(!text.includes(word), `${name} contains ${word}`);
  }
});

for (const name of EXTENSIONS) {
  test(`the ${name} extension is its own module without the engine`, async () => {
    const files = await buildExtension(name, 'minified');
    const text = files[`livemira-${name}.min.mjs`];
    assert.ok(text !== undefined);
    assert.ok(text.startsWith(`/*! LiveMira ${name} | Copyright 2026 Andy`));
    assert.ok(!/\bimport\s*[{*\w]/.test(text.replace(/^\/\*![^]*?\*\//, '')), 'no imports');
    assert.ok(!text.includes('LiveMira vision'), 'the engine and its Worker are not bundled');
    const module = (await import(
      `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
    )) as Record<string, unknown>;
    assert.ok(Object.keys(module).length > 0);
  });
}
