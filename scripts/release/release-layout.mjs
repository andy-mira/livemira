// Copyright 2026 Andy (@andy-mira)
// SPDX-License-Identifier: Apache-2.0
// Reader/validator/classifier for the central release layout contract (release-layout.json). Pure functions; no output is written here.
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { LEGAL_FILES, SPDX_LICENSE_ID } from './legal.mjs';

export const LAYOUT_PATH = fileURLToPath(new URL('./release-layout.json', import.meta.url));
export const SUPPORTED_LAYOUT_VERSION = 2;
export const DEVELOPMENT_PREFIX = './development/';
const KNOWN_TOOLS = ['recognition-diagnostics', 'target-quality', 'tracking-visuals'];
const CORE_RUNTIME = ['lm-engine.mjs', 'lm-engine.min.mjs'];
const DIR_KEYS = ['audits', 'core', 'docs', 'notices', 'runtime', 'tools', 'types'];
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

function bad(message) { throw new Error(`release layout: ${message}`); }
// A POSIX relative path made of plain segments only: no traversal, absolute, drive, backslash or empty segment.
export function safeRel(value, what = 'path') {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) bad(`${what} is not a safe relative path: ${JSON.stringify(value)}`);
  for (const segment of value.split('/')) if (!segment || segment === '.' || segment === '..') bad(`${what} has an unsafe segment: ${JSON.stringify(value)}`);
  return value;
}
const safeName = (value, what) => { if (safeRel(value, what).includes('/')) bad(`${what} must be a plain file name: ${value}`); return value; };
const underOrEqual = (child, parent) => child === parent || child.startsWith(parent + '/');
export const isDeclaration = (rel, layout) => layout.devRuntime.declarationExtensions.some(extension => rel.endsWith(extension));
export const isDevelopmentExport = key => key.startsWith(DEVELOPMENT_PREFIX);

// The declaration an export's runtime file must pair with: core/x.mjs -> types/core/x.d.mts, tools/t/x.mjs -> types/tools/t/x.d.mts, runtime/a/b.js -> types/runtime/a/b.d.ts.
function declarationFor(layout, file) {
  const { dirs } = layout;
  if (underOrEqual(file, dirs.runtime)) return `${dirs.types}/runtime/${file.slice(dirs.runtime.length + 1).replace(/\.js$/, '.d.ts').replace(/\.mjs$/, '.d.mts')}`;
  if (file.startsWith(`${dirs.core}/`)) return `${dirs.types}/core/${file.slice(dirs.core.length + 1).replace(/\.mjs$/, '.d.mts')}`;
  if (file.startsWith(`${dirs.tools}/`)) return `${dirs.types}/tools/${file.slice(dirs.tools.length + 1).replace(/\.mjs$/, '.d.mts')}`;
  return bad(`no declaration rule for ${file}`);
}
// The stable production export table implied by core and tools: key -> runtime file. Any other non-development export is rejected.
function stableExportTargets(layout) {
  const { dirs, core } = layout, minified = core.requiredRuntime, readable = core.runtime.find(name => name !== minified);
  const wanted = { '.': `${dirs.core}/${minified}`, './browser': `${dirs.core}/${minified}`, './single': `${dirs.core}/${readable}`, './single/min': `${dirs.core}/${minified}` };
  for (const [tool, spec] of Object.entries(layout.tools)) {
    const min = spec.runtime.find(name => name.endsWith('.min.mjs')), plain = spec.runtime.find(name => !name.endsWith('.min.mjs')), at = name => `${dirs.tools}/${tool}/${name}`;
    wanted[`./${tool}`] = at(min ?? plain); wanted[`./${tool}/single`] = at(plain);
    if (min) wanted[`./${tool}/single/min`] = at(min);
  }
  return wanted;
}

export function validateLayout(layout) {
  if (!layout || typeof layout !== 'object') bad('not an object');
  if (layout.schema !== 'lm-release-layout/1') bad(`unsupported schema ${layout.schema}`);
  if (layout.layoutVersion !== SUPPORTED_LAYOUT_VERSION) bad(`unsupported layoutVersion ${layout.layoutVersion}`);
  if (!sameSet(Object.keys(layout.dirs ?? {}), DIR_KEYS)) bad(`dirs must be exactly ${DIR_KEYS.join(', ')}`);
  const dirs = Object.entries(layout.dirs).map(([key, value]) => [key, safeRel(value, `dirs.${key}`)]);
  for (const [a, x] of dirs) for (const [b, y] of dirs) if (a !== b && underOrEqual(x, y)) bad(`dirs.${a} (${x}) collides with dirs.${b} (${y})`);
  const all = [];
  const unique = (value, what) => { if (all.includes(value)) bad(`destination collision: ${what} -> ${value}`); all.push(value); };
  const names = (list, what, suffix) => {
    if (!Array.isArray(list) || !list.length) bad(`${what} must be a non-empty list`);
    for (const name of list) if (!safeName(name, what).endsWith(suffix)) bad(`${what}: ${name} must end with ${suffix}`);
    if (new Set(list).size !== list.length) bad(`${what} has duplicates`);
  };
  for (const name of layout.rootFiles ?? bad('rootFiles missing')) unique(safeName(name, 'rootFiles'), 'root');
  // The legal files travel with every SDK and every curated drop; both root lists must carry them.
  const legal = layout.legal ?? bad('legal missing');
  if (!sameSet(legal.files ?? [], LEGAL_FILES)) bad(`legal.files must be exactly ${LEGAL_FILES.join(' and ')}`);
  if (legal.license !== SPDX_LICENSE_ID) bad(`legal.license must be ${SPDX_LICENSE_ID}`);
  for (const name of legal.files) if (!layout.rootFiles.includes(name) || !layout.curated?.rootFiles?.includes(name)) bad(`legal file ${name} must be a root file of the SDK and of the curated drop`);

  const core = layout.core ?? bad('core missing');
  if (!sameSet(core.runtime ?? [], CORE_RUNTIME)) bad(`core.runtime must be exactly ${CORE_RUNTIME.join(' and ')} (production core is two files)`);
  if (!core.runtime.includes(core.requiredRuntime)) bad('core.requiredRuntime must be one of core.runtime');
  names(core.types, 'core.types', '.d.mts'); names(core.audits, 'core.audits', '.audit.json');
  if (core.types.length !== core.runtime.length) bad('core needs one declaration per runtime file');
  safeRel(core.typesForwardTo, 'core.typesForwardTo');
  const distDirs = [safeName(core.distDir, 'core.distDir')];
  for (const name of core.runtime) unique(`${layout.dirs.core}/${name}`, 'core runtime');
  for (const name of core.types) unique(`${layout.dirs.types}/core/${name}`, 'core types');
  for (const name of core.audits) unique(`${layout.dirs.audits}/core/${name}`, 'core audit');

  if (!sameSet(Object.keys(layout.tools ?? {}), KNOWN_TOOLS)) bad(`tools must be exactly ${KNOWN_TOOLS.join(', ')}`);
  for (const [tool, spec] of Object.entries(layout.tools)) {
    distDirs.push(safeName(spec.distDir, `${tool}.distDir`));
    names(spec.runtime, `${tool}.runtime`, '.mjs'); names(spec.types, `${tool}.types`, '.d.mts'); names(spec.audits, `${tool}.audits`, '.audit.json');
    if (spec.types.length !== spec.runtime.length) bad(`${tool} needs one declaration per runtime file`);
    for (const name of spec.runtime) unique(`${layout.dirs.tools}/${tool}/${name}`, `${tool} runtime`);
    for (const name of spec.types) unique(`${layout.dirs.types}/tools/${tool}/${name}`, `${tool} types`);
    for (const name of spec.audits) unique(`${layout.dirs.audits}/tools/${tool}/${name}`, `${tool} audit`);
  }
  if (new Set(distDirs).size !== distDirs.length) bad('distDir collision between core and tools');

  const dev = layout.devRuntime ?? bad('devRuntime missing');
  for (const name of dev.packages ?? bad('devRuntime.packages missing')) safeName(name, 'devRuntime.packages');
  if (new Set(dev.packages).size !== dev.packages.length) bad('devRuntime.packages has duplicates');
  for (const dir of distDirs) if (dev.packages.includes(dir)) bad(`${dir} is both a standalone dir and a runtime package`);
  for (const rel of [...dev.generated, ...dev.generatedTypes]) safeRel(rel, 'devRuntime.generated');
  for (const name of layout.notices.files) unique(`${layout.dirs.notices}/${safeName(name, 'notices')}`, 'notice');
  safeRel(layout.notices.sourceDir, 'notices.sourceDir');
  for (const [name, source] of Object.entries(layout.docs)) { unique(`${layout.dirs.docs}/${safeName(name, 'docs')}`, 'doc'); safeRel(source, `docs.${name}`); }

  if ('exportWildcards' in layout) bad('wildcard exports are not allowed: every export is an explicit entry');
  if ('aliases' in (layout.curated ?? {})) bad('curated.aliases is not allowed: the drop serves the same stable exports as the SDK');
  const stable = stableExportTargets(layout);
  for (const [key, target] of Object.entries(layout.exports ?? bad('exports missing'))) {
    if (key !== '.' && !(key.startsWith('./') && key.length > 2 && !key.includes('*') && safeRel(key.slice(2), `export key ${key}`))) bad(`export key ${key}`);
    if (!target.types || !target.default) bad(`export ${key} needs types and default`);
    if (!underOrEqual(safeRel(target.types, `export ${key}.types`), layout.dirs.types)) bad(`export ${key}: types must live under ${layout.dirs.types}/`);
    if (![layout.dirs.core, layout.dirs.tools, layout.dirs.runtime].some(dir => underOrEqual(safeRel(target.default, `export ${key}.default`), dir))) bad(`export ${key}: default must live in core, tools or runtime`);
    // Development entries (SDK only) are the only exports that may reach the multi-file runtime; stable entries are exactly the table derived from core and tools.
    if (isDevelopmentExport(key)) { if (!underOrEqual(target.default, layout.dirs.runtime)) bad(`export ${key}: a development export must resolve to ${layout.dirs.runtime}/`); }
    else if (stable[key] !== target.default) bad(`export ${key}: ${key in stable ? `must resolve to ${stable[key]}` : 'is not a stable production export and must be named ./development/...'}`);
    if (target.types !== declarationFor(layout, target.default)) bad(`export ${key}: types must be ${declarationFor(layout, target.default)}`);
  }
  for (const key of Object.keys(stable)) if (!(key in layout.exports)) bad(`stable export ${key} is missing`);
  const exported = Object.values(layout.exports).map(target => target.default);
  const shipped = [...core.runtime.map(name => `${layout.dirs.core}/${name}`), ...Object.entries(layout.tools).flatMap(([tool, spec]) => spec.runtime.map(name => `${layout.dirs.tools}/${tool}/${name}`))];
  for (const file of shipped) if (!exported.includes(file)) bad(`${file} has no package export`);
  safeName(layout.demo.routeRoot, 'demo.routeRoot');
  if (!layout.curated) bad('curated missing');
  curatedExports(layout);
  return layout;
}

export async function loadLayout(file = LAYOUT_PATH) {
  if ((await lstat(file)).isSymbolicLink()) bad(`refusing symbolic link: ${file}`);
  const bytes = await readFile(file);
  return { layout: validateLayout(JSON.parse(bytes.toString('utf8'))), sha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}

// Every private build (dist/) file the layout requires for core and tools.
export function requiredDistFiles(layout) {
  return [{ ...layout.core, id: 'core' }, ...Object.entries(layout.tools).map(([tool, spec]) => ({ ...spec, id: tool }))]
    .flatMap(spec => [...spec.runtime, ...spec.types, ...spec.audits].map(name => `${spec.distDir}/${name}`));
}

// Classify one private build file. Returns { dest, kind } or { discard } for the declared duplicates; anything unknown throws, so a new JS file can never land anywhere by accident.
export function classifyDist(layout, rel) {
  safeRel(rel, 'dist path');
  const [top, ...rest] = rel.split('/'), inner = rest.join('/');
  const standalone = top === layout.core.distDir ? { id: 'core', spec: layout.core, run: layout.dirs.core, types: `${layout.dirs.types}/core`, audits: `${layout.dirs.audits}/core` }
    : Object.entries(layout.tools).filter(([, spec]) => spec.distDir === top).map(([tool, spec]) => ({ id: tool, spec, run: `${layout.dirs.tools}/${tool}`, types: `${layout.dirs.types}/tools/${tool}`, audits: `${layout.dirs.audits}/tools/${tool}` }))[0];
  if (standalone) {
    const { spec } = standalone;
    if (standalone.id === 'core' && spec.discardedDistDirs.includes(rest[0])) return { discard: true, kind: 'duplicate-notice' };
    if (rest.length !== 1) bad(`unclassified file in ${top}/: ${inner}`);
    if (spec.runtime.includes(inner)) return { dest: `${standalone.run}/${inner}`, kind: standalone.id === 'core' ? 'core-runtime' : 'tool-runtime', owner: standalone.id };
    if (spec.types.includes(inner)) return { dest: `${standalone.types}/${inner}`, kind: standalone.id === 'core' ? 'core-types' : 'tool-types', owner: standalone.id };
    if (spec.audits.includes(inner)) return { dest: `${standalone.audits}/${inner}`, kind: standalone.id === 'core' ? 'core-audit' : 'tool-audit', owner: standalone.id };
    bad(`unclassified file in ${top}/: ${inner} (a new standalone file must be added to release-layout.json)`);
  }
  if (!layout.devRuntime.packages.includes(top) || !rest.length) bad(`unclassified build path ${rel}: unknown package directory`);
  if (isDeclaration(rel, layout)) return { dest: `${layout.dirs.types}/runtime/${rel}`, kind: 'dev-types', owner: top };
  if (layout.devRuntime.runtimeExtensions.some(extension => rel.endsWith(extension))) return { dest: `${layout.dirs.runtime}/${rel}`, kind: 'dev-runtime', owner: top };
  bad(`unclassified build file type: ${rel}`);
}

export function packageExports(layout) {
  const exports = {};
  for (const [key, target] of Object.entries(layout.exports)) exports[key] = { types: `./${target.types}`, default: `./${target.default}` };
  exports['./package.json'] = './package.json';
  return exports;
}

// Exports of the curated drop (no shared/runtime): exactly the stable exports, identical to the SDK's; the ./development/... entries stay SDK-only.
export function curatedExports(layout) {
  const out = {};
  for (const [key, target] of Object.entries(layout.exports)) if (!isDevelopmentExport(key) && !underOrEqual(target.default, layout.dirs.runtime)) out[key] = { types: `./${target.types}`, default: `./${target.default}` };
  out['./package.json'] = './package.json';
  return out;
}

// Classified-tree check for the SDK or the curated drop (`development: false` = no shared/runtime tree). Returns the problems; empty means valid.
export function checkTree(layout, files, { development = true, rootFiles = layout.rootFiles } = {}) {
  const problems = [], set = new Set(files), at = prefix => files.filter(file => file.startsWith(prefix));
  const expect = (rel, what) => { if (!set.has(rel)) problems.push(`missing ${what}: ${rel}`); };
  const { dirs } = layout;
  const core = files.filter(file => file.startsWith(`${dirs.core}/`));
  if (core.length !== 2 || !sameSet(core, layout.core.runtime.map(name => `${dirs.core}/${name}`))) problems.push(`${dirs.core}/ must contain exactly ${layout.core.runtime.join(' and ')}, found ${core.length}: ${core.join(', ')}`);
  expect(`${dirs.core}/${layout.core.requiredRuntime}`, 'required core runtime');
  for (const name of layout.core.types) expect(`${dirs.types}/core/${name}`, 'core types');
  for (const name of layout.core.audits) expect(`${dirs.audits}/core/${name}`, 'core audit');
  const toolDirs = [...new Set(at(`${dirs.tools}/`).map(file => file.split('/')[1]))];
  for (const unknown of toolDirs.filter(tool => !layout.tools[tool])) problems.push(`unknown tool directory ${dirs.tools}/${unknown}`);
  for (const [tool, spec] of Object.entries(layout.tools)) {
    const found = at(`${dirs.tools}/${tool}/`);
    if (!sameSet(found, spec.runtime.map(name => `${dirs.tools}/${tool}/${name}`))) problems.push(`${dirs.tools}/${tool}/ must contain exactly its runtime files: ${found.join(', ')}`);
    for (const name of spec.types) expect(`${dirs.types}/tools/${tool}/${name}`, `${tool} types`);
    for (const name of spec.audits) expect(`${dirs.audits}/tools/${tool}/${name}`, `${tool} audit`);
  }
  for (const name of layout.legal.files) expect(name, 'legal file');
  for (const name of layout.notices.files) expect(`${dirs.notices}/${name}`, 'notice');
  for (const name of Object.keys(layout.docs)) expect(`${dirs.docs}/${name}`, 'guide');
  for (const file of files) {
    const known = rootFiles.includes(file) || file.startsWith(`${dirs.core}/`) || file.startsWith(`${dirs.tools}/`) || file.startsWith(`${dirs.types}/`) || file.startsWith(`${dirs.audits}/`) || file.startsWith(`${dirs.notices}/`) || file.startsWith(`${dirs.runtime}/`) || file.startsWith(`${dirs.docs}/`);
    if (!known) problems.push(`file outside the classified layout: ${file}`);
    if (file.startsWith(`${dirs.types}/`) && !isDeclaration(file, layout)) problems.push(`non-declaration in ${dirs.types}/: ${file}`);
    if (file.startsWith(`${dirs.audits}/`) && !file.endsWith('.audit.json')) problems.push(`non-audit in ${dirs.audits}/: ${file}`);
    if (file.startsWith(`${dirs.docs}/`) && !file.endsWith('.md')) problems.push(`non-guide in ${dirs.docs}/: ${file}`);
    if (file.startsWith(`${dirs.runtime}/`) && !development) problems.push(`development runtime is not part of this distribution: ${file}`);
    if (file.startsWith(`${dirs.notices}/`) && !layout.notices.files.includes(file.slice(dirs.notices.length + 1))) problems.push(`unknown notice ${file}`);
    if (/\.(?:m?js|cjs)$/.test(file) && !(file.startsWith(`${dirs.core}/`) || file.startsWith(`${dirs.tools}/`) || file.startsWith(`${dirs.runtime}/`))) problems.push(`JavaScript outside core/tools/runtime: ${file}`);
  }
  const typesRuntime = `${dirs.types}/runtime/`;
  if (development) {
    expect(`${dirs.runtime}/entry/sdk-worker.js`, 'worker entry');
    for (const file of at(`${dirs.runtime}/`)) { const top = file.slice(dirs.runtime.length + 1).split('/')[0]; if (!layout.devRuntime.packages.includes(top) && top !== 'entry') problems.push(`unknown runtime package ${top}`); }
  }
  for (const file of at(typesRuntime)) { const top = file.slice(typesRuntime.length).split('/')[0]; if (!layout.devRuntime.packages.includes(top) && top !== 'entry') problems.push(`unknown runtime types package ${top}`); }
  return problems;
}

// Every export target must exist in the tree.
export function checkExports(layout, files, { development = true } = {}) {
  const set = new Set(files), problems = [];
  for (const [key, target] of Object.entries(layout.exports)) {
    const needsRuntime = underOrEqual(target.default, layout.dirs.runtime);
    if (needsRuntime && !development) continue;
    for (const kind of ['types', 'default']) if (!set.has(target[kind])) problems.push(`export ${key}.${kind} target missing: ${target[kind]}`);
  }
  return problems;
}

// Development Demo routes: SDK-relative source -> Demo-relative destination, from the same contract (no public aliases in the SDK).
export function demoRoutes(layout, files) {
  const root = layout.demo.routeRoot, routes = [];
  const owners = [[layout.dirs.core, layout.core.distDir, layout.core, 'core'], ...Object.entries(layout.tools).map(([tool, spec]) => [`${layout.dirs.tools}/${tool}`, spec.distDir, spec, tool])];
  for (const [dir, distDir, spec, id] of owners) {
    for (const name of spec.runtime) routes.push({ from: `${dir}/${name}`, to: `${root}/${distDir}/${name}` });
    for (const name of spec.audits) routes.push({ from: `${layout.dirs.audits}/${id === 'core' ? 'core' : `tools/${id}`}/${name}`, to: `${root}/${distDir}/${name}` });
  }
  for (const file of files.filter(file => file.startsWith(`${layout.dirs.runtime}/`))) {
    const inner = file.slice(layout.dirs.runtime.length + 1);
    if (!layout.demo.skipRuntime.includes(inner.split('/')[0])) routes.push({ from: file, to: `${root}/${inner}` });
  }
  const targets = routes.map(route => route.to);
  if (new Set(targets).size !== targets.length) bad('demo route collision');
  for (const route of routes) if (!files.includes(route.from)) bad(`demo route source missing from SDK: ${route.from}`);
  return routes.sort((a, b) => a.to < b.to ? -1 : 1);
}
