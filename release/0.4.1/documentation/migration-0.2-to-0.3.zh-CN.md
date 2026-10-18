# 从 0.2.x 迁移到 0.3.0

[English](migration-0.2-to-0.3.md) | [简体中文](migration-0.2-to-0.3.zh-CN.md)

0.3.0 保留 0.2.x 的算法、目标格式与行为（少数行为变化见下文）。变化的是引擎的组装方式与命名：一次 `createEngine` 调用取代了手工组装的相机、Worker 管线与渲染器，命名遵循统一规范。只迁移了 0.2.x 的默认能力。

## 组装

| 0.2.x                                                                                                                                | 0.3.0                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `new CameraFrameSource({ previewContainer, camera, geometry, onEvent })`                                                             | `createEngine({ container, camera: { … } })`；相机事件改为 `cameraPermission`、`cameraStatus`、`cameraSize` |
| `createWorkerPipeline({ options, prepareFrame, onCapability, onTiming, onFailure })`                                                 | 内部组装；能力见 `capabilityChanged`，计时进入诊断日志，Worker 失败作为 `error` 并结束会话                  |
| `new CssVideoRenderSink({ geometryForResult, presentation })`                                                                        | `createEngine({ presentation })`；每个结果按其所属帧的几何绘制                                              |
| `getFrameGeometry`、`prepareWorkerFrame`、自己维护的几何 `Map`                                                                       | 删除，不再需要                                                                                              |
| 两个叠放的元素（`#preview`、`#overlay`）                                                                                             | 一个定位容器；图层由引擎加入                                                                                |
| `engine.loadTargets(targets)` + `engine.setTargetMedia(id, media)`                                                                   | `engine.setTargets([{ target, media }])`；`engine.setTargetMedia(id, media \| null)`                        |
| `renderer.setTargetMediaFile(id, file, config)`                                                                                      | `media: { file, … }`                                                                                        |
| `renderer.setMutedFromGesture(m)`、`retryActiveMediaFromGesture()`、`event.retry()`                                                  | `engine.media.setMuted(m)`、`engine.media.retry()`                                                          |
| `source.updateGeometry({ longEdge })`、`source.configureCamera({ deviceId })`                                                        | 空闲时 `engine.camera.configure({ processingLongEdge, deviceId })`                                          |
| `engine.setTrackingMode`、`trackingMode`、`backendPreference`、`cpuMatching`、`cpuFeatures`、`legacyScaleSearch`、`algorithmVersion` | 删除：只有默认组合（absolute 跟踪、CPU 识别、WebAssembly 精确匹配并可回退 JavaScript、尺度重试）            |
| `collectMatchedPoints`、`observeRecognition`                                                                                         | 由传入的扩展（`needs`）决定                                                                                 |
| `new Engine(config)`、导出的 `Engine` 类                                                                                             | `createEngine(options)`；返回对象的类型为 `Engine`（接口，不再是类）                                        |
| `createEmbeddedWorkerFactory(source)`                                                                                                | 内置：默认使用内嵌 Worker；要用 Worker 文件时传 `adapters: { workerFactory }`                               |
| `getSessionContext()`、`refreshSessionConfig()`                                                                                      | `engine.getEventContext()`；会话配置由引擎刷新                                                              |

相机出错或页面隐藏时，引擎现在自行结束会话（`sessionEnded`，原因 `'camera-error'` 或 `'camera-suspended'`）；0.2.x 会停在"运行中"直到页面调用 `stop`。

## 目标

用 ANMS 算法（`m0-harris-anms-brief256-v1`）编译的目标可直接加载，同一图片编译出相同字节。贪心（`m0-harris-brief256-v1`）或 oriented v2 算法的目标会以 `INVALID_TARGET` 拒绝，请重新编译。`compileTargetImage(file, { targetId })` 在 Worker 中编译图片文件。`ALGORITHM_VERSION`、`ANMS_ALGORITHM_VERSION`、`ORIENTED_ALGORITHM_VERSION`、`SUPPORTED_ALGORITHM_VERSIONS` 不再导出。灰度图为 `{ widthPx, heightPx, data }`。

## 命名

| 0.2.x                                                                                                                                              | 0.3.0                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `EngineError(code, recoverable, reason)`、`.recoverable`、`.reason`                                                                                | `.isRecoverable`、`.message`                                                                                       |
| `MediaConfig.muted`、`loop`、`lostBehavior`、`resumeBehavior`、`wechatPlaybackRecovery`                                                            | `isMuted`、`isLooping`、`onLost`、`onResume`、`playbackRecovery`（取值不变）                                       |
| `result.predictionAgeUs`、`lastReliableObservationTimeUs`、`predictionExpiresAtUs`                                                                 | `result.prediction.ageUs`、`.lastMeasuredTimeUs`、`.expiresAtUs`                                                   |
| `result.quality.measured`、`.degenerate`                                                                                                           | `.isMeasured`、`.isDegenerate`                                                                                     |
| `result.absoluteCorrectionAgeUs`、`T_cameraFromTarget`、`poseMetricValid`、`matchedPoints.origin`                                                  | 删除（在 0.2.x 默认组合下恒等于其他字段或为常量）                                                                  |
| 相机选项 `width`、`height`、`snapshotPreference: 'cpu'`、`timestampPreference: 'media'`                                                            | `idealWidthPx`、`idealHeightPx`、`capture: 'canvas'`、`timestamps: 'media-time'`                                   |
| `mediaState.media.paused`、`loop`、`ended`、`wechatRecoveryAttempts`、`presentation.reducedMotion`                                                 | `isPaused`、`isLooping`、`isEnded`、`recoveryAttempts`、`presentation.isReducedMotion`                             |
| `targetLost.lossContext` 中的帧：`measured`、`inputWidth`、`inputHeight`、`fullyInsideInput`、`sourceObservationId`、`precedingInputFrameRecorded` | `isMeasured`、`inputWidthPx`、`inputHeightPx`、`isFullyInsideInput`、`pictureKey`、`isPrecedingInputFrameRecorded` |

## 事件与错误

- `capabilityChanged` 携带 `capability`（引擎构建、画面层、新帧检测方式、匹配算子与回退），取代 `backend` 与 `reason`。
- `playbackBlocked` 不再携带 `retry` 函数：请在点击中调用 `engine.media.retry()`。
- 新事件：`cameraPermission`、`cameraStatus`、`cameraSize`、`pageVisibility`、`viewportTransition`（原始触发原因，不合并）。
- 媒体失败的错误码为 `MEDIA_FAILED`（0.2.x 为 `RESOURCE_FAILED`），消息为原因，例如 `media-decode-error`、`media-loading-timeout`。
- 相机失败为带 `CAMERA_*` 错误码的 `EngineError`；`cameraStatus.detail` 保留原始细分原因（`TRACK_ENDED`、`NO_VIDEO_CALLBACK` 等）。

## 诊断

`DiagnosticRecorder` 由 `DiagnosticLog({ level: 'key' | 'full' })` 取代，通过 `createEngine({ diagnostics })` 接入，不再需要手工转交。导出格式为 `livemira-diagnostics/2`：去掉候选包与测试流程字段，事件只保留白名单字段，关键级别不记录逐帧数据。旧的分析脚本需要调整。

## 扩展

| 0.2.x                                                                          | 0.3.0                                                                                                                                                               |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new TrackingVisualRenderSink({ base, geometryForResult, boundary, points })`  | `createEngine({ extensions: [createTrackingVisuals({ boundary, points })] })`                                                                                       |
| `createRecognitionDiagnostics()` + 手工转交 `onRecognitionTrace` 与 `onResult` | `extensions: [createRecognitionDiagnostics()]`；快照格式 `livemira-recognition-diagnostics/2`（`isDisposed`；去掉每个目标的 `originalTarget`/`previousFrame` 计数） |
| target-quality 评分器 1.0.0、贪心算法选项、`scorerVersion`、`algorithmVersion` | 只有评分器 2.0.0 与 ANMS 算法；结果格式 `livemira-target-quality/3`（`shouldReplace`，尺寸为 `…Px`）；错误为 `EngineError`                                          |

扩展是独立模块，它们的错误是各自类副本的 `EngineError`：请比较 `code`，不要用 `instanceof`。

## 行为变化

- 相机默认 `capture: 'canvas'`、`timestamps: 'callback'`（0.2.x 为原生帧与媒体时间）。需要 0.2.x 的默认值时传
  `camera: { capture: 'auto', timestamps: 'media-time' }`。
- 丢失显示宽限默认 200 ms（0.2.x 为 0）：丢失后叠加层最多保持最后位置 200 ms，用来遮住刚识别到目标时的短暂丢失。需要 0.2.x
  的行为时传 `tracking: { lossDisplayGraceMs: 0 }`。
- 丢失时，丢失前在快速移动的目标立即隐藏，较慢的目标只在它不可能移远时保持；宽限是最长的保持时间。目标仍在跟踪中而叠加层已隐藏时，
  要重新确认（连续三次新鲜实测）后才再次显示。
- 媒体时间不前进的相机在同一次运行中改用回调时间戳，不再停滞。

## 文件

| 0.2.x                                          | 0.3.0                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `core/lm-engine.min.mjs`、`core/lm-engine.mjs` | `livemira-engine.min.mjs`、`livemira-engine.mjs`                                                                   |
| `tools/*/lm-*.mjs`                             | `livemira-tracking-visuals.min.mjs`、`livemira-recognition-diagnostics.min.mjs`、`livemira-target-quality.min.mjs` |
| `./development/*` 入口                         | 删除                                                                                                               |
| —                                              | `livemira-engine-worker.min.mjs`，供 CSP 禁止 `blob:` Worker 的页面使用                                            |
