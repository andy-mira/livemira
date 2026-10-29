// SPDX-License-Identifier: Apache-2.0
// Builds a LiveMira release directory in the layout of 0.4.1 (what LiveMorae's `sync-livemira` installs from):
//
//   files/      single-file engine (Worker and WebAssembly embedded), the Worker file for strict CSPs, the camera UI,
//               the target rating (its own Worker embedded, and that Worker file), declarations
//   npm/        @livemira/engine, @livemira/ui and @livemira/target-rating tarballs
//   demo/       full-screen demo with sample photos and a video
//   documentation/, README*.md, CHANGELOG.md, LICENSE, NOTICE, 发布说明.md
//   release-manifest.json, SHA256SUMS
//
//   node tools/release.ts                 release/livemira-<version>/ and its .zip (the working tree must be committed)
//   node tools/release.ts --allow-dirty   the same from uncommitted sources (sourceCommit marked "-dirty")

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildEngine, buildRating, buildUi } from './bundle.ts';

export const VERSION = '0.5.0';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs/release');

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== '.DS_Store')
    .flatMap((e) => (e.isDirectory() ? listFiles(join(dir, e.name), base) : [relative(base, join(dir, e.name))]))
    .sort();
}

/** Declarations: the API file's types, then the module's values. */
function declarations(apiFile: string, values: string): string {
  const out = mkdtempSync(join(tmpdir(), 'livemira-dts-'));
  try {
    execFileSync(
      join(ROOT, 'node_modules/.bin/tsc'),
      [
        apiFile,
        '--ignoreConfig',
        '--declaration',
        '--emitDeclarationOnly',
        '--strict',
        '--target',
        'es2022',
        '--lib',
        'es2022,dom',
        '--skipLibCheck',
        '--outDir',
        out,
      ],
      { cwd: ROOT, stdio: 'pipe' },
    );
    const api = readFileSync(join(out, 'api.d.ts'), 'utf8').replace(/^\/\/ SPDX[^\n]*\n/, '');
    return `// SPDX-License-Identifier: Apache-2.0\n// LiveMira ${VERSION}\n\n${api.trim()}\n\n${values.trim()}\n\nexport {};\n`;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const ENGINE_VALUES = `
export declare const ENGINE_VERSION: string;
export declare const engineBuildInfo: EngineBuildInfo;
/** Creates an engine in \`options.container\`. Throws INVALID_CONFIG for invalid options. Nothing starts until \`start()\`. */
export declare function createEngine(options: EngineOptions): Engine;
/** What this device supports, without opening the camera. */
export declare function probeDevice(): Promise<DeviceSupport>;
/** Decodes and compiles a picture file (JPEG, PNG, WebP, …; its own orientation applied) in a Worker. */
export declare function compileTargetImage(image: Blob, options: CompileImageOptions): Promise<TargetBundle>;
/** Loads stored target bytes; refuses damaged data and targets compiled for another descriptor version. */
export declare function parseTarget(bytes: Uint8Array | ArrayBuffer): Promise<TargetBundle>;
export declare class EngineError extends Error implements EngineErrorShape {
  readonly name: 'EngineError';
  readonly code: ErrorCode;
  readonly isRecoverable: boolean;
  readonly missing?: readonly string[];
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; missing?: readonly string[] });
}`;

const RATING_VALUES = `
export declare const RATING_VERSION: string;
export declare const ratingBuildInfo: RatingBuildInfo;
/** Rates a picture file as a target (decoded and compiled as the engine's \`compileTargetImage\` would), in a Worker. */
export declare function rateTargetImage(image: Blob, options?: RateImageOptions): Promise<TargetRating>;
/** Rates an already compiled target: the engine's target bundle or its bytes. */
export declare function rateTarget(target: { readonly bytes: Uint8Array } | Uint8Array, options?: RateOptions): Promise<TargetRating>;
export declare class RatingError extends Error implements RatingErrorShape {
  readonly name: 'RatingError';
  readonly code: RatingErrorCode;
  constructor(code: RatingErrorCode, message: string, options?: { cause?: unknown });
}`;

const UI_VALUES = `
export declare const UI_VERSION: string;
export declare const DEFAULT_LOCALE = 'zh-CN';
export declare const ZH_CN: ArMessages;
export declare const EN: ArMessages;
/** The camera in one call: a session and the default view in \`container\`. \`destroy()\` removes the view, then disposes the session. */
export declare function mountArCamera(container: HTMLElement, options: ArSessionOptions & ArViewOptions): ArCameraHandle;
export declare function createArSession(options: ArSessionOptions): ArSession;
export declare function mountArView(container: HTMLElement, session: ArSessionLike, options?: ArViewOptions): ArViewHandle;
/** Host override, then the host table, then the built-in table of the locale, then Chinese, then the key itself. */
export declare function createTranslator(options?: TranslatorOptions): Translator;
/** 'en' and 'en-*' → 'en'; everything else → 'zh-CN'. */
export declare function resolveLocale(locale: string | null | undefined): 'zh-CN' | 'en';
/** The default \`loadMedia\`: \`fetch\` without credentials or referrer, reporting progress when the size is known. */
export declare const fetchMedia: ArLoadMedia;`;

/** The public repository; each release's directory is release/<version>/ in it, at the tag v<version>. */
const REPOSITORY = 'https://github.com/andy-mira/livemira';
const releaseUrl = `${REPOSITORY}/tree/v${VERSION}/release/${VERSION}`;

/**
 * A release guide as a package README: links relative to the release directory point to the same file in the
 * repository at this version (npm shows a README apart from the release), and `note` goes under the title.
 */
function npmReadme(docPath: string, note: string): string {
  const base = `${REPOSITORY}/blob/v${VERSION}/release/${VERSION}/`;
  const lines = readFileSync(join(DOCS, docPath), 'utf8')
    .replace(
      /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
      (_, target: string) => `](${base}${posix.normalize(posix.join(posix.dirname(docPath), target))})`,
    )
    .split('\n');
  // After the title and its language links.
  const languages = lines.findIndex((line) => line.startsWith('[English]'));
  lines.splice(languages > 0 ? languages + 1 : 1, 0, '', note);
  return lines.join('\n');
}

function npmPackage(
  stage: string,
  pkg: Record<string, unknown>,
  files: Record<string, string | Buffer>,
  into: string,
): string {
  const dir = join(stage, String(pkg.name).replace('/', '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
  const name = execFileSync('npm', ['pack', '--silent', '--pack-destination', into], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return name.split('\n').at(-1)!;
}

export async function release(options: { allowDirty: boolean; out?: string }): Promise<string> {
  const dirty = git('status', '--porcelain', '--', '.').length > 0;
  if (dirty && !options.allowDirty) throw new Error('Uncommitted changes: commit first, or pass --allow-dirty');
  const commit = git('rev-parse', 'HEAD') + (dirty ? '-dirty' : '');
  const out = options.out ?? join(ROOT, 'release', `livemira-${VERSION}`);
  rmSync(out, { recursive: true, force: true });
  for (const d of ['files', 'npm', 'demo/assets', 'documentation']) mkdirSync(join(out, d), { recursive: true });

  // Bundles.
  const engine = await buildEngine(VERSION);
  const ui = { minified: await buildUi(VERSION, 'minified'), readable: await buildUi(VERSION, 'readable') };
  const rating = await buildRating(VERSION);
  const engineDts = declarations('packages/engine/src/api.ts', ENGINE_VALUES);
  const uiDts = declarations('packages/ui/src/api.ts', UI_VALUES);
  const ratingDts = declarations('packages/rating/src/api.ts', RATING_VALUES);
  const files: Record<string, string> = {
    'livemira-engine.min.mjs': engine.minified.code,
    'livemira-engine.mjs': engine.readable.code,
    'livemira-engine-worker.min.js': engine.minified.workerCode,
    'livemira-engine-worker.js': engine.readable.workerCode,
    'livemira-engine.d.ts': engineDts,
    'livemira-ui.min.mjs': ui.minified,
    'livemira-ui.mjs': ui.readable,
    'livemira-ui.d.ts': uiDts,
    'livemira-target-rating.min.mjs': rating.minified.code,
    'livemira-target-rating.mjs': rating.readable.code,
    'livemira-target-rating-worker.min.js': rating.minified.workerCode,
    'livemira-target-rating-worker.js': rating.readable.workerCode,
    'livemira-target-rating.d.ts': ratingDts,
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(out, 'files', name), data);

  // Legal and documentation.
  const license = readFileSync(join(ROOT, 'LICENSE'));
  const notice = readFileSync(join(DOCS, 'NOTICE'));
  const changelog = readFileSync(join(DOCS, 'CHANGELOG.md'));
  writeFileSync(join(out, 'LICENSE'), license);
  writeFileSync(join(out, 'NOTICE'), notice);
  writeFileSync(join(out, 'CHANGELOG.md'), changelog);
  for (const doc of ['README.md', 'README.zh-CN.md']) cpSync(join(DOCS, doc), join(out, doc));
  for (const doc of readdirSync(join(DOCS, 'documentation')))
    cpSync(join(DOCS, 'documentation', doc), join(out, 'documentation', doc));

  // Demo: the page, the minified modules and the sample media.
  for (const f of ['index.html', 'demo.js', 'targets.html', 'rate.html', 'rate.js'])
    cpSync(join(ROOT, 'demo', f), join(out, 'demo', f));
  writeFileSync(join(out, 'demo/livemira-engine.min.mjs'), engine.minified.code);
  writeFileSync(join(out, 'demo/livemira-ui.min.mjs'), ui.minified);
  writeFileSync(join(out, 'demo/livemira-target-rating.min.mjs'), rating.minified.code);
  for (const f of readdirSync(join(ROOT, 'bench/release/assets')).filter((f) => f !== '.DS_Store'))
    cpSync(join(ROOT, 'bench/release/assets', f), join(out, 'demo/assets', f));

  // npm packages: the minified modules, their declarations and the guides; the readable builds stay in files/.
  // The engine and the UI are published to npm; the target rating is offline only (npm/ of the release).
  const stage = mkdtempSync(join(tmpdir(), 'livemira-npm-'));
  try {
    const common = {
      version: VERSION,
      license: 'Apache-2.0',
      type: 'module',
      sideEffects: false,
      repository: { type: 'git', url: `git+${REPOSITORY}.git` },
      homepage: `${REPOSITORY}#readme`,
      bugs: { url: `${REPOSITORY}/issues` },
      publishConfig: { access: 'public' },
    };
    const legal = { 'CHANGELOG.md': changelog, LICENSE: license, NOTICE: notice };
    const packageFiles = ['dist', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'NOTICE'];
    npmPackage(
      stage,
      {
        name: '@livemira/engine',
        ...common,
        description:
          'LiveMira: recognise photos in the camera picture and play their videos on them (WebAR image tracking).',
        keywords: ['webar', 'ar', 'image-tracking', 'image-recognition', 'camera', 'video', 'webgl2', 'webassembly'],
        main: './dist/livemira-engine.min.mjs',
        types: './dist/livemira-engine.d.ts',
        exports: {
          '.': { types: './dist/livemira-engine.d.ts', default: './dist/livemira-engine.min.mjs' },
          './worker': './dist/livemira-engine-worker.min.js',
        },
        files: packageFiles,
      },
      {
        'dist/livemira-engine.min.mjs': files['livemira-engine.min.mjs']!,
        'dist/livemira-engine-worker.min.js': files['livemira-engine-worker.min.js']!,
        'dist/livemira-engine.d.ts': engineDts,
        'README.md': npmReadme(
          'README.md',
          `> **npm:** \`npm install @livemira/engine\`. The files listed below as \`files/livemira-engine*\` are under \`dist/\` here (\`import { createEngine } from '@livemira/engine'\`; the Worker file is \`@livemira/engine/worker\`). The camera UI is \`@livemira/ui\`; the demo and the target rating come with the [release](${releaseUrl}).`,
        ),
        'README.zh-CN.md': npmReadme(
          'README.zh-CN.md',
          `> **npm：** \`npm install @livemira/engine\`。下文中 \`files/livemira-engine*\` 在本包的 \`dist/\` 下（\`import { createEngine } from '@livemira/engine'\`，Worker 文件为 \`@livemira/engine/worker\`）。相机界面是 \`@livemira/ui\`；示例与目标图评分见[发布包](${releaseUrl})。`,
        ),
        ...legal,
      },
      join(out, 'npm'),
    );
    npmPackage(
      stage,
      {
        name: '@livemira/ui',
        ...common,
        description:
          'LiveMira camera UI: the full-screen AR camera (photos, videos, loading, controls) over the LiveMira engine.',
        keywords: ['webar', 'ar', 'camera', 'image-tracking', 'livemira'],
        main: './dist/livemira-ui.min.mjs',
        types: './dist/livemira-ui.d.ts',
        exports: { '.': { types: './dist/livemira-ui.d.ts', default: './dist/livemira-ui.min.mjs' } },
        files: packageFiles,
      },
      {
        'dist/livemira-ui.min.mjs': ui.minified,
        'dist/livemira-ui.d.ts': uiDts,
        'README.md': npmReadme(
          'documentation/ui.md',
          `> **npm:** \`npm install @livemira/ui @livemira/engine\`. The UI contains no engine code: pass the engine module in (\`loadEngine: () => import('@livemira/engine')\`). The full [release](${releaseUrl}) has a demo.`,
        ),
        'README.zh-CN.md': npmReadme(
          'documentation/ui.zh-CN.md',
          `> **npm：** \`npm install @livemira/ui @livemira/engine\`。相机界面不含引擎代码：通过 \`loadEngine: () => import('@livemira/engine')\` 把引擎模块传进来。完整[发布包](${releaseUrl})中有示例。`,
        ),
        ...legal,
      },
      join(out, 'npm'),
    );
    npmPackage(
      stage,
      {
        name: '@livemira/target-rating',
        ...common,
        description:
          'LiveMira target rating: how well the LiveMira engine will find and keep a picture, in stars, without the engine.',
        keywords: ['webar', 'image-tracking', 'target-rating', 'livemira'],
        main: './dist/livemira-target-rating.min.mjs',
        types: './dist/livemira-target-rating.d.ts',
        exports: {
          '.': { types: './dist/livemira-target-rating.d.ts', default: './dist/livemira-target-rating.min.mjs' },
          './worker': './dist/livemira-target-rating-worker.min.js',
        },
        files: packageFiles,
      },
      {
        'dist/livemira-target-rating.min.mjs': rating.minified.code,
        'dist/livemira-target-rating-worker.min.js': rating.minified.workerCode,
        'dist/livemira-target-rating.d.ts': ratingDts,
        'README.md': npmReadme(
          'documentation/target-rating.md',
          `> **Offline package**, not on npm: \`npm install ./livemira-target-rating-${VERSION}.tgz\` from the [release](${releaseUrl}).`,
        ),
        'README.zh-CN.md': npmReadme(
          'documentation/target-rating.zh-CN.md',
          `> **离线包**，不在 npm 上：从[发布包](${releaseUrl})中 \`npm install ./livemira-target-rating-${VERSION}.tgz\`。`,
        ),
        ...legal,
      },
      join(out, 'npm'),
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  // Release notes with this build's numbers.
  const date = new Date().toISOString().slice(0, 10);
  const notes = readFileSync(join(DOCS, '发布说明.md'), 'utf8')
    .replaceAll('{{version}}', VERSION)
    .replaceAll('{{commit}}', commit)
    .replaceAll('{{buildId}}', engine.minified.buildId)
    .replaceAll('{{ratingBuildId}}', rating.minified.buildId)
    .replaceAll('{{date}}', date)
    .replaceAll('{{engineKb}}', (Buffer.byteLength(engine.minified.code) / 1024).toFixed(0))
    .replaceAll('{{uiKb}}', (Buffer.byteLength(ui.minified) / 1024).toFixed(0))
    .replaceAll('{{ratingKb}}', (Buffer.byteLength(rating.minified.code) / 1024).toFixed(0));
  writeFileSync(join(out, '发布说明.md'), notes);

  // Manifest and checksums.
  const listed = listFiles(out).filter((f) => f !== 'SHA256SUMS' && f !== 'release-manifest.json');
  const manifest = {
    schema: 'livemira-release/1',
    name: 'LiveMira',
    version: VERSION,
    tag: `v${VERSION}`,
    sourceCommit: commit,
    buildId: engine.minified.buildId,
    // Each module is built on its own: a change to one leaves the others' files and build ids as they were.
    modules: {
      engine: { file: 'files/livemira-engine.min.mjs', buildId: engine.minified.buildId },
      ui: { file: 'files/livemira-ui.min.mjs' },
      targetRating: { file: 'files/livemira-target-rating.min.mjs', buildId: rating.minified.buildId },
    },
    date,
    stable: !VERSION.includes('-'),
    preview: VERSION.includes('-preview.'),
    // Packages for the npm registry; the others are offline tarballs in npm/ only.
    npmRegistry: ['@livemira/engine', '@livemira/ui'],
    files: listed.map((path) => {
      const data = readFileSync(join(out, path));
      return { path, bytes: data.length, sha256: sha256(data) };
    }),
  };
  writeFileSync(join(out, 'release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  const sums = listFiles(out)
    .filter((f) => f !== 'SHA256SUMS')
    .map((path) => `${sha256(readFileSync(join(out, path)))}  ${path}`);
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);

  // Archive beside the directory.
  const zip = `${out}.zip`;
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', '-X', zip, relative(dirname(out), out)], { cwd: dirname(out) });
  writeFileSync(`${zip}.sha256`, `${sha256(readFileSync(zip))}  ${relative(dirname(out), zip)}\n`);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = await release({ allowDirty: process.argv.includes('--allow-dirty') });
  const size = (p: string): string => `${(statSync(join(out, p)).size / 1024).toFixed(0)} KB`;
  console.log(`LiveMira ${VERSION} → ${out}`);
  console.log(
    `  engine ${size('files/livemira-engine.min.mjs')}, UI ${size('files/livemira-ui.min.mjs')}, ` +
      `target rating ${size('files/livemira-target-rating.min.mjs')}`,
  );
  if (!existsSync(`${out}.zip`)) throw new Error('archive missing');
}
