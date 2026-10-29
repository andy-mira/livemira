# @livemira/ui —— 相机界面

[English](ui.md) | [简体中文](ui.zh-CN.md)

一次调用得到全屏 AR 相机：照片在浏览器里编译为目标（与打开相机同时进行），照片被识别后才请求对应的视频并边下边播，同一时间只绑定一个视频。默认视图用简体中文或英文显示状态、提示与控件，布局、配色与文字沿用 LiveMorae 相机。包内没有引擎代码：页面通过 `loadEngine` 把引擎模块传进来。

**状态：** 0.5.0，接口与 0.4.1 兼容，内部全部重写。已在桌面 Chromium 与 WebKit 中配合真实引擎、用合成相机通过端到端测试，并已在 LiveMorae 中真机验收。

## 使用

```js
import { mountArCamera } from './livemira-ui.min.mjs';

const camera = mountArCamera(document.body, {
  loadEngine: () => import('./livemira-engine.min.mjs'),
  targets: [{ id: 'poster-1', photo: './poster-1.jpg', video: './poster-1.mp4' }],
  locale: 'zh-CN',
  onExit: () => camera.destroy(),
});
```

舞台有尺寸后立即开始（`isAutoStart: false` 时请在点击中调用 `camera.view.start()`）。`destroy()` 先移除视图，再停止并释放引擎、相机、Worker 与视频；多次调用共享同一个 Promise。

## 与 0.4.1 相比

| 方面       | 0.4.1                                | 0.5                                                                                                                  |
| ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 准备阶段   | 先编译全部照片，再打开相机           | 照片编译与打开相机同时进行；相机授权提示更早出现，总等待更短                                                         |
| Loading    | 状态行文字"正在准备照片（3/10）…"    | 居中的加载卡片：进度环和百分比（组件、照片、相机三段合计）、当前步骤与提示；相机画面出现后变为半透明，准备完成后淡出 |
| 扫描中     | 状态行提示                           | 另有扫描引导框：四角呼吸，中间一道柔光自上而下扫过；识别到照片时淡出，照片移开后再出现                               |
| 识别反馈   | —                                    | 照片边缘亮起一次光晕；支持时手机轻振一下（`isHapticEnabled`）                                                        |
| 视频加载   | 先下载整个文件，再播放；DOM 遮罩加 CSS 转圈 | 边下边播（`video.isStreamed`）：识别后立即在照片上出现与视频同比例的半透明黑色区域，中间转圈；整段下载时显示真实进度环与百分比；播放中数据跟不上时再次转圈 |
| 展开动效   | CSS 径向渐变遮罩，不支持时退化为淡入 | 视频能播放时，从区域中心向四周展开；着色器中按照片自身坐标计算的柔边圆，透视正确，带光亮的波前；与相机画面同帧绘制，不会漂移 |
| 播放被拒绝 | 提示文字                             | 照片中心显示播放标记，声音按钮脉动提示，状态行提示"轻点声音按钮即可播放"                                             |
| 设备不支持 | —                                    | 不支持 WebGL2 的设备直接提示"需要 WebGL2 支持"，不显示无效的"重新开始"                                               |

## 目标

| 字段     | 含义                                                                                            |
| -------- | ----------------------------------------------------------------------------------------------- |
| `id`     | 稳定编号，也是引擎的目标编号：1..128 个字符，取自 A–Z、a–z、0–9、`_`、`.`、`-`。                |
| `photo`  | `Blob`，或经 `loadMedia` 下载的 URL；用引擎的 `compileTargetImage` 编译。                       |
| `target` | 代替 `photo`：已编译的目标（`parseTarget` 的结果，或其 `bytes`）；其 `targetId` 必须等于 `id`。 |
| `video`  | URL（照片被识别后才请求：默认由浏览器边下边播，或经 `loadMedia` 整段下载）或直接交给引擎的 `Blob`。 |

每次 1 至 10 个目标，编号互不相同。无法成为目标的照片会被跳过并计数（`skippedCount`），不会挪动其他照片的视频。

## 选项

| 选项                  | 默认              | 含义                                                                                                                                              |
| --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadEngine`          | 必填              | 返回引擎模块（或其 Promise）；第一次开始时调用。                                                                                                  |
| `targets`             | 必填              | 见上文。`session.setTargets()` 改变下一次开始的目标。                                                                                             |
| `loadMedia`           | `fetch`，只对本站带 Cookie | `(url, { signal, kind, targetId, onProgress? }) => Promise<Blob>`：鉴权写在这里；调用 `onProgress(0..1)` 可让照片上的进度环显示真实进度（可选）。 |
| `classifyError`       | 内置提示          | `(cause, { phase, targetId }) => { notice?, shouldStop?, isStale? }`（见下文）。                                                                  |
| `observe`             | 无                | 运行中的数值与代码（生命周期、目标、声音）；不含 URL。                                                                                            |
| `engineOptions`       | 引擎默认值        | 除 `container` 外的引擎选项：`profile`、`camera`、`tracking`、`presentation`、`workerUrl`。                                                       |
| `video`               | 循环、`contain`、边下边播 | 所有视频的 `{ isLooping, fit, isStreamed }`。视频静音开始。`isStreamed`：视频 URL 直接交给浏览器播放，下到够播就开始（服务器需支持 Range，跨站需 CORS；本站请求带 Cookie）；false 时先经 `loadMedia` 整段下载（用于需要请求头鉴权的视频）。默认 true，传了 `loadMedia` 时默认 false。 |
| `photoMaxEdgePx`      | 640               | 照片编译前缩放到的长边。                                                                                                                          |
| `locale`              | `'zh-CN'`         | `'zh-CN'` 或 `'en'`（`en-*` → `en`，其他 → `zh-CN`）。                                                                                            |
| `messages`            | 无                | 按语言提供自己的或替换的文字：`{ en: { 'host.expired': '…' } }`。                                                                                 |
| `translate`           | 无                | `(key, params, locale) => string \| undefined`；返回字符串即优先。                                                                                |
| `onExit`              | 无                | 退出控件（左上）调用它；它与 `exitHref` 都没有时不显示退出控件。                                                                                  |
| `exitHref`            | 无                | 把退出控件渲染为链接。                                                                                                                            |
| `isStoppedWhenHidden` | true              | 页面隐藏或离开时结束运行并提示。                                                                                                                  |
| `isAutoStart`         | true              | false：自己调用 `view.start()`，最好在点击中调用。                                                                                                |
| `isHapticEnabled`     | true              | 识别到照片时轻振一下（设备支持时）。                                                                                                              |
| `mode`                | `'fullscreen'`    | 固定在视口并锁定页面滚动；`'embedded'` 填满你设定尺寸的容器。                                                                                     |
| `theme`               | 无                | `.lm-ar` 上的 CSS 变量：`{ accent: '#c0674a' }` 设置 `--lm-ar-accent`。照片上的光晕颜色用 `engineOptions.presentation.accent`。                   |

错误按阶段分类：`engine-load`、`photo-load`、`photo-compile`、`start` 总是结束运行（宿主可以改提示并标记过期，例如链接过期）；`video-load` 默认不停相机，并提供"重新加载视频"，除非宿主返回 `shouldStop: true`。边下边播的视频取不到时，`cause` 是带 `code`（`'network'` 或 `'unsupported'`，浏览器对 403/404 一般报后者）的 `Error`，没有 HTTP 状态码。

## 会话与视图

```js
import { createArSession, mountArView } from './livemira-ui.min.mjs';

const session = createArSession({ loadEngine, targets });
session.subscribe(() => render(session.getState()));
const view = mountArView(container, session, { locale: 'zh-CN' }); // 或按状态自己绘制
await session.stop({ notice: { key: 'host.unauthorized' }, isStale: true }); // 宿主结束一次运行
await session.dispose();
```

`state` 的字段：

- 与 0.4.1 相同：`phase`（`idle | preparing | starting | scanning | stopping`）、`view`（`searching | loading | playing | lost | videoError`）、`progress`、`notice`（`{ key, params?, text? }`）、`isMuted`、`isAdjusting`、`isPlaybackBlocked`、`isStale`、`skippedCount`、`activeTargetId`、`isDisposed`。
- 新增：
  - `readiness`：准备阶段的整体进度，0..1；
  - `isCameraOn`：相机已打开，照片可能仍在准备；
  - `videoProgress`：当前视频的下载进度。

只在字段变化时通知，不逐帧。`session.setMuted()` 与 `session.retryVideo()` 要在点击里调用。`start()` 从不 reject：结果看状态。

## 新增的文字键

`loader.engine`、`loader.photos`、`loader.camera`、`loader.hint`、`status.loadingProgress`、`status.blocked`、`notice.cameraUnavailable`、`notice.unsupported`、`notice.insecure`。其余键与 0.4.1 相同，宿主已有的覆盖仍然有效。

## 许可

Apache-2.0。见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。
