import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRecognitionDiagnostics } from '../../scripts/release/build-recognition-diagnostics.mjs';
import * as compiled from '../../dist/recognition-diagnostics/src/index.js';

// Built into temp dirs, copied somewhere with no repository above it and used with plain objects, as an external project would.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const tsc = path.join(repo, 'node_modules/typescript/bin/tsc');
let root, first, second, readable, minified;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'webar-diagnostics-test-'));
  first = await buildRecognitionDiagnostics({ outDir: path.join(root, 'a') });
  second = await buildRecognitionDiagnostics({ outDir: path.join(root, 'b', 'nested') });
  await mkdir(path.join(root, 'lone'));
  await cp(first.runtime, path.join(root, 'lone', 'diagnostics.mjs'));
  await cp(first.minified, path.join(root, 'lone', 'diagnostics.min.mjs'));
  readable = await import(pathToFileURL(path.join(root, 'lone', 'diagnostics.mjs')).href);
  minified = await import(pathToFileURL(path.join(root, 'lone', 'diagnostics.min.mjs')).href);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('build: readable + minified modules, types and audit; repeatable; no imports, engine, recorder, network or paths', async () => {
  assert.deepEqual((await readdir(first.outDir)).sort(), ['lm-recognition-diagnostics.audit.json', 'lm-recognition-diagnostics.d.mts', 'lm-recognition-diagnostics.min.d.mts', 'lm-recognition-diagnostics.min.mjs', 'lm-recognition-diagnostics.mjs']);
  for (const entry of first.audit.runtimes) {
    const data = await readFile(path.join(first.outDir, entry.file));
    assert.equal(entry.sha256, sha(data));assert.equal(entry.bytes, data.length);
    assert.deepEqual(await readFile(path.join(second.outDir, entry.file)), data);
    const text = data.toString('utf8');
    assert.ok(!/\bimport\s*\(|^import\s|\bfrom\s+['"]|node:|\bfetch\s*\(|new Worker|WebAssembly|sourceMappingURL|createElement\(\s*['"]script/m.test(text), `${entry.file}: no imports, network, Worker, script injection`);
    assert.ok(!text.includes(repo) && !/createEngine|CameraFrameSource|startVisionWorker|compileGrayTarget|DiagnosticRecorder|CssVideoRenderSink|assessGrayTarget/.test(text), `${entry.file}: no engine, recorder or scorer code`);
    assert.match(text, /^\/\*! Copyright 2026 Andy \(@andy-mira\)\n \* SPDX-License-Identifier: Apache-2\.0\n \* @livemira\/recognition-diagnostics standalone companion \(LiveMira /, `${entry.file}: legal banner leads the file (readable and minified)`);
    assert.ok(text.slice(0, text.indexOf('*/')).includes('(LiveMira ' + JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version + ')'), 'banner version agrees with the root package.json');
    assert.equal(first.audit.settings.legalBanner, text.slice(0, text.indexOf('*/') + 2), `${entry.file}: the audit records the emitted banner`);
  }
  assert.ok(first.audit.runtimes.find(r => r.variant === 'minified').bytes < first.audit.runtimes.find(r => r.variant === 'readable').bytes);
  assert.deepEqual(first.audit.closure, ['packages/recognition-diagnostics/src/index.ts', 'packages/recognition/experimental/geometry.mjs', 'packages/recognition/src/point-stats.mjs']);
  assert.deepEqual({ ...second.audit, source: null }, { ...first.audit, source: null });
  assert.ok(!JSON.stringify(first.audit).includes(repo));
});

test('core has NO diagnostic implementation: not in the main closure, not in the embedded Worker closure, not in the built engine files, not in the scorer', async () => {
  const forbidden = /recognition-diagnostics|point-stats|createRecognitionDiagnostics|lm-recognition-diagnostics|pointDistribution|RecognitionDiagnosticsError/;
  for (const audit of ['dist/engine-single/lm-engine.audit.json', 'dist/engine-single/lm-engine.min.audit.json']) {
    const data = JSON.parse(await readFile(path.join(repo, audit), 'utf8'));
    for (const closure of ['mainClosure', 'workerClosure']) {
      assert.ok(data[closure].length > 10, `${audit} ${closure} is populated`);
      assert.ok(!data[closure].some(file => forbidden.test(file)), `${audit} ${closure} contains a diagnostics input`);
    }
    assert.ok(!data.inputs.some(i => forbidden.test(i.path ?? i)), `${audit} inputs`);
  }
  for (const file of ['dist/engine-single/lm-engine.mjs', 'dist/engine-single/lm-engine.min.mjs']) {
    const text = await readFile(path.join(repo, file), 'utf8');   // the embedded Worker source is a string inside this file
    assert.ok(!forbidden.test(text), `${file} (main + embedded Worker) contains diagnostics code`);
    assert.ok(!/byStage|rejections|skippedByRate|hullCoverage|isotropy/.test(text), `${file} contains diagnostic aggregation`);
  }
  for (const file of ['packages/sdk/src/worker-runtime.ts', 'packages/sdk/src/worker-pipeline.ts', 'packages/sdk/src/cpu.ts', 'packages/recognition/src/index.ts', 'packages/target-compiler/src/index.ts', 'packages/tracking/src/index.ts']) {
    assert.ok(!forbidden.test(await readFile(path.join(repo, file), 'utf8')), file);
  }
  const companion = await readFile(path.join(repo, 'packages/recognition-diagnostics/src/index.ts'), 'utf8');
  assert.deepEqual([...companion.matchAll(/^import .*$/gm)].map(m => m[0]), ["import { pointDistribution } from '../../recognition/src/point-stats.mjs';"], 'the companion imports only the shared primitive, never the engine');
  const scorer = await readFile(path.join(repo, 'packages/target-quality/src/index.ts'), 'utf8');
  assert.ok(!/recognition-diagnostics|createRecognitionDiagnostics/.test(scorer), 'scoring and diagnostics are separate companions');
});

test('both variants export the same API as the compiled workspace module and behave identically', () => {
  for (const mod of [readable, minified]) {
    assert.deepEqual(Object.keys(mod).sort(), Object.keys(compiled).sort());
    assert.throws(() => mod.createRecognitionDiagnostics({ maxSessions: 0 }), { code: 'INVALID_CONFIG' });
    const d = mod.createRecognitionDiagnostics({ minDispersionIntervalMs: 0, now: () => 0 });
    d.setTargets([{ targetId: 't', widthPx: 100, heightPx: 100 }]);
    d.observeRecognition({ sessionId: 's', frameId: 1, algorithmVersion: 'a', featureCount: 3, candidateCount: 1, legacyScalePasses: 1, observationCount: 0, ambiguous: false, budgetExhausted: false, rejected: [{ targetId: 't', reason: 'LOW_INLIER_SUPPORT' }] });
    d.observeResult({ sessionId: 's', frameId: 1, targetId: 't', state: 'TRACKING', H_imageFromTarget: [1, 0, 0, 0, 1, 0, 0, 0, 1], quality: { measured: true, degenerate: false }, predictionAgeUs: 0,
      matchedPoints: { sessionId: 's', frameId: 1, targetId: 't', origin: 'original-target', pointsPx: [[10, 10], [90, 10], [90, 90], [10, 90]] } });
    const snap = d.snapshot();
    assert.equal(snap.schema, 'webar-recognition-diagnostics/1');assert.deepEqual(snap.sessions[0].targets[0].rejections.byStage, { geometry: 1 });
    assert.ok(Math.abs(snap.sessions[0].targets[0].measured.hullCoverage.mean - 0.64) < 1e-9);
    d.dispose();assert.equal(d.snapshot().disposed, true);
  }
  assert.deepEqual(readable.createRecognitionDiagnostics().snapshot(), minified.createRecognitionDiagnostics().snapshot());
});

test('declarations are self-contained: an external project type-checks them without the repository', async () => {
  const types = await readFile(first.types, 'utf8');
  assert.ok(!/\bfrom\s+['"]|\bimport\s*\(/.test(types), 'no import specifiers at all');
  const project = path.join(root, 'consumer');
  await mkdir(project);
  await cp(first.outDir, path.join(project, 'diagnostics'), { recursive: true });
  await writeFile(path.join(project, 'use.ts'), `import { createRecognitionDiagnostics, type RecognitionDiagnostics, type DiagnosticsSnapshot, type TraceInput, type ResultInput } from './diagnostics/lm-recognition-diagnostics.min.mjs';
const d: RecognitionDiagnostics = createRecognitionDiagnostics({ maxSessions: 2, minDispersionIntervalMs: 250 });
declare const trace: TraceInput;
declare const result: ResultInput;
d.setTargets([{ targetId: 't', widthPx: 640, heightPx: 480 }]);
d.observeRecognition(trace);
d.observeResult(result);
const snap: DiagnosticsSnapshot = d.snapshot();
const passes: number = snap.sessions[0]?.recognition.passes ?? 0;
void passes;
// @ts-expect-error unknown option
createRecognitionDiagnostics({ verbose: true });
`);
  await writeFile(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM'], types: [] }, files: ['use.ts'] }));
  const run = spawnSync(process.execPath, [tsc, '-p', project], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
