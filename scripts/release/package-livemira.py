# Copyright 2026 Andy (@andy-mira)
# SPDX-License-Identifier: Apache-2.0
"""Curate a verified LiveMira local distribution from a classified SDK package; refuse every overwrite.

    python3 scripts/release/package-livemira.py <sdk-dir> <new-output-dir>

The SDK (build-engine-package.mjs) is already classified by scripts/release/release-layout.json. The curated drop keeps exactly that
classification: core/, tools/<name>/, shared/{types,audits,notices}/, docs/. The development runtime tree (shared/runtime) is not shipped here.
"""
from pathlib import Path, PurePosixPath
import hashlib
import json
import os
import shutil
import sys
import zipfile

KNOWN_TOOLS = ['recognition-diagnostics', 'target-quality', 'tracking-visuals']
CORE_RUNTIME = ['lm-engine.mjs', 'lm-engine.min.mjs']
LEGAL_FILES = ['LICENSE', 'NOTICE']
ROOT_METADATA = json.loads((Path(__file__).resolve().parents[2] / 'package.json').read_text())
LICENSE_ID = ROOT_METADATA['license']
ENGINE_NAME = ROOT_METADATA['livemira']['displayName']
ENGINE_PACKAGE_NAME = ROOT_METADATA['livemira']['enginePackageName']
DEVELOPMENT_PREFIX = './development/'
# SDK record classes that belong to the curated drop (everything except the multi-file development runtime and the SDK package/readme files).
RELEASE_GUIDE = 'docs/release/livemira-release.md'  # canonical release guide; mirrors release-version.mjs
CURATED_CLASSES ={'core-runtime', 'tool-runtime', 'core-types', 'tool-types', 'dev-types', 'core-audit', 'tool-audit', 'notice', 'doc', 'legal', 'layout'}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_rel(value, what):
    """A POSIX relative path of plain segments only (no traversal, absolute, drive, backslash)."""
    assert isinstance(value, str) and value and '\\' not in value and '\0' not in value, f'{what}: unsafe path {value!r}'
    path = PurePosixPath(value)
    assert not path.is_absolute() and not (len(value) > 1 and value[1] == ':'), f'{what}: absolute path {value!r}'
    assert all(part not in ('', '.', '..') for part in value.split('/')), f'{what}: unsafe segment in {value!r}'
    return value


def declaration_for(layout, file):
    """Python mirror of release-layout.mjs declarationFor: the declaration an export's runtime file pairs with."""
    dirs = layout['dirs']
    if file.startswith(dirs['runtime'] + '/'):
        inner = file[len(dirs['runtime']) + 1:]
        return f"{dirs['types']}/runtime/" + (inner[:-3] + '.d.ts' if inner.endswith('.js') else inner[:-4] + '.d.mts' if inner.endswith('.mjs') else inner)
    for key, kind in (('core', 'core'), ('tools', 'tools')):
        if file.startswith(dirs[key] + '/'):
            inner = file[len(dirs[key]) + 1:]
            return f"{dirs['types']}/{kind}/" + (inner[:-4] + '.d.mts' if inner.endswith('.mjs') else inner)
    raise AssertionError(f'no declaration rule for {file}')


def stable_export_targets(layout):
    """Python mirror of release-layout.mjs stableExportTargets: the only non-development exports allowed."""
    dirs, core = layout['dirs'], layout['core']
    minified = core['requiredRuntime']
    readable = next(name for name in core['runtime'] if name != minified)
    wanted = {'.': f"{dirs['core']}/{minified}", './browser': f"{dirs['core']}/{minified}", './single': f"{dirs['core']}/{readable}", './single/min': f"{dirs['core']}/{minified}"}
    for tool, spec in layout['tools'].items():
        minimal = next((name for name in spec['runtime'] if name.endswith('.min.mjs')), None)
        plain = next(name for name in spec['runtime'] if not name.endswith('.min.mjs'))
        wanted[f'./{tool}'] = f"{dirs['tools']}/{tool}/{minimal or plain}"
        wanted[f'./{tool}/single'] = f"{dirs['tools']}/{tool}/{plain}"
        if minimal:
            wanted[f'./{tool}/single/min'] = f"{dirs['tools']}/{tool}/{minimal}"
    return wanted


def validate_layout(layout):
    assert layout.get('schema') == 'lm-release-layout/1' and layout.get('layoutVersion') == 2, 'Unsupported release layout'
    assert 'exportWildcards' not in layout, 'wildcard exports are not allowed'
    assert 'aliases' not in layout.get('curated', {}), 'curated.aliases is not allowed'
    core = layout['core']
    assert sorted(core['runtime']) == sorted(CORE_RUNTIME), f'core must be exactly {CORE_RUNTIME}'
    assert core['requiredRuntime'] in core['runtime']
    assert sorted(layout['tools']) == sorted(KNOWN_TOOLS), f'tools must be exactly {KNOWN_TOOLS}'
    legal = layout['legal']
    assert sorted(legal['files']) == sorted(LEGAL_FILES) and legal['license'] == LICENSE_ID, f'legal must be exactly {LEGAL_FILES} under {LICENSE_ID}'
    assert all(name in layout['rootFiles'] and name in layout['curated']['rootFiles'] for name in legal['files']), 'legal files must be root files of the SDK and of the drop'
    for key, value in layout['dirs'].items():
        safe_rel(value, f'dirs.{key}')
    stable = stable_export_targets(layout)
    runtime = layout['dirs']['runtime'] + '/'
    for key, target in layout['exports'].items():
        assert key == '.' or (key.startswith('./') and len(key) > 2 and '*' not in key), f'bad export key {key}'
        if key != '.':
            safe_rel(key[2:], f'export key {key}')
        safe_rel(target['types'], 'export types')
        safe_rel(target['default'], 'export default')
        if key.startswith(DEVELOPMENT_PREFIX):
            assert target['default'].startswith(runtime), f'export {key}: a development export must resolve to {runtime}'
        else:
            assert stable.get(key) == target['default'], f'export {key}: not a stable production export (development entries are named ./development/...)'
        assert target['types'] == declaration_for(layout, target['default']), f'export {key}: types must be {declaration_for(layout, target["default"])}'
    assert all(key in layout['exports'] for key in stable), 'a stable export is missing'
    return layout


def curated_exports(layout):
    """Python mirror of release-layout.mjs curatedExports: exactly the stable exports (core/ and tools/ targets); ./development/... stays SDK-only."""
    runtime = layout['dirs']['runtime'] + '/'
    out = {key: {'types': './' + target['types'], 'default': './' + target['default']}
           for key, target in layout['exports'].items() if not key.startswith(DEVELOPMENT_PREFIX) and not target['default'].startswith(runtime)}
    out['./package.json'] = './package.json'
    return out


def check_tree(layout, files):
    """Python mirror of release-layout.mjs checkTree for a distribution without the development runtime."""
    dirs, problems, present = layout['dirs'], [], set(files)
    root_files = set(layout['curated']['rootFiles'])
    core = sorted(f for f in files if f.startswith(dirs['core'] + '/'))
    if core != sorted(f"{dirs['core']}/{name}" for name in layout['core']['runtime']):
        problems.append(f"{dirs['core']}/ must contain exactly {layout['core']['runtime']}, found {core}")
    for tool in sorted({f.split('/')[1] for f in files if f.startswith(dirs['tools'] + '/')} - set(layout['tools'])):
        problems.append(f"unknown tool directory {tool}")
    for tool, spec in layout['tools'].items():
        found = sorted(f for f in files if f.startswith(f"{dirs['tools']}/{tool}/"))
        if found != sorted(f"{dirs['tools']}/{tool}/{name}" for name in spec['runtime']):
            problems.append(f"{dirs['tools']}/{tool}/ must contain exactly its runtime files, found {found}")
        for name in spec['types']:
            if f"{dirs['types']}/tools/{tool}/{name}" not in present:
                problems.append(f'missing {tool} types {name}')
        for name in spec['audits']:
            if f"{dirs['audits']}/tools/{tool}/{name}" not in present:
                problems.append(f'missing {tool} audit {name}')
    for name in layout['core']['types']:
        if f"{dirs['types']}/core/{name}" not in present:
            problems.append(f'missing core types {name}')
    for name in layout['core']['audits']:
        if f"{dirs['audits']}/core/{name}" not in present:
            problems.append(f'missing core audit {name}')
    for name in layout['legal']['files']:
        if name not in present:
            problems.append(f'missing legal file {name}')
    for name in layout['notices']['files']:
        if f"{dirs['notices']}/{name}" not in present:
            problems.append(f'missing notice {name}')
    for name in layout['docs']:
        if f"{dirs['docs']}/{name}" not in present:
            problems.append(f'missing guide {name}')
    for file in files:
        top = [dirs[key] + '/' for key in ('core', 'tools', 'types', 'audits', 'notices', 'docs')]
        if file not in root_files and not any(file.startswith(prefix) for prefix in top):
            problems.append(f'file outside the classified layout: {file}')
        if file.startswith(dirs['runtime'] + '/'):
            problems.append(f'development runtime is not part of this distribution: {file}')
        if file.endswith(('.js', '.mjs', '.cjs')) and not (file.startswith(dirs['core'] + '/') or file.startswith(dirs['tools'] + '/')):
            problems.append(f'JavaScript outside core/tools: {file}')
        if file.startswith(dirs['types'] + '/') and not file.endswith(('.d.ts', '.d.mts')):
            problems.append(f'non-declaration in types: {file}')
    # Every export that is shipped here (types always; JS only for core/tools) must exist.
    for key, target in curated_exports(layout).items():
        if isinstance(target, str):
            continue
        for kind in ('types', 'default'):
            if target[kind][2:] not in present:
                problems.append(f'export {key}.{kind} missing: {target[kind]}')
    return problems


assert len(sys.argv) == 3, 'Usage: package-livemira.py <sdk-dir> <new-output-dir>'
assert not Path(sys.argv[1]).is_symlink(), 'SDK root must not be a symbolic link'
assert not Path(sys.argv[2]).is_symlink(), 'Output must not be a symbolic link'
sdk, output = map(lambda value: Path(value).resolve(), sys.argv[1:3])
root = Path(__file__).resolve().parents[2]
archive = output.parent / (output.name + '.zip')
staging = output.parent / f'.{output.name}.staging-{os.getpid()}'
assert sdk.is_dir() and not sdk.is_symlink(), 'SDK directory required'
manifest = json.loads((sdk / 'engine-package-manifest.json').read_text())
package = json.loads((sdk / 'package.json').read_text())
assert manifest['source']['dirty'] is False, 'Committed release source required'
assert package['name'] == ENGINE_PACKAGE_NAME == manifest['name']
assert package['license'] == LICENSE_ID, f'SDK package.json must declare {LICENSE_ID}'
version = manifest['version']
assert package['version'] == version, 'SDK package.json and manifest versions differ'
# The root package.json is the single source of the release version.
assert ROOT_METADATA['version'] == version, 'SDK version differs from the root package.json version'
assert not output.exists() and not archive.exists() and not staging.exists(), 'Refusing to overwrite an existing release'

# The classification comes from the SDK's own recorded contract, which must equal the repository's current one.
layout_bytes = (sdk / 'release-layout.json').read_bytes()
layout = validate_layout(json.loads(layout_bytes))
assert sha256(layout_bytes) == manifest['layout']['sha256'] == sha256((root / 'scripts/release/release-layout.json').read_bytes()), 'SDK was not built with the current release layout'

# Exact SDK closure: every disk file is recorded (and only those), no symlinks, no traversal, every hash matches.
assert not any(path.is_symlink() for path in sdk.rglob('*')), 'No symbolic links in the SDK'
on_disk = {path.relative_to(sdk).as_posix() for path in sdk.rglob('*') if path.is_file()}
recorded = {safe_rel(row['path'], 'manifest path') for row in manifest['files']}
assert len(recorded) == len(manifest['files']), 'Duplicate manifest paths'
assert on_disk == recorded | {'engine-package-manifest.json'}, f'SDK files differ from manifest: {sorted(on_disk ^ (recorded | {"engine-package-manifest.json"}))[:10]}'
for row in manifest['files']:
    data = (sdk / row['path']).read_bytes()
    assert len(data) == row['bytes'] and sha256(data) == row['sha256'], row['path']

classes = {row['path']: row.get('class') for row in manifest['files']}
assert all(classes.values()), 'SDK manifest lacks layout classes: rebuild the SDK with the current build-engine-package.mjs'
try:
    staging.mkdir(parents=True)
    copied = []
    for row in manifest['files']:
        if classes[row['path']] in CURATED_CLASSES:
            destination = staging / row['path']
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(sdk / row['path'], destination)  # raw copy: bytes identical to the verified SDK
            copied.append(row['path'])
    extras = {}
    readme_source = root / RELEASE_GUIDE
    for destination, source in [('README.md', readme_source), ('docs/NAMING.md', root / 'docs/release/livemira-naming.md'), ('docs/MEDIA.md', root / 'packages/media/README.md')]:
        assert destination not in copied, f'Destination collision: {destination}'
        shutil.copyfile(source, staging / destination)
        extras[destination] = {'sourcePath': source.relative_to(root).as_posix(), 'sourceSha256': sha256(source.read_bytes()), 'class': 'doc'}
    # Minimal package.json: exports come from the central layout and resolve only to files that exist in this drop (the SDK package.json would dangle without shared/runtime).
    package_json = {'name': package['name'], 'version': version, 'private': True, 'type': 'module', 'description': package['description'], 'license': package['license'], 'author': package['author'],
                    'exports': curated_exports(layout), 'files': sorted({value.split('/')[0] for value in layout['dirs'].values()} | (set(layout['curated']['rootFiles']) - {'package.json'}))}
    assert 'package.json' not in copied, 'Destination collision: package.json'
    for name in LEGAL_FILES:
        assert (staging / name).is_file() and (staging / name).read_bytes() == (root / name).read_bytes(), f'{name} must be a byte copy of the repository root file'
    (staging / 'package.json').write_text(json.dumps(package_json, indent=2) + '\n')
    extras['package.json'] = {'class': 'package', 'generatedFrom': 'release-layout.json'}
    problems = check_tree(layout, sorted(p.relative_to(staging).as_posix() for p in staging.rglob('*') if p.is_file()) + ['release-manifest.json'])
    assert not problems, 'Classified layout check failed:\n  ' + '\n  '.join(problems)
    files = []
    for source in sorted(staging.rglob('*'), key=lambda path: path.relative_to(staging).as_posix()):
        if source.is_file():
            relative = source.relative_to(staging).as_posix()
            data = source.read_bytes()
            files.append({'path': relative, 'bytes': len(data), 'sha256': sha256(data), 'class': extras[relative]['class'] if relative in extras else classes[relative], **{k: v for k, v in extras.get(relative, {}).items() if k != 'class'}})
    stable = '-' not in version.split('+')[0]
    release = {
        'schema': 'lm-release/2', 'name': ENGINE_NAME, 'version': version, 'channel': 'stable' if stable else 'preview',
        'releaseId': output.name, 'releaseKind': 'local-stable' if stable else 'local-preview', 'source': manifest['source'],
        'license': {'spdx': LICENSE_ID, 'files': LEGAL_FILES, 'thirdParty': f"{layout['dirs']['notices']}/"},
        'sdk': {'name': manifest['name'], 'packageId': manifest['packageId'], 'manifestSha256': sha256((sdk / 'engine-package-manifest.json').read_bytes()), 'fileCount': manifest['fileCount']},
        'algorithmBaseline': f'{ENGINE_NAME} {version}', 'productionReady': False, 'phoneFunctionalSuiteRepeated': False,
        'supportScope': 'Tested in an iPhone browser Demo integration; other devices and environments are trial',
        'layout': {'schema': layout['schema'], 'layoutVersion': layout['layoutVersion'], 'file': 'release-layout.json', 'sha256': sha256(layout_bytes), 'dirs': layout['dirs'],
                   'requiredCoreRuntime': f"{layout['dirs']['core']}/{layout['core']['requiredRuntime']}",
                   'coreRuntime': [f"{layout['dirs']['core']}/{name}" for name in layout['core']['runtime']],
                   'tools': {tool: [f"{layout['dirs']['tools']}/{tool}/{name}" for name in spec['runtime']] for tool, spec in layout['tools'].items()}},
        'runtimeNecessaryFiles': [f"{layout['dirs']['core']}/{layout['core']['requiredRuntime']}"],
        'optionalFiles': {tool: [f"{layout['dirs']['tools']}/{tool}/{name}" for name in spec['runtime']] for tool, spec in layout['tools'].items()},
        'typeFiles': f"{layout['dirs']['types']}/** (core, tools/<name>, runtime)", 'auditFiles': f"{layout['dirs']['audits']}/** (core, tools/<name>)",
        'noticeFiles': f"{layout['dirs']['notices']}/*", 'files': files,
    }
    (staging / 'release-manifest.json').write_text(json.dumps(release, ensure_ascii=False, indent=2) + '\n')
    assert not output.exists() and not archive.exists(), 'Release appeared during build; refusing to overwrite'
    staging.rename(output)
except BaseException:
    shutil.rmtree(staging, ignore_errors=True)
    raise
with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
    for source in sorted(output.rglob('*'), key=lambda path: path.relative_to(output).as_posix()):
        if source.is_file():
            target.write(source, arcname=str(Path(output.name) / source.relative_to(output)))
print(json.dumps({'output': str(output), 'zip': str(archive), 'sha256': sha256(archive.read_bytes()), 'files': len(files) + 1}))
