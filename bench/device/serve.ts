// SPDX-License-Identifier: Apache-2.0
// Device test kit (test side): builds the device pages and Workers, compiles the test targets into G2 assets, writes
// the target pictures for display or print, and serves everything over HTTPS on the LAN (phones need a secure
// context for the camera; the certificate is self-signed, so the phone shows a warning once). With `--tunnel` it also
// opens a Cloudflare quick tunnel (public HTTPS with a trusted certificate) for phones that cannot reach the LAN.
// ⑩ adds LiveMorae's demo photo and video, read from the LiveMorae web directory (`--livemorae <dir>`) into dist/ only:
// they are LiveMorae's and are never copied into this repository.
// Every request needs the access token (printed in the links; kept in a cookie after the first visit), uploads are
// capped, and only files inside dist/ are served. Results POSTed by the pages are saved under
// bench/results/device/reports/.
//   node bench/device/serve.ts [--port 8443] [--tunnel]
//   node bench/device/serve.ts --build-only   rebuild the pages in place (a running server picks them up)

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { build } from 'esbuild';

import { compileTarget, encodeTarget } from '@livemira-next/features';

import { buildEngine } from '../../tools/bundle.ts';
import { buildDemoSite } from '../release/demo-site.ts';
import { VERSION } from '../../tools/release.ts';
import { encodePng } from '../src/png.ts';
import { sendFile } from '../src/send-file.ts';
import { renderSequence, sceneTarget, sequences } from '../src/scene/suites.ts';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = join('bench', 'results', 'device');
const DIST = join(ROOT, 'dist');
const REPORTS = join(ROOT, 'reports');
const PORT = Number(option('port') ?? 8443);
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.css': 'text/css',
};
const ensure = (dir: string): void => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => a!.address);

ensure(DIST);
ensure(REPORTS);
for (const [entry, out] of [
  ['bench/device/page-device.ts', 'device.js'],
  ['bench/device/page-modules.ts', 'modules.js'],
  ['bench/browser/page-webgpu.ts', 'webgpu.js'],
  ['bench/prototype/worker-main.ts', 'worker.js'],
  ['bench/prototype/relocalize-main.ts', 'relocalize-worker.js'],
  ['bench/device/page-compare.ts', 'compare/compare.js'],
  ['bench/device/page-compare-targets.ts', 'compare/targets.js'],
] as const)
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile: join(DIST, out),
    logLevel: 'silent',
    minify: true,
    // The prototype pages read the vision Worker's per-frame diagnostics (compiled out of releases).
    define: { __LIVEMIRA_DIAGNOSTICS__: 'true' },
  });

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title}</title>` +
  `<style>html,body{margin:0;background:#111;color:#eee;font:16px/1.5 -apple-system,system-ui,sans-serif}a{color:#7cf}main{padding:16px}` +
  `#stage{position:relative;width:100vw;height:70vh;overflow:hidden;background:#000}#status{padding:12px 16px;min-height:3em}pre{white-space:pre-wrap;padding:0 16px}li{margin:10px 0}</style>${body}</html>`;

// Targets: the S1/S2 poster and photo plus the graphic distractor, as G2 assets and as pictures to show.
const kinds = ['poster', 'photo', 'graphic'] as const;
ensure(join(DIST, 'assets'));
for (const kind of kinds) {
  const t = sceneTarget(kind);
  const image = { width: 640, height: 480, stride: 640, data: t.gray };
  writeFileSync(
    join(DIST, 'assets', `${t.id}.lmt`),
    await encodeTarget(
      compileTarget({ info: { id: t.id, width: 640, height: 480, physicalWidthMeters: 0.2 }, image }),
      image,
    ),
  );
  writeFileSync(join(DIST, `${t.id}.png`), encodePng(640, 480, t.gray));
  // The picture itself, for the on-device compilation option of the combination page.
  ensure(join(DIST, 'targets'));
  writeFileSync(join(DIST, 'targets', `${t.id}.gray`), t.gray);
}
// The baseline release engine (B0 on the combination page), served as released.
const RELEASE = join('..', 'livemira-github', 'release', '0.4.1', 'files');
for (const [file, served] of [
  ['livemira-engine.mjs', 'baseline-engine.js'],
  ['livemira-tracking-visuals.mjs', 'baseline-visuals.js'],
] as const)
  writeFileSync(join(DIST, served), readFileSync(join(RELEASE, file)));
writeFileSync(
  join(DIST, 'targets.json'),
  JSON.stringify(kinds.map((k) => ({ id: sceneTarget(k).id, width: 640, height: 480 }))),
);
writeFileSync(
  join(DIST, 'frame.gray'),
  renderSequence(
    sceneTarget('poster'),
    sequences().find((s) => s.id === 'T3-shake')!,
  )[0]!.image,
);

writeFileSync(
  join(DIST, 'device.html'),
  page(
    'LiveMira Next 真机测试',
    '<div id="status">加载中…</div><div id="stage"></div><script type="module" src="/device.js"></script>',
  ),
);
writeFileSync(
  join(DIST, 'webgpu.html'),
  page(
    'WebGPU 探针',
    '<main><p id="out">WebGPU 探针运行中…</p></main><script type="module" src="/webgpu.js"></script><script type="module">' +
      'const wait=()=>globalThis.__webgpu?fetch("/report?kind=webgpu",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({userAgent:navigator.userAgent,...globalThis.__webgpu})}).then(r=>{document.getElementById("out").textContent=(r.ok?"已回传：":"回传失败，请截图：")+JSON.stringify(globalThis.__webgpu,null,2)}):setTimeout(wait,300);wait();</script>',
  ),
);
writeFileSync(
  join(DIST, 'modules.html'),
  page(
    '模块组合测试',
    '<style>#app{padding:16px}.muted{color:#999;font-size:14px}.card{border:1px solid #444;border-radius:8px;padding:10px;margin:8px 0;cursor:pointer}' +
      '.card.active{border-color:#7cf;background:#162430}fieldset{border:1px solid #333;border-radius:8px;margin:10px 0}legend{color:#7cf}' +
      '.row{margin:6px 0}.field{color:#ccc;font-weight:600}label{display:block;margin:4px 0 4px 8px}.off{color:#666}.why{color:#e77;font-size:14px}' +
      '.warn{color:#eb5;font-size:14px}button{font-size:16px;padding:8px 16px}table{border-collapse:collapse;font-size:13px}' +
      'td,th{border:1px solid #333;padding:4px 6px;white-space:nowrap}.scroll{overflow-x:auto}</style>' +
      '<div id="app">加载中…</div><script type="module" src="/modules.js"></script>',
  ),
);
writeFileSync(
  join(DIST, 'target.html'),
  page(
    '测试目标',
    '<main><p>在电脑显示器上全屏显示这张图（或打印成 20 cm 宽），作为识别目标。</p><p id="awake" style="color:#999"></p>' +
      // Keeps the computer's display on during the unattended stand run (Screen Wake Lock).
      '<script>(()=>{const s=document.getElementById("awake");let lock=null;const req=()=>{' +
      'if(!navigator.wakeLock){s.textContent="屏幕常亮：此浏览器不支持，请在系统设置里暂时关闭显示器自动休眠";return}' +
      'if(document.visibilityState!=="visible"||(lock&&!lock.released))return;' +
      'navigator.wakeLock.request("screen").then(l=>{lock=l;s.textContent="屏幕常亮：已开启（保持本页在前台即可）";' +
      'l.addEventListener("release",()=>{s.textContent="屏幕常亮已解除，点一下页面重新开启"})},' +
      'e=>{s.textContent="屏幕常亮未开启（"+e.name+"），点一下页面重试"})};' +
      'req();document.addEventListener("visibilitychange",req);document.addEventListener("click",req)})()</script>' +
      kinds
        .map(
          (k) =>
            `<p>${k}</p><img src="/${sceneTarget(k).id}.png" style="width:100%;max-width:960px;image-rendering:auto">`,
        )
        .join('') +
      '</main>',
  ),
);
// ⑩ LiveMorae material comparison: the product UI over a diagnostic build of the engine (per-frame trace events),
// the release demo's photos and video, and LiveMorae's demo photo and video.
const LIVEMORAE_ASSETS = join(option('livemorae') ?? process.env.LIVEMORAE_WEB ?? '', 'src/features/home/assets');
const hasLiveMorae = ['demo-memory.png', 'demo-memory.mp4'].every((f) => existsSync(join(LIVEMORAE_ASSETS, f)));
if (hasLiveMorae) {
  const compare = join(DIST, 'compare');
  ensure(join(compare, 'assets'));
  writeFileSync(
    join(compare, 'livemira-engine.mjs'),
    (await buildEngine(`${VERSION}+diagnostics`, { diagnostics: true })).minified.code,
  );
  for (const f of [
    'bird-01.png',
    'forest-03.png',
    'mountain-01.png',
    'ship-01.png',
    'demo-video.mp4',
    'demo-video.webm',
  ])
    cpSync(join('bench', 'release', 'assets', f), join(compare, 'assets', f));
  for (const f of ['demo-memory.png', 'demo-memory.mp4']) cpSync(join(LIVEMORAE_ASSETS, f), join(compare, 'assets', f));
  writeFileSync(
    join(compare, 'index.html'),
    page(
      '⑩ LiveMorae 素材对比',
      '<main id="landing"><h2>⑩ LiveMorae 素材对比</h2>' +
        '<p>同一套引擎与界面（诊断版），加入 LiveMorae 的演示照片与视频。电脑上打开 <a href="targets.html">对比识别图</a>，点“开始轮换”：它会依次显示 4 种方式，每种 30 秒。</p>' +
        '<ol><li>手机点下面的“开始扫描”，对准电脑屏幕；</li><li>像平时扫照片一样手持扫描，跟着电脑上的提示换到下一张；</li><li>电脑显示“全部完成”后，点手机左上角 ×，数据自动回传（中途每 30 秒也会回传一次）。</li></ol>' +
        '<p>档位：<select id="profile" style="font-size:16px"><option value="swift">Swift（默认）</option><option value="hawk">Hawk</option></select></p>' +
        '<p>处理尺寸：<select id="scale" style="font-size:16px"><option value="1">原尺寸（默认）</option><option value="0.75">3/4</option><option value="0.5">1/2（rc.1）</option></select></p>' +
        '<p class="muted">想对比时，同样的流程每种设置各测一轮。</p>' +
        '<p><button id="start" style="font-size:18px;padding:10px 24px">开始扫描</button></p><p id="result"></p></main>' +
        '<script type="module" src="compare.js"></script>',
    ),
  );
  writeFileSync(
    join(compare, 'targets.html'),
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>⑩ 对比识别图</title>' +
      '<style>html,body{margin:0;background:#f7f1e6;color:#3b3226;font:16px/1.5 -apple-system,system-ui,sans-serif}' +
      'header{padding:14px 20px;min-height:3em;font-size:18px}button{font-size:18px;padding:8px 22px}' +
      '#stage{display:grid;place-items:center;min-height:80vh}img.large{width:min(900px,92vw)}img.small{width:453px}' +
      // LiveMorae's homepage card (its styles.css), at its desktop size.
      '.lm-frame{position:relative;background:#fffaf0;padding:14px 14px 10px;border-radius:6px;box-shadow:0 10px 30px rgba(87,66,38,.12);transform:rotate(1.2deg);border:1px solid #eadfc8}' +
      '.lm-stage{position:relative;width:453px;aspect-ratio:4/3;border-radius:3px;overflow:hidden;background:#e4ecdc}.lm-stage img{display:block;width:100%;height:100%}' +
      '.lm-controls{position:absolute;left:8px;right:8px;bottom:8px;display:flex;align-items:center;gap:6px}' +
      '.lm-pill{min-height:32px;box-sizing:border-box;display:flex;align-items:center;padding:4px 14px;border-radius:999px;background:rgba(59,50,38,.78);color:#fff8ee;font-size:13px}' +
      '.lm-scan{background:#55735a}.lm-badge{position:absolute;top:24px;left:24px;background:#55735a;color:#fff;font-size:12px;padding:2px 10px;border-radius:999px;letter-spacing:.1em}</style>' +
      '<header><span id="label">手机先打开 ⑩ 并点“开始扫描”，再点这里开始。</span> <button id="start">开始轮换</button></header>' +
      '<div id="stage"></div><script type="module" src="targets.js"></script></html>',
  );
} else console.log(`⑩ 跳过：未找到 LiveMorae 的演示素材（${LIVEMORAE_ASSETS}）`);

// ⑪ The demo built from the current source (the target rating page among it), before a release has it; its rating
// page also rates the whole picture set the 0.4.1 samples come from (served here only, not in the release).
await buildDemoSite(join(DIST, 'dev'), `${VERSION}+dev`);
cpSync(join('bench', 'assets', 'target-set'), join(DIST, 'dev', 'target-set'), { recursive: true });

// The newest preview release's demo, for phone acceptance (built by tools/release.ts).
const previews = existsSync('release')
  ? readdirSync('release').filter((d) => d.startsWith('livemira-') && existsSync(join('release', d, 'demo')))
  : [];
const preview = previews.sort().at(-1);
if (preview) cpSync(join('release', preview, 'demo'), join(DIST, 'preview'), { recursive: true });

writeFileSync(
  join(DIST, 'index.html'),
  page(
    'LiveMira Next 真机测试',
    '<main><h2>LiveMira Next 真机测试</h2><ol>' +
      '<li><a href="/device.html?test=caps">① 能力探测</a>（几秒，自动回传）</li>' +
      '<li><a href="/webgpu.html">② WebGPU 探针</a>（几秒，自动回传）</li>' +
      '<li><a href="/device.html?test=engine&seconds=60">③ 引擎 60 秒（默认档位 Swift，即 R1）</a>：对准电脑上的 poster 目标，手持自然晃动</li>' +
      '<li><a href="/device.html?test=engine&seconds=60&compositor=css">④ 引擎 60 秒（CSS 兜底 F4，实验）</a>：同上</li>' +
      '<li><a href="/device.html?test=engine&seconds=600&stand=1">⑤⑥ 支架免操作 10 分钟</a>（静止抖动 + 持续性能，一次测完）：电脑先打开目标图；手机点开后放上支架对准目标，画面稳定 3 秒自动开始，之后不用碰，最好不插电</li>' +
      '<li><a href="/modules.html">⑦ 模块组合测试</a>：各预设、基线与自定义组合（按设计文档 §3.12 约束），结果可对比</li>' +
      '<li><a href="/device.html?test=engine&seconds=30&profile=hawk">⑧ Hawk 档位 30 秒</a>：偏好 Hawk（R3），设备不达标时自动回退到 Swift（R1）或 Wren（R2b）</li>' +
      (preview
        ? `<li><a href="/preview/index.html">⑨ ${preview.replace('livemira-', 'LiveMira ')} 示例（真机验收）</a>：电脑上打开 <a href="/preview/targets.html">示例识别图片</a>，手机点“开始扫描”</li>`
        : '') +
      '<li><a href="/dev/rate.html">⑪ 目标图评分（当前源码）</a>：上传图片或视频（选首帧、尾帧、任意帧）打分，并列出 0.4.1 整套 28 张目标图的评分；<a href="/dev/index.html">当前源码的示例</a>（手机），<a href="/dev/targets.html">识别图片</a>（电脑，左右翻页）</li>' +
      (hasLiveMorae
        ? '<li><a href="/compare/index.html">⑩ LiveMorae 素材对比（回传诊断数据）</a>：电脑上打开 <a href="/compare/targets.html">对比识别图</a>，自动轮换 4 种显示方式，每种 30 秒</li>'
        : '') +
      '</ol><p><a href="/target.html">测试目标图片</a>（在电脑上打开）</p></main>',
  ),
);

if (process.argv.includes('--build-only')) {
  console.log(`已构建到 ${DIST}（运行中的服务会直接提供新文件）`);
  process.exit(0);
}

// Self-signed certificate for the LAN addresses (kept between runs).
const key = join(ROOT, 'key.pem');
const cert = join(ROOT, 'cert.pem');
if (!existsSync(key) || !existsSync(cert)) {
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map((a) => `IP:${a}`)].join(',');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      cert,
      '-days',
      '60',
      '-subj',
      '/CN=livemira-next-device',
      '-addext',
      `subjectAltName=${san}`,
    ],
    { stdio: 'ignore' },
  );
}

// Access token, kept between runs so links stay valid.
const tokenFile = join(ROOT, 'token.txt');
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(12).toString('base64url'));
const TOKEN = readFileSync(tokenFile, 'utf8').trim();
const MAX_UPLOAD = 4 * 1024 * 1024;
const MAX_REPORTS = 2000;
const same = (a: string | null | undefined): boolean =>
  !!a && a.length === TOKEN.length && timingSafeEqual(Buffer.from(a), Buffer.from(TOKEN));
const cookieToken = (req: IncomingMessage): string | null =>
  /(?:^|;\s*)lmk=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
const ROOT_DIST = resolve(DIST);
let reports = 0;

const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const url = new URL(req.url ?? '/', 'https://local');
  const byQuery = same(url.searchParams.get('k'));
  if (!byQuery && !same(cookieToken(req))) {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      page('需要访问令牌', '<main><p>请使用测试服务终端里打印的完整链接（带 <code>?k=</code> 令牌）打开。</p></main>'),
    );
    return;
  }
  const cookie = byQuery
    ? { 'set-cookie': `lmk=${TOKEN}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800` }
    : {};
  if (req.method === 'POST' && url.pathname === '/report') {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD) {
        res.writeHead(413).end('too large');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_UPLOAD) return;
      if (++reports > MAX_REPORTS) {
        res.writeHead(429).end('too many reports');
        return;
      }
      const kind = (url.searchParams.get('kind') ?? 'report').replace(/[^\w.-]/g, '_').slice(0, 64);
      const file = join(REPORTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${kind}.json`);
      writeFileSync(file, Buffer.concat(chunks));
      console.log(`收到结果：${file}`);
      res.writeHead(200, cookie).end('ok');
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // Only files inside dist/ (an encoded "../" must not escape it).
  let path: string;
  try {
    path = resolve(ROOT_DIST, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!path.startsWith(ROOT_DIST + sep)) {
    res.writeHead(404).end();
    return;
  }
  sendFile(req, res, path, {
    ...cookie,
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cache-control': 'no-store',
  }).catch(() => {
    if (!res.headersSent) res.writeHead(404).end();
  });
});
server.listen(PORT, '0.0.0.0', () => {
  console.log('真机测试服务已启动。');
  console.log('局域网（手机与电脑连同一 Wi-Fi；自签名证书，首次需选择继续访问）：');
  for (const a of addresses) console.log(`  https://${a}:${PORT}/?k=${TOKEN}`);
  console.log(`电脑上打开测试目标：https://localhost:${PORT}/target.html?k=${TOKEN}`);
  if (!process.argv.includes('--tunnel')) console.log('Ctrl+C 结束。');
});

// Public access through a Cloudflare quick tunnel (no account; the address changes on every start).
if (process.argv.includes('--tunnel')) {
  const tunnel = spawn(
    'cloudflared',
    ['tunnel', '--no-autoupdate', '--url', `https://localhost:${PORT}`, '--no-tls-verify'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let announced = false;
  tunnel.stderr.on('data', (chunk: Buffer) => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
    if (match && !announced) {
      announced = true;
      console.log('公网（任何网络都可访问，证书受信任）：');
      console.log(`  手机打开：${match[0]}/?k=${TOKEN}`);
      console.log(`  测试目标：${match[0]}/target.html?k=${TOKEN}`);
      console.log('Ctrl+C 结束（隧道一并关闭）。');
    }
  });
  tunnel.on('exit', (code) => console.log(`公网隧道已退出（${code}）`));
  const stop = (): void => {
    tunnel.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
