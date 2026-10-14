#!/usr/bin/env node
// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Builds the single-file engine in two variants of the SAME code: each is ONE complete runtime ES module with the vision Worker (as a Blob
// source), WASM binary + glue and WGSL embedded. The 'readable' variant (lm-engine.mjs) is unminified; the 'minified' variant (lm-engine.min.mjs)
// is minified together with its own embedded Worker source. Inputs, algorithms and resources are identical; only the output text differs.
//   node scripts/release/build-engine-single.mjs [--out-dir <absolute dir>]      default: <repo>/dist/engine-single (ignored build output)
// Output safety: a custom --out-dir must not exist yet. Only the default directory may be rebuilt in place, and only after it is verified to hold
// nothing but this builder's own files (exact names, no symlinks, valid audit schema); nothing else is ever deleted. That includes directories
// produced by the earlier readable-only builder. Builds go through a fresh sibling staging directory and are swapped in with renames.
// Outputs per variant: runtime .mjs (the only runtime file), a forwarding .d.mts (optional types), an audit .json (build metadata); plus NOTICES/*.
// No timestamps or absolute paths are written to the runtime files; the same inputs and settings give identical bytes.
import { build, transform, version as esbuildVersion } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LEGAL_SOURCE_SCOPE, legalBanner, withoutLegalComments } from './legal.mjs';
import { RELEASE_VERSION, ENGINE_NAME, ENGINE_PACKAGE_NAME } from './release-version.mjs';

const repo =path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES_FORWARDER = "// Forwarding declaration only: it needs the multi-file declaration tree (../sdk/src/*.d.ts); it is not a standalone types file.\nexport * from '../sdk/src/browser.js';\n";
const RUNTIME = 'lm-engine.mjs', AUDIT = 'lm-engine.audit.json', TYPES = 'lm-engine.d.mts';
const VARIANTS = [
  { id: 'readable', runtime: RUNTIME, types: TYPES, audit: AUDIT, minify: false },
  { id: 'minified', runtime: 'lm-engine.min.mjs', types: 'lm-engine.min.d.mts', audit: 'lm-engine.min.audit.json', minify: true },
];
const ENTRY = 'packages/sdk/src/browser.ts';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const posix = p => p.split(path.sep).join('/');
const fail = message => { throw new Error(message); };

// locateFile keeps the glue from resolving 'compute.wasm' against import.meta.url, which is a non-hierarchical blob: URL inside the embedded Worker.
// The Worker's whole module closure, as one source: runtime + the host-supplied assets (scalar WASM glue/binary, Hamming WGSL).
const WORKER_ENTRY = `
import { startVisionWorker } from './packages/sdk/src/worker-entry.ts';
import createWasmModule from './packages/compute/artifacts/scalar/compute.mjs';
import wasmBinary from './packages/compute/artifacts/scalar/compute.wasm';
import hammingShaderCode from './packages/compute/shaders/hamming.wgsl';
startVisionWorker(globalThis, { wasmModuleFactory: () => createWasmModule({ wasmBinary, locateFile: file => file }), hammingShaderCode });
`;
const EMBEDDED_ASSETS = [
  ['packages/compute/artifacts/scalar/compute.wasm', 'WebAssembly binary (scalar preprocessing), embedded in the Worker source'],
  ['packages/compute/artifacts/scalar/compute.mjs', 'Emscripten glue for the scalar module'],
  ['packages/compute/shaders/hamming.wgsl', 'WebGPU Hamming matcher shader source'],
  ['packages/compute/src/exact-matching-wasm-binaries.mjs', 'Exact Hamming matcher WebAssembly (scalar and SIMD, base64 text; cpuMatching wasm-experimental), assembled from packages/compute/exact-matching-wasm/*.wat'],
];
// Closure gates: nothing under these paths or with these names may be part of the production runtime.
const FORBIDDEN_INPUT = [/^(tests?|apps|reports|benchmarks?|scripts|docs|datasets|references|reference-code|artifacts)\//, /(^|\/)(mock|replay|diagnostics)\.(?:ts|mjs|js)$/, /recorder|phone-trial|benchmark|target-quality|tracking-visuals|recognition-diagnostics|point-stats/i];
const FORBIDDEN_NAMES = ['DiagnosticRecorder', 'MockSource', 'MockPipeline', 'MockRenderer', 'ReplaySource', 'ReplayFrameSource', 'phone-trial', 'assessGrayTarget', 'assessTargetImage', 'webar-target-suitability', 'createRecognitionDiagnostics', 'lm-recognition-diagnostics', 'pointDistribution'];

// The frozen Emscripten glue detects Node at run time and keeps Node-only branches (fs/path/url, import('module')). This browser-only product
// removes them with one asserted, exact-match substitution of that detector (the identifier becomes the literal false) followed by esbuild's
// syntax folding applied to this single file. Any change to the glue makes the match fail and the build stop; nothing else is rewritten.
const GLUE_FILE = /packages[\\/]compute[\\/]artifacts[\\/]scalar[\\/]compute\.mjs$/;
const NODE_DETECTOR = 'var ENVIRONMENT_IS_NODE=typeof process=="object"&&process.versions?.node&&process.type!="renderer";';
// The Hamming matcher falls back to fetching its shader beside the module when no shader source is supplied. The embedded Worker always supplies
// it, so the fallback is replaced (exact match, asserted) by a refusal: the one-file runtime then contains no reference to a sibling .wgsl file.
const HAMMING_FILE = /packages[\\/]compute[\\/]src[\\/]hamming-matcher\.mjs$/;
const SHADER_FETCH = "const code=shaderCode ?? await fetch(new URL('../shaders/hamming.wgsl',import.meta.url)).then(r=>{if(!r.ok)throw new Error('Shader unavailable');return r.text();});";
const SHADER_REQUIRED = "if(typeof shaderCode!=='string')throw new Error('Shader source required');const code=shaderCode;";
const embeddedShaderOnly = {
  name: 'embedded-shader-only',
  setup(b) {
    b.onLoad({ filter: HAMMING_FILE }, async args => {
      const text = await readFile(args.path, 'utf8');
      if (text.split(SHADER_FETCH).length !== 2) fail('Hamming matcher changed: shader fetch fallback not found exactly once');
      return { contents: text.replace(SHADER_FETCH, SHADER_REQUIRED), loader: 'js' };
    });
  },
};
const browserOnlyGlue = {
  name: 'browser-only-emscripten-glue',
  setup(b) {
    b.onLoad({ filter: GLUE_FILE }, async args => {
      const text = await readFile(args.path, 'utf8');
      if (text.split(NODE_DETECTOR).length !== 2) fail('Emscripten glue changed: Node detector not found exactly once');
      const folded = (await transform(text.replace(NODE_DETECTOR, '').replace(/\bENVIRONMENT_IS_NODE\b/g, 'false'), { loader: 'js', minifySyntax: true })).code;
      if (/\bimport\s*\(|\bprocess\b|"fs"|"path"|"url"|"module"/.test(folded)) fail('Emscripten glue still references Node after folding');
      return { contents: folded, loader: 'js' };
    });
  },
};

function commonOptions(extraDefine = {}, minify = false) {
  return {
    absWorkingDir: repo, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', splitting: false, write: false, metafile: true,
    sourcemap: false, minify, legalComments: 'inline', logLevel: 'silent', charset: 'utf8',
    // tsconfig files in the tree differ per package; the build must not depend on them. @livemira/contracts is the only workspace alias.
    tsconfigRaw: { compilerOptions: { target: 'ES2022', useDefineForClassFields: true } },
    alias: { '@livemira/contracts': path.join(repo, 'packages/contracts/src/index.ts') },
    loader: { '.wasm': 'binary', '.wgsl': 'text' },
    define: { __LM_EMBEDDED__: 'true', ...extraDefine }, plugins: [browserOnlyGlue, embeddedShaderOnly],
  };
}
function externalImports(metafile) {
  const found = [];
  for (const [file, output] of Object.entries(metafile.outputs)) for (const imported of output.imports) if (imported.external || imported.kind !== 'import-statement') found.push(`${file}: ${imported.kind} ${imported.path}`);
  return found;
}
function assertClosure(label, metafile) {
  const bad = Object.keys(metafile.inputs).filter(input => !input.startsWith('<') && FORBIDDEN_INPUT.some(rule => rule.test(input)));
  if (bad.length) fail(`${label} closure contains development/test input: ${bad.join(', ')}`);
  const external = externalImports(metafile);
  if (external.length) fail(`${label} has unexpected external or dynamic imports: ${external.join('; ')}`);
}
function assertText(label, text) {
  const names = FORBIDDEN_NAMES.filter(name => text.includes(name));
  if (names.length) fail(`${label} contains development/test code: ${names.join(', ')}`);
  if (text.includes(repo) || /\/Users\/|[A-Za-z]:\\\\Users/.test(text)) fail(`${label} contains an absolute workspace path`);
  if (/sourceMappingURL/.test(text)) fail(`${label} references a source map`);
  if (/\bimport\s*\(/.test(text)) fail(`${label} contains a dynamic import()`);
  if (/\brequire\s*\(|node:|\bprocess\.(?:versions|env|argv|exit)/.test(text)) fail(`${label} references Node APIs`);
  if (/new URL\(\s*['"`]\.{1,2}\//.test(text)) fail(`${label} references a sibling file by URL`);
  if (/https?:\/\//.test(withoutLegalComments(text).replace(/\/\/[^\n]*/g, ''))) fail(`${label} embeds a network URL`);
}
async function hashInputs(paths, stdin) {
  const files = [];
  for (const rel of [...new Set(paths)].sort()) { const data = await readFile(path.join(repo, rel)); files.push({ path: rel, bytes: data.length, sha256: sha256(data) }); }
  files.push({ path: '<worker-virtual-entry>', bytes: Buffer.byteLength(stdin), sha256: sha256(stdin) });
  return files;
}
function gitIdentity() {
  try {
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const dirty = git(['status', '--porcelain=v1', '--untracked-files=all', '--', 'packages', 'tsconfig.json', 'package.json', 'package-lock.json', 'native', 'scripts/release/build-engine-single.mjs', 'scripts/release/release-version.mjs', ...LEGAL_SOURCE_SCOPE]).split('\n').filter(Boolean);
    return { commit: git(['rev-parse', 'HEAD']).trim(), dirty: dirty.length > 0, dirtyEntryCount: dirty.length };
  } catch { return { commit: null, dirty: null, dirtyEntryCount: null }; }
}

const DEFAULT_OUT = path.join(repo, 'dist/engine-single');
const NOTICE_FILES = ['EMSCRIPTEN-LICENSE.txt', 'MUSL-COPYRIGHT.txt', 'LIBCXX-LICENSE.txt', 'DLMALLOC-NOTICE.txt', 'toolchain-pin.json'];
const OWNED_FILES = VARIANTS.flatMap(v => [v.runtime, v.types, v.audit]);
const exists = async p => lstat(p).then(() => true, error => error.code === 'ENOENT' ? false : fail(`Cannot inspect ${p}: ${error.code}`));

/** The directory holds nothing but this builder's own outputs: real directory, exact file names, no symlinks, valid audit schema. */
async function assertOwned(dir) {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`Refusing to replace ${dir}: not a real directory`);
  const entries = await readdir(dir);
  if (!entries.length) return;
  for (const name of entries) {
    const full = path.join(dir, name), entry = await lstat(full);
    if (entry.isSymbolicLink()) fail(`Refusing to replace ${dir}: symbolic link ${name}`);
    if (name === 'NOTICES') {
      if (!entry.isDirectory()) fail(`Refusing to replace ${dir}: NOTICES is not a directory`);
      for (const inner of await readdir(full)) {
        const innerInfo = await lstat(path.join(full, inner));
        if (!NOTICE_FILES.includes(inner) || !innerInfo.isFile()) fail(`Refusing to replace ${dir}: unexpected NOTICES/${inner}`);
      }
    } else if (!OWNED_FILES.includes(name) || !entry.isFile()) fail(`Refusing to replace ${dir}: unexpected entry ${name}`);
  }
  let schema = null;
  try { schema = JSON.parse(await readFile(path.join(dir, AUDIT), 'utf8')).schema; } catch { /* reported below */ }
  if (schema !== 'lm-engine-single-audit/1') fail(`Refusing to replace ${dir}: no valid ${AUDIT}`);
}
/** Validates the destination before any work. Returns whether an owned directory will be replaced. */
async function planOutput(outDir, allowOwnedReplace) {
  if (!path.isAbsolute(outDir) || outDir !== path.resolve(outDir)) fail('outDir must be an absolute, normalized path');
  if (outDir === path.parse(outDir).root || repo === outDir || repo.startsWith(outDir + path.sep)) fail('outDir must not be the filesystem root, the repository or one of its ancestors');
  const inRepo = outDir.startsWith(repo + path.sep);
  if (inRepo && outDir !== DEFAULT_OUT && !outDir.startsWith(path.join(repo, 'dist') + path.sep)) fail('A custom outDir inside the repository must be under dist/');
  const parent = path.dirname(outDir);
  if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) fail('outDir parent must not be a symbolic link');
  if (!(await exists(outDir))) return false;
  if (!allowOwnedReplace) fail(`Output already exists, refusing to touch it: ${outDir}`);
  await assertOwned(outDir);
  return true;
}

/** Builds one variant completely in memory: Worker source, runtime module and the facts the audit needs. Nothing is written. */
async function buildVariant(variant, script) {
  // 1. Worker closure -> one source string (minified together with the runtime for the minified variant).
  const worker = await build({ ...commonOptions({}, variant.minify), stdin: { contents: WORKER_ENTRY, resolveDir: repo, sourcefile: 'worker-entry-virtual.js', loader: 'js' }, outfile: 'worker.mjs' });
  assertClosure(`Worker (${variant.id})`, worker.metafile);
  if (worker.outputFiles.length !== 1) fail('Worker build produced more than one output');
  const workerText = worker.outputFiles[0].text;
  assertText(`Worker source (${variant.id})`, workerText);
  // 2. Input identity from both closures (a first pass of the main entry lists its inputs; defines never change the import graph).
  const probe = await build({ ...commonOptions({ __LM_WORKER_SOURCE__: '""' }, variant.minify), entryPoints: [ENTRY], outfile: 'probe.mjs' });
  assertClosure(`Main (${variant.id})`, probe.metafile);
  const inputPaths = [...Object.keys(worker.metafile.inputs), ...Object.keys(probe.metafile.inputs)].filter(p => !p.startsWith('<') && p !== 'worker-entry-virtual.js');
  const inputs = await hashInputs(inputPaths, WORKER_ENTRY);
  const banner = legalBanner(`${ENGINE_PACKAGE_NAME} single-file runtime (${ENGINE_NAME} ${RELEASE_VERSION}). Embeds WebAssembly built with Emscripten and musl libc; third-party notices are in shared/notices/ of the distribution. Variant: ${variant.id}.`);
  const settings = { esbuild: esbuildVersion, variant: variant.id, target: 'es2022', format: 'esm', splitting: false, minify: variant.minify, define: ['__LM_EMBEDDED__=true'], plugins: ['browser-only-emscripten-glue (exact-match Node detector substitution + syntax folding of that file only)', 'embedded-shader-only (exact-match replacement of the shader fetch fallback)'], legalBanner: banner, scriptSha256: sha256(script) };
  const inputHash = sha256(JSON.stringify({ settings, inputs }));
  const engine = { format: 'single', variant: variant.id, buildId: `single-${inputHash.slice(0, 16)}`, inputHash };
  // 3. The runtime module.
  const main = await build({ ...commonOptions({ __LM_WORKER_SOURCE__: JSON.stringify(workerText), __LM_BUILD__: JSON.stringify(engine) }, variant.minify), entryPoints: [ENTRY], outfile: variant.runtime, banner: { js: banner } });
  assertClosure(`Main (${variant.id})`, main.metafile);
  if (main.outputFiles.length !== 1) fail('Main build produced more than one output');
  const runtimeText = main.outputFiles[0].text, probeText = probe.outputFiles[0].text;
  // The Worker source was checked in plain form above; the rest of the module is checked here from the same graph with an empty Worker source.
  assertText(`Runtime module (${variant.id}, excluding the embedded Worker source)`, probeText);
  // Names do not survive minification, so the embedded Worker is proven by size here (every Worker byte adds at least one runtime byte) and, in the
  // tests, by hashing the source a real Worker receives against workerSourceSha256.
  if (Buffer.byteLength(runtimeText) - Buffer.byteLength(probeText) < Buffer.byteLength(workerText)) fail(`Embedded Worker source missing from the ${variant.id} runtime module`);
  if (!variant.minify && (!runtimeText.includes('startVisionWorker') || probeText.includes('startVisionWorker'))) fail('Embedded Worker source missing from the runtime module');
  const runtime = Buffer.from(runtimeText);
  const byPath = new Map(inputs.map(i => [i.path, i]));
  return {
    variant, runtime, engine, settings, inputs,
    summary: { variant: variant.id, file: variant.runtime, bytes: runtime.length, sha256: sha256(runtime), workerSourceBytes: Buffer.byteLength(workerText), workerSourceSha256: sha256(workerText), buildId: engine.buildId },
    mainClosure: Object.keys(main.metafile.inputs).filter(p => !p.startsWith('<')).sort(),
    workerClosure: Object.keys(worker.metafile.inputs).filter(p => !p.startsWith('<') && p !== 'worker-entry-virtual.js').sort(),
    embeddedAssets: EMBEDDED_ASSETS.map(([file, role]) => ({ ...byPath.get(file), role })),
  };
}

export async function buildEngineSingle({ outDir = DEFAULT_OUT, allowOwnedReplace = false } = {}) {
  const replacing = await planOutput(outDir, allowOwnedReplace);
  const script = await readFile(fileURLToPath(import.meta.url));
  const built = [];
  for (const variant of VARIANTS) built.push(await buildVariant(variant, script));
  const source = gitIdentity();
  const siblings = built.map(b => b.summary);
  const audits = built.map(b => ({
    schema: 'lm-engine-single-audit/1', engine: b.engine,
    runtime: { file: b.variant.runtime, bytes: b.runtime.length, sha256: b.summary.sha256, jsOutputs: 1, workerSourceBytes: b.summary.workerSourceBytes, workerSourceSha256: b.summary.workerSourceSha256 },
    note: 'Both variants are built from the same inputs and algorithms; they differ only in output text (the minified variant also embeds a minified Worker source). Behavior is intended to be identical and is verified by tests.',
    variants: siblings,
    settings: b.settings, source, inputs: b.inputs, mainClosure: b.mainClosure, workerClosure: b.workerClosure, embeddedAssets: b.embeddedAssets,
    externalAppAssets: 'none embedded: target bundles and media URLs are supplied by the application',
    gates: ['one JS output', 'no external or dynamic imports', 'no development/test/target-quality/tracking-visuals inputs in either closure', 'no development/test identifiers in runtime or Worker source', 'no absolute paths, source maps, Node APIs or network URLs'],
  }));
  // 4. Write into a fresh staging directory next to the destination; nothing existing is touched until it is complete.
  const parent = path.dirname(outDir), staging = path.join(parent, `.${path.basename(outDir)}.staging-${process.pid}`), previous = path.join(parent, `.${path.basename(outDir)}.previous-${process.pid}`);
  await mkdir(parent, { recursive: true });
  let swapped = false, created = false;
  try {
    await mkdir(staging);
    created = true;
    await mkdir(path.join(staging, 'NOTICES'));
    for (const [i, b] of built.entries()) {
      await writeFile(path.join(staging, b.variant.runtime), b.runtime);
      await writeFile(path.join(staging, b.variant.types), TYPES_FORWARDER);
      await writeFile(path.join(staging, b.variant.audit), JSON.stringify(audits[i], null, 2) + '\n');
    }
    for (const name of NOTICE_FILES) await writeFile(path.join(staging, 'NOTICES', name), await readFile(path.join(repo, 'packages/compute', name)));
    // Re-validate right before the swap: the destination may have changed while the bundle was built.
    if (replacing) {
      await assertOwned(outDir);
      await rename(outDir, previous);
      try { await rename(staging, outDir); swapped = true; } catch (error) { await rename(previous, outDir); throw error; }
      // The previous directory was validated as exclusively ours; remove only the known names.
      await assertOwned(previous);
      for (const name of NOTICE_FILES) await unlink(path.join(previous, 'NOTICES', name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(path.join(previous, 'NOTICES')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      for (const name of OWNED_FILES) await unlink(path.join(previous, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(previous);
    } else {
      if (await exists(outDir)) fail(`Output appeared during the build, refusing to touch it: ${outDir}`);
      await rename(staging, outDir);
      swapped = true;
    }
  } finally {
    // Only the staging directory this call created is removed; it is never the destination.
    if (created && !swapped) await rm(staging, { recursive: true, force: true });
  }
  const variants = Object.fromEntries(built.map((b, i) => [b.variant.id, { runtime: path.join(outDir, b.variant.runtime), audit: audits[i] }]));
  // `runtime` and `audit` stay the readable variant, as before the minified variant existed.
  return { outDir, runtime: variants.readable.runtime, audit: variants.readable.audit, variants };
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
    // Only the default output may be rebuilt in place (after ownership validation); a custom directory must be new.
    const result = await buildEngineSingle(outDir ? { outDir } : { allowOwnedReplace: true });
    console.log(JSON.stringify({ runtime: result.runtime, bytes: result.audit.runtime.bytes, sha256: result.audit.runtime.sha256, buildId: result.audit.engine.buildId, variants: Object.fromEntries(Object.entries(result.variants).map(([id, v]) => [id, { runtime: v.runtime, bytes: v.audit.runtime.bytes, sha256: v.audit.runtime.sha256, workerSourceBytes: v.audit.runtime.workerSourceBytes, buildId: v.audit.engine.buildId }])) }));
  } catch (error) { console.error(`build-engine-single: ${error.message}`); process.exit(1); }
}
