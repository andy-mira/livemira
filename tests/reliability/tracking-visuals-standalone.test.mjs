import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTrackingVisuals } from '../../scripts/release/build-tracking-visuals.mjs';
import * as compiled from '../../dist/tracking-visuals/src/index.js';

// The companion is built into temp dirs, copied somewhere with no repository above it and used with a stand-in core renderer, as an external project would.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const tsc = path.join(repo, 'node_modules/typescript/bin/tsc');
let root, first, second, readable, minified;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'webar-visuals-test-'));
  first = await buildTrackingVisuals({ outDir: path.join(root, 'a') });
  second = await buildTrackingVisuals({ outDir: path.join(root, 'b', 'nested') });
  await mkdir(path.join(root, 'lone'));
  await cp(first.runtime, path.join(root, 'lone', 'visuals.mjs'));
  await cp(first.minified, path.join(root, 'lone', 'visuals.min.mjs'));
  readable = await import(pathToFileURL(path.join(root, 'lone', 'visuals.mjs')).href);
  minified = await import(pathToFileURL(path.join(root, 'lone', 'visuals.min.mjs')).href);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('build: readable + minified modules, types and audit; repeatable; no imports, engine, recorder, network or paths', async () => {
  assert.deepEqual((await readdir(first.outDir)).sort(), ['lm-tracking-visuals.audit.json', 'lm-tracking-visuals.d.mts', 'lm-tracking-visuals.min.d.mts', 'lm-tracking-visuals.min.mjs', 'lm-tracking-visuals.mjs']);
  for (const entry of first.audit.runtimes) {
    const data = await readFile(path.join(first.outDir, entry.file));
    assert.equal(entry.sha256, sha(data));assert.equal(entry.bytes, data.length);
    assert.deepEqual(await readFile(path.join(second.outDir, entry.file)), data);
    const text = data.toString('utf8');
    assert.ok(!/\bimport\s*\(|^import\s|\bfrom\s+['"]|node:|\bfetch\s*\(|new Worker|WebAssembly|sourceMappingURL|createElement\(\s*['"]script/m.test(text), `${entry.file}: no imports, network, Worker, script injection`);
    assert.ok(!text.includes(repo) && !/createEngine|CameraFrameSource|startVisionWorker|compileGrayTarget|DiagnosticRecorder|CssVideoRenderSink/.test(text), `${entry.file}: no engine or recorder code`);
    assert.match(text, /^\/\*! Copyright 2026 Andy \(@andy-mira\)\n \* SPDX-License-Identifier: Apache-2\.0\n \* @livemira\/tracking-visuals standalone companion \(LiveMira /, `${entry.file}: legal banner leads the file (readable and minified)`);
    assert.ok(text.slice(0, text.indexOf('*/')).includes('(LiveMira ' + JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version + ')'), 'banner version agrees with the root package.json');
    assert.equal(first.audit.settings.legalBanner, text.slice(0, text.indexOf('*/') + 2), `${entry.file}: the audit records the emitted banner`);
  }
  assert.ok(first.audit.runtimes.find(r => r.variant === 'minified').bytes < first.audit.runtimes.find(r => r.variant === 'readable').bytes);
  assert.deepEqual(first.audit.closure, ['packages/tracking-visuals/src/index.ts']);
  assert.deepEqual({ ...second.audit, source: null }, { ...first.audit, source: null });
  assert.ok(!JSON.stringify(first.audit).includes(repo));
});

test('core has NO dependency on the companion, in either direction (source and built engine files)', async () => {
  const visualsSource = await readFile(path.join(repo, 'packages/tracking-visuals/src/index.ts'), 'utf8');
  assert.ok(!/^import\s|^export\s[^\n]*\sfrom\s/m.test(visualsSource), 'companion source imports nothing');
  for (const file of ['dist/engine-single/lm-engine.mjs', 'dist/engine-single/lm-engine.min.mjs']) {
    const text = await readFile(path.join(repo, file), 'utf8');
    assert.ok(!/tracking-visuals|TrackingVisualRenderSink|data-lm-visual|createElementNS/.test(text), `${file} contains auxiliary drawing code`);
  }
  for (const file of ['packages/renderer/src/index.ts', 'packages/sdk/src/browser.ts', 'packages/sdk/src/index.ts', 'packages/sdk/src/worker-runtime.ts', 'packages/tracking/src/index.ts']) {
    assert.ok(!/tracking-visuals|createElementNS|TrackingVisual/.test(await readFile(path.join(repo, file), 'utf8')), file);
  }
});

test('both variants export the same API as the compiled workspace module and validate options', () => {
  for (const mod of [readable, minified]) {
    assert.deepEqual(Object.keys(mod).sort(), Object.keys(compiled).sort());
    assert.throws(() => new mod.TrackingVisualRenderSink({ boundary: 'x' }), { code: 'INVALID_CONFIG' });
  }
});

test('a relocated copy decorates a stand-in renderer end to end (draws, clears on hold/hide/stop, disposes the base once)', async () => {
  class El {
    constructor(tag) { this.tag = tag;this.style = {};this.attrs = {};this.children = []; this.ownerDocument = doc; }
    append(...k) { for (const c of k) { this.children.push(c);c.parent = this; } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this); }
    setAttribute(k, v) { this.attrs[k] = String(v); } removeAttribute(k) { delete this.attrs[k]; }
  }
  const doc = { hidden: false, createElementNS: (_n, t) => new El(t), addEventListener() {}, removeEventListener() {}, defaultView: { addEventListener() {}, removeEventListener() {} } };
  for (const mod of [readable, minified]) {
    const calls = [];
    const base = { async start() {}, async update() { calls.push('update'); }, hide() { calls.push('hide'); }, holdAfterLoss() { calls.push('hold'); return true; }, setTargetMedia() {}, async stop() { calls.push('stop'); }, async dispose() { calls.push('dispose'); } };
    const sink = mod.createTrackingVisualRenderSink({ base, boundary: true, points: true, geometryForResult: () => ({ H_viewportFromStandard: [1, 0, 0, 0, 1, 0, 0, 0, 1] }) });
    const container = new El('div');
    await sink.start(container, 's');
    await sink.update({ sessionId: 's', frameId: 1, targetId: 't', state: 'TRACKING', H_imageFromTarget: null, cornersPx: [[0, 0], [9, 0], [9, 9], [0, 9]], quality: { measured: true, degenerate: false }, predictionAgeUs: 0, matchedPoints: { sessionId: 's', frameId: 1, targetId: 't', origin: 'original-target', pointsPx: [[1, 2]] } });
    const svg = container.children[0];
    assert.equal(svg.style.display, 'block');assert.equal(svg.children[0].attrs.points, '0,0 9,0 9,9 0,9');assert.equal(svg.children[1].attrs.d, 'M1.0 2.0h0');
    sink.holdAfterLoss(500);assert.equal(svg.style.display, 'none');
    await sink.stop();assert.equal(container.children.length, 0);
    await sink.dispose();await sink.dispose();
    assert.equal(calls.filter(c => c === 'dispose').length, 1);
  }
});

test('declarations are self-contained: an external project type-checks them without the repository', async () => {
  const types = await readFile(first.types, 'utf8');
  assert.ok(!/\bfrom\s+['"]|\bimport\s*\(/.test(types), 'no import specifiers at all');
  const project = path.join(root, 'consumer');
  await mkdir(project);
  await cp(first.outDir, path.join(project, 'visuals'), { recursive: true });
  await writeFile(path.join(project, 'use.ts'), `import { createTrackingVisualRenderSink, type TrackingVisualRenderSink, type VisualBaseSink } from './visuals/lm-tracking-visuals.min.mjs';
declare const base: VisualBaseSink;
const sink: TrackingVisualRenderSink = createTrackingVisualRenderSink({ base, boundary: true, geometryForResult: () => ({ H_viewportFromStandard: [1, 0, 0, 0, 1, 0, 0, 0, 1] }) });
sink.setVisualization({ points: false });
const flags: { boundary: boolean; points: boolean } = sink.getVisualization();
void flags;
// @ts-expect-error unknown switch
sink.setVisualization({ lines: true });
`);
  await writeFile(path.join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, lib: ['ES2022', 'DOM'], types: [] }, files: ['use.ts'] }));
  const run = spawnSync(process.execPath, [tsc, '-p', project], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});
