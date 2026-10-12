# 引擎集成指南

[English](README.md) | [简体中文](README.zh-CN.md)

本指南随 `@livemira/engine` 软件包一同提供（作为其 `docs` 目录中的 `INTEGRATION.md`），同时也包含在源码仓库中（`packages/sdk/README.md`）；两份副本完全相同。您无需检出源码即可遵循本指南。

状态：LiveMira 0.2.0（首个稳定版本），未发布到 npm，未声明达到生产就绪状态。下方的 API 对照提供的声明进行了检查，并由 Node 级别的测试进行了演练（导入、严格 TypeScript、伪 DOM 循环/宽限期行为）。引擎已在 iPhone 浏览器 Demo 集成中进行了测试；其他设备和环境均为试验性质。下方的示例本身**尚未**在手机上或使用任何特定的打包工具运行过。

## 获取软件包

从源码构建软件包（`npm ci && npm run build && npm run engine:package -- <fresh-id>`）或获取其目录。其名称为 `@livemira/engine`（任何目录名称均可；其 `package.json` 注明为 `@livemira/engine` 0.2.0）。将其放置在您的项目可以导入的位置，例如 `node_modules/@livemira/engine`，或者在您自己的包管理器中通过本地路径引用它。软件包目录包含构建好的完整运行时、本指南、`LICENSE`、`NOTICE`、第三方声明以及 `engine-package-manifest.json`（每个文件的 SHA-256、源码 commit、dirty 标志）。

**生产接口**（在 SDK 软件包中与在精简生产发布包中完全相同，后者没有 `shared/runtime/`）：`.` 和 `./browser`（压缩核心文件 `core/lm-engine.min.mjs`）、`./single`（可读核心文件 `core/lm-engine.mjs`）、`./single/min`，以及工具入口 `./target-quality`、`./tracking-visuals`、`./recognition-diagnostics`（每个工具亦带有 `/single`，并在存在压缩文件时带有 `/single/min`）。每一个都解析为 `core/` 或 `tools/` 中的独立文件；没有已记录的生产导入依赖于内部目录，并且没有通配符导出。类型声明是自包含的（不需要路径别名或工作区源码）；TypeScript 项目需要 `lib: ["DOM"]`。

**SDK 专用开发入口**（仅存在于 SDK 软件包中，在稳定生产接口之外，可能在任意版本中变动）：`./development/sdk`、`./development/browser`、`./development/cpu`、`./development/worker`、`./development/mock`、`./development/camera`、`./development/renderer`、`./development/renderer/perspective`、`./development/media`、`./development/target-compiler`、`./development/recognition`、`./development/tracking`、`./development/compute`、`./development/contracts`、`./development/contracts/worker`、`./development/target-quality`、`./development/tracking-visuals` 和 `./development/recognition-diagnostics`。它们加载 `shared/runtime/` 中的多文件模块。

兼容性：补丁版本保持生产接口和目标模式不变；次版本仅向生产接口添加内容；新的目标模式或算法版本在次版本中引入，且引擎绝不在单个实例中混用算法版本。参见源码仓库中的 `docs/release/livemira-release.md`（作为生产发布包的 `README.md` 提供）。

视频呈现默认在目标平面内使用 55% 黑色的加载层和旋转环，然后在当前视频拥有解码帧后从其中心展开历时 420 ms 的柔和圆形展开效果。使用 `new CssVideoRenderSink({ geometryForResult, presentation: { revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 } })` 进行配置；`presentation: false` 禁用它。第一帧回调属于其自身的媒体请求，并在替换或停止时取消。现有的 `mediaState` 事件增加了加载/首帧/展开/失败等状态转换以及有界的 `media.presentation` 遥测；数值诊断导出保留这些字段。详情请参阅渲染器指南。该呈现在 iPhone Chrome Demo 中使用发布候选版本得到了确认。横竖屏切换可能会使视频覆盖层发生变形；这在 0.2.0 中仍未解决。

## 完整最小示例（浏览器）

通过 HTTPS（或 `localhost`）提供页面服务，以确保相机可用。目标是您的应用已经拥有的已编译包（由核心导出的 `compileGrayTarget` / `serializeTarget`）；媒体 URL 由您自行提供。

```html
<style>
  #stage { position: relative; width: min(100vw, 640px); aspect-ratio: 3 / 4; overflow: hidden; background: #000; }
  #preview, #overlay { position: absolute; inset: 0; }   /* same bounded viewport, stacked */
  #overlay { pointer-events: none; }
</style>
<div id="stage"><div id="preview"></div><div id="overlay"></div></div>
<button id="start">Start camera</button> <button id="stop">Stop</button>

<script type="module">
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry, prepareWorkerFrame,
         CssVideoRenderSink, parseTarget } from '@livemira/engine';

const stage = document.querySelector('#stage');

// Targets: 1..10 bundles with unique targetIds and one algorithm version.
const targets = await Promise.all(['/targets/poster-a.json', '/targets/poster-b.json']
  .map(async url => parseTarget(await (await fetch(url)).text())));

let engine, running = false;
const stopEngine = reason => { running = false; return engine.stop(reason).catch(error => console.warn('stop failed', error)); };

// Camera. longEdge is the processing long edge: 480, 640 (default), 960 or 'native' (the camera's own size).
const source = new CameraFrameSource({
  previewContainer: document.querySelector('#preview'),
  camera: { facingMode: 'environment' },
  geometry: { longEdge: 640, fit: 'contain' }, // previewContainer dimensions/DPR are measured by the source
  onEvent: event => {
    // Camera event types: 'error' (event.code, e.g. CAMERA_PERMISSION_DENIED, TRACK_ENDED, CAMERA_FRAME_STALLED) and 'suspended'
    // (page hidden). Both end capture; stop the whole engine so camera, pipeline and renderer share a fresh session on restart.
    if (event.type === 'error' || event.type === 'suspended') void stopEngine(event.code ?? event.type);
  },
});

// The renderer needs the geometry of the exact frame each result came from.
const geometries = new Map();
const renderer = new CssVideoRenderSink({ geometryForResult: result => geometries.get(`${result.sessionId}:${result.frameId}`) });
const pipeline = createWorkerPipeline({
  options: { trackingMode: 'absolute', backendPreference: 'cpu', algorithmVersion: targets[0].algorithmVersion },
  prepareFrame: async (frame, signal) => {
    const geometry = getFrameGeometry(frame);
    geometries.set(`${frame.sessionId}:${frame.frameId}`, geometry);
    if (geometries.size > 64) geometries.delete(geometries.keys().next().value);
    return prepareWorkerFrame(frame, geometry, signal);
  },
  onFailure: error => { console.warn(error.reason); void stopEngine('worker-failure'); },
});

engine = createEngine({
  source, pipeline, renderer, getFrameGeometry,
  maxPredictionMs: 100,      // default 100, see below
  lossDisplayGraceMs: 500,   // default 0; 0..1000
});
engine.on('error', event => console.warn(event.error));
engine.on('playbackBlocked', () => { /* optional noninteractive notice: the host browser denied playback after bounded recovery */ });
await engine.loadTargets(targets);
for (const target of targets) {
  engine.setTargetMedia(target.targetId, {
    url: `/media/${target.targetId}.mp4`,   // your URL: same origin or CORS-enabled
    loop: true,                             // default true; false plays once
    muted: true,                            // default true; keep muted until a user gesture unmutes
    fit: 'contain',                         // default; or 'cover'
  });
}

// Starting from a click is the user gesture that lets the camera prompt and video playback proceed.
document.querySelector('#start').addEventListener('click', () => {
  running = true;
  engine.start(document.querySelector('#overlay')).catch(error => { running = false; console.warn('start failed', error); });
});
document.querySelector('#stop').addEventListener('click', () => void stopEngine('user'));

// Orientation/container/viewport changes are handled by CameraFrameSource + SDK automatically.
// Keep preview/overlay siblings responsive and equally sized; no app resize gate or restart is needed.
// Leaving the page releases the camera, Worker and media.
addEventListener('pagehide', () => void engine.dispose());
</script>
```

这些选项的含义（均为常规的 `createEngine` / 媒体选项，都不依赖于您的事件处理程序）：
- **`loop`**（`MediaConfig`，默认 `true`）：片段循环播放。有界的回退机制会在片段于末尾卡住时倒回；`false` 播放一次。
- **`maxPredictionMs`**（默认 100）：新鲜度/有效性时间窗口。位姿仅在其背后的结果不早于此时长时才被视为有效；当在窗口期内没有新的有效结果到达时，引擎报告 `targetLost`。它不是请求更长推断的参数。
- **`lossDisplayGraceMs`**（默认 0，最大 1000）：在 `targetLost` 之后，覆盖层在此期间保持可见并继续播放，然后隐藏并暂停。仅供显示：`targetLost` 事件和跟踪结果保持不变，并且窗口期内相同的目标的有效结果将更新位姿而无需重新开始视频。
- **处理尺寸**：`geometry.longEdge` 为 `480`、`640`（默认）、`960` 或 `'native'`（相机自身尺寸）。若要更改它，调用 `await engine.stop()`，然后调用 `source.updateGeometry({ longEdge })`，再调用 `engine.start(...)`。
- Worker 选项中的 **`algorithmVersion`** 必须与加载的目标包匹配；单个引擎不能混用版本。
- 切换相机：`await engine.stop(); source.configureCamera({ deviceId }); await engine.start(overlayElement)`。

## 单文件运行时（单个 JavaScript 下载）

`@livemira/engine/single/min`（文件 `core/lm-engine.min.mjs`，**压缩版**；推荐文件）和 `@livemira/engine/single`（`core/lm-engine.mjs`，可读版）各自代表作为**单个 ES 模块**的完整浏览器引擎，由 `npm run build` 构建到构建输出目录 `dist/engine-single/` 中，并由发布生成器归类到 `core/`（`core/` 恰好包含这两个文件）。选取其中一个文件即可；二者具有相同的导出项、类型和行为，并且每个文件均嵌入了自身相匹配的（压缩版或可读版）Worker 源码。`engineBuildInfo.variant` 说明正在运行的是哪一个。每个文件：它内嵌了视觉 Worker（作为 Blob 源）、标量 WASM 二进制文件及胶水代码，以及汉明 WGSL 着色器。导入它不会创建 Worker，也不会发起请求；即使采用 `backendPreference: 'wasm'`，页面随后也无需从引擎下载其他内容。应用程序目标和媒体仍归您自己所有。

```js
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry, prepareWorkerFrame, CssVideoRenderSink,
         compileGrayTarget, parseTarget, serializeTarget, engineBuildInfo } from '/assets/lm-engine.min.mjs';   // or '@livemira/engine' / '@livemira/engine/single/min'; readable: '/assets/lm-engine.mjs' = '@livemira/engine/single'
```

它导出的名称与多文件 `@livemira/engine/development/browser` 相同（一个 `WorkerVisionPipeline` 类型，无类）；上方的示例在任一导入路径下均可正常运行，并且 `createWorkerPipeline` 在嵌入的 Worker 中运行识别，绝不在 UI 线程上运行。`engineBuildInfo` 报告 `{ format: 'single' | 'multi-file', variant: 'readable' | 'minified' | null, buildId, inputHash }`，以便日志可以证明运行的是哪个构建版本。单文件排除了 DiagnosticRecorder、模拟对象、回放源以及测试/演示代码；保留了数值的 `onCapability`、`onTiming`、`onFailure`、`onDiagnostics` 钩子。运行时文件本身即可移植。类型来自声明树（`shared/types/runtime/sdk/src/browser.d.ts`）或包中的 `@livemira/engine/single`；`shared/types/core/lm-engine.d.mts` 仅是一个需要该树的转发声明，并非独立的类型文件。审计位于 `shared/audits/core/` 中，第三方声明位于 `shared/notices/` 中。`WorkerVisionPipeline` 类不是此入口的值导出项（请使用 `createWorkerPipeline`）；仅用于 SDK 的 `./development/worker` 模块仍导出该类。

此构建所需的 CSP：`worker-src blob:`（Worker 根据 Blob URL 创建，该 URL 在 Worker 终止时撤销），以及对于 `backendPreference: 'wasm'`，`script-src ... 'wasm-unsafe-eval'`。针对您自己的目标和视频 URL 保留 `connect-src`/`media-src`。构建过程在源码仓库中的 `scripts/release/build-engine-single.mjs` 头部进行了描述；每次构建的审计位于 `shared/audits/core/` 中。

## 可选：绘制已识别边界与当前匹配点（跟踪视觉效果）

分为两部分，两部分均默认关闭，且第二部分是**单独的文件**，以保持核心引擎体积小巧：

1. **核心，仅数据。** `createWorkerPipeline({ options: { collectMatchedPoints: true } })`（亦可使用 `createCpuPipeline({ collectMatchedPoints: true })`）使每个测量的 `TRACKING` 结果携带 `result.matchedPoints = { sessionId, frameId, targetId, origin: 'original-target' | 'previous-frame', pointsPx }`。`pointsPx` 是**恰好针对该帧所接受观测的实际内点图像点**（标准图像像素，即 `cornersPx` 所在的空间），最多 512 个，无额外特征提取。预测（`LIMITED`）、`ACQUIRING`、缺失和丢失结果绝不携带点，且点绝不从更早的帧复制。除非请求，否则该字段不存在；它按 Worker 固定，因此更改它意味着创建新管线。非布尔值抛出 `INVALID_CONFIG`。主线程侧丢弃与其结果不匹配的点。`DiagnosticRecorder` 从不存储它们。
2. **配套模块，绘制。** `@livemira/engine/tracking-visuals/single/min`（压缩版，`tools/tracking-visuals/lm-tracking-visuals.min.mjs`）、`.../single`（可读版）或 `@livemira/engine/tracking-visuals`（压缩文件）。它不导入任何内容（无引擎，无记录器），并可放置在您提供服务的任何位置；引擎文件从不导入它。仅在需要绘制时才加载它：

```js
import { createEngine, createWorkerPipeline, CssVideoRenderSink, getFrameGeometry, prepareWorkerFrame } from '/assets/lm-engine.min.mjs';
const geometryForResult = r => geometries.get(`${r.sessionId}:${r.frameId}`) ?? null;   // same function you give CssVideoRenderSink
const base = new CssVideoRenderSink({ geometryForResult });
let renderer = base;
if (wantDrawing) {
  const { createTrackingVisualRenderSink } = await import('/assets/lm-tracking-visuals.min.mjs');   // loaded only now
  renderer = createTrackingVisualRenderSink({ base, geometryForResult, boundary: true, points: true });    // both default false
}
const pipeline = createWorkerPipeline({ options: { trackingMode: 'absolute', backendPreference: 'cpu', collectMatchedPoints: wantDrawing }, prepareFrame: /* as above */ });
const engine = createEngine({ source, pipeline, renderer });
// Media convenience calls (setTargetMediaFile, setMutedFromGesture, retryActiveMediaFromGesture) stay on `base`; renderer.setVisualization({ boundary, points }) switches live.
```

装饰器将引擎调用的所有内容转发给 `base` 并从那时起拥有它（`engine.dispose()` 处置装饰器，装饰器进而处置 `base`）。绘制是覆盖层容器中的 SVG 层，通过 `H_viewportFromStandard` 以 CSS 像素呈现（裁剪、镜像、旋转和 DPR 均来自该矩阵）。针对每个有效的 `TRACKING`/`LIMITED` 结果显示边界（预测时显示为虚线琥珀色）；仅针对带有匹配 `matchedPoints` 的测量结果显示圆点。在 `hide()` 时、丢失时（500 ms `lossDisplayGraceMs` 保持仅保留**视频**）、停止/处置/新会话时、页面隐藏时、针对该目标的媒体错误时（在成功重试后使用 `clearMediaFailure()` 恢复，或重新启动），以及在任何无效结果时，所有内容均会被清除。它适用于未配置媒体的目标。`setVisualization({ boundary, points })` 和构造函数遇到未知键和非布尔值会抛出 `INVALID_CONFIG`。`getVisualDiagnostics()` 仅返回计数。在没有该配套模块或两个开关均关闭的情况下，不存在多余的 DOM。

## 可选：检查图片是否适合作为目标（评分 0..5）

`@livemira/engine/target-quality` 和 `@livemira/engine/target-quality/single`（同一款独立的浏览器 ES 模块，`tools/target-quality/lm-target-quality.mjs`，无依赖项、Worker、WASM 或网络）在将图像用作目标**之前**对其进行评分。它独立于引擎：引擎文件从不导入它，并且您可以交付其中任一模块而无需附带另一个。它支持传统算法（默认）以及显式 `algorithmVersion: 'm0-harris-anms-brief256-v1'`；请使用与您编译的目标相同的算法。默认评分器为 2.0.0（支持度、覆盖率、协方差展开/各向同性以及描述符唯一性）；`scorerVersion: '1.0.0'` 重现历史公式和结果模式。

```js
// Browser, one call with a File/Blob (decoded locally; nothing is uploaded or fetched)
import { assessTargetImage } from '/assets/lm-target-quality.mjs';   // or '@livemira/engine/target-quality/single'
const result = await assessTargetImage(fileInput.files[0], { signal: abortController.signal });
if (result.recommendReplacement) showWarning(result.advice);            // score < 3: choose another picture
console.log(result.score, 'of', result.maxScore, result.reasons.map(r => r.code));
```

```js
// Node (or a Worker): canonical gray8, no browser needed
import { assessGrayTarget } from '@livemira/engine/target-quality';
const result = assessGrayTarget({ width, height, data /* Uint8Array, width*height bytes */ });
```

`score` 为 0..5，最多保留一位小数；`recommendReplacement` 严格对应 `score < 3`，且 `reasons[]` 列出具体的、可采取行动的原因（`LOW_FEATURE_COUNT`、`LOW_COVERAGE`、`CLUSTERED_FEATURES`、`REPETITIVE_PATTERN`、`LOW_CONTRAST`、`WEAK_SCALE_SUPPORT`、`LOW_RESOLUTION`；严重级别 `blocker` = `compileGrayTarget` 会将其标出）。**低于 3 分我们建议更换图像。3 分或以上在真实设备上仍可能失败**（光照、运动模糊、打印、相机、匹配器自身限制）。该评分是一种启发式适用性预检：不是检测概率，不是保证，也不是 Vuforia 或 ARCore 评级。图像缩小至 640 px 长边（绝不放大），与引擎的处理方式一致；结果记录原始尺寸和归一化尺寸。公式、限制、错误以及严格的 TypeScript 声明：软件包中与本指南并列的 `TARGET-QUALITY.md`（源码：`packages/target-quality/README.md`）。

`analyzeGrayTarget` / `analyzeTargetImage` 还会从同一次提取中返回 `{ result, features }`；可选的 `drawTemplateFeatures` 辅助函数用于绘制这些静态模板点。它们不是相机匹配点。

## 可选：识别诊断

仅在需要诊断时才导入 `@livemira/engine/recognition-diagnostics/single/min`（或可读版 `.../single`；`@livemira/engine/recognition-diagnostics` 是同一个压缩文件）。其独立文件包含有界聚合和点分布计算；核心引擎从不导入它。

```js
import { createWorkerPipeline, prepareWorkerFrame, getFrameGeometry } from '@livemira/engine/single/min';
import { createRecognitionDiagnostics } from '@livemira/engine/recognition-diagnostics/single/min';
const diagnostics = createRecognitionDiagnostics();
diagnostics.setTargets(targets.map(t => ({ targetId: t.targetId, widthPx: t.widthPx, heightPx: t.heightPx })));
const pipeline = createWorkerPipeline({
  options: { observeRecognition: true, collectMatchedPoints: true },
  prepareFrame: (frame, signal) => prepareWorkerFrame(frame, getFrameGeometry(frame), signal),
  onRecognitionTrace: trace => diagnostics.observeRecognition(trace),
  onResult: result => diagnostics.observeResult(result),
});
// Load targets and start your engine as above. Reading a snapshot never stops collection.
const numericSnapshot = diagnostics.snapshot();
// After ending a session, reset it to reject late callbacks; dispose the collector with its host.
// diagnostics.reset(endedSessionId); diagnostics.dispose();
```

两个 Worker 选项均默认为 false。识别追踪包含与结果相同的会话/帧的有界计数和拒绝代码。当被观察时，追踪还可携带 `stageMs`（特征/检索/匹配/几何/总计毫秒数，按各轮次累加）和 `passes`（每个识别轮次一条记录，最多两轮：标准图像和半倍频程尺度重试）。每个轮次记录保存其自身的尺度、`prepareMs`（重试的重新采样）、各阶段耗时、特征/候选/观测计数以及拒绝原因，在任何累加之前形成快照，以便第一轮的拒绝原因在成功的重试后得以留存。`featureCount` 保持为最后一轮的计数，而非总和。两个字段均为可选（较旧的追踪保持有效），仅限有限非负有界浮点数，无像素、坐标或 URL；当 `observeRecognition` 关闭时，不会发生额外特征提取，也不存储任何内容。配套模块将其作为单独的 `stageTiming`、`passStats` 和逐目标 `passRejections` 字段报告；原始的 `recognition` 和 `rejections` 计数器保留其含义，且不进行累加。它们描述的是识别器候选接受情况，而非跟踪器随后做出的时间/质量决策。分布仅使用测量的 `TRACKING` 结果，将接受的内点归一化回目标坐标，并且默认每 200 ms 最多运行一次。快照不包含像素、URL 或点数组。核心记录器保持独立于此配套模块。

## 传统尺度重试控制

`WorkerPipelineOptions.legacyScaleSearch`（亦被 `createCpuPipeline` 和 `CpuRecognizer` 接受）是一个布尔值，默认 `true`：在全局未命中后，传统家族算法（贪婪和 ANMS）以半倍频程尺度重试一次。`false` 跳过该重试。它**仅供诊断比对；在正常使用中切勿将其关闭**，因为它移除了针对保存的描述符与实时图像之间尺度差距的恢复机制。任何非布尔值（`null`、字符串、数字）均会被拒绝并抛出 `INVALID_CONFIG`；v2 算法从不重试，因此它会忽略该选项。该选项在 Worker 的整个生命周期内固定不变。

## ANMS 测试算法

旧的引擎/编译器默认项仍为 `m0-harris-brief256-v1`。显式指定的 `ANMS_ALGORITHM_VERSION`（`m0-harris-anms-brief256-v1`）使用鲁棒性为 0.9 的 Brown/Szeliski/Winder CVPR 2005 §3 抑制半径选择。工作量限制在每个金字塔层级最强的 1024 个候选之内，且现有的逐层特征配额保持不变（384 个模板 / 512 个实时特征，三个层级）。这是一份记录在案的近似实现，而非论文中完整的 MOPS 管线。算法变更需要重新编译目标并构建匹配的管线；混用的包将被拒绝。更多的内点并不能保证更准确的角点；在手机上的改善尚未确立。跟踪有效性仍为 100 ms，且可配置的 500 ms 视觉宽限期不会延长它。

## CPU 回退、Worker 与静态资源

- `createWorkerPipeline` 在模块 Worker 中运行识别与跟踪（`shared/runtime/sdk/src/worker-pipeline.js` 内部的 `new Worker(new URL('./vision-worker.js', import.meta.url), { type: 'module' })`）。`backendPreference: 'cpu'` 在 Worker 内部完全使用 CPU 运行所有内容；`'wasm'` 增加标量 WASM 灰度预处理；`'webgpu'` 增加 GPU 匹配（需要 oriented v2 算法）。Worker 通过 `onCapability` 报告其实际使用的配置，包括 `fallbackReason`。
- 来自仅供 SDK 的 `@livemira/engine/development/cpu` 的 `createCpuPipeline` 在调用线程上运行相同的识别器。它可能会阻塞页面，是针对不支持模块 Worker 环境的回退方案；引擎本身从不自行切换到该方案。
- **静态复制（受支持的布局）：** 这是 SDK 软件包可选的多文件开发布局（`./development/...` 入口）；保持 `shared/runtime/` 完整并将其作为静态文件提供服务（生产环境的 `core/` 文件不需要其中的任何内容）。Worker、`shared/runtime/compute/artifacts/{scalar,simd}/compute.{mjs,wasm}` 以及 `shared/runtime/compute/shaders/*.wgsl` 均位于相对于加载它们的模块的位置。
- **打包工具：** Worker URL、WASM 和 WGSL 文件必须作为静态资源输出，并保持其相对布局，或者您向 `createWorkerPipeline` 传递 `workerFactory: () => new Worker(yourWorkerUrl, { type: 'module' })`。尚未针对任何特定的打包工具进行过测试。
- **浏览器要求：** ES 模块、模块 Worker、安全上下文中的 `getUserMedia`、用于媒体的静音 `playsInline` 视频。声音需要用户手势（因此会有 `playbackBlocked`）。相机行为因设备而异；此处的内容均不构成手机性能或生产声称。
