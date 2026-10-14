import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolveObjectURL } from 'node:buffer';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEngineSingle } from '../../scripts/release/build-engine-single.mjs';

// Builds the single-file engine into temp dirs (never into dist/) and exercises it as a consumer would; also covers the multi-file seams it relies on.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const dist = rel => import(pathToFileURL(path.join(repo, 'dist', rel)).href);
const VARIANT_IDS = ['readable', 'minified'];
let root, first, second;
const variants = {};   // id -> { runtime, audit, text, module }

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lm-engine-single-test-'));
  first = await buildEngineSingle({ outDir: path.join(root, 'a') });
  second = await buildEngineSingle({ outDir: path.join(root, 'b', 'nested') });
  // Import a lone copy of each runtime file: it must not need any sibling file, workspace or dist tree.
  for (const id of VARIANT_IDS) {
    const lone = path.join(root, 'lone', id), runtime = first.variants[id].runtime;
    await mkdir(lone, { recursive: true });
    await cp(runtime, path.join(lone, 'engine.mjs'));
    variants[id] = { runtime, lone: path.join(lone, 'engine.mjs'), audit: first.variants[id].audit, text: await readFile(runtime, 'utf8'), module: await import(pathToFileURL(path.join(lone, 'engine.mjs')).href) };
  }
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('build output: two complete runtime JS variants, metadata and notices beside them, nothing else executable', async () => {
  const files = (await readdir(first.outDir, { recursive: true, withFileTypes: true })).filter(e => e.isFile()).map(e => path.relative(first.outDir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();
  assert.deepEqual(files, ['NOTICES/DLMALLOC-NOTICE.txt', 'NOTICES/EMSCRIPTEN-LICENSE.txt', 'NOTICES/LIBCXX-LICENSE.txt', 'NOTICES/MUSL-COPYRIGHT.txt', 'NOTICES/toolchain-pin.json', 'lm-engine.audit.json', 'lm-engine.d.mts', 'lm-engine.min.audit.json', 'lm-engine.min.d.mts', 'lm-engine.min.mjs', 'lm-engine.mjs']);
  assert.deepEqual(files.filter(f => /\.(?:js|mjs|cjs)$/.test(f)), ['lm-engine.min.mjs', 'lm-engine.mjs'], 'exactly one runtime JS per variant');
  assert.ok(!files.some(f => /\.(?:wasm|wgsl|map)$/.test(f)), 'no child wasm/wgsl/map files');
  for (const id of VARIANT_IDS) {
    const { audit, text, runtime } = variants[id], bytes = await readFile(runtime);
    assert.equal(audit.runtime.jsOutputs, 1);assert.equal(audit.runtime.sha256, sha(bytes));assert.equal(audit.runtime.bytes, bytes.length);
    // Legal banner: copyright, SPDX id, product and variant, and a pointer to the shipped third-party notices; no URL and no runtime import.
    const banner = text.slice(0, text.indexOf('*/') + 2);
    // The version in the banner is the root package.json version (single source), never a separate constant.
    const version = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version;
    assert.match(banner, /^\/\*! Copyright 2026 Andy \(@andy-mira\)\n \* SPDX-License-Identifier: Apache-2\.0\n \* @livemira\/engine single-file runtime \(LiveMira /);
    assert.ok(banner.includes(`single-file runtime (LiveMira ${version}).`), `${id}: banner names version ${version}`);
    assert.match(banner, /Emscripten and musl libc; third-party notices are in shared\/notices\/ of the distribution\./);
    assert.match(banner, new RegExp(`Variant: ${id}\\.`));
    assert.ok(!/https?:\/\/|apache\.org/.test(banner), `${id}: the banner carries no URL`);
    assert.equal(audit.settings.legalBanner, banner, `${id}: the audit records the emitted banner`);
    assert.equal(text.split('SPDX-License-Identifier: Apache-2.0').length - 1 >= 1, true);
    assert.ok(!/NOTICES\//.test(banner), 'the banner points at the distribution layout, not at a private build directory');
  }
  assert.equal(path.basename(variants.readable.runtime), 'lm-engine.mjs');assert.equal(path.basename(variants.minified.runtime), 'lm-engine.min.mjs');
  // Third-party notices are byte copies of the source files, including the full libc++ license (not relabelled) and the dlmalloc dedication.
  for (const notice of ['EMSCRIPTEN-LICENSE.txt', 'MUSL-COPYRIGHT.txt', 'LIBCXX-LICENSE.txt', 'DLMALLOC-NOTICE.txt', 'toolchain-pin.json'])
    assert.deepEqual(await readFile(path.join(first.outDir, 'NOTICES', notice)), await readFile(path.join(repo, 'packages/compute', notice)), notice);
  assert.match(await readFile(path.join(first.outDir, 'NOTICES', 'LIBCXX-LICENSE.txt'), 'utf8'), /Apache License v2\.0 with LLVM Exceptions[\s\S]*LLVM Exceptions to the Apache 2\.0 License[\s\S]*University of Illinois\/NCSA[\s\S]*Copyright \(c\) 2009-2014 by the contributors/);
  assert.match(await readFile(path.join(first.outDir, 'NOTICES', 'DLMALLOC-NOTICE.txt'), 'utf8'), /Doug Lea and released to the public domain[\s\S]*Version 2\.8\.6/);
  assert.ok(!/windowsSdkStatus|selectedBuildMethod/.test(await readFile(path.join(first.outDir, 'NOTICES', 'toolchain-pin.json'), 'utf8')), 'the toolchain pin is technical only');
});

test('variants: distinct bytes and hashes, same inputs and public API, minified Worker source embedded in the minified file only, real size reduction', async () => {
  const [r, m] = [variants.readable, variants.minified];
  assert.notEqual(r.audit.runtime.sha256, m.audit.runtime.sha256);assert.notEqual(r.audit.engine.buildId, m.audit.engine.buildId);
  assert.equal(r.audit.engine.variant, 'readable');assert.equal(m.audit.engine.variant, 'minified');
  assert.equal(r.audit.settings.minify, false);assert.equal(m.audit.settings.minify, true);
  assert.notEqual(r.audit.runtime.workerSourceSha256, m.audit.runtime.workerSourceSha256, 'the embedded Worker string differs per variant');
  // Same source inputs, embedded assets and exported names; only the output text differs.
  assert.deepEqual(r.audit.inputs, m.audit.inputs);assert.deepEqual(r.audit.embeddedAssets, m.audit.embeddedAssets);
  assert.deepEqual(r.audit.mainClosure, m.audit.mainClosure);assert.deepEqual(r.audit.workerClosure, m.audit.workerClosure);
  assert.deepEqual(Object.keys(r.module).sort(), Object.keys(m.module).sort());
  // Each audit carries both variants' hashes (cross-reference), consistent with the files.
  for (const { audit } of [r, m]) assert.deepEqual(audit.variants.map(v => [v.variant, v.file, v.bytes, v.sha256, v.workerSourceBytes]), [['readable', 'lm-engine.mjs', r.audit.runtime.bytes, r.audit.runtime.sha256, r.audit.runtime.workerSourceBytes], ['minified', 'lm-engine.min.mjs', m.audit.runtime.bytes, m.audit.runtime.sha256, m.audit.runtime.workerSourceBytes]]);
  // Minification must reach the embedded Worker, not just the outer text (the Worker is the largest part of the file).
  assert.ok(m.audit.runtime.workerSourceBytes < r.audit.runtime.workerSourceBytes * 0.75, `worker ${m.audit.runtime.workerSourceBytes} vs ${r.audit.runtime.workerSourceBytes}`);
  assert.ok(m.audit.runtime.bytes < r.audit.runtime.bytes * 0.75, `runtime ${m.audit.runtime.bytes} vs ${r.audit.runtime.bytes}`);
  assert.ok(m.audit.runtime.bytes >= m.audit.runtime.workerSourceBytes, 'the runtime holds its Worker source');
  assert.ok(r.text.includes('startVisionWorker') && !m.text.includes('startVisionWorker'), 'readable keeps names, minified does not');
  assert.ok(m.text.split('\n').length * 5 < r.text.split('\n').length, 'minified text is compacted into far fewer lines');
});

for (const id of VARIANT_IDS) test(`audit [${id}]: input hashes are real, closures contain no test/development/quality inputs, embedded assets match their sources`, async () => {
  const { audit, text: runtimeText, module: single } = variants[id];
  assert.equal(audit.schema, 'lm-engine-single-audit/1');assert.equal(audit.engine.format, 'single');assert.equal(audit.engine.variant, id);
  assert.match(audit.engine.inputHash, /^[0-9a-f]{64}$/);assert.equal(audit.engine.buildId, `single-${audit.engine.inputHash.slice(0, 16)}`);
  for (const input of audit.inputs.filter(i => !i.path.startsWith('<'))) {
    const data = await readFile(path.join(repo, input.path));
    assert.equal(sha(data), input.sha256, input.path);assert.equal(data.length, input.bytes, input.path);
  }
  const closure = [...audit.mainClosure, ...audit.workerClosure];
  assert.ok(closure.length > 30);
  for (const input of closure) {
    assert.ok(!/^(tests?|apps|reports|scripts|docs|artifacts)\//.test(input), input);
    assert.ok(!/(^|\/)(mock|replay|diagnostics)\.(ts|mjs|js)$|recorder|phone-trial|benchmark|target-quality|tracking-visuals/i.test(input), input);
  }
  for (const required of ['packages/sdk/src/browser.ts', 'packages/renderer/src/index.ts', 'packages/camera/src/sdk-source.mjs']) assert.ok(audit.mainClosure.includes(required), required);
  for (const required of ['packages/sdk/src/worker-entry.ts', 'packages/sdk/src/worker-runtime.ts', 'packages/compute/artifacts/scalar/compute.wasm', 'packages/compute/shaders/hamming.wgsl']) assert.ok(audit.workerClosure.includes(required), required);
  assert.deepEqual(audit.embeddedAssets.map(a => a.path).sort(), ['packages/compute/artifacts/scalar/compute.mjs', 'packages/compute/artifacts/scalar/compute.wasm', 'packages/compute/shaders/hamming.wgsl', 'packages/compute/src/exact-matching-wasm-binaries.mjs']);
  for (const asset of audit.embeddedAssets) assert.equal(asset.sha256, sha(await readFile(path.join(repo, asset.path))), asset.path);
  assert.ok(!JSON.stringify(audit).includes(repo), 'audit has no absolute workspace path');
  // The runtime itself: no development identifiers, no absolute paths, maps, Node APIs or network URLs.
  for (const name of ['DiagnosticRecorder', 'MockSource', 'MockPipeline', 'MockRenderer', 'ReplaySource', 'ReplayFrameSource', 'phone-trial', 'assessGrayTarget', 'assessTargetImage', 'webar-target-suitability']) assert.ok(!runtimeText.includes(name), name);
  assert.ok(!runtimeText.includes(repo) && !/sourceMappingURL|node:|\brequire\s*\(|\bprocess\.(versions|env|argv)|https?:\/\//.test(runtimeText));
  assert.ok(!/import\s*\(/.test(runtimeText), 'no dynamic import');
});

test('rebuilds are byte-stable and independent of the output directory, for both variants', async () => {
  for (const id of VARIANT_IDS) {
    assert.deepEqual(await readFile(second.variants[id].runtime), await readFile(first.variants[id].runtime), id);
    assert.equal(second.variants[id].audit.engine.inputHash, first.variants[id].audit.engine.inputHash);
    assert.deepEqual({ ...second.variants[id].audit, source: null }, { ...first.variants[id].audit, source: null });
  }
});

for (const id of VARIANT_IDS) test(`public entry imports cleanly in plain Node [${id}]: exports, build identity, no Worker or network on import`, async () => {
  const { audit, text: runtimeText, module: single } = variants[id];
  assert.deepEqual(Object.keys(single).sort(), ['ALGORITHM_VERSION', 'ANMS_ALGORITHM_VERSION', 'CameraFrameSource', 'CssVideoRenderSink', 'Engine', 'EngineError', 'ORIENTED_ALGORITHM_VERSION', 'SUPPORTED_ALGORITHM_VERSIONS',
    'compileGrayTarget', 'createEmbeddedWorkerFactory', 'createEngine', 'createWorkerPipeline', 'engineBuildInfo', 'getFrameGeometry', 'parseTarget', 'prepareWorkerFrame', 'serializeTarget']);
  assert.deepEqual({ ...single.engineBuildInfo }, { format: 'single', variant: id, buildId: audit.engine.buildId, inputHash: audit.engine.inputHash });
  // Re-import in a child with Worker/fetch/Blob URL traps to prove importing has no side effect.
  const { spawnSync } = await import('node:child_process');
  const script = `globalThis.Worker = class { constructor() { console.log('WORKER-CREATED'); } }; globalThis.fetch = () => { console.log('FETCH'); throw new Error('network'); };
    const m = await import(${JSON.stringify(pathToFileURL(variants[id].lone).href)}); console.log('imported', typeof m.createEngine);`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: root, timeout: 60000, env: { PATH: process.env.PATH } });
  assert.equal(out.status, 0, out.stderr);assert.equal(out.stdout.trim(), 'imported function');
});

for (const id of VARIANT_IDS) test(`embedded Worker factory [${id}]: blob URL lives as long as the Worker, failures revoke it, input is validated, nothing is fetched`, async () => {
  const { module: single } = variants[id];
  const events = [];
  const env = {
    Blob: class { constructor(parts, options) { this.parts = parts; this.options = options; } },
    URL: { createObjectURL: blob => { events.push(['create', blob.parts[0], blob.options.type]); return 'blob:test/1'; }, revokeObjectURL: url => events.push(['revoke', url]) },
    Worker: class { constructor(url, options) { events.push(['worker', url, options]); this.l = []; }
      postMessage(m, t) { events.push(['post', m, t]); } terminate() { events.push(['terminate']); }
      addEventListener(t, l) { this.l.push([t, l]); } removeEventListener(t, l) { events.push(['remove', t, l === this.l[0]?.[1]]); } },
  };
  const realFetch = globalThis.fetch;globalThis.fetch = () => { throw new Error('network used'); };
  try {
    const make = single.createEmbeddedWorkerFactory('export {};', env);
    const endpoint = make();
    assert.deepEqual(events.slice(0, 2), [['create', 'export {};', 'text/javascript'], ['worker', 'blob:test/1', { type: 'module', name: 'LiveMira vision' }]]);
    const listener = () => {};
    endpoint.addEventListener('message', listener);endpoint.postMessage({ a: 1 }, []);endpoint.removeEventListener('message', listener);
    assert.equal(events.filter(e => e[0] === 'revoke').length, 0, 'URL stays valid while the Worker lives');
    endpoint.terminate();endpoint.terminate();
    assert.deepEqual(events.filter(e => e[0] === 'revoke'), [['revoke', 'blob:test/1']], 'revoked exactly once on terminate');
    assert.equal(events.filter(e => e[0] === 'terminate').length, 2, 'terminate always reaches the Worker');
    // A throwing Worker constructor must not leak the URL.
    events.length = 0;
    const broken = single.createEmbeddedWorkerFactory('x', { ...env, Worker: class { constructor() { throw new Error('CSP'); } } });
    assert.throws(() => broken(), /CSP/);
    assert.deepEqual(events.map(e => e[0]), ['create', 'revoke']);
    for (const bad of ['', null, undefined, 5, {}]) assert.throws(() => single.createEmbeddedWorkerFactory(bad, env), TypeError);
  } finally { globalThis.fetch = realFetch; }
});

// ---- The real embedded Worker source, driven through the real pipeline in-process --------------------------------------
function texture(seed, width = 320, height = 240) {
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const data = new Uint8Array(width * height).fill(80);
  for (let i = 0; i < 900; i++) { const x = random() % width, y = random() % height, w = 3 + random() % 20, h = 3 + random() % 20, c = random() % 256;
    for (let dy = 0; dy < h && y + dy < height; dy++) for (let dx = 0; dx < w && x + dx < width; dx++) data[(y + dy) * width + x + dx] = c; }
  return { data, width, height };
}
/** Stands in for the browser's Worker: loads the Blob source as a data: module (non-hierarchical import.meta.url, like a blob: Worker). */
// Process-wide, so every fake Worker evaluates a fresh module instance instead of hitting the data: module cache.
let workerScopes = 0;
function installFakeWorker() {
  const log = { created: [], terminated: 0, revoked: [], fetches: 0, scopes: 0 };
  const saved = { Worker: globalThis.Worker, fetch: globalThis.fetch, postMessage: globalThis.postMessage, addEventListener: globalThis.addEventListener, revoke: URL.revokeObjectURL };
  globalThis.fetch = () => { log.fetches++; throw new Error('network used'); };
  URL.revokeObjectURL = url => { log.revoked.push(url); return saved.revoke.call(URL, url); };
  globalThis.Worker = class {
    constructor(url, options) {
      this.options = options;this.url = url;this.listeners = { message: [], error: [], messageerror: [] };this.dead = false;this.handler = null;log.created.push(this);
      this.ready = (async () => {
        const blob = resolveObjectURL(url);assert.ok(blob, 'blob URL resolves while the Worker lives');
        const source = await blob.text();log.source = source;
        globalThis.postMessage = message => setImmediate(() => { if (!this.dead) for (const l of this.listeners.message) l({ data: structuredClone(message) }); });
        globalThis.addEventListener = (type, listener) => { if (type === 'message') this.handler = listener; };
        log.scopes++;
        await import('data:text/javascript;base64,' + Buffer.from(source + `\n//${++workerScopes}`).toString('base64'));
      })();
    }
    postMessage(message, transfer) { const copy = structuredClone(message, { transfer }); this.ready.then(() => { if (!this.dead) this.handler({ data: copy }); }); }
    addEventListener(type, listener) { this.listeners[type].push(listener); }
    removeEventListener(type, listener) { this.listeners[type] = this.listeners[type].filter(l => l !== listener); }
    terminate() { this.dead = true;log.terminated++; }
  };
  return { log, restore() { globalThis.Worker = saved.Worker;globalThis.fetch = saved.fetch;URL.revokeObjectURL = saved.revoke;
    if (saved.postMessage === undefined) delete globalThis.postMessage; else globalThis.postMessage = saved.postMessage;
    if (saved.addEventListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = saved.addEventListener; } };
}
for (const id of VARIANT_IDS) test(`embedded Worker end to end [${id}]: real recognition reaches TRACKING on t1 with measured quality, then loses it on a negative scene`, async () => {
  const { audit, text: runtimeText, module: single } = variants[id];
  const fake = installFakeWorker();
  const capabilities = [];
  let pipeline;
  try {
    const images = [texture(101), texture(102)], negative = texture(777);
    const targets = [];
    for (const [i, image] of images.entries()) targets.push(await single.parseTarget(await single.serializeTarget(await single.compileGrayTarget(image, { targetId: `t${i}` }))));
    pipeline = single.createWorkerPipeline({
      options: { trackingMode: 'absolute', backendPreference: 'wasm', algorithmVersion: single.ALGORITHM_VERSION },
      prepareFrame: (frame, signal) => single.prepareWorkerFrame(frame, null, signal),
      onCapability: c => capabilities.push(c),
    });
    await pipeline.loadTargets(targets);
    await pipeline.reset('s1');
    let frameId = 0;
    const next = async data => {
      frameId++;
      const t = frameId * 33333;
      const frame = { sessionId: 's1', frameId, sourceTimestampUs: t, timestampSource: 'callback', captureTimeUs: null, arrivalTimeUs: t, mappedObservationTimeUs: t, imageIdentity: `img-${frameId}`,
        width: 320, height: 240, pixelFormat: 'gray8', rotation: 0, mirrored: false, calibrationId: null, imageHandle: { kind: 'gray8', data, released: false, release() {} } };
      const result = await pipeline.process(frame, new AbortController().signal);
      assert.equal(result.sessionId, 's1');assert.equal(result.frameId, frameId);
      return result;
    };
    // Positive frames of the second target: real acquisition, then confirmed measured tracking of t1 (not t0, not null).
    let tracked = null;
    for (let i = 0; i < 8 && !tracked; i++) { const r = await next(images[1].data); if (r.state === 'TRACKING') tracked = r; }
    assert.ok(tracked, 'reached TRACKING within 8 positive frames');
    assert.equal(tracked.targetId, 't1');assert.equal(tracked.quality.measured, true);assert.equal(tracked.quality.degenerate, false);
    assert.ok(tracked.quality.inlierCount >= 12 && tracked.quality.inlierRatio >= 0.35, JSON.stringify(tracked.quality));
    assert.ok(tracked.H_imageFromTarget?.length === 9 && tracked.cornersPx?.length === 4);
    // Negative frames: unmeasured prediction is bounded by 100 ms, then the target is lost and the pipeline searches again.
    const states = [];
    let lost = null;
    for (let i = 0; i < 10 && !lost; i++) {
      const r = await next(negative.data);
      states.push(r.state);
      if (r.state === 'LIMITED') { assert.equal(r.quality.measured, false);assert.ok(r.predictionAgeUs <= 100000, `prediction age ${r.predictionAgeUs}`); }
      if (r.state === 'LOST') lost = r;
      else assert.notEqual(r.state, 'TRACKING', 'a scene without the target is never TRACKING');
    }
    assert.ok(lost, `loss reached: ${states.join(',')}`);
    assert.equal(lost.reason, 'prediction-expired');assert.equal(lost.targetId, null);
    assert.equal((await next(negative.data)).state, 'SEARCHING');
    // The embedded WASM really initialised (a failed init reports WASM_INIT_FAILED and CPU preprocessing).
    assert.ok(capabilities.length > 0);
    const last = capabilities.at(-1);
    assert.equal(last.operators.preprocessing, 'wasm-scalar');assert.equal(last.fallbackReason, null);
    assert.equal(fake.log.created.length, 1);assert.deepEqual(fake.log.created[0].options, { type: 'module', name: 'LiveMira vision' });
    assert.equal(fake.log.fetches, 0, 'no network request for engine assets');
    // The Worker a browser would start is exactly this variant's audited Worker closure (minified in the minified file), byte for byte.
    assert.equal(sha(fake.log.source), audit.runtime.workerSourceSha256);assert.equal(Buffer.byteLength(fake.log.source), audit.runtime.workerSourceBytes);
    assert.equal(/startVisionWorker/.test(fake.log.source), id === 'readable');assert.ok(!/DiagnosticRecorder|Mock|Replay|assessGrayTarget/.test(fake.log.source), 'the Blob source is the production Worker closure');
    assert.ok(!/https?:\/\//.test(fake.log.source.replace(/\/\/[^\n]*/g, '')), 'no external URL in the Worker');
    assert.ok(resolveObjectURL(fake.log.created[0].url), 'Blob URL alive during the session');
  } finally {
    try { await pipeline?.dispose(); } finally { fake.restore(); }
  }
  assert.equal(fake.log.terminated, 1);
  assert.deepEqual(fake.log.revoked, [fake.log.created[0].url]);
  assert.equal(resolveObjectURL(fake.log.created[0].url), undefined, 'Blob URL released on termination');
});
for (const id of VARIANT_IDS) test(`embedded Worker cpuMatching [${id}]: the Blob Worker selects the embedded SIMD matcher without fetching and posts the same results as 'js'`, async () => {
  const { module: single } = variants[id];
  const images = [texture(101), texture(102)], targets = [];
  for (const [i, image] of images.entries()) targets.push(await single.compileGrayTarget(image, { targetId: `t${i}` }));
  const run = async (cpuMatching, cpuFeatures) => {
    const fake = installFakeWorker(), capabilities = [], results = [];
    let pipeline;
    try {
      pipeline = single.createWorkerPipeline({ options: { trackingMode: 'absolute', backendPreference: 'cpu', ...(cpuMatching ? { cpuMatching } : {}), ...(cpuFeatures ? { cpuFeatures } : {}) }, prepareFrame: (frame, signal) => single.prepareWorkerFrame(frame, null, signal), onCapability: c => capabilities.push(c) });
      await pipeline.loadTargets(targets);await pipeline.reset('s1');
      for (let frameId = 1; frameId <= 6; frameId++) {
        const t = frameId * 33333, data = (frameId < 5 ? images[1] : texture(777)).data;
        results.push(await pipeline.process({ sessionId: 's1', frameId, sourceTimestampUs: t, timestampSource: 'callback', captureTimeUs: null, arrivalTimeUs: t, mappedObservationTimeUs: t, imageIdentity: `img-${frameId}`,
          width: 320, height: 240, pixelFormat: 'gray8', rotation: 0, mirrored: false, calibrationId: null, imageHandle: { kind: 'gray8', data, released: false, release() {} } }, new AbortController().signal));
      }
      assert.equal(fake.log.fetches, 0, 'no network request for engine assets');
    } finally { try { await pipeline?.dispose(); } finally { fake.restore(); } }
    // Each run owns exactly one Worker, evaluated as its own module instance, terminated with its Blob URL revoked.
    assert.equal(fake.log.created.length, 1);assert.equal(fake.log.scopes, 1);assert.equal(fake.log.terminated, 1);
    assert.deepEqual(fake.log.revoked, [fake.log.created[0].url]);assert.equal(resolveObjectURL(fake.log.created[0].url), undefined);
    return { capability: capabilities.at(-1), results };
  };
  const js = await run('js'), wasm = await run('wasm-experimental'), omitted = await run(undefined), reference = await run('js', { briefOffsets: false });
  assert.equal(js.capability.operators.matching, 'cpu');assert.equal(js.capability.operators.cpuMatching, undefined);
  assert.deepEqual(wasm.capability.operators, { ...js.capability.operators, matching: 'wasm-simd', cpuMatching: 'wasm-experimental', matchingScope: 'legacy-family', matchingSelection: 'simd:selected', matchingFallback: 'none' });
  assert.equal(wasm.capability.fallbackReason, null);
  assert.ok(js.results.some(r => r.state === 'TRACKING' && r.targetId === 't1'), js.results.map(r => r.state).join());
  assert.deepStrictEqual(wasm.results, js.results);
  // 0.2.1 defaults: with both options omitted the Blob Worker runs the embedded WebAssembly matcher and BRIEF offsets; both opt-outs reproduce the same results.
  assert.deepStrictEqual(omitted.capability, wasm.capability);assert.equal(omitted.capability.operators.recognitionFeatures, 'cpu-brief-offsets');assert.equal(omitted.capability.operators.matching, 'wasm-simd');
  assert.equal(reference.capability.operators.recognitionFeatures, undefined);assert.equal(reference.capability.operators.matching, 'cpu');
  assert.deepStrictEqual(omitted.results, reference.results);
});

test('Worker seams: createWasmPreprocessor moduleFactory, runtime asset config, bootstrap without import side effects', async () => {
  const { createWasmPreprocessor } = await dist('compute/src/wasm-preprocessor.mjs');
  const glue = (await dist('compute/artifacts/scalar/compute.mjs')).default;
  let calls = 0;
  const viaFactory = await createWasmPreprocessor({ moduleFactory: () => { calls++; return glue(); } });
  assert.equal(calls, 1);assert.equal(typeof viaFactory.rgbaToGray, 'function');viaFactory.dispose();
  const fileBacked = await createWasmPreprocessor({ variant: 'scalar' });
  assert.equal(typeof fileBacked.rgbaToGray, 'function');fileBacked.dispose();
  await assert.rejects(createWasmPreprocessor({ moduleFactory: 'nope' }), TypeError);
  await assert.rejects(createWasmPreprocessor({ variant: 'bogus', moduleFactory: () => glue() }), RangeError);
  const aborted = new AbortController();aborted.abort();
  await assert.rejects(createWasmPreprocessor({ moduleFactory: () => { throw new Error('must not run'); }, signal: aborted.signal }), { name: 'AbortError' });
  const late = new AbortController();
  await assert.rejects(createWasmPreprocessor({ moduleFactory: async () => { late.abort(); return glue(); }, signal: late.signal }), { name: 'AbortError' });

  const { createVisionWorkerRuntime } = await dist('sdk/src/worker-runtime.js');
  for (const withAssets of [false, true]) {
    const posted = [];let factoryCalls = 0;
    const handle = withAssets ? createVisionWorkerRuntime(m => posted.push(m), undefined, { wasmModuleFactory: () => { factoryCalls++; return glue(); } }) : createVisionWorkerRuntime(m => posted.push(m));
    await handle({ protocol: 1, requestId: 1, generation: 1, type: 'init', options: { trackingMode: 'absolute', backendPreference: 'wasm', algorithmVersion: 'm0-harris-brief256-v1' } });
    assert.equal(posted.at(-1).type, 'ready');
    assert.equal(posted.at(-1).capability.operators.preprocessing, 'wasm-scalar', withAssets ? 'asset factory used' : 'default file-backed path unchanged');
    assert.equal(factoryCalls, withAssets ? 1 : 0);
    await handle({ protocol: 1, requestId: 2, generation: 1, type: 'dispose' });
    assert.equal(posted.at(-1).type, 'ack');
  }

  const { startVisionWorker } = await dist('sdk/src/worker-entry.js');
  const registered = [], scope = { postMessage: m => registered.push(m), addEventListener: (t, l) => registered.push(['add', t, typeof l]), removeEventListener: (t) => registered.push(['remove', t]) };
  assert.deepEqual(registered, [], 'importing worker-entry registered nothing');
  const stop = startVisionWorker(scope);
  assert.deepEqual(registered, [['add', 'message', 'function']]);
  stop();assert.deepEqual(registered.at(-1), ['remove', 'message']);
});

test('multi-file development entry keeps the same public API and declarations', async () => {
  const single = variants.readable.module;
  const multi = await dist('sdk/src/browser.js');
  assert.deepEqual(Object.keys(multi).sort(), Object.keys(single).sort());
  assert.deepEqual({ ...multi.engineBuildInfo }, { format: 'multi-file', variant: null, buildId: null, inputHash: null });
  const declarations = await readFile(path.join(repo, 'dist/sdk/src/browser.d.ts'), 'utf8');
  for (const name of ['createEngine', 'Engine', 'EngineError', 'CameraFrameSource', 'getFrameGeometry', 'prepareWorkerFrame', 'CssVideoRenderSink', 'createWorkerPipeline', 'createEmbeddedWorkerFactory', 'engineBuildInfo', 'compileGrayTarget', 'parseTarget', 'serializeTarget'])
    assert.match(declarations, new RegExp(`\\b${name}\\b`), name);
  for (const name of ['lm-engine.d.mts', 'lm-engine.min.d.mts']) assert.match(await readFile(path.join(first.outDir, name), 'utf8'), /^\/\/ Forwarding declaration only: it needs the multi-file declaration tree .*not a standalone types file\.\nexport \* from '\.\.\/sdk\/src\/browser\.js';\n$/, name);
  // The file-backed Worker default stays for the multi-file tree; the dev tree has no embedded source.
  assert.throws(() => multi.createEmbeddedWorkerFactory(''), TypeError);
  assert.equal('WorkerVisionPipeline' in multi, false, 'the raw class is not a value export of the new browser entry');
  assert.match(declarations, /export type \{[^}]*WorkerVisionPipeline[^}]*\}/);
});

// ---- Output safety: only disposable temp directories are ever passed to the builder ---------------------------------------------------------
import { symlink, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const listing = async dir => (await readdir(dir, { recursive: true })).sort();
const fresh = async name => { const dir = path.join(root, 'safety', name); await mkdir(path.dirname(dir), { recursive: true }); return dir; };
const sentinel = async dir => { await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'keep.txt'), 'precious'); return async () => assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'precious'); };

test('builder never deletes or merges into an existing custom directory (sentinel survives, nothing left behind)', async () => {
  const dir = await fresh('unrelated'), intact = await sentinel(dir), before = await listing(dir);
  await assert.rejects(buildEngineSingle({ outDir: dir }), /already exists, refusing to touch it/);
  await intact();assert.deepEqual(await listing(dir), before);
  // Even when in-place replacement is allowed, a directory that is not exclusively the builder's own is refused.
  await assert.rejects(buildEngineSingle({ outDir: dir, allowOwnedReplace: true }), /unexpected entry keep\.txt/);
  await intact();assert.deepEqual(await listing(dir), before);
  const empty = await fresh('empty');await mkdir(empty);
  await assert.rejects(buildEngineSingle({ outDir: empty }), /already exists/);
  assert.deepEqual(await readdir(empty), []);
  assert.deepEqual((await readdir(path.dirname(dir))).sort(), ['empty', 'unrelated'], 'no staging or previous directories left');
});

test('builder rejects symbolic-link roots, children and lookalike audit files without touching their targets', async () => {
  const realDir = await fresh('link-target'), intact = await sentinel(realDir), link = await fresh('link');
  await symlink(realDir, link);
  for (const options of [{ outDir: link }, { outDir: link, allowOwnedReplace: true }]) await assert.rejects(buildEngineSingle(options), /already exists|not a real directory/);
  await intact();assert.deepEqual(await readdir(realDir), ['keep.txt']);
  // A symlink as the destination's parent is refused too.
  await assert.rejects(buildEngineSingle({ outDir: path.join(link, 'child') }), /parent must not be a symbolic link/);
  assert.deepEqual(await readdir(realDir), ['keep.txt']);
  // Owned-looking directories with a symlinked child, an extra file, or a foreign audit schema are refused unchanged.
  const cases = {
    'child-link': async dir => { await rm(path.join(dir, 'lm-engine.d.mts'));await symlink(path.join(realDir, 'keep.txt'), path.join(dir, 'lm-engine.d.mts')); },
    'notices-link': async dir => { await rm(path.join(dir, 'NOTICES'), { recursive: true });await symlink(realDir, path.join(dir, 'NOTICES')); },
    'extra-file': async dir => { await writeFile(path.join(dir, 'notes.txt'), 'mine'); },
    'extra-notice': async dir => { await writeFile(path.join(dir, 'NOTICES', 'mine.txt'), 'mine'); },
    'foreign-audit': async dir => { await writeFile(path.join(dir, 'lm-engine.audit.json'), '{"schema":"something-else"}'); },
    'no-audit': async dir => { await rm(path.join(dir, 'lm-engine.audit.json')); },
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const dir = await fresh(`owned-${name}`);
    await cp(first.outDir, dir, { recursive: true });await corrupt(dir);
    const before = await listing(dir), runtimeBefore = await readFile(path.join(dir, 'lm-engine.mjs'));
    await assert.rejects(buildEngineSingle({ outDir: dir, allowOwnedReplace: true }), /Refusing to replace/, name);
    assert.deepEqual(await listing(dir), before, name);
    assert.deepEqual(await readFile(path.join(dir, 'lm-engine.mjs')), runtimeBefore, name);
    await intact();
  }
});

test('an owned output can be rebuilt in place (default-directory behavior) with identical bytes and no leftovers', async () => {
  const dir = await fresh('owned-ok');
  await cp(first.outDir, dir, { recursive: true });
  const old = await readFile(path.join(dir, 'lm-engine.mjs'));
  const rebuilt = await buildEngineSingle({ outDir: dir, allowOwnedReplace: true });
  assert.deepEqual(await readFile(rebuilt.runtime), old);
  assert.deepEqual(await listing(dir), await listing(first.outDir));
  assert.ok((await stat(path.join(dir, 'NOTICES'))).isDirectory());
  assert.ok((await readdir(path.dirname(dir))).every(name => !name.startsWith('.')), 'no staging/previous directories left');
  // A rebuild into a stale-but-owned directory replaces its contents (the old runtime is gone, the new one is in place).
  await writeFile(path.join(dir, 'lm-engine.mjs'), 'stale');
  await buildEngineSingle({ outDir: dir, allowOwnedReplace: true });
  assert.deepEqual(await readFile(path.join(dir, 'lm-engine.mjs')), old);
});

test('a directory left by the earlier readable-only builder is still recognised as owned and replaced; nothing foreign is ever deleted', async () => {
  const dir = await fresh('owned-legacy');
  await cp(first.outDir, dir, { recursive: true });
  for (const name of ['lm-engine.min.mjs', 'lm-engine.min.audit.json', 'lm-engine.min.d.mts']) await rm(path.join(dir, name));
  assert.deepEqual((await readdir(dir)).sort(), ['NOTICES', 'lm-engine.audit.json', 'lm-engine.d.mts', 'lm-engine.mjs']);
  await writeFile(path.join(dir, 'lm-engine.mjs'), 'legacy bytes');
  await buildEngineSingle({ outDir: dir, allowOwnedReplace: true });
  assert.deepEqual(await listing(dir), await listing(first.outDir));
  assert.deepEqual(await readFile(path.join(dir, 'lm-engine.min.mjs')), await readFile(variants.minified.runtime));
  // A foreign file next to the new names is still refused, and symlinked new names are too.
  for (const [name, corrupt] of Object.entries({
    'foreign-beside-min': async d => writeFile(path.join(d, 'lm-engine.min.map'), 'mine'),
    'min-symlink': async d => { await rm(path.join(d, 'lm-engine.min.mjs'));await symlink(path.join(d, 'lm-engine.mjs'), path.join(d, 'lm-engine.min.mjs')); },
    'min-is-directory': async d => { await rm(path.join(d, 'lm-engine.min.audit.json'));await mkdir(path.join(d, 'lm-engine.min.audit.json')); },
  })) {
    const other = await fresh(`owned-${name}`);
    await cp(first.outDir, other, { recursive: true });await corrupt(other);
    const before = await listing(other);
    await assert.rejects(buildEngineSingle({ outDir: other, allowOwnedReplace: true }), /Refusing to replace/, name);
    assert.deepEqual(await listing(other), before, name);
  }
});

test('builder refuses dangerous destinations before doing anything', async () => {
  for (const outDir of ['/', path.dirname(repo), repo, path.join(repo, 'packages', 'sdk', 'out'), path.join(repo, 'node_modules', 'x'), 'relative/dir', `${root}/a/../b`])
    await assert.rejects(buildEngineSingle({ outDir, allowOwnedReplace: true }), /outDir|absolute|ancestors|under dist|must be/, outDir);
});

test('CLI: --out-dir needs a value, existing directories are refused, unknown arguments fail', async () => {
  const script = path.join(repo, 'scripts/release/build-engine-single.mjs'), dir = await fresh('cli'), intact = await sentinel(dir);
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: root, timeout: 120000, env: { PATH: process.env.PATH } });
  for (const args of [['--out-dir'], ['--out-dir', '--foo'], ['--out-dir', ''], ['bogus'], ['--out-dir', dir]]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));assert.match(result.stderr, /build-engine-single: /);assert.equal(result.stdout, '');
  }
  await intact();assert.deepEqual(await readdir(dir), ['keep.txt']);
  const ok = run(['--out-dir', await fresh('cli-new')]);
  assert.equal(ok.status, 0, ok.stderr);const out = JSON.parse(ok.stdout);assert.equal(out.bytes, variants.readable.audit.runtime.bytes);assert.equal(out.variants.minified.sha256, variants.minified.audit.runtime.sha256);assert.equal(out.variants.minified.runtime.endsWith('lm-engine.min.mjs'), true);
});

test('recorder metadata keeps the structured engine identity fields and still filters unrelated keys', async () => {
  const { module: single, audit } = variants.minified;
  const { DiagnosticRecorder } = await dist('sdk/src/diagnostics.js');
  const recorder = new DiagnosticRecorder('candidate', 'worker', 10);
  recorder.setMetadata({ engineFormat: single.engineBuildInfo.format, engineVariant: single.engineBuildInfo.variant, engineBuildId: single.engineBuildInfo.buildId, engineInputHash: single.engineBuildInfo.inputHash, evil: 'dropped', engineSecret: 'dropped', notes: 'readable' });
  const metadata = recorder.export().metadata;
  assert.equal(metadata.engineFormat, 'single');assert.equal(metadata.engineVariant, 'minified');assert.equal(metadata.engineBuildId, audit.engine.buildId);assert.equal(metadata.engineInputHash, audit.engine.inputHash);
  assert.equal(metadata.notes, 'readable');assert.ok(!('evil' in metadata) && !('engineSecret' in metadata));
  recorder.setMetadata({ engineBuildId: 'x'.repeat(5000), engineFormat: { nested: true } });
  assert.equal(recorder.export().metadata.engineBuildId.length, 1024, 'bounded like the other string fields');
  assert.equal(recorder.export().metadata.engineFormat, 'single', 'non-scalar values are ignored');
  // The recorder stays outside the production closure.
  assert.ok(![...audit.mainClosure, ...audit.workerClosure].some(p => p.endsWith('diagnostics.ts')));
  assert.ok(![...audit.mainClosure, ...audit.workerClosure].some(p => p.includes('target-quality')), 'the quality utility is outside the engine closure');
  assert.ok(![...audit.mainClosure, ...audit.workerClosure].some(p => p.includes('tracking-visuals')), 'the tracking-visuals companion is outside the engine closure');
});
