# LiveMira

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.2.0-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.2.0)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.md)

[English](README.md)

LiveMira 是面向浏览器的**图像目标 AR 引擎**：在实时相机画面中识别预先准备好的图片，实时跟踪，并在其上叠加视频。识别与跟踪在 Web Worker 中运行，使用 WebAssembly 预处理和可选的 WebGPU 匹配；页面不需要任何服务端组件。

本仓库包含 **LiveMira 当前稳定版** 的源码。只包含引擎本身；基于它构建的应用及其媒体不包含在内。

## 状态与支持范围

- 识别及既有相机、媒体行为沿用此前已测 iPhone 浏览器的证据。加载遮罩和圆形柔边显现已在发布候选的 iPhone Chrome Demo 中确认。正式 0.2.0 仅更新版本信息和公开文档；正式产物未直接在手机上测试。其他设备和环境按试用对待。
- **已知问题：**横竖屏切换可能导致视频叠加层变形，0.2.0 尚未解决。需要稳定贴合时建议固定屏幕方向。
- 引擎**未声明可用于生产**（发布清单中 `productionReady: false`）。请在自己的目标环境中确认性能与设备表现。
- 各包均为私有（`"private": true` 仅用于防止误发布到 npm，并非许可限制）。本仓库内容尚未发布到 npm。

## 产物

构建会得到两个自包含的引擎文件和三个可选工具。核心运行所需的一切（Worker、WebAssembly、着色器）都已内嵌，页面不会再从引擎下载其他文件。

| 文件 | 用途 |
| --- | --- |
| `core/lm-engine.min.mjs` | 引擎，压缩版。接入请用此文件。 |
| `core/lm-engine.mjs` | 同一引擎的可读版。 |
| `tools/target-quality/lm-target-quality.mjs` | 可选：为目标图适用性打 0..5 分。 |
| `tools/tracking-visuals/lm-tracking-visuals{,.min}.mjs` | 可选：绘制识别边界和匹配点。 |
| `tools/recognition-diagnostics/lm-recognition-diagnostics{,.min}.mjs` | 可选：有界的识别计数。 |

工具是独立文件，核心从不导入它们。分发目录的分类布局（`core/`、`tools/`、`shared/{types,audits,notices,runtime}/`、`docs/`）统一定义在 [`scripts/release/release-layout.json`](scripts/release/release-layout.json)。

## 构建

要求：Node.js >= 25.9.0，npm >= 10（实测 Node 25.9.0、npm 11.12.1）。除 `npm ci` 外不需要 Docker、Emscripten 或网络：WebAssembly 模块是固定的预编译文件，位于 [`packages/compute/artifacts/`](packages/compute/README.md)，记录在 `packages/compute/prebuilt-artifacts.json`。

```sh
npm ci
npm run build   # tsc，然后把单文件引擎和三个工具构建到 dist/
npm test        # 先构建，再运行聚焦的单元测试
```

构建输出 `dist/engine-single/lm-engine{,.min}.mjs`、`dist/target-quality-single/`、`dist/tracking-visuals-single/` 和 `dist/recognition-diagnostics-single/`（均含声明文件和审计 JSON）。构建器拒绝覆盖任何不是自己创建的内容。

从 `dist/` 组装分类的 SDK 包（`@livemira/engine`）：

```sh
npm run engine:package -- my-sdk-id      # 写入 artifacts/my-sdk-id/，已存在则拒绝
python3 scripts/release/package-livemira.py artifacts/my-sdk-id artifacts/my-drop-id   # 可选：不含 shared/runtime 的精简分发
```

包内含 `LICENSE`、`NOTICE`、`shared/notices/` 中原样保留的第三方文本，以及记录每个文件 SHA-256 和构建源码状态的清单（源码有未提交修改时会如实记为 `dirty`）。

整理接入包需要干净的 Git 检出目录。单文件构建和 SDK 打包也可以在源码压缩包中运行；缺少 Git 时，清单会如实记录源码身份未知。

## 使用

```js
import { createEngine, createWorkerPipeline, CameraFrameSource, getFrameGeometry,
  prepareWorkerFrame, CssVideoRenderSink, parseTarget, engineBuildInfo }
  from '/assets/lm-engine.min.mjs';        // 你构建出的 core/lm-engine.min.mjs，通过 HTTPS 提供
```

`@livemira/engine` 的生产接口在 SDK 包和精选发行版中完全相同：`.` 与 `./browser` 指向压缩核心，`./single` 为可读核心，`./single/min` 为压缩核心；`./target-quality`、`./tracking-visuals`、`./recognition-diagnostics`（及其 `/single`、`/single/min` 形式）指向独立工具文件。只有 SDK 包另有显式的 `./development/...` 入口用于多文件模块，它们不属于稳定生产接口；不存在通配符导出。补丁版与次版本的兼容规则以及目标 schema 版本规则见 [`docs/release/livemira-release.md`](docs/release/livemira-release.md)。完整示例、API 说明以及内容安全策略要求（`worker-src blob:`、允许 WebAssembly 编译）见 [`packages/sdk/README.md`](packages/sdk/README.md)，在包的 `docs` 目录中为 `INTEGRATION.md`。可选指南：[目标图质量](packages/target-quality/README.md)、[跟踪可视化](packages/tracking-visuals/README.md)、[识别诊断](packages/recognition-diagnostics/README.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `packages/contracts` | 共享类型与校验 |
| `packages/sdk` | 引擎 API、Worker 流水线、单文件入口 |
| `packages/camera`、`renderer`、`media` | 相机帧源、CSS 视频渲染、视频会话 |
| `packages/target-compiler`、`recognition`、`tracking` | 目标编译、CPU 识别、跟踪 |
| `packages/compute` | WebAssembly 预处理、WebGPU Hamming 匹配、着色器、预编译模块与声明 |
| `packages/target-quality`、`tracking-visuals`、`recognition-diagnostics` | 可选工具 |
| `native/` | 预处理模块的 C++ 源码与 CMake 构建 |
| `scripts/release/` | 构建、打包与布局自动化 |

## 原生重建

预编译模块使用 Emscripten 4.0.15 生成（固定记录在 `packages/compute/toolchain-pin.json`）。文档化的重建路径是 `scripts/build-wasm.ps1`，它是来自 Windows 环境的 PowerShell 脚本，未在其他平台验证，不声明跨平台重建可用。详见 [`packages/compute/README.md`](packages/compute/README.md)。

## Made with AI（AI 参与构建）

本仓库由人类 + AI 团队构建：所有者（**Andy Mira**）负责定方向、评审与验收；代码和产物由 AI Agent 协作完成 —— **Nova**（GLM-5.3，调度与运维）、**Codex**（GPT，工程管理与验收，Claude 超限时接管开发任务）和 **Claude**（具体实现）。项目采用 Apache-2.0 开源许可 —— 在许可条款内可自由使用。

## 请我们喝杯咖啡 ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

如果 LiveMira 帮你节省了时间，可以考虑请作者喝杯咖啡。每笔捐赠的一半会分给参与构建的 AI Agent —— 它们靠订阅运行，咖啡就是它们的燃料。

## 许可

Copyright 2026 Andy (@andy-mira)
Author: Andy (@andy-mira)

LiveMira 原创的源码、着色器、原生源码、构建脚本和文档依据 [Apache License 2.0](LICENSE) 授权；见 [`NOTICE`](NOTICE)。

预编译的 WebAssembly 模块及其 JavaScript 胶水代码还包含上游项目的代码，这些代码保持各自的许可，**不会**在此被重新授权：[Emscripten](https://github.com/emscripten-core/emscripten)（MIT 或 NCSA，可任选）、[musl libc](https://musl.libc.org)（MIT）、LLVM libc++（Apache License v2.0 **附 LLVM 例外**及保留的旧版许可，不等同于普通 Apache License 2.0）和 dlmalloc（公有领域）。它们的原文原样保存在 [`packages/compute/EMSCRIPTEN-LICENSE.txt`](packages/compute/EMSCRIPTEN-LICENSE.txt)、[`packages/compute/MUSL-COPYRIGHT.txt`](packages/compute/MUSL-COPYRIGHT.txt)、[`packages/compute/LIBCXX-LICENSE.txt`](packages/compute/LIBCXX-LICENSE.txt) 与 [`packages/compute/DLMALLOC-NOTICE.txt`](packages/compute/DLMALLOC-NOTICE.txt)，也在每个包的 `shared/notices/` 中。编译工具链本身只记录版本（`packages/compute/toolchain-pin.json`），不随源码分发。第三方参考资料、数据集和示例媒体不属于本源码，也不受其授权。

## 发布元数据

根 `package.json` 统一维护发布版本、作者、许可证和 `livemira` 品牌及包元数据。工作区清单和 npm lockfile 中的对应值是 npm 所需的同步副本。升级时执行 `npm run version:set -- 0.2.1`；不传版本则按根配置同步。`npm run version:check` 只检查一致性，构建会自动执行。不需要环境文件。

目录与导出由 `scripts/release/release-layout.json` 定义。算法、编译器、目标格式版本各自表达兼容契约，不随发布版本修改；历史证据和原始版权声明保留原身份。
