# CSS 视频渲染器

[English](README.md) | [简体中文](README.zh-CN.md)

`src/index.ts` 使用 `@livemira/contracts` 0.1.0 导出 `CssVideoRenderSink implements RenderSink`。`src/perspective.mjs` 是一个无依赖的浏览器兼容实现。它使用 CSS `matrix3d` 投影 `w` 而非仿射三角形。视频解码与合成归浏览器负责；此路径没有显式的纹理上传或 WebGPU 设备，且绝不借用相机图像句柄。

媒体源可以是 URL 或拥有的 `File`/`Blob`，具有显式的重试与音频控制、数值媒体诊断以及 pagehide 清理。`examples/media-controls.mjs` 展示了如何将这些绑定到现有 UI（它不创建任何 DOM）。

提供一个与相机视口对齐的定位覆盖层容器。CSS 几何以 CSS 像素表示，因此请勿将变换乘以 DPR。视口变换已包含旋转、裁剪和显示镜像。目标边缘为 (0,0)、(width,0)、(width,height)、(0,height)。不执行额外的过滤或坐标排序。无效或交叉的四边形将被隐藏并拒绝。

最小 SDK 接线：

```ts
const renderer = new CssVideoRenderSink({
  geometryForResult: result => geometryForSessionAndFrame(result.sessionId, result.frameId),
});
const engine = createEngine({ source, pipeline, renderer });
engine.on('playbackBlocked', event => showRetryButton(event.retry));
engine.on('error', event => showMediaError(event.error));
await engine.loadTargets(targetBundles);
engine.setTargetMedia(targetBundles[0].targetId, { url: mediaUrl, muted: true });
await engine.start(overlayContainer);
```

即使没有新帧，当预测过期时 SDK 也必须调用 `hide()`；渲染器会拒绝提供的预测年龄 >= 100 ms 的结果，但不会创建第二个跟踪时钟。`geometryForResult` 必须解析该结果对应的几何，而不是可变且无关的最新相机帧。在此 2D 路径中不使用校准位姿或 Three.js 转换。

同一时间仅存在一个视频。切换媒体或目标，或停止引擎，都会移除源和挂起的帧回调。`lostBehavior: hide` 有意让媒体在隐藏时继续播放；默认的 `pause-and-hide` 会暂停。文档置于后台始终会暂停，随后需要新的有效更新才能显示或恢复。被阻塞的播放不会在每个跟踪帧上重试；调用方提供显式的重试手势。错误和加载重试的自动尝试次数为零；调用方可以替换配置。网络错误原因不被归类为已证实的 CORS 失败。

资源故障会隐藏原生媒体错误层并锁定失败的源，直到 `setTargetMedia` 替换它或目标或会话发生改变。正常的跟踪更新不会在失败的源上重复调用播放。这不会改变跟踪状态或 `targetFound`/`targetLost` 语义。

SDK `loadTargets` 调用可选的公开 `setTargets` 钩子，并通过 `connectEvents` 连接 `RendererEventSink`。构造函数回调仍然受支持，但应用程序应选择一种 UI 订阅方式以避免重复消息。观察器是隔离的，退订是幂等的，dispose 会清除订阅，旧的媒体重试闭包处于非活动状态。

在 `npm ci` 之后，从代码仓库根目录进行类型检查：

```sh
node node_modules/typescript/bin/tsc -p packages/renderer/tsconfig.json
```

真实浏览器中的行为各不相同；`MediaRecorder` 和 `captureStream` 是测试夹具技术，而非运行时依赖。现有的视频渲染通过 iPhone 浏览器 Demo 集成进行了演练；加载遮罩和圆形展开效果已在 iPhone Chrome Demo 中使用发布候选版本得到确认。横竖屏切换仍可能使视频覆盖层发生变形；0.2.0 并未修复此问题。

出处：代码和所有夹具素材均专为本项目编写；未合并任何第三方代码或媒体。

## 跟踪视觉效果不属于此渲染器

`CssVideoRenderSink` 仅绘制视频。可选的已识别边界和当前匹配点图层属于独立的配套模块 `packages/tracking-visuals`（`TrackingVisualRenderSink`，此类周围的一个 `RenderSink` 装饰器，构建为 `lm-tracking-visuals{,.min}.mjs`）。它不与渲染器共享任何代码，因此仅使用渲染器的集成无需为此付出任何开销。参见 SDK README 中的“可选：绘制已识别边界与当前匹配点”章节。

## 加载遮罩与圆形展开（默认开启）

`CssVideoRenderSink` 在*透视平面内部*显示加载和展开效果，作为位于视频之后的子元素（视频保持为平面的第一个子元素），因此它们遵循 `matrix3d`、被平面裁剪、继承 `pointer-events:none`，并且从不覆盖相机视图或捕获触摸。源码：`src/loading-reveal.mjs`（仅限 DOM/动画，无媒体知识）以及 `src/index.ts` 中的请求状态机。

**行为。** (1) 已识别的目标若当前视频没有可呈现的画面，将显示一个黑色层（`overlayOpacity`，默认 .55）和一个居中的旋转环；视频被遮罩隐藏而非移除，因此它仍能解码并呈现。(2) 当当前媒体请求的第一帧可呈现时（`VideoSession.awaitPresentableFrame`：具有 `readyState >= 2`、非零固有尺寸且无错误的 `requestVideoFrameCallback` 回调；在缺少该 API 时使用已记录的保守回退方案：未暂停、在两次连续 100 ms 轮询中 `currentTime` 严格递增，并且如果平台报告，解码帧计数上升；它可能比真实帧滞后约两次轮询，但绝不先于真实帧），一个圆形以三次方减速缓动（ease-out cubic）在 `revealMs`（默认 420 ms；选自所请求的 350–500 ms 范围内，将根据手机结果进行微调）内从平面中心展开。视频在圆形内部可见，暗层仅在圆形外部可见，并具有羽化边缘（平面较短边的 22%）；旋转指示器在展开初期淡出。在结束时，遮罩和图层被移除。在没有 CSS 遮罩支持的情况下，相同的时间表现为不透明度淡入淡出。(3) `prefers-reduced-motion: reduce`（在调用时读取）：静态环，无展开动画，120 ms 淡入淡出。

**所有权。** 每个媒体请求（针对目标的新视频元素、手势重新加载或在被阻塞播放后的重试）都具有一个 `requestGeneration` 及其自身的就绪监听。每个后续延续（第一帧、超时、动画结束）都会重新检查它是否仍是针对同一会话、目标和媒体元素的渲染槽（sink）当前请求；已释放或被替换的请求（目标切换、`setTargetMedia`/`clearTargetMedia`、`stop`、`dispose`、A→B→A）将被报告一次为 `reveal-cancel`，其迟到的回调不执行任何操作。新目标始终获得新元素，因此旧画面绝不会透过遮罩显示。可重入观察器是安全的：释放操作在渲染槽状态已被清除后报告其带有自身 ID 的请求，释放期间的 `hide` 不能突变完成或重复报告它，且较旧的更新不能处置较新的平面。

**不重启。** 重复的跟踪更新绝不会触碰动画。加载时的隐藏/丢失保持相同的请求及其监听（隐藏时加载预算暂停）；展开期间的隐藏使其立即完成（带有较短 `revealElapsedMs` 的 `reveal-end`）；隐藏的第一帧在无动画的情况下完成。重新获取可呈现媒体（包括在 `lossDisplayGraceMs` 内）会显示已完成的视频，而无需新的加载或展开。

**失败。** 媒体错误、播放被阻塞以及有界的加载超时（`loadingTimeoutMs`，默认为 15 秒*可见*时间，经验证为有限值）均会清除旋转指示器（`loading-failed`，`failureReason` 为 `media-error` / `playback-blocked` / `loading-timeout`），随后遵循未改变的约定：`error` `RESOURCE_FAILED`（超时原因为 `media-loading-timeout`，可恢复）伴随失败源锁定，或 `playbackBlocked` 伴随其 `retry`。`retryActiveMediaFromGesture()` 和被阻塞的 `retry()` 启动新请求（新代际，重新加载）。播放本身仍由 `VideoSession` 处理（原生 `play()` 优先，仅在 `NotAllowedError` 之后进行微信恢复）；手势路径未发生任何改变。

**选项与选择退出。** `new CssVideoRenderSink({ geometryForResult, presentation })`：省略/`true`/对象 = 开启；`presentation: { revealMs (0..2000, 0 = no animation), loadingTimeoutMs (1..600000), overlayOpacity (.05..1) }`（0 表示无动画）；`presentation: false` = 之前的行为（无多余 DOM，无多余事件）。无效值会抛出 `INVALID_CONFIG`。每个目标的媒体选项（`MediaConfig`）保持不变。

**遥测。** `mediaState` 事件（`loading`、`first-frame`、`reveal-start`、`reveal-end`、`reveal-cancel`、`loading-failed`）携带 `media.presentation`（`@livemira/contracts` 中的 `MediaPresentationTelemetry`）：请求代际、阶段、就绪信号、经过时间/首帧/展开毫秒数、配置的时长、减弱动态效果标志和失败原因。仅在状态转换时记录，从不在每帧记录，从不记录 URL 或像素。`DiagnosticRecorder.event` 将其保持为由有界数字/枚举构成的封闭集合（丢弃其他任何内容），以便日志导出能予以保留。`getMediaDiagnostics().presentation` 返回当前请求的快照。
