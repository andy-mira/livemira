/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The merged declarations are self-contained: a strict TypeScript page that uses the engine and the extensions
// compiles against them alone, and misuse is reported.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import ts from 'typescript';

import { buildTypes } from '../../tools/build-types.ts';

let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'livemira-types-'));
  const outcomes = buildTypes(dir, 'rollup');
  assert.deepEqual(
    outcomes.filter((o) => !o.succeeded).map((o) => [o.module, o.messages]),
    [],
  );
});
after(() => rmSync(dir, { recursive: true, force: true }));

function diagnostics(source: string): string[] {
  const file = path.join(dir, 'page.ts');
  writeFileSync(file, source);
  const program = ts.createProgram([file], {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    paths: {
      engine: [path.join(dir, 'livemira-engine.d.ts')],
      visuals: [path.join(dir, 'livemira-tracking-visuals.d.ts')],
      recognition: [path.join(dir, 'livemira-recognition-diagnostics.d.ts')],
      quality: [path.join(dir, 'livemira-target-quality.d.ts')],
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('a page using the engine and the extensions compiles against the merged declarations', () => {
  const errors = diagnostics(`
    import { createEngine, DiagnosticLog, EngineError, type EngineEvents, type TrackingResult } from 'engine';
    import { createTrackingVisuals } from 'visuals';
    import { createRecognitionDiagnostics } from 'recognition';
    import { assessGrayTarget } from 'quality';
    declare const container: HTMLElement;
    const log = new DiagnosticLog({ level: 'full' });
    const engine = createEngine({
      container,
      camera: { processingLongEdge: 640, fit: 'cover' },
      tracking: { lossDisplayGraceMs: 500 },
      diagnostics: log,
      extensions: [createTrackingVisuals({ boundary: true }), createRecognitionDiagnostics()],
    });
    engine.on('targetFound', (event: EngineEvents['targetFound']) => {
      const result: TrackingResult = event.result;
      const age: number = result.prediction.ageUs;
      void age;
    });
    engine.on('error', (event) => {
      if (event.error instanceof EngineError && event.error.code === 'MEDIA_FAILED') void engine.media.retry();
    });
    const score: number = assessGrayTarget({ widthPx: 64, heightPx: 64, data: new Uint8Array(4096) }).score;
    void score;
  `);
  assert.deepEqual(errors, []);
});

test('misuse is reported by the declarations', () => {
  const errors = diagnostics(`
    import { createEngine } from 'engine';
    declare const container: HTMLElement;
    createEngine({ container, camera: { processingLongEdge: 720 } });
    createEngine({ container }).on('noSuchEvent', () => {});
  `);
  assert.equal(errors.length, 2, errors.join('\n'));
});
