#!/usr/bin/env node
// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Builds a private, self-contained local copy of the built engine (dist/) as the package @livemira/engine.
//   node scripts/release/build-engine-package.mjs <fresh-id> [--out-root <absolute-dir>] [--layout <absolute layout json>]
// Output: <out-root>/<id>/ (default out-root: <repo>/artifacts). Refuses to overwrite, never publishes, installs or builds.
// Run `npm run build` first (the root script `npm run engine:package -- <id>` does that).
// The private build tree (dist/) keeps the compiler's layout; this script classifies every file into the production layout
// defined once in scripts/release/release-layout.json (core/, tools/<name>/, shared/{types,audits,notices,runtime}/, docs/).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkExports, checkTree, classifyDist, loadLayout, packageExports, requiredDistFiles, safeRel } from './release-layout.mjs';
import { documentLanguageLinks, materializeDocumentation } from './documentation.mjs';
import { AUTHOR, LEGAL_SOURCE_SCOPE, SPDX_LICENSE_ID } from './legal.mjs';
import { syncMetadata } from './sync-metadata.mjs';
import { isPreviewVersion, RELEASE_GUIDE, RELEASE_VERSION, ENGINE_NAME, ENGINE_PACKAGE_NAME, ROOT_METADATA } from './release-version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_NAME = ENGINE_PACKAGE_NAME, PACKAGE_VERSION = RELEASE_VERSION, MANIFEST_SCHEMA = 'lm-engine-package/1';
const CONTRACTS_ENTRY = 'contracts/src/index.js';
// Files of the private build that are not classified by the layout's standalone sections (those come from requiredDistFiles(layout)).
const REQUIRED = ['sdk/src/index.js', 'sdk/src/cpu.js', 'sdk/src/worker-pipeline.js', 'sdk/src/vision-worker.js', 'sdk/src/diagnostics.js', 'sdk/src/mock.js', 'sdk/src/index.d.ts',
  CONTRACTS_ENTRY, 'contracts/src/index.d.ts', 'camera/src/index.mjs', 'camera/src/index.d.mts', 'renderer/src/index.js', 'renderer/src/index.d.ts', 'renderer/src/perspective.mjs',
  'renderer/src/loading-reveal.mjs', 'renderer/src/loading-reveal.d.mts', 'media/src/video-session.mjs', 'target-compiler/src/index.js', 'recognition/src/index.js', 'tracking/src/index.js', 'compute/src/index.js',
  'compute/artifacts/scalar/compute.mjs', 'compute/artifacts/scalar/compute.wasm', 'compute/artifacts/simd/compute.mjs', 'compute/artifacts/simd/compute.wasm',
  'compute/shaders/gray.wgsl', 'compute/shaders/hamming.wgsl',
  'sdk/src/browser.js', 'sdk/src/browser.d.ts', 'sdk/src/worker-entry.js',
  // Optional workspace-style modules of the standalone tools (the standalone files themselves are required through the layout).
  'target-quality/src/index.js', 'target-quality/src/index.d.ts', 'tracking-visuals/src/index.js', 'tracking-visuals/src/index.d.ts', 'recognition-diagnostics/src/index.js', 'recognition-diagnostics/src/index.d.ts',
  'recognition/src/anms.d.mts', 'recognition/src/legacy-family.d.mts', 'recognition/src/point-stats.d.mts'];
// Inputs whose changes make the package differ from the recorded commit.
// It includes the legal files and public documents copied into the SDK or the curated drop, so an edit to any of them (tracked or untracked) cannot claim a clean source.
const SOURCE_SCOPE = ['packages', 'native', 'tsconfig.json', 'package.json', 'package-lock.json', 'apps/demo/copy-assets.mjs', 'scripts/release/release-layout.json', 'scripts/release/release-layout.mjs', 'scripts/release/build-engine-package.mjs', 'scripts/release/build-engine-single.mjs', 'scripts/release/build-target-quality.mjs', 'scripts/release/build-recognition-diagnostics.mjs', 'scripts/release/build-tracking-visuals.mjs',
  'scripts/release/documentation.mjs', 'scripts/release/SDK.zh-CN.md.template', 'scripts/release/release-version.mjs', 'scripts/release/sync-metadata.mjs', 'scripts/release/package-livemira.py', RELEASE_GUIDE, RELEASE_GUIDE.replace(/\.md$/, '.zh-CN.md'), 'docs/release/livemira-naming.md', 'docs/release/livemira-naming.zh-CN.md', ...LEGAL_SOURCE_SCOPE];
// Directories compiled/copied into dist; used only to refuse a stale dist.
const BUILD_INPUTS = ['packages/*/src', 'packages/recognition/experimental', 'packages/tracking/experimental', 'packages/compute/shaders', 'packages/compute/artifacts'];

function fail(message, code = 1) { const error = new Error(message); error.exitCode = code; throw error; }
const sha256 = data => createHash('sha256').update(data).digest('hex');
const posix = p => p.split(path.sep).join('/');

async function walk(directory, base = directory, files = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    const full = path.join(directory, entry.name), info = await lstat(full);
    if (info.isSymbolicLink()) fail(`Refusing symbolic link in input tree: ${full}`);
    if (info.isDirectory()) await walk(full, base, files);
    else if (info.isFile()) files.push({ full, rel: posix(path.relative(base, full)), mtimeMs: info.mtimeMs });
    else fail(`Unsupported file type in input tree: ${full}`);
  }
  return files;
}
async function newestMtime(directories) {
  let newest = 0;
  for (const directory of directories) {
    let files; try { files = await walk(directory); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const file of files) newest = Math.max(newest, file.mtimeMs);
  }
  return newest;
}
async function expandBuildInputs() {
  const result = [];
  for (const pattern of BUILD_INPUTS) {
    if (!pattern.includes('*')) { result.push(path.join(repo, pattern)); continue; }
    for (const entry of await readdir(path.join(repo, 'packages'), { withFileTypes: true })) if (entry.isDirectory()) result.push(path.join(repo, pattern.replace('*', entry.name)));
  }
  return result;
}
function git(args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
function sourceIdentity() {
  try {
    const commit = git(['rev-parse', 'HEAD']).trim(), status = git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...SOURCE_SCOPE]).split('\n').filter(Boolean);
    return { commit, dirty: status.length > 0, dirtyScope: SOURCE_SCOPE, dirtyEntries: status.slice(0, 100), dirtyEntryCount: status.length };
  } catch { return { commit: null, dirty: null, dirtyScope: SOURCE_SCOPE, dirtyEntries: [], dirtyEntryCount: null, note: 'git identity unavailable' }; }
}

// Bare workspace specifier -> relative compiled contracts path, for runtime JS and declaration files alike.
function rewriteContracts(text, rel) {
  let target = posix(path.relative(path.posix.dirname(rel), CONTRACTS_ENTRY));
  if (!target.startsWith('.')) target = './' + target;
  return text.replace(/(['"])@livemira\/contracts\1/g, JSON.stringify(target));
}
const TEXT = /\.(?:js|mjs|ts|mts)$/;
// tsc emits weaker declarations inferred from these .mjs files; the hand-written .d.mts beside the source are the authoritative types
// (the workspace and every other declaration reference them), so the package ships those instead. dist path -> source path.
const HANDWRITTEN_DECLARATIONS = {
  'camera/src/index.d.mts': 'packages/camera/src/index.d.mts', 'camera/src/sdk-source.d.mts': 'packages/camera/src/sdk-source.d.mts', 'media/src/video-session.d.mts': 'packages/media/src/video-session.d.mts',
  'recognition/experimental/features.d.mts': 'packages/recognition/experimental/features.d.mts', 'recognition/experimental/geometry.d.mts': 'packages/recognition/experimental/geometry.d.mts',
  'recognition/src/legacy-scale.d.mts': 'packages/recognition/src/legacy-scale.d.mts', 'recognition/src/oriented.d.mts': 'packages/recognition/src/oriented.d.mts',
  'recognition/src/anms.d.mts': 'packages/recognition/src/anms.d.mts', 'recognition/src/legacy-family.d.mts': 'packages/recognition/src/legacy-family.d.mts', 'recognition/src/point-stats.d.mts': 'packages/recognition/src/point-stats.d.mts',
  'renderer/src/perspective.d.mts': 'packages/renderer/src/perspective.d.mts', 'renderer/src/loading-reveal.d.mts': 'packages/renderer/src/loading-reveal.d.mts' };

const README = `# ${PACKAGE_NAME} (local ${isPreviewVersion(PACKAGE_VERSION) ? 'preview' : 'stable'} release)

[English](README.md) | [简体中文](README.zh-CN.md)

Classified distribution of the compiled engine. Start with **docs/INTEGRATION.md** (complete usage guide and example). The layout is defined once in release-layout.json:

- \`core/\`: exactly \`lm-engine.min.mjs\` (production, minified) and \`lm-engine.mjs\` (readable). Each is one self-contained ES module with its own embedded Worker, WASM and shaders; nothing else is requested at runtime.
- \`tools/target-quality/\`, \`tools/tracking-visuals/\`, \`tools/recognition-diagnostics/\`: optional standalone tool files, one directory each, self-contained and never imported by the core.
- \`shared/types/\`: every declaration (\`shared/types/core/\`, \`shared/types/tools/<name>/\` and \`shared/types/runtime/\` for the multi-file modules). \`shared/audits/\`: build audits by core/tool. \`shared/notices/\`: third-party notices.
- \`shared/runtime/\`: SDK-only multi-file development modules, reachable only through the explicit \`${PACKAGE_NAME}/development/...\` subpaths and outside the stable production entry contract. Keep it as an intact tree: the Worker (\`shared/runtime/sdk/src/vision-worker.js\`), WASM (\`shared/runtime/compute/artifacts/*/compute.wasm\`) and WGSL (\`shared/runtime/compute/shaders/*.wgsl\`) are located relative to the modules that load them. Production pages do not need it, and the curated production drop does not contain it.
- \`docs/\`: guides (INTEGRATION.md, TARGET-QUALITY.md).

- Stable production entries (the same names and files in the SDK and in the curated drop): \`import { createEngine } from '${PACKAGE_NAME}'\`; \`${PACKAGE_NAME}\` and \`${PACKAGE_NAME}/browser\` serve \`core/lm-engine.min.mjs\`. There is no wildcard export; the list is the package.json "exports".
- One-file engine: \`${PACKAGE_NAME}/single/min\` (\`core/lm-engine.min.mjs\`) or \`${PACKAGE_NAME}/single\` (\`core/lm-engine.mjs\`, readable); same code and public API.
- Optional image-target suitability check (score 0..5, replace below 3): \`${PACKAGE_NAME}/target-quality\` (also \`.../target-quality/single\`), the standalone file \`tools/target-quality/lm-target-quality.mjs\`; see docs/TARGET-QUALITY.md. It is not part of the engine runtime.
- Optional tracking drawing (recognized boundary and current matched points) as a RenderSink decorator: \`${PACKAGE_NAME}/tracking-visuals\` or \`.../single/min\` (minified), \`.../single\` (readable). Loaded only when wanted; the engine files never import it. See docs/INTEGRATION.md, section "Tracking visuals".
- Optional recognition diagnostics (bounded rejection-stage counters and measured point-distribution statistics): \`${PACKAGE_NAME}/recognition-diagnostics\` or \`.../single/min\` (minified), \`.../single\` (readable). Opt-in import; the engine files never import it and it needs the engine's \`observeRecognition\`/\`collectMatchedPoints\` options (default off). See docs/INTEGRATION.md.
- SDK-specific development entries (not in the curated drop, not part of the stable contract): \`${PACKAGE_NAME}/development/{sdk,browser,cpu,worker,mock,camera,renderer,renderer/perspective,media,target-compiler,recognition,tracking,compute,contracts,contracts/worker,target-quality,tracking-visuals,recognition-diagnostics}\`.
- CPU defaults: the Worker matches legacy-family descriptors with the exact WebAssembly matcher (SIMD, then scalar, then JavaScript fallback) and reuses precomputed BRIEF sample offsets unless \`cpuMatching: 'js'\` or \`cpuFeatures: { briefOffsets: false }\` is set. WebGPU stays opt-in. Results and algorithm/schema identifiers are unchanged; matching loss in fast motion is a known issue these defaults do not fix.
- Declarations are self-contained (no path aliases, no workspace source).
- engine-package-manifest.json lists every file with SHA-256, its layout class and the source commit/dirty state; docs/INTEGRATION.md records its source file and hash there too.
- LICENSE is the Apache License 2.0 that covers the original LiveMira code and documentation; NOTICE gives the attribution and the scope of that license. shared/notices/ holds the unchanged third-party texts (Emscripten, musl libc, LLVM libc++ under Apache-2.0 with LLVM Exceptions, dlmalloc) for the embedded WebAssembly, which keep their own licenses.
`;

function packageJson(layout) {
  const files = [...new Set([...Object.values(layout.dirs).map(dir => dir.split('/')[0]), ...layout.rootFiles.filter(name => name !== 'package.json')])].sort();
  return {
    name: PACKAGE_NAME, version: PACKAGE_VERSION, private: true, type: 'module', description: `${ENGINE_NAME} ${PACKAGE_VERSION} local ${isPreviewVersion(PACKAGE_VERSION) ? 'preview' : 'stable'} runtime for tested iPhone Demo scope. Other devices trial. Not published to npm.`,
    license: SPDX_LICENSE_ID, author: AUTHOR,
    exports: packageExports(layout),
    files
  };
}

async function main() {
  await syncMetadata(repo, { check: true });
  const args = process.argv.slice(2);
  let outRoot = path.join(repo, 'artifacts'), id, layoutFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out-root') { outRoot = args[++i]; if (!outRoot || !path.isAbsolute(outRoot)) fail('--out-root requires an absolute directory', 2); }
    else if (args[i] === '--layout') { layoutFile = args[++i]; if (!layoutFile || !path.isAbsolute(layoutFile)) fail('--layout requires an absolute file', 2); }
    else if (args[i].startsWith('-') || id !== undefined) fail(`Unexpected argument: ${args[i]}`, 2);
    else id = args[i];
  }
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(id) || id.includes('..')) fail('Usage: build-engine-package.mjs <fresh-id: 3-80 chars of A-Z a-z 0-9 . _ ->  [--out-root <absolute dir>] [--layout <absolute layout json>]', 2);
  // The layout contract is validated before anything is created: an invalid contract writes nothing.
  const { layout, sha256: layoutSha256, bytes: layoutBytes } = await loadLayout(layoutFile).catch(error => fail(error.message));
  const { dirs } = layout;
  await mkdir(outRoot, { recursive: true });
  outRoot = await realpath(outRoot);
  const dist = path.join(repo, 'dist'), final = path.join(outRoot, id), staging = path.join(outRoot, `.${id}.staging-${process.pid}`);
  if (outRoot === dist || outRoot.startsWith(dist + path.sep)) fail('Output must not be inside dist/');
  if (await lstat(final).then(() => true, () => false)) fail(`Output already exists, refusing to overwrite: ${final}`);
  if (!(await stat(dist).then(s => s.isDirectory(), () => false))) fail('dist/ is missing: run npm run build first');

  const inputs = await walk(dist);
  const have = new Set(inputs.map(f => f.rel));
  const absent = Object.keys(HANDWRITTEN_DECLARATIONS).filter(r => !have.has(r));
  if (absent.length) fail(`dist/ lacks declaration slots for overlay: ${absent.join(', ')}`);
  const missing = [...REQUIRED, ...requiredDistFiles(layout)].filter(r => !have.has(r));
  if (missing.length) fail(`dist/ is incomplete (run npm run build): missing ${missing.join(', ')}`);
  const oldestDist = Math.min(...inputs.map(f => f.mtimeMs)), newestSource = await newestMtime(await expandBuildInputs());
  if (newestSource > oldestDist) fail('dist/ is older than its sources: run npm run build before packaging');

  await mkdir(staging);
  try {
    const records = [];
    // Every package file goes through put(): a destination can be written once (collisions fail) and always gets a layout class in the manifest.
    const put = async (rel, data, origin, kind, extra = {}) => {
      safeRel(rel);
      if (records.some(record => record.path === rel)) fail(`Destination collision in classified layout: ${rel}`);
      const target = path.join(staging, rel); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, data);
      records.push({ path: rel, bytes: data.length, sha256: sha256(data), origin, class: kind, ...extra });
    };
    // Self-contained tools: a static relative import would be a hidden shared runtime dependency.
    const RELATIVE_IMPORT = /\bfrom\s*(['"`])\.{1,2}\/|\bimport\s*\(\s*(['"`])\.{1,2}\//;
    const omitted = [];
    for (const file of inputs) {
      if (file.rel.endsWith('.map')) continue;
      const placed = classifyDist(layout, file.rel);
      if (placed.discard) { omitted.push(file.rel); continue; }
      const rel = placed.dest, kind = placed.kind, extra = placed.owner ? { owner: placed.owner } : {};
      // Standalone files (core and tools) and their audits are hash-audited as produced: raw copies, never rewritten here.
      if (kind === 'core-runtime' || kind === 'tool-runtime' || kind === 'tool-types' || kind === 'core-audit' || kind === 'tool-audit') {
        const data = await readFile(file.full);
        if ((kind === 'tool-runtime' || kind === 'tool-types') && RELATIVE_IMPORT.test(data.toString('utf8'))) fail(`Standalone tool file is not self-contained: ${file.rel}`);
        await put(rel, data, 'copied', kind, extra); continue;
      }
      if (kind === 'core-types') {
        // Forwarding declaration of the core: only its module specifier is re-pointed into the classified runtime declaration tree.
        const original = await readFile(file.full), text = original.toString('utf8'), from = `../${layout.core.typesForwardTo}`;
        if (!text.includes(`'${from}'`)) fail(`Unexpected core forwarding declaration ${file.rel}: lacks '${from}'`);
        const to = path.posix.relative(`${dirs.types}/core`, `${dirs.types}/runtime/${layout.core.typesForwardTo}`);
        await put(rel, Buffer.from(text.replace(`'${from}'`, `'${to}'`).replace('(../sdk/src/*.d.ts)', `(${dirs.types}/runtime/sdk/src/*.d.ts)`)), 'rewritten', kind, { ...extra, sourceSha256: sha256(original) }); continue;
      }
      if (!TEXT.test(file.rel)) { await put(rel, await readFile(file.full), 'copied', kind, extra); continue; }
      // Development modules and their declarations keep their relative tree; only the contracts specifier is rewritten (same relative shape in both trees).
      const overlay = HANDWRITTEN_DECLARATIONS[file.rel], generated = await readFile(file.full);
      const original = overlay ? await readFile(path.join(repo, overlay)) : generated, originalText = original.toString('utf8');
      let text = rewriteContracts(originalText, file.rel);
      if (have.has(file.rel + '.map')) text = text.replace(/\n?\/\/# sourceMappingURL=[^\n]*\s*$/, '\n');
      if (overlay) await put(rel, Buffer.from(text), 'declaration-overlay', kind, { ...extra, overlaySource: overlay, overlaySourceSha256: sha256(original), replacedGeneratedSha256: sha256(generated) });
      else if (text === originalText) await put(rel, original, 'copied', kind, extra);
      else await put(rel, Buffer.from(text), 'rewritten', kind, { ...extra, sourceSha256: sha256(original) });
    }
    const leftovers = [];
    for (const record of records) if (TEXT.test(record.path) && /(['"])@livemira\/contracts\1/.test(await readFile(path.join(staging, record.path), 'utf8'))) leftovers.push(record.path);
    if (leftovers.length) fail(`Unresolved @livemira/contracts specifier remains in: ${leftovers.join(', ')}`);

    const workerForward = "export * from '../sdk/src/worker-pipeline.js';\nexport * from '../sdk/src/diagnostics.js';\n";
    if (layout.devRuntime.generated.join() !== 'entry/sdk-worker.js' || layout.devRuntime.generatedTypes.join() !== 'entry/sdk-worker.d.ts') fail('release layout: unknown generated development entry');
    await put(`${dirs.runtime}/entry/sdk-worker.js`, Buffer.from(workerForward), 'generated', 'dev-runtime', { owner: 'sdk' });
    await put(`${dirs.types}/runtime/entry/sdk-worker.d.ts`, Buffer.from(workerForward), 'generated', 'dev-types', { owner: 'sdk' });
    await put('package.json', Buffer.from(JSON.stringify(packageJson(layout), null, 2) + '\n'), 'generated', 'package');
    await put('README.md', Buffer.from(README), 'generated', 'package');
    const chineseReadme = materializeDocumentation(await readFile(path.join(repo, 'scripts/release/SDK.zh-CN.md.template'), 'utf8'), { PACKAGE_NAME, CHANNEL: isPreviewVersion(PACKAGE_VERSION) ? '候选' : '稳定', COPYRIGHT_YEAR: ROOT_METADATA.livemira.copyrightYear, AUTHOR, LICENSE: SPDX_LICENSE_ID });
    await put('README.zh-CN.md', Buffer.from(chineseReadme), 'generated', 'package');
    // Legal files: raw copies of the repository root files, recorded with their source hash like the guides and notices.
    for (const name of layout.legal.files) {
      const data = await readFile(path.join(repo, name));
      await put(name, data, 'copied-from-source', 'legal', { sourcePath: name, sourceSha256: sha256(data) });
    }
    const layoutSource = path.relative(repo, layoutFile ?? path.join(repo, 'scripts/release/release-layout.json'));
    await put('release-layout.json', layoutBytes, 'copied-from-source', 'layout', { sourcePath: layoutSource.startsWith('..') ? path.basename(layoutSource) : posix(layoutSource), sourceSha256: layoutSha256 });
    for (const [name, source] of Object.entries(layout.docs)) {
      const original = await readFile(path.join(repo, source));
      const guide = Buffer.from(documentLanguageLinks(original.toString('utf8'), name));
      await put(`${dirs.docs}/${name}`, guide, 'language-navigation-adjusted', 'doc', { sourcePath: source, sourceSha256: sha256(original) });
    }
    for (const name of layout.notices.files) {
      const source = `${layout.notices.sourceDir}/${name}`, data = await readFile(path.join(repo, source));
      await put(`${dirs.notices}/${name}`, data, 'copied-from-source', 'notice', { sourcePath: source, sourceSha256: sha256(data) });
    }

    // Final contract check on the staged tree: exact core, known tools, no unclassified files, every export and type path present.
    const staged = [...records.map(record => record.path), 'engine-package-manifest.json'].sort();
    const problems = [...checkTree(layout, staged), ...checkExports(layout, staged)];
    if (problems.length) fail(`Classified layout check failed:\n  ${problems.join('\n  ')}`);

    records.sort((a, b) => a.path < b.path ? -1 : 1);
    const manifest = { schema: MANIFEST_SCHEMA, name: PACKAGE_NAME, version: PACKAGE_VERSION, private: true, packageId: id, builtAtUtc: new Date().toISOString(), nodeVersion: process.version,
      source: sourceIdentity(), license: { spdx: layout.legal.license, files: layout.legal.files, thirdParty: `${dirs.notices}/` },
      approval: 'local stable release; tested iPhone Demo scope; other devices trial; full commercial acceptance pending',
      layout: { schema: layout.schema, layoutVersion: layout.layoutVersion, file: 'release-layout.json', sha256: layoutSha256, dirs, requiredCoreRuntime: `${dirs.core}/${layout.core.requiredRuntime}`,
        coreRuntime: layout.core.runtime.map(name => `${dirs.core}/${name}`), tools: Object.fromEntries(Object.entries(layout.tools).map(([tool, spec]) => [tool, { dir: `${dirs.tools}/${tool}`, runtime: spec.runtime.map(name => `${dirs.tools}/${tool}/${name}`) }])), omittedBuildFiles: omitted },
      transforms: ['dist/**/*.map omitted', 'private dist/ build tree classified into core/, tools/<name>/, shared/{types,audits,notices,runtime}/ and docs/ by release-layout.json (raw copies unless noted)', `dist/${layout.core.distDir}/NOTICES duplicates omitted (shared/notices is authoritative)`,
        'core forwarding declarations re-pointed to shared/types/runtime/sdk/src/browser.js (origin: rewritten)', 'hand-written .d.mts from source replace the tsc-inferred declarations of 10 modules (origin: declaration-overlay)', 'tsc sourceMappingURL trailers removed where the map was omitted', "bare '@livemira/contracts' rewritten to a relative path to contracts/src/index.js (same relative shape in shared/runtime and shared/types/runtime) in .js/.mjs/.ts/.mts"],
      fileCount: records.length, files: records };
    await writeFile(path.join(staging, 'engine-package-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    if (await lstat(final).then(() => true, () => false)) fail(`Output appeared during build, refusing to overwrite: ${final}`);
    await rename(staging, final);
    console.log(JSON.stringify({ output: final, files: records.length + 1, commit: manifest.source.commit, dirty: manifest.source.dirty }));
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
}
main().catch(error => { console.error(`build-engine-package: ${error.message}`); process.exit(error.exitCode ?? 1); });
