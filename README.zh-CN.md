# LiveMira

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.4.1-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.4.1)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.md)

预构建模块、npm 离线包和 Demo 见[0.4.1 发布版](release/0.4.1/README.zh-CN.md)。

LiveMira 是用于**图片目标 AR** 的浏览器引擎：在实时相机画面中识别预先准备好的图片，持续跟踪它，并在其上播放视频。识别与跟踪在设备上的 Web Worker 中运行；页面不需要服务端组件，也不上传任何内容。

**状态：** 0.4.1。提供浏览器内图像目标识别、跟踪、视频叠加与可选相机界面。相机需要安全上下文与用户授权。

**兼容性限制：** 相机界面尚未经真机验收；Android 与应用内浏览器尚未验证。桌面浏览器结果不代表所有设备上的兼容性或性能。

## 使用

```js
import { createEngine, parseTarget } from './livemira-engine.min.mjs';

const engine = createEngine({ container: document.getElementById('stage') });
await engine.setTargets([{ target: await parseTarget(text), media: { url: './poster.mp4' } }]);
startButton.onclick = () => engine.start();
```

[集成指南](packages/sdk/README.zh-CN.md)介绍选项、事件、目标、媒体、诊断、扩展、内容安全策略与浏览器要求。从 0.2.x 升级请看[迁移说明](documentation/migration-0.2-to-0.3.zh-CN.md)。

## 构建与试用

要求：Node.js ≥ 25.9。除 `npm ci` 外不需要联网。

```sh
npm ci
npm run build   # dist/：单文件引擎、Worker 文件、扩展与 Demo 站点
npm run dev     # 构建 Demo 并在 http://127.0.0.1:5173/ 提供
npm run check   # 格式、lint、类型、API、版本、结构、内容与 WebAssembly 检查、测试
```

| 产物                                            |                                                      |
| ----------------------------------------------- | ---------------------------------------------------- |
| `dist/livemira-engine.min.mjs`                  | 引擎：单个 ES 模块，内嵌 Worker 与 WebAssembly。     |
| `dist/livemira-engine.mjs`                      | 同一引擎的可读版本。                                 |
| `dist/livemira-engine-worker.min.mjs`           | Worker 文件，供 CSP 禁止 `blob:` Worker 的页面使用。 |
| `dist/livemira-tracking-visuals.min.mjs`        | 可选：绘制识别边框与匹配点。                         |
| `dist/livemira-recognition-diagnostics.min.mjs` | 可选：有界的识别统计。                               |
| `dist/livemira-target-quality.min.mjs`          | 可选：为图片作为目标的适合程度打分（0..5）。         |
| `dist/livemira-ui.min.mjs`                      | 可选：全屏[相机界面](packages/ui/README.zh-CN.md)。  |
| `dist/demo/`                                    | 静态站点形式的 [Demo](apps/demo/README.zh-CN.md)。   |
| `dist/livemira-*.d.ts`                          | 合并后的声明，每个模块一份。                         |
| `dist/packages/`                                | 每个模块一个可发布的 npm 包目录。                    |

构建可复现：相同源码得到相同字节，`engineBuildInfo.buildId` 标识构建。

## 仓库结构

| 路径                                                                     | 内容                                                        |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `packages/contracts`                                                     | 共享类型、错误与校验                                        |
| `packages/compute`                                                       | 灰度转换、标准图、精确汉明匹配（JavaScript 与 WebAssembly） |
| `packages/recognition`、`tracking`、`target-compiler`                    | 识别、跟踪、目标编译                                        |
| `packages/camera`、`media`、`renderer`                                   | 相机帧来源与预览、视频会话、叠加层渲染                      |
| `packages/diagnostics`                                                   | 两级诊断日志                                                |
| `packages/sdk`                                                           | `@livemira/engine`：组装、调度、事件、Worker 协议与运行时   |
| `packages/tracking-visuals`、`recognition-diagnostics`、`target-quality` | 可选扩展                                                    |
| `packages/ui`                                                            | `@livemira/ui`：基于引擎公开 API 的可选全屏相机界面         |
| `apps/page-shell`、`apps/demo`                                           | 全屏页面外壳与公开 Demo                                     |
| `tools`、`tests`                                                         | 构建工具、结构检查、浏览器探针                              |

## 参与开发

见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。安全问题请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 私下报告。

## 许可

Copyright 2026 Andy (@andy-mira)。采用 [Apache License 2.0](LICENSE) 许可，见 [NOTICE](NOTICE)。Demo 中的示例照片是其作者的 CC0 作品（[来源](apps/demo/assets/CREDITS.md)）。

## Made with AI（AI 参与构建）

本仓库由人类 + AI 团队构建：所有者（**Andy (@andy-mira)**）负责定方向、评审与验收；代码和产物由 AI Agent 协作完成 —— **Nova**（调度与运维）、**Codex**（工程管理与验收，Claude 超限时接管开发任务）和 **Claude**（具体实现）。项目采用 Apache-2.0 开源许可 —— 在许可条款内可自由使用。

## 请作者喝杯咖啡 ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

如果 LiveMira 帮你节省了时间，可以考虑请作者喝杯咖啡。本项目由人类 + AI 团队构建——你的支持会帮助这个团队继续开发下去。
