/*! Copyright 2026 Andy
 * SPDX-License-Identifier: Apache-2.0
 */

// The packages as a user installs them: built, packed and placed in a project outside the repository. Node imports
// and runs them through their exports, and a strict TypeScript project compiles against them without skipLibCheck,
// path mappings or workspace sources.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

import ts from 'typescript';

import { buildEngine } from '../../tools/build-engine.ts';
import { buildTypes } from '../../tools/build-types.ts';
import { pack } from '../../tools/pack.ts';

let work: string;
let project: string;

before(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'livemira-consumer-'));
  const build = path.join(work, 'build');
  await buildEngine(build);
  const outcomes = buildTypes(build, 'rollup');
  assert.deepEqual(
    outcomes.filter((o) => !o.succeeded).map((o) => [o.module, o.messages]),
    [],
  );
  project = path.join(work, 'project');
  pack(build, path.join(project, 'node_modules', '@livemira'));
  writeFileSync(path.join(project, 'package.json'), '{ "type": "module", "private": true }\n');
});
after(() => rmSync(work, { recursive: true, force: true }));

test('Node imports the installed packages through their exports and runs them', () => {
  writeFileSync(
    path.join(project, 'run.mjs'),
    `import { compileGrayTarget, engineBuildInfo, parseTarget, serializeTarget } from '@livemira/engine';
import * as readable from '@livemira/engine/readable';
import { assessGrayTarget } from '@livemira/target-quality';
import { createArSession, createTranslator } from '@livemira/ui';

let seed = 1234;
const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 8);
const widthPx = 320, heightPx = 240, data = new Uint8Array(widthPx * heightPx).fill(80);
for (let i = 0; i < 900; i++) {
  const x = random() % widthPx, y = random() % heightPx, w = 3 + (random() % 20), h = 3 + (random() % 20), c = random() % 256;
  for (let dy = 0; dy < h && y + dy < heightPx; dy++) for (let dx = 0; dx < w && x + dx < widthPx; dx++) data[(y + dy) * widthPx + x + dx] = c;
}
const image = { widthPx, heightPx, data };
const target = await parseTarget(await serializeTarget(await compileGrayTarget(image, { targetId: 'installed' })));
console.log(JSON.stringify({
  variant: engineBuildInfo.variant,
  readable: readable.engineBuildInfo.variant,
  targetId: target.targetId,
  hasFeatures: target.features.points.length > 100,
  score: typeof assessGrayTarget(image).score,
  ui: createArSession({ loadEngine: () => import('@livemira/engine'), targets: [] }).getState().phase,
  wording: createTranslator({ locale: 'en' }).t('status.playing'),
}));
`,
  );
  const output = execFileSync(process.execPath, ['run.mjs'], { cwd: project, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(output), {
    variant: 'minified',
    readable: 'readable',
    targetId: 'installed',
    hasFeatures: true,
    score: 'number',
    ui: 'idle',
    wording: 'Playing',
  });
});

for (const moduleResolution of ['NodeNext', 'Bundler'] as const) {
  test(`a strict TypeScript project compiles against the installed declarations (${moduleResolution})`, () => {
    const source = path.join(project, 'src');
    mkdirSync(source, { recursive: true });
    const file = path.join(source, 'page.ts');
    writeFileSync(
      file,
      `import { createEngine, DiagnosticLog, type EngineEvents } from '@livemira/engine';
import { createTrackingVisuals } from '@livemira/tracking-visuals';
import { createRecognitionDiagnostics } from '@livemira/recognition-diagnostics';
import { mountArCamera, type ArState } from '@livemira/ui';
declare const container: HTMLElement;
const camera = mountArCamera(container, {
  loadEngine: () => import('@livemira/engine'),
  targets: [{ id: 'poster', photo: './poster.jpg', video: './poster.mp4' }],
  engineOptions: { camera: { fit: 'contain' } },
  onExit: () => void camera.destroy(),
});
const phase: ArState['phase'] = camera.session.getState().phase;
void phase;
const engine = createEngine({
  container,
  diagnostics: new DiagnosticLog({ level: 'key' }),
  extensions: [createTrackingVisuals({ boundary: true }), createRecognitionDiagnostics()],
});
engine.on('targetLost', (event: EngineEvents['targetLost']) => void event.lossContext.triggerFrame);
export {};
`,
    );
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      target: ts.ScriptTarget.ES2022,
      module: moduleResolution === 'NodeNext' ? ts.ModuleKind.NodeNext : ts.ModuleKind.ESNext,
      moduleResolution:
        moduleResolution === 'NodeNext'
          ? ts.ModuleResolutionKind.NodeNext
          : ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
      types: [],
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    assert.deepEqual(errors, []);
  });
}
