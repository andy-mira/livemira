import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildTargetQuality } from '../../scripts/release/build-target-quality.mjs';
import { blank, natural, rects, tiled } from './fixtures.mjs';
import * as compiled from '../../dist/target-quality/src/index.js';

// The standalone utility is built into temp dirs, copied somewhere with no repository above it, imported alone and type-checked as an external project would.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const tsc = path.join(repo, 'node_modules/typescript/bin/tsc');
let root, first, second, standalone;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lm-target-quality-test-'));
  first = await buildTargetQuality({ outDir: path.join(root, 'a') });
  second = await buildTargetQuality({ outDir: path.join(root, 'b', 'nested') });
  await mkdir(path.join(root, 'lone'));
  await cp(first.runtime, path.join(root, 'lone', 'quality.mjs'));
  standalone = await import(pathToFileURL(path.join(root, 'lone', 'quality.mjs')).href);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('standalone build: one dependency-free module plus types and audit; repeat builds are identical', async () => {
  assert.deepEqual((await readdir(first.outDir)).sort(), ['lm-target-quality.audit.json', 'lm-target-quality.d.mts', 'lm-target-quality.mjs']);
  const runtime = await readFile(first.runtime);
  assert.equal(first.audit.runtime.sha256, sha(runtime));assert.equal(first.audit.runtime.bytes, runtime.length);
  assert.deepEqual(await readFile(second.runtime), runtime);assert.deepEqual({ ...second.audit, source: null }, { ...first.audit, source: null });
  assert.deepEqual(first.audit.closure, ['packages/recognition/experimental/features.mjs', 'packages/recognition/experimental/geometry.mjs', 'packages/recognition/src/anms.mjs', 'packages/recognition/src/legacy-family.mjs', 'packages/recognition/src/point-stats.mjs', 'packages/target-quality/src/index.ts']);
  const text = runtime.toString('utf8');
  assert.ok(!/\bimport\s*\(|^import\s|\bfrom\s+['"]|node:|\bfetch\s*\(|new Worker|WebAssembly|sourceMappingURL/m.test(text), 'no imports, network, Worker or WASM');
  assert.ok(!text.includes(repo) && !/createEngine|CameraFrameSource|startVisionWorker|compileGrayTarget/.test(text), 'no engine code or paths');
  assert.match(text, /^\/\*! Copyright 2026 Andy \(@andy-mira\)\n \* SPDX-License-Identifier: Apache-2\.0\n \* @livemira\/target-quality standalone utility \(LiveMira /, 'legal banner leads the file');
  assert.ok(text.slice(0, text.indexOf('*/')).includes('(LiveMira ' + JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version + ')'), 'banner version agrees with the root package.json');
  assert.equal(first.audit.settings.legalBanner, text.slice(0, text.indexOf('*/') + 2), 'the audit records the banner that was emitted');
  assert.ok(!/LICENSE-2\.0|apache\.org|https?:\/\//.test(text.slice(0, text.indexOf('*/'))), 'the banner carries no URL: the file never needs the network');
  assert.ok(runtime.length < 60_000);
  assert.ok(!JSON.stringify(first.audit).includes(repo));
});

test('standalone module scores exactly like the compiled workspace module and exposes the same API', () => {
  assert.deepEqual(Object.keys(standalone).sort(), Object.keys(compiled).sort());
  for (const image of [blank(), natural(11), tiled(7), rects(6, 512, 384, 900, { region: [0, 0, 128, 96] }), rects(9, 1280, 960, 4000)])
    assert.deepEqual(standalone.assessGrayTarget(image), compiled.assessGrayTarget(image));
  assert.throws(() => standalone.assessGrayTarget({ width: 1 }), { name: 'TargetQualityError', code: 'INVALID_INPUT' });
});

test('standalone Blob path: works from a lone copy with injected decode primitives and rejects without browser support', async () => {
  const image = natural(12);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  for (let i = 0; i < image.data.length; i++) rgba.set([image.data[i], image.data[i], image.data[i], 255], i * 4);
  let closed = 0;
  const environment = { createImageBitmap: async () => ({ width: image.width, height: image.height, close() { closed++; } }),
    OffscreenCanvas: class { constructor(w, h) { this.width = w;this.height = h; } getContext() { return { drawImage() {}, getImageData: () => ({ data: rgba }) }; } } };
  const result = await standalone.assessTargetImage(new Blob([new Uint8Array(8).fill(1)]), { environment });
  assert.deepEqual(result, compiled.assessGrayTarget(image));assert.equal(closed, 1);
  await assert.rejects(standalone.assessTargetImage(new Blob([new Uint8Array(8)])), { code: 'UNSUPPORTED_ENVIRONMENT' });
});

test('strict external TypeScript consumer type-checks against the standalone declarations', async () => {
  const consumer = path.join(root, 'consumer');
  await mkdir(consumer);
  await cp(first.runtime, path.join(consumer, 'lm-target-quality.mjs'));await cp(first.types, path.join(consumer, 'lm-target-quality.d.mts'));
  await writeFile(path.join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022', 'DOM'], strict: true, noEmit: true, skipLibCheck: false, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, types: [] }, files: ['main.mts'] }));
  await writeFile(path.join(consumer, 'main.mts'), `
import { assessGrayTarget, assessTargetImage, TargetQualityError, type TargetQualityResult, type QualityReason, type AssessImageOptions } from './lm-target-quality.mjs';
const gray = assessGrayTarget({ width: 64, height: 64, data: new Uint8Array(64 * 64) }, { algorithmVersion: 'm0-harris-brief256-v1' });
const score: number = gray.score;
const max: 5 = gray.maxScore;
const replace: boolean = gray.recommendReplacement;
const first: QualityReason | undefined = gray.reasons[0];
const code: 'blocker' | 'warning' | 'info' | undefined = first?.severity;
export async function fromFile(file: File, signal: AbortSignal): Promise<TargetQualityResult> {
  const options: AssessImageOptions = { signal, maxImageBytes: 5_000_000 };
  try { return await assessTargetImage(file, options); } catch (error) { if (error instanceof TargetQualityError) { const c: string = error.code; void c; } throw error; }
}
// @ts-expect-error data must be a Uint8Array
assessGrayTarget({ width: 64, height: 64, data: [1, 2, 3] });
// @ts-expect-error unknown option
assessGrayTarget({ width: 64, height: 64, data: new Uint8Array(1) }, { signal });
// @ts-expect-error a string is not a Blob
assessTargetImage('photo.png');
// @ts-expect-error the score is read-only data typed as a number
const text: string = gray.score;
void [score, max, replace, code, text];
`);
  const result = spawnSync(process.execPath, [tsc, '-p', path.join(consumer, 'tsconfig.json')], { encoding: 'utf8', cwd: consumer, timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('builder never overwrites or deletes unrelated output and only replaces its own directory', async () => {
  const keep = path.join(root, 'keep');await mkdir(keep);await writeFile(path.join(keep, 'keep.txt'), 'precious');
  await assert.rejects(buildTargetQuality({ outDir: keep }), /already exists, refusing to touch it/);
  await assert.rejects(buildTargetQuality({ outDir: keep, allowOwnedReplace: true }), /unexpected entry keep\.txt/);
  assert.equal(await readFile(path.join(keep, 'keep.txt'), 'utf8'), 'precious');
  const link = path.join(root, 'link');await symlink(keep, link);
  await assert.rejects(buildTargetQuality({ outDir: link, allowOwnedReplace: true }), /not a real directory|already exists/);
  const owned = path.join(root, 'owned');await cp(first.outDir, owned, { recursive: true });
  await writeFile(path.join(owned, 'lm-target-quality.mjs'), 'stale');
  await buildTargetQuality({ outDir: owned, allowOwnedReplace: true });
  assert.deepEqual(await readFile(path.join(owned, 'lm-target-quality.mjs')), await readFile(first.runtime));
  const extra = path.join(root, 'extra');await cp(first.outDir, extra, { recursive: true });await writeFile(path.join(extra, 'notes.txt'), 'mine');
  await assert.rejects(buildTargetQuality({ outDir: extra, allowOwnedReplace: true }), /Refusing to replace/);
  assert.equal(await readFile(path.join(extra, 'notes.txt'), 'utf8'), 'mine');
  for (const outDir of ['/', repo, path.dirname(repo), 'relative/dir', path.join(repo, 'packages', 'x'), path.join(repo, 'node_modules', 'x')]) await assert.rejects(buildTargetQuality({ outDir, allowOwnedReplace: true }), /outDir|absolute|ancestors|under dist/, outDir);
  assert.ok((await readdir(root)).every(name => !name.startsWith('.')), 'no staging or previous directories left');
  const script = path.join(repo, 'scripts/release/build-target-quality.mjs');
  for (const args of [['--out-dir'], ['--out-dir', '--x'], ['bogus'], ['--out-dir', keep]]) {
    const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, timeout: 60000 });
    assert.equal(run.status, 1, args.join(' '));assert.match(run.stderr, /build-target-quality: /);
  }
});
