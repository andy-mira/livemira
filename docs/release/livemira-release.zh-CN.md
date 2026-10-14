# LiveMira 0.2.1

[English](livemira-release.md) | [简体中文](livemira-release.zh-CN.md)

LiveMira 是一个用于图像目标 AR 的浏览器引擎：它在实时相机画面中识别准备好的图像目标，对其进行跟踪，并在其上显示视频。0.2.1 是首个稳定版本（0.2.0）的补丁版本。识别、匹配结果、尺度重试、相机和跟踪的行为与之前一致；两项结果逐位一致的 CPU 优化现在默认开启（见“CPU 默认值”）。视频呈现沿用 0.2.0 引入的黑色半透明加载层和旋转加载指示器（spinner），并在有解码帧可用时从中心进行边缘柔和的圆形展开，本版本未改动。软件包名称、分发文件名和导入路径遵循 `docs` 目录中 `NAMING.md` 内的 LiveMira 命名规则。

## 目录布局

| 目录 | 内容 |
| --- | --- |
| `core/` | 恰好两个文件：`lm-engine.min.mjs`（压缩版，供集成的文件）和 `lm-engine.mjs`（可读版）。每个文件均自包含，内嵌有其 Worker、WebAssembly 和着色器 |
| `tools/target-quality/`, `tools/tracking-visuals/`, `tools/recognition-diagnostics/` | 可选独立模块，每个模块均自包含；核心从不导入它们 |
| `shared/types/` | 所有类型声明（`core/`、`tools/<name>/`、`runtime/`） |
| `shared/audits/` | 构建审计，按核心和工具分组 |
| `shared/notices/` | 未修改的第三方许可证文本以及工具链锁定（toolchain pin） |
| `docs/` | 关于命名、媒体和目标质量的指南 |

根目录仅包含 `package.json`、中英文 README 文件、`LICENSE`、`NOTICE`、`release-layout.json` 和 `release-manifest.json`。`release-manifest.json` 记录了每个文件的类别、大小和 SHA-256。SDK 软件包（`@livemira/engine`）额外包含 `shared/runtime/`（多文件开发模块）；生产发布包则不包含。

## 生产接口

这些入口是稳定的生产接口。它们在 SDK 软件包中与在本生产发布包中具有完全相同的名称、文件和类型：

| 导入路径 | 文件 |
| --- | --- |
| `@livemira/engine`, `@livemira/engine/browser`, `@livemira/engine/single/min` | `core/lm-engine.min.mjs` |
| `@livemira/engine/single` | `core/lm-engine.mjs`（可读版） |
| `@livemira/engine/target-quality`（亦包含 `/single`） | `tools/target-quality/lm-target-quality.mjs` |
| `@livemira/engine/tracking-visuals`, `.../single/min` | `tools/tracking-visuals/lm-tracking-visuals.min.mjs` |
| `@livemira/engine/tracking-visuals/single` | `tools/tracking-visuals/lm-tracking-visuals.mjs`（可读版） |
| `@livemira/engine/recognition-diagnostics`, `.../single/min` | `tools/recognition-diagnostics/lm-recognition-diagnostics.min.mjs` |
| `@livemira/engine/recognition-diagnostics/single` | `tools/recognition-diagnostics/lm-recognition-diagnostics.mjs`（可读版） |

```js
import { createEngine, createWorkerPipeline, CameraFrameSource,
  CssVideoRenderSink, prepareWorkerFrame, parseTarget, engineBuildInfo }
  from '/assets/lm/core/lm-engine.min.mjs';
```

类型位于 `shared/types/` 且仅用于开发；核心从不请求类型、审计或声明文件。现有的已编译目标无需重新编译，目标与媒体的分发仍然由您自行负责。

经过验证的设置：CPU 后端、绝对跟踪模式、640 px 长边、ANMS Harris/BRIEF、`legacyScaleSearch: true`、`maxPredictionMs: 100`、`lossDisplayGraceMs: 500`、媒体 `loop: true` 和 `muted: true`。请通过 HTTPS 以正确的 MIME 类型提供 JavaScript。内容安全策略（CSP）必须允许 `worker-src blob:` 以及 WebAssembly 编译，并针对您自己的目标和媒体 URL 允许 `connect-src` / `media-src`。

## SDK 专用开发入口

仅 SDK 软件包包含多文件模块（`shared/runtime/`）。它们可通过明确命名的 `@livemira/engine/development/...` 子路径访问：`sdk`、`browser`、`cpu`、`worker`、`mock`、`camera`、`renderer`、`renderer/perspective`、`media`、`target-compiler`、`recognition`、`tracking`、`compute`、`contracts`、`contracts/worker`、`target-quality`、`tracking-visuals` 和 `recognition-diagnostics`。它们用于需要各个独立模块的开发、测试以及打包工具配置。它们不是上述生产接口的一部分，不在本发布包中，并可能在任意版本中发生变动。不存在通配符导出，且没有任何已记录的生产导入依赖于内部目录。

## 支持范围

现有的识别和相机/媒体行为已在 iPhone 浏览器 Demo 集成中进行了测试。其他设备和环境均为试验性质。加载遮罩和圆形展开效果已在 iPhone Chrome Demo 中使用发布候选版本（release candidate）得到确认。0.2.1 将两项优化设为共享默认值：精确 WebAssembly 匹配与 BRIEF 采样位置复用。显式开启这两项的候选构建曾在两台标记为 14 PM 与 18 PM 的手机上实机测试（输入到结果 p95 约 55 → 28 ms 与 62 → 28 ms；测试者感觉差异很小或不明显；输入并非物理配对）。该证据仅被沿用而非重新标注：最终 0.2.1 产物未直接在手机上测试，打包后的默认值与该候选的一致性另经自动化比对核对。快速移动时的匹配丢失与横竖屏叠加层变形仍然存在。`productionReady` 为 false：稳定渠道并不意味着已完成全面的商业验证。

默认呈现方式使用 55% 黑色的加载层、旋转环以及边缘柔和的 420 ms 圆形展开效果。它会等待当前视频解码出第一帧；不需要下载整个视频。配置 `new CssVideoRenderSink({ geometryForResult, presentation: { revealMs: 420, loadingTimeoutMs: 15000, overlayOpacity: 0.55 } })`，或使用 `presentation: false` 将其禁用。减弱动态效果设置使用短暂的淡入淡出。请求代际可防止旧的回调展开已被替换或停止的视频。呈现状态转换可在现有的 `mediaState` 事件和数值日志导出中获取。

## 已知问题

横竖屏切换可能会使视频覆盖层发生变形。这在 0.2.1 中仍未解决。当需要保持一致的对齐时，请使用固定方向。

快速移动时匹配仍可能丢失。0.2.1 的默认值并不能解决此问题，也不声称主观效果有明显改善。

## CPU 默认值

自 0.2.1 起，省略 `cpuMatching` 和 `cpuFeatures` 时：

- 传统家族的精确汉明匹配器在 Worker 内以内嵌 WebAssembly 运行：SIMD 经验证并通过自检时使用 SIMD，否则使用标量模块，再否则使用 JavaScript 匹配器。能力信息的 `operators.matching` 报告 `wasm-simd`、`wasm-scalar` 或 `cpu`（回退时附带 `matchingFallback` 与 `fallbackReason: 'WASM_MATCHING_JS_FALLBACK'`）。字符串 `'wasm-experimental'` 作为该默认值的兼容写法保留；
- BRIEF 采样位置按每个金字塔层预先计算一次（`cpuFeatures: { briefOffsets: true }`；能力信息报告 `recognitionFeatures: 'cpu-brief-offsets'`）。部分指定或 `undefined` 的 `cpuFeatures` 使用同样的默认值。

可用 `cpuMatching: 'js'` 与 `cpuFeatures: { briefOffsets: false }` 关闭。结果、已编译目标以及算法和模式标识均不变。`backendPreference: 'webgpu'` 仍需显式开启并保留其自身匹配器（CPU WebAssembly 匹配器不应用于它）；oriented-v2 目标保持使用 JavaScript 匹配器。两台手机的输入到结果 p95 延迟分别从约 55 降至 28 ms、从 62 降至 28 ms；人工测试者感觉差异很小或不明显，且输入并非物理配对，因此这不是用户可见的修复。`productionReady` 仍为 false。

## 兼容性

- **补丁版本 (0.2.x)** 仅包含修复。它们保留上述每个生产入口（名称、文件角色和导出的 API），不改变目标模式（target schema），并且从不改变对已编译目标的解析方式。
- **次版本 (0.x.0)** 对生产接口而言严格为向后兼容的追加：可能会出现新的导出、选项或可选工具，而现有的生产入口保留其名称、文件角色和兼容行为。发布说明不能作为破坏兼容性的理由。移除或破坏稳定入口，或放弃可读取的目标格式，都需要建立新的主版本兼容性边界，或者在旧的稳定入口保持兼容的同时引入新的可选择加入（opt-in）的版本化入口。
- **开发入口** (`./development/...`) 不受这两条规则的约束。
- **目标模式。** 编译后的目标携带 `schemaVersion`、`compilerVersion` 和 `algorithmVersion`。这些算法和模式 ID 与软件包版本分开，不会因软件包发布而更改。引擎接受其在 `SUPPORTED_ALGORITHM_VERSIONS` 中列出的版本，拒绝任何其他版本，并且从不在单个引擎中混用算法版本。新的目标模式或算法版本会在次版本中与现有版本并存添加（可选择加入），并且所有先前可读取的目标格式在新的主版本边界之前保持可读。补丁版本和次版本从不需要重新编译目标。
- 布局约定（`release-layout.json`，`layoutVersion` 2）由生成器进行检查；分发版本始终随附构建它时所依据的约定。

## 许可证

原始 LiveMira 代码和文档在 Apache License 2.0（`LICENSE`）下获得许可；`NOTICE` 给出了该许可的归属和范围。嵌入的 WebAssembly 还包含上游代码，这些代码保留其自身的许可证且不重新许可：Emscripten、musl libc、LLVM libc++（带有 LLVM Exceptions 的 Apache-2.0，而非单纯的 Apache-2.0）以及 dlmalloc（公有领域）。未修改的文本位于 `shared/notices/` 中。
