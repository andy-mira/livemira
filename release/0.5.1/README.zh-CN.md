# @livemira/engine —— 集成指南

[English](README.md) | [简体中文](README.zh-CN.md)

LiveMira 在实时相机画面中识别预先准备好的图片（"目标"），持续跟踪它，并在图片上播放视频。识别与跟踪在 Web Worker 中运行，全部在设备本地完成。

**状态：** 0.5.0，正式版。这是新一代引擎：识别、跟踪、画面合成与 0.4 完全不同，对外接口另行设计；相机界面 `@livemira/ui` 的接口与 0.4.1 兼容（见[升级说明](documentation/migration-0.4-to-0.5.zh-CN.md)）。

- 引擎核心已在真机上测过：iPhone（iOS 27，Safari、Chrome、微信）、POCO F4、三星 A26、Android 10 低端机。10 分钟持续运行不降频，静止抖动 0.005 px。
- 产品层（视频平面、加载区域、中心展开、边下边播、相机界面）已在桌面 Chromium 与 WebKit 中用合成相机通过端到端测试，并已在 LiveMorae 中真机验收（0.5.0-rc.2；识别、跟踪与呈现与本版相同，本版只移出了评分、测试工具和未被使用的逐帧 6 自由度位姿计算）。
- npm：`npm install @livemira/engine @livemira/ui`。目标图评分只在发布包中提供，不发布到 npm。

## 文件

| 文件                                            | 用途                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `files/livemira-engine.min.mjs`                 | 单个 ES 模块的引擎，Worker 与 WebAssembly 已内嵌。推荐使用。             |
| `files/livemira-engine.mjs`                     | 同一引擎的可读版本。                                                     |
| `files/livemira-engine-worker.min.js`           | 引擎的 Worker 脚本（经典脚本），供 CSP 禁止 `blob:` Worker 的页面使用。  |
| `files/livemira-engine.d.ts`                    | 类型声明。                                                               |
| `files/livemira-ui.min.mjs`、`livemira-ui.d.ts` | 相机界面（[说明](documentation/ui.zh-CN.md)）。不含引擎代码。            |
| `files/livemira-target-rating.min.mjs` 等       | 目标图评分（[说明](documentation/target-rating.zh-CN.md)）。不需要引擎。 |
| `npm/*.tgz`                                     | 三个包的离线 tarball（引擎与相机界面也已发布到 npm）。                   |
| `demo/`                                         | 全屏示例：四张示例照片和一段视频，另有评分页 `rate.html`。用 HTTPS 打开。 |

导入引擎不会创建任何东西：调用之前不会启动 Worker、相机，也不会发出请求。在 Node 中也能导入（只读取版本信息）。

## 快速开始

页面必须通过 HTTPS（或 `localhost`）提供，因为相机需要安全上下文。

```html
<div id="stage" style="position: fixed; inset: 0"></div>
<button id="start">开始</button>
<script type="module">
  import { compileTargetImage, createEngine } from './livemira-engine.min.mjs';

  const engine = createEngine({ container: document.getElementById('stage') });
  const photo = await (await fetch('./poster.jpg')).blob();
  await engine.setTargets([await compileTargetImage(photo, { targetId: 'poster' })]);

  engine.on('targetFound', ({ targetId }) => {
    // 识别到之后才请求视频，由浏览器边下边播；期间照片上显示视频比例的加载区域。
    engine.setTargetMedia(targetId, { url: './poster.mp4' });
  });
  engine.on('ended', ({ reason, error }) => console.log('结束', reason, error?.code));

  // 在点击中开始：相机授权提示与视频播放都需要用户手势。
  document.getElementById('start').onclick = () => engine.start();
</script>
```

容器须为定位元素且有尺寸。引擎在其中加入自己的图层（相机画面与视频都画在同一个 WebGL2 画布中），停止时移除。转屏、地址栏伸缩与容器尺寸变化由引擎处理：变化期间不在照片上绘制任何内容，并发出 `viewport` 事件，页面可借此遮住画面。

## 档位

| 档位（`profile`）  | 定位                     | 组合                                            | 设备要求                    |
| ------------------ | ------------------------ | ----------------------------------------------- | --------------------------- |
| `'hawk'` 鹰        | 最精准，耗电最多         | KLT 先验 + ESM 跟踪，慢环 3 Hz（第二个 Worker） | Worker 直采相机帧（MSTP）   |
| **`'swift'` 雨燕** | **默认**，均衡           | ESM 跟踪，慢环 0.5 Hz（第二个 Worker）          | 同上                        |
| `'wren'` 鹪鹩      | 兼容最广，对设备要求最低 | 页面取帧、轻量 ESM，慢环 1 Hz（同一个 Worker）  | `requestVideoFrameCallback` |

设备不满足所选档位时，按 Hawk → Swift → Wren 的顺序回退（`ready` 事件的 `fallbacks` 说明跳过了哪些档位以及原因）。Hawk 运行中如果 Worker 每帧平均处理时间超过 22 ms（60 帧窗口），会自动降到 Swift，并发出 `profileChange` 事件。

所有档位都需要 WebGL2 与 `VideoFrame`：画面与视频按帧锁定绘制，这是真机测试中视频不漂移的必要条件。缺少这两项的设备，`start()` 以 `UNSUPPORTED_DEVICE` 拒绝，不做识别。`probeDevice()` 可在打开相机前查询设备是否支持。

## 目标

| 函数                                                 | 用途                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `compileTargetImage(file, { targetId, maxEdgePx? })` | 在短时 Worker 中解码（按照片自带的方向）、缩放到长边 `maxEdgePx`（默认 640）并编译。最多 3 个 Worker 并行。 |
| `parseTarget(bytes)`                                 | 加载保存过的目标字节（`target.bytes`）。损坏、或由不兼容版本编译的数据以 `INVALID_TARGET` 拒绝。            |

一个目标约 230 KB。编译一张照片在桌面实测约 0.2 秒；按真机测得的算力系数估计，iPhone 约 0.5 秒，低端 Android 约 2–3 秒。照片很多、设备较弱时，建议在上传照片时编译一次并保存 `bytes`，扫描时用 `parseTarget` 加载（相机界面的目标可直接给 `target`）。

不适合识别的图片（太小、纹理太少）以 `UNSUITABLE_TARGET` 拒绝，无法解码的以 `DECODE_FAILED` 拒绝。每个引擎 0..10 个目标，`targetId` 互不相同，由 1..128 个 `A–Z a–z 0–9 _ . -` 组成。

### 目标图评分（独立模块）

评分不在引擎里：用户选目标图的页面（例如作品编辑页）往往不打开相机，不必为此加载引擎。评分模块 `files/livemira-target-rating.min.mjs`（随发布包提供，不在 npm 上）在自己的 Worker 里按引擎的方式编译图片并打分，用法与评分标准见[目标图评分说明](documentation/target-rating.zh-CN.md)。

## `createEngine(options)`

| 选项                          | 默认            | 含义                                                                   |
| ----------------------------- | --------------- | ---------------------------------------------------------------------- |
| `container`                   | 必填            | 引擎绘制所在的定位元素。                                               |
| `profile`                     | `'swift'`       | 见上文。                                                               |
| `camera.facingMode`           | `'environment'` | 或 `'user'`；设置 `deviceId` 时忽略。                                  |
| `camera.deviceId`             | —               | 指定相机。                                                             |
| `camera.fit`                  | `'cover'`       | 相机画面如何填充容器：裁切铺满（`'cover'`）或完整显示（`'contain'`）。 |
| `camera.processingScale`      | `1`             | 识别与跟踪处理的画面占相机画面尺寸的比例：`1`（原尺寸）、`0.75`、`0.5`。原尺寸更能认出、跟住画面里较小的照片：真机 2.5 分钟里 0 次丢失，`0.5` 为 6 次；每帧多约 2 ms。 |
| `tracking.lossGraceMs`        | 200             | 0..1000：照片丢失后，视频淡出并保留的时长，之后才算丢失。              |
| `presentation.revealMs`       | 900             | 0..3000：视频第一次出现时，从中心向四周展开的时长。                    |
| `presentation.resumeRevealMs` | 320             | 同一视频在照片丢失后重新出现时的较短展开时长。                         |
| `presentation.veilOpacity`    | 0.5             | 0..1：视频加载期间，视频比例的黑色区域的不透明度。                     |
| `presentation.accent`         | `'#c0674a'`     | 识别光晕与展开波前的颜色。                                             |
| `presentation`                | 开启            | `false`：不显示遮罩与动效，视频直接出现。                              |
| `workerUrl`                   | 内嵌            | 引擎 Worker 文件的地址（CSP 见下文）。                                 |

非法选项抛出 `EngineError('INVALID_CONFIG')`。

## 识别时照片上的呈现

全部画在帧锁定的 WebGL2 画布中，与相机画面使用同一帧的位姿，所以不会相对照片漂移；按照片自身的坐标计算，透视正确、边缘抗锯齿：

1. **识别光晕**：照片被识别时，边缘亮起一次。
2. **加载区域**：视频在路上（已设置但还不能播放，或 `setTargetProgress` 报告下载中）时，照片上立即出现一块与视频同比例的半透明黑色区域（按 `fit` 放在照片里），中间转圈（`setTargetProgress` 报告百分比时为进度环），照片边缘轻微呼吸。视频尺寸在浏览器读到之前按照片比例，读到后平滑变为视频比例。浏览器拒绝自动播放时，转圈换成播放标记。
3. **中心展开**：视频能播放、画面开始到达屏幕时，一个柔边圆从区域中心展开到区域最远的角，边缘带光亮的波前；圆内是视频，圆外仍是半透明黑色。同一视频在照片丢失后重新出现时，使用较短的展开。播放中数据跟不上（浏览器的 `waiting`）超过 0.4 秒时，视频上再次显示转圈。
4. 系统开启"减弱动态效果"时，没有光晕与波前，展开改为 0.2 秒淡入。

## `Engine`

| 成员                                        | 含义                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                                     | `'idle'`、`'starting'`、`'running'`、`'stopping'` 或 `'disposed'`。                                                                                     |
| `profile`                                   | 正在运行的档位；空闲时为 `null`。                                                                                                                       |
| `setTargets(targets)`                       | 替换全部目标。任何状态都可调用：运行中在后台加载，`targetsReady` 之后开始识别。                                                                         |
| `setTargetMedia(targetId, media \| null)`   | 设置、替换或清除一个目标的视频：`{ file }` 或 `{ url }`，另有 `isLooping`（默认 true）、`fit`（`'contain'` 默认、`'cover'`、`'fill'`）、`crossOrigin`。 |
| `setTargetProgress(targetId, p \| null)`    | 页面正在下载该目标的视频：0..1，大小未知时为 NaN，下载结束或放弃时为 null。                                                                             |
| `start()` / `stop(reason?)` / `dispose()`   | 生命周期，依次执行。启动中调用 `stop()` 会立即取消启动（`start()` 以 `ABORTED` 拒绝）。                                                                 |
| `on(type, listener)`                        | 订阅事件，返回取消函数。监听器出错不影响引擎。                                                                                                          |
| `media.setMuted(isMuted)` / `media.isMuted` | 在点击中调用。视频以静音开始；开声音被浏览器拒绝时退回静音并返回 false。                                                                                |
| `media.retry()`                             | 在点击中调用：播放被拒绝后重试，或媒体出错后重新加载当前照片的视频。                                                                                    |

视频只在其照片可见时播放：照片丢失时暂停，重新出现时继续。

## 事件

| 事件              | 载荷                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `state`           | `state`                                                                                            |
| `ready`           | `profile`、`capture`（取帧方式）、`fallbacks`（跳过的档位及缺少的能力）                            |
| `targetsReady`    | `targetIds`                                                                                        |
| `targetFound`     | `targetId`                                                                                         |
| `targetLost`      | `targetId`、`reason`（`'out-of-view'`、`'viewport'`、`'stopped'`）                                 |
| `viewport`        | `phase`（`'begin'`/`'end'`）：画面形状变化中                                                       |
| `media`           | `targetId`、`state`（`none`、`loading`、`ready`、`playing`、`paused`、`blocked`、`error`）、`code` |
| `playbackBlocked` | `targetId`：需要一次点击（`media.retry()` 或开声音）                                               |
| `profileChange`   | `from`、`to`、`reason`（Hawk 运行中降到 Swift）                                                    |
| `ended`           | `reason`；会话不是主动停止时带 `error`                                                             |
| `error`           | `error`：一个 `EngineError`                                                                        |

## 错误

`EngineError` 有 `code`、`isRecoverable` 与 `message`（`UNSUPPORTED_DEVICE` 还有 `missing`）。错误码：`INVALID_CONFIG`、`INVALID_TARGET`、`UNSUITABLE_TARGET`、`DECODE_FAILED`、`UNSUPPORTED_DEVICE`、`CAMERA_PERMISSION_DENIED`、`CAMERA_UNAVAILABLE`、`CAMERA_START_FAILED`、`CAMERA_ENDED`、`WORKER_FAILED`、`MEDIA_FAILED`、`ABORTED`、`DISPOSED`。请按 `code` 分支，不要依赖消息文字。

## 内容安全策略（CSP）

- 单文件引擎用 `blob:` 地址启动 Worker：请允许 `worker-src blob:`。不允许时，部署 `livemira-engine-worker.min.js` 并传 `workerUrl`（`createEngine` 与 `compileTargetImage` 都接受）。
- WebAssembly 内核需要 `script-src 'wasm-unsafe-eval'`。
- `{ url }` 由浏览器边下边播：服务器需支持 Range 请求（常见 Web 服务器与 CDN 默认支持），其他源的视频还需要 CORS（默认 `crossOrigin: 'anonymous'`）。需要请求头鉴权的视频请先自行下载，再用 `{ file }` 传入（可用 `setTargetProgress` 显示进度）。

## 浏览器要求

安全上下文、`getUserMedia`、WebGL2、`VideoFrame`，以及 Worker 中的 `MediaStreamTrackProcessor`（Hawk/Swift）或 `requestVideoFrameCallback`（Wren）。真机测试覆盖 iOS 27 的 Safari、Chrome 与微信，以及 Android Chrome 与微信。iOS 微信中被拒绝的自动播放会通过微信桥接重试一次。

## 已知问题

- 边下边播在桌面 WebKit 测试版中无法验证（它要等响应全部到达才把数据交给播放器），iPhone 上以真机为准；LiveMorae 尚未开启边下边播。
- 每帧把相机画面转正并转成灰度，在 iPhone 上约 5.6 ms，高于识别本身（约 3.5 ms）；整体仍远低于帧间隔，后续优化。
- 照片很多时，在弱设备上编译需要数秒；建议预先编译（见"目标"）。

## 许可

Apache-2.0。见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
