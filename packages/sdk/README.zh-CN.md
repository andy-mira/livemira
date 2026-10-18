# @livemira/engine —— 集成指南

[English](README.md) | [简体中文](README.zh-CN.md)

LiveMira 在实时相机画面中识别预先准备好的图片（"目标"），持续跟踪它，并在其上播放视频。识别与跟踪在 Web Worker 中运行，全部在设备本地完成。

**状态：** 0.4.1。提供浏览器内图像目标识别、跟踪、视频叠加与可选相机界面。相机需要安全上下文与用户授权。

**兼容性限制：** 相机界面尚未经真机验收；Android 与应用内浏览器尚未验证。桌面浏览器结果不代表所有设备上的兼容性或性能。

## 文件

`npm run build` 输出到 `dist/`：

| 文件                                   | 用途                                                           |
| -------------------------------------- | -------------------------------------------------------------- |
| `livemira-engine.min.mjs`              | 单个 ES 模块的引擎，已内嵌 Worker 与 WebAssembly。推荐使用。   |
| `livemira-engine.mjs`                  | 同一引擎的可读版本。                                           |
| `livemira-engine-worker.min.mjs`       | Worker 文件，供 CSP 禁止 `blob:` Worker 的页面使用（见下文）。 |
| `livemira-tracking-visuals.min.mjs` 等 | 可选扩展，各自一个模块（[见下文](#扩展)）。                    |

导入引擎不会创建任何东西：调用之前不会启动 Worker、相机或任何请求。

## 快速开始

页面须通过 HTTPS（或 `localhost`）提供：相机需要安全上下文。

```html
<div id="stage" style="position: fixed; inset: 0"></div>
<button id="start">开始</button>
<script type="module">
  import { createEngine, parseTarget } from './livemira-engine.min.mjs';

  const engine = createEngine({ container: document.getElementById('stage') });
  const target = await parseTarget(await (await fetch('./poster.target.json')).text());
  await engine.setTargets([{ target, media: { url: './poster.mp4' } }]);

  engine.on('targetFound', (event) => console.log('识别到', event.targetId));
  engine.on('playbackBlocked', () => showRetryButton()); // 在点击中调用 engine.media.retry()
  engine.on('sessionEnded', (event) => console.log('结束', event.reason));

  // 在用户手势中开始，以便相机授权提示与视频可以播放。
  document.getElementById('start').onclick = () => engine.start();
</script>
```

容器须为定位元素且有尺寸。引擎在其中加入三个同尺寸、指针事件穿透的图层：相机画面、视频平面、扩展绘制。转屏、地址栏伸缩与容器尺寸变化由引擎内部处理：在新视图稳定之前遮住相机区域，变化之前的帧既不显示也不参与识别。

## 目标

| 函数                                                 | 用途                                                   |
| ---------------------------------------------------- | ------------------------------------------------------ |
| `compileTargetImage(file, { targetId, maxEdgePx? })` | 在短时 Worker 中解码并编译图片文件（不占用页面线程）。 |
| `compileGrayTarget(gray, { targetId })`              | 编译灰度图 `{ widthPx, heightPx, data }`。             |
| `serializeTarget(target)` / `parseTarget(text)`      | 保存与加载编译好的目标（格式 v1，带 SHA-256 校验）。   |

每个引擎 1 至 10 个目标，`targetId` 互不相同。0.2.x 用 ANMS 算法（`m0-harris-anms-brief256-v1`）编译的目标可直接加载，0.3.0 对同一图片编译出相同的字节；贪心算法（`m0-harris-brief256-v1`）或 oriented v2 编译的目标需要重新编译（报 `INVALID_TARGET`）。

## `createEngine(options)`

| 选项                                    | 默认            | 含义                                                                                                                         |
| --------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `container`                             | 必填            | 引擎绘制所在的定位元素。                                                                                                     |
| `camera.facingMode`                     | `'environment'` | 或 `'user'`；设置 `deviceId` 时忽略。                                                                                        |
| `camera.deviceId`                       | —               | 来自 `engine.camera.list()` 的设备。                                                                                         |
| `camera.idealWidthPx` / `idealHeightPx` | 1280 / 720      | 请求的采集尺寸。                                                                                                             |
| `camera.processingLongEdge`             | 640             | 480、640、960 或 `'native'`：识别所用图像的长边。                                                                            |
| `camera.fit`                            | `'cover'`       | 相机画面如何填充容器（`'contain'` 显示完整画面）。                                                                           |
| `camera.capture`                        | `'canvas'`      | `'canvas'`：用 canvas 读回处理图；`'auto'`：原生帧（VideoFrame、ImageBitmap），canvas 读回作为最后手段。                     |
| `camera.timestamps`                     | `'callback'`    | `'callback'`：帧时间取自帧回调；`'media-time'`：取自视频的媒体时钟。                                                         |
| `tracking.maxPredictionMs`              | 100             | 0..100：最后一次实测之后，预测结果最多显示多久。                                                                             |
| `tracking.lossDisplayGraceMs`           | 200             | 0..1000：丢失后最多保留最后位置与视频的时长（仅视觉）；丢失前在快速移动的目标立即隐藏。                                      |
| `presentation`                          | 开启            | 视频平面上的加载遮罩与圆形揭示：`{ revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 }`；`false` 让视频直接出现。 |
| `adapters`                              | 默认            | 替换环境适配器：`previewSurface`、`snapshot`、`playbackRecoveries`、`workerFactory`。                                        |
| `extensions`                            | 无              | 可选扩展（见下文）。                                                                                                         |
| `diagnostics`                           | 无              | 一个 `DiagnosticLog`（见下文）。                                                                                             |

非法选项抛出 `EngineError('INVALID_CONFIG')`。

使用 `timestamps: 'media-time'` 时，如果浏览器从不推进相机流的
媒体时间（在 WebKit 中出现），相机在连续三张媒体时间相同的新画面之后自动改用回调时间戳，会话快照的 `timestampSource` 随之变为
`'callback'`。

## `Engine`

| 成员                                         | 含义                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `state`                                      | `'idle'`、`'starting'`、`'running'`、`'stopping'` 或 `'disposed'`。   |
| `setTargets(entries)`                        | 替换全部目标及其媒体，只能在空闲时调用。每项为 `{ target, media? }`。 |
| `setTargetMedia(targetId, media \| null)`    | 设置、替换或清除某个目标的视频；运行中也可调用。                      |
| `start()` / `stop(reason?)` / `dispose()`    | 生命周期；操作依次执行。                                              |
| `on(type, listener)`                         | 订阅事件，返回取消函数。监听器出错不影响引擎。                        |
| `media.setMuted(isMuted)`                    | 在点击中调用：开启或关闭声音。                                        |
| `media.retry()`                              | 在 `playbackBlocked` 或媒体错误之后，于点击中调用。                   |
| `camera.list()` / `camera.configure(change)` | 列出相机；空闲时修改朝向、设备、处理长边或填充方式。                  |
| `getEventContext()` / `getDiagnostics()`     | 当前事件时钟；诊断快照。                                              |

目标的媒体为 `{ url }` 或 `{ file }`，另可设置：`isMuted`（默认 true）、`isLooping`（默认 true）、`fit`（`'contain'`）、`onLost`（`'pause-and-hide'` 或 `'hide'`）、`onResume`（`'resume'` 或 `'restart'`）、`crossOrigin`（`'anonymous'`）、`playbackRecovery`（`'auto'` 或 `'off'`）。浏览器只在点击之后允许声音：视频以静音开始，请在按钮中调用 `engine.media.setMuted(false)`。

## 事件

每个事件都带 `sessionId`、`targetId`、`timestampUs` 与 `timestampDomain`（相机会话时钟建立后使用它）。

| 事件                                    | 载荷                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `attemptStart`、`ready`                 | —                                                                                      |
| `sessionConfig`、`sessionConfigUpdated` | `config`：目标、媒体身份（哈希，不含网址）、策略、相机信息                             |
| `stageTiming`                           | `stage`、`status`、`durationUs`、`attemptTimeUs`                                       |
| `sessionStartFailed`                    | `code`、`attemptTimeUs`                                                                |
| `sessionEnded`                          | `reason`（`'stopped'`、`'camera-error'`、`'camera-suspended'`、`'worker-failure'` 等） |
| `cameraPermission`                      | `phase`、`permission`                                                                  |
| `cameraStatus`                          | `code`、`detail`：相机已停止（随后结束会话）                                           |
| `cameraSize`                            | `widthPx`、`heightPx`：在画面仍隐藏时发出，页面可借此调整布局                          |
| `pageVisibility`                        | `visibility`                                                                           |
| `viewportTransition`                    | `phase`（`'begin'`/`'end'`）、`epoch`、`reason`（原始触发原因）、`sizes`               |
| `capabilityChanged`                     | `capability`：引擎构建、画面层、新帧检测方式、匹配算子与回退                           |
| `targetFound`、`targetUpdated`          | `result`                                                                               |
| `targetLost`                            | `reason`、`lossContext`（目标在相机像素中的位置）                                      |
| `mediaState`                            | `state`、`media`（数值与状态，含加载与揭示进度）                                       |
| `playbackBlocked`                       | —（在点击中用 `engine.media.retry()` 重试）                                            |
| `error`                                 | `error`：一个 `EngineError`                                                            |

转场开始时叠加层立即隐藏，不使用丢失显示宽限，并报告目标丢失（`targetLost`，原因 `'viewport-transition'`）。

## 错误

`EngineError` 有 `code`、`isRecoverable` 与 `message`。错误码：`INVALID_CONFIG`、`INVALID_TARGET`、`DISPOSED`、`ABORTED`、`START_FAILED`、`FRAME_FAILED`、`RESOURCE_FAILED`、`UNSUPPORTED`、`CAMERA_UNAVAILABLE`、`CAMERA_PERMISSION_DENIED`、`CAMERA_START_FAILED`、`CAMERA_TRACK_ENDED`、`CAMERA_FRAME_STALLED`、`CAMERA_CAPTURE_FAILED`、`CAMERA_CLOCK_RESET`、`CAMERA_SUSPENDED`、`MEDIA_FAILED`、`PLAYBACK_BLOCKED`。请按 `code` 分支，不要依赖消息文字。扩展是独立模块，带有自己的类副本；判断它们的错误请用 `code`（或 `name === 'EngineError'`），不要用 `instanceof`。

## 诊断日志

```js
import { DiagnosticLog } from './livemira-engine.min.mjs';
const log = new DiagnosticLog({ level: 'key' }); // 或 'full'
const engine = createEngine({ container, diagnostics: log });
log.setLevel('full'); // 下次开始时生效
const file = JSON.stringify(log.export()); // 由用户保存；不会上传
```

关键日志（会话、错误、权限、页面可见性、转场、识别、媒体状态、能力）建议始终开启。完整日志另外记录逐帧调度、结果（不含匹配点）与 Worker 计时。记录只有数值与封闭枚举：不含画面、网址或匹配点坐标。存储有上限（默认每类 10 000 条），导出会注明是否有丢弃。

## 扩展

| 模块                                                                             | 用途                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`livemira-tracking-visuals`](../tracking-visuals/README.zh-CN.md)               | 绘制识别边框与当前匹配点。                           |
| [`livemira-recognition-diagnostics`](../recognition-diagnostics/README.zh-CN.md) | 有界统计：目标为何被拒绝、匹配点分布在哪里。         |
| [`livemira-target-quality`](../target-quality/README.zh-CN.md)                   | 评估图片是否适合作为目标（独立工具，不是引擎扩展）。 |

```js
import { createTrackingVisuals } from './livemira-tracking-visuals.min.mjs';
const engine = createEngine({
  container,
  extensions: [createTrackingVisuals({ boundary: true, points: true })],
});
```

扩展需要 Worker 提供的数据（匹配点、识别轨迹）在创建引擎时确定。

## 内容安全策略（CSP）

- 单文件引擎用 `blob:` 地址启动 Worker：请允许 `worker-src blob:`。否则请提供 `livemira-engine-worker.min.mjs`，并传入 `adapters: { workerFactory: () => new Worker(url, { type: 'module' }) }`。
- 精确匹配器需要编译 WebAssembly：请在 `script-src` 中允许 `'wasm-unsafe-eval'`。不允许时引擎回退到结果相同的 JavaScript 匹配器，并在 `capabilityChanged` 中报告。
- 来自其他源的媒体需要 CORS（默认 `crossOrigin: 'anonymous'`）。

## 浏览器要求

安全上下文、`getUserMedia`、模块 Worker、Worker 中带 2D 上下文的 `OffscreenCanvas`，以及 `<video>` 的帧回调或播放质量接口。支持时使用 WebAssembly SIMD。在 iOS 微信中，被阻止的视频会通过微信桥接重试一次（`playbackRecovery: 'auto'`）。

## 已知问题

- 转屏开始时，视频平面可能在遮罩上多停留约一帧。
- 快速移动时可能丢失匹配。
- 目标在画面中约为编译尺寸的 0.7 倍（介于两个金字塔层级之间）时跟踪最弱：仍能识别，但匹配点更少、抖动更大。

## 许可

Apache-2.0。见 [LICENSE](../../LICENSE) 与 [NOTICE](../../NOTICE)。
