#!/usr/bin/env node
// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Builds the OPTIONAL auxiliary tracking-drawing companion (RenderSink decorator: recognized boundary + current matched points) as standalone browser ES modules,
// readable and minified (no dependencies, no Worker, no WASM, no network, no engine import, no recorder).
//   node scripts/release/build-tracking-visuals.mjs [--out-dir <absolute dir>]      default: <repo>/dist/tracking-visuals-single (ignored build output)
// It is a separate artifact from the engine runtime: the engine closures never import it (build-engine-single.mjs gates that) and it never imports the engine.
// Run `npm run build` first for the declarations (tsc output of packages/tracking-visuals); the root build script runs this builder after tsc.
// Output safety matches build-engine-single.mjs: a custom --out-dir must not exist; only the default directory may be rebuilt in place, and only when it
// holds nothing but this builder's own files (exact names, regular files, valid audit schema). Staging directory + rename; nothing else is ever deleted.
import { build, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGAL_SOURCE_SCOPE, legalBanner } from './legal.mjs';
import { RELEASE_VERSION, ENGINE_NAME, workspacePackageName } from './release-version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BANNER = legalBanner(`${workspacePackageName('tracking-visuals')} standalone companion (${ENGINE_NAME} ${RELEASE_VERSION}): optional boundary and matched-point drawing for a RenderSink. Not a runtime dependency of the engine.`);
const RUNTIME = 'lm-tracking-visuals.mjs', RUNTIME_MIN = 'lm-tracking-visuals.min.mjs', TYPES = 'lm-tracking-visuals.d.mts', TYPES_MIN = 'lm-tracking-visuals.min.d.mts', AUDIT = 'lm-tracking-visuals.audit.json', OWNED_FILES = [RUNTIME, RUNTIME_MIN, TYPES, TYPES_MIN, AUDIT];
const ENTRY = 'packages/tracking-visuals/src/index.ts', DECLARATIONS = 'dist/tracking-visuals/src/index.d.ts';
const ALLOWED_INPUTS = [/^packages\/tracking-visuals\/src\/[^/]+\.ts$/];
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(message); };
const DEFAULT_OUT = path.join(repo, 'dist/tracking-visuals-single');
const exists = async p => lstat(p).then(() => true, error => error.code === 'ENOENT' ? false : fail(`Cannot inspect ${p}: ${error.code}`));

async function assertOwned(dir) {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`Refusing to replace ${dir}: not a real directory`);
  for (const name of await readdir(dir)) {
    const entry = await lstat(path.join(dir, name));
    if (!OWNED_FILES.includes(name) || !entry.isFile()) fail(`Refusing to replace ${dir}: unexpected entry ${name}`);
  }
  let schema = null;
  try { schema = JSON.parse(await readFile(path.join(dir, AUDIT), 'utf8')).schema; } catch { /* reported below */ }
  if (schema !== 'lm-tracking-visuals-audit/1') fail(`Refusing to replace ${dir}: no valid ${AUDIT}`);
}
async function planOutput(outDir, allowOwnedReplace) {
  if (!path.isAbsolute(outDir) || outDir !== path.resolve(outDir)) fail('outDir must be an absolute, normalized path');
  if (outDir === path.parse(outDir).root || repo === outDir || repo.startsWith(outDir + path.sep)) fail('outDir must not be the filesystem root, the repository or one of its ancestors');
  if (outDir.startsWith(repo + path.sep) && outDir !== DEFAULT_OUT && !outDir.startsWith(path.join(repo, 'dist') + path.sep)) fail('A custom outDir inside the repository must be under dist/');
  const parent = path.dirname(outDir);
  if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) fail('outDir parent must not be a symbolic link');
  if (!(await exists(outDir))) return false;
  if (!allowOwnedReplace) fail(`Output already exists, refusing to touch it: ${outDir}`);
  await assertOwned(outDir);
  return true;
}
function gitIdentity() {
  try {
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const dirty = git(['status', '--porcelain=v1', '--untracked-files=all', '--', 'packages/tracking-visuals', 'scripts/release/build-tracking-visuals.mjs', 'package.json', 'package-lock.json', 'scripts/release/release-version.mjs', ...LEGAL_SOURCE_SCOPE]).split('\n').filter(Boolean);
    return { commit: git(['rev-parse', 'HEAD']).trim(), dirty: dirty.length > 0, dirtyEntryCount: dirty.length };
  } catch { return { commit: null, dirty: null, dirtyEntryCount: null }; }
}

export async function buildTrackingVisuals({ outDir = DEFAULT_OUT, allowOwnedReplace = false } = {}) {
  const replacing = await planOutput(outDir, allowOwnedReplace);
  const declarations = await readFile(path.join(repo, DECLARATIONS), 'utf8').catch(() => fail(`${DECLARATIONS} is missing: run npm run build (tsc) first`));
  if (/\bfrom\s+['"]\.{1,2}\/|\bimport\s*\(|\brequire\b/.test(declarations)) fail('Declarations must be self-contained (no relative imports)');
  const variants = [];
  for (const [variant, file, minify] of [['readable', RUNTIME, false], ['minified', RUNTIME_MIN, true]]) {
    const result = await build({
      absWorkingDir: repo, entryPoints: [ENTRY], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', splitting: false, write: false, metafile: true, outfile: file,
      sourcemap: false, minify, legalComments: 'inline', logLevel: 'silent', charset: 'utf8',
      tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } }, banner: { js: BANNER },
    });
    if (result.outputFiles.length !== 1) fail('Build produced more than one output');
    const inputs = Object.keys(result.metafile.inputs);
    const stray = inputs.filter(i => !ALLOWED_INPUTS.some(rule => rule.test(i)));
    if (stray.length) fail(`Closure contains inputs outside the companion: ${stray.join(', ')}`);
    for (const imported of Object.values(result.metafile.outputs).flatMap(o => o.imports)) fail(`Unexpected external import: ${imported.path}`);
    const text = result.outputFiles[0].text;
    if (text.includes(repo) || /\/Users\/|sourceMappingURL|node:|\brequire\s*\(|\bprocess\.|\bimport\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|new Worker|createElement\(\s*['"]script|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(text.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''))) fail('Output references a path, Node API, network API, script injection or Worker');
    if (/\b(createEngine|CameraFrameSource|compileGrayTarget|startVisionWorker|DiagnosticRecorder|CssVideoRenderSink)\b/.test(text)) fail('Output contains engine or recorder code');
    variants.push({ variant, file, minify, text, inputs });
  }
  const types = Buffer.from(declarations);
  const hashed = [];
  for (const rel of [...variants[0].inputs].sort()) { const data = await readFile(path.join(repo, rel)); hashed.push({ path: rel, bytes: data.length, sha256: sha256(data) }); }
  const settings = { esbuild: esbuildVersion, target: 'es2022', format: 'esm', legalBanner: BANNER, scriptSha256: sha256(await readFile(fileURLToPath(import.meta.url))) };
  const inputHash = sha256(JSON.stringify({ settings, hashed, declarations: sha256(types) }));
  const audit = {
    schema: 'lm-tracking-visuals-audit/1', companion: { name: 'lm-tracking-visuals', buildId: `visuals-${inputHash.slice(0, 16)}`, inputHash },
    runtimes: variants.map(v => { const data = Buffer.from(v.text); return { variant: v.variant, file: v.file, minified: v.minify, bytes: data.length, sha256: sha256(data) }; }),
    types: { files: [TYPES, TYPES_MIN], bytes: types.length, sha256: sha256(types) },
    settings, source: gitIdentity(), inputs: hashed, closure: variants[0].inputs.sort(),
    gates: ['two JS outputs (readable, minified), no external or dynamic imports', 'closure limited to packages/tracking-visuals/src', 'no engine, recorder, Worker, WASM, Node API, network API, script injection or absolute path in the output', 'engine closures exclude this companion (build-engine-single.mjs gate)'],
  };
  const parent = path.dirname(outDir), staging = path.join(parent, `.${path.basename(outDir)}.staging-${process.pid}`), previous = path.join(parent, `.${path.basename(outDir)}.previous-${process.pid}`);
  await mkdir(parent, { recursive: true });
  let swapped = false, created = false;
  try {
    await mkdir(staging);
    created = true;
    for (const v of variants) await writeFile(path.join(staging, v.file), v.text);
    await writeFile(path.join(staging, TYPES), types);
    await writeFile(path.join(staging, TYPES_MIN), types);
    await writeFile(path.join(staging, AUDIT), JSON.stringify(audit, null, 2) + '\n');
    if (replacing) {
      await assertOwned(outDir);
      await rename(outDir, previous);
      try { await rename(staging, outDir); swapped = true; } catch (error) { await rename(previous, outDir); throw error; }
      await assertOwned(previous);
      for (const name of OWNED_FILES) await unlink(path.join(previous, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(previous);
    } else {
      if (await exists(outDir)) fail(`Output appeared during the build, refusing to touch it: ${outDir}`);
      await rename(staging, outDir);
      swapped = true;
    }
  } finally {
    if (created && !swapped) await rm(staging, { recursive: true, force: true });
  }
  return { outDir, runtime: path.join(outDir, RUNTIME), minified: path.join(outDir, RUNTIME_MIN), types: path.join(outDir, TYPES), audit };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    let outDir;
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== '--out-dir') fail(`Unexpected argument: ${args[i]}`);
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('--out-dir requires an absolute directory that does not exist yet');
      outDir = value;
    }
    const result = await buildTrackingVisuals(outDir ? { outDir } : { allowOwnedReplace: true });
    console.log(JSON.stringify({ runtime: result.runtime, runtimes: result.audit.runtimes, buildId: result.audit.companion.buildId }));
  } catch (error) { console.error(`build-tracking-visuals: ${error.message}`); process.exit(1); }
}
