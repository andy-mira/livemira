# @livemira/ui —— 相机界面

[English](ui.md) | [简体中文](ui.zh-CN.md)

一次调用得到引擎的全屏 AR 相机：照片在浏览器里编译为目标，照片被识别后才下载对应视频，默认视图用简体中文或英文显示状态、提示与控件，提供暖色深色控件、黑色转场遮罩与可配置主题变量。相机画面、转屏遮罩、视频揭示以及页面隐藏时结束会话都由引擎完成；本包只跟随引擎事件。包内没有引擎代码：页面把引擎模块传进来。

**兼容性限制：** 真机兼容性尚未确定。请在应用支持的设备和浏览器上验证相机、播放与转屏行为。

## 使用

```js
import { mountArCamera } from './livemira-ui.min.mjs';

const camera = mountArCamera(document.body, {
  loadEngine: () => import('./livemira-engine.min.mjs'),
  targets: [{ id: 'poster-1', photo: './poster-1.jpg', video: './poster-1.mp4' }],
  locale: 'en',
  onExit: () => camera.destroy(),
});
```

舞台有尺寸后相机立即开始。`destroy()` 先移除视图，再停止并释放引擎、相机、Worker 与视频；多次调用共享同一个 Promise。

## 目标

| 字段     | 含义                                                                             |
| -------- | -------------------------------------------------------------------------------- |
| `id`     | 稳定编号，也是引擎的目标编号：1..128 个字符，取自 A–Z、a–z、0–9、`_`、`.`、`-`。 |
| `photo`  | `Blob`，或经 `loadMedia` 下载的 URL；用引擎的 `compileTargetImage` 编译。        |
| `target` | 代替 `photo`：已编译的目标（`parseTarget`）；其 `targetId` 必须等于 `id`。       |
| `video`  | URL（照片被识别后经 `loadMedia` 下载）或直接交给引擎的 `Blob`。                  |

每次 1 至 10 个目标，编号互不相同。无法成为目标的照片会被跳过并计数（`skippedCount`），不会挪动其他照片的视频。同一时间只绑定一个视频：识别到另一张照片时，取消上一个下载并释放上一个视频。

## 选项

| 选项                  | 默认              | 含义                                                                                     |
| --------------------- | ----------------- | ---------------------------------------------------------------------------------------- |
| `loadEngine`          | 必填              | 返回引擎模块（或其 Promise）；第一次开始时调用。                                         |
| `targets`             | 必填              | 见上文。`session.setTargets()` 改变下一次开始的目标。                                    |
| `loadMedia`           | `fetch`，不带凭据 | `(url, { signal, kind: 'photo' \| 'video', targetId }) => Promise<Blob>`：鉴权写在这里。 |
| `classifyError`       | 内置提示          | `(cause, { phase, targetId }) => { notice?, shouldStop?, isStale? }`（见下文）。         |
| `observe`             | 无                | 运行中的数值与代码（生命周期、目标、原始引擎事件、声音）；不含 URL。                     |
| `engineOptions`       | 引擎默认值        | 除 `container` 外的全部 `createEngine` 选项（相机、跟踪、呈现、扩展……）。                |
| `video`               | 循环、`contain`   | 所有视频的 `{ isLooping, fit }`。视频静音开始。                                          |
| `photoMaxEdgePx`      | 640               | 照片编译前缩放到的长边。                                                                 |
| `locale`              | `'zh-CN'`         | `'zh-CN'` 或 `'en'`（`en-*` → `en`，其他 → `zh-CN`）。                                   |
| `messages`            | 无                | 按语言提供自己的或替换的文字：`{ en: { 'host.expired': '…' } }`。                        |
| `translate`           | 无                | `(key, params, locale) => string \| undefined`；返回字符串即优先。                       |
| `onExit`              | 无                | 退出控件（左上）调用它；它与 `exitHref` 都没有时不显示退出控件。                         |
| `exitHref`            | 无                | 把退出控件渲染为链接。                                                                   |
| `isStoppedWhenHidden` | true              | 页面隐藏或离开时结束运行并提示。                                                         |
| `isAutoStart`         | true              | false：自己调用 `view.start()`，最好在点击中调用。                                       |
| `mode`                | `'fullscreen'`    | 固定在视口并锁定页面滚动；`'embedded'` 填满你设定尺寸的容器。                            |
| `theme`               | 无                | `.lm-ar` 上的 CSS 变量：`{ accent: '#c0674a' }` 设置 `--lm-ar-accent`。                  |

错误按阶段分类：`engine-load`、`photo-load`、`photo-compile`、`start` 总是结束运行（宿主可以改提示并标记过期，例如链接过期）；`video-load` 默认不停相机，并提供"重新加载视频"，除非宿主返回 `shouldStop: true`。

## 分别使用会话与视图

```js
import { createArSession, mountArView } from './livemira-ui.min.mjs';

const session = createArSession({ loadEngine, targets });
session.subscribe(() => render(session.getState()));
const view = mountArView(container, session, { locale: 'zh-CN' }); // 或按状态自己绘制
await session.stop({ notice: { key: 'host.unauthorized' }, isStale: true }); // 宿主结束一次运行
await session.dispose();
```

`state`：`phase`（`idle | preparing | starting | scanning | stopping`）、`view`（`searching | loading | playing | lost | videoError`）、`progress`、`notice`（`{ key, params?, text? }`）、`isMuted`、`isAdjusting`（视图变化正在稳定）、`isPlaybackBlocked`、`isStale`、`skippedCount`、`activeTargetId`、`isDisposed`。只在字段变化时通知，不逐帧。引擎报告真正开始播放后 `view` 才是 `playing`；媒体失败会保持 `videoError`，直到重新加载视频。

`session.setMuted()` 与 `session.retryVideo()` 要在点击里调用：引擎需要看到用户手势。视频播放中开声音被拒绝时，会回到静音并提示。`start()` 从不 reject：结果看状态。

## 从 `@web-ar/ui` 0.1 迁移

| 0.1                                                     | `@livemira/ui`                                      |
| ------------------------------------------------------- | --------------------------------------------------- |
| `engine` / `loadEngine`（0.2.1 引擎）                   | `loadEngine`（0.3 引擎模块）                        |
| `{ id, photo, videoUrl, bundle }`                       | `{ id, photo \| target, video }`                    |
| `config`（相机、Worker、宽限、长边、填充）              | `engineOptions`（引擎默认：`cover`、宽限 200 ms）   |
| `stop(reason, notice)`                                  | `stop({ reason, notice, isStale })`                 |
| `classifyError → { stop, stale, notice }`               | `{ shouldStop, isStale, notice }`                   |
| `state.muted`、`stale`、`skipped`、`viewportTransition` | `isMuted`、`isStale`、`skippedCount`、`isAdjusting` |
| `.wa-ar` 类名与 `--wa-ar-*` 变量                        | `.lm-ar` 与 `--lm-ar-*`；布局、颜色与文字相同       |
| `show`、`icons`、`className`、`injectStyles`            | 不提供                                              |

视图保持 0.1 的布局：左上退出、扫描中右上显示声音、其下是状态行与提示、视图变化稳定前显示带"正在调整画面…"的黑色幕布，底部只在需要时出现"重新开始"/"重新加载视频"。浏览器阻止自动播放时只显示提示，点声音按钮即可继续播放。页面隐藏或离开时结束运行并提示（传 `isStoppedWhenHidden: false` 可继续运行）。

0.1 默认相机 `contain`、丢失宽限 500 ms；引擎默认值（`cover`、200 ms）是在手机上测试过的设置。需要保留旧取景时传 `engineOptions: { camera: { fit: 'contain' } }`。

## 许可

Apache-2.0。见 [LICENSE](../LICENSE) 与 [NOTICE](../NOTICE)。
