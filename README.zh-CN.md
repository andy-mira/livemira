# LiveMira

[English](README.md) | [简体中文](README.zh-CN.md)

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Engine](https://img.shields.io/badge/engine-0.5.0-orange.svg)](https://github.com/andy-mira/livemira/releases/tag/v0.5.0)
[![Docs](https://img.shields.io/badge/docs-EN%20%7C%20%E4%B8%AD%E6%96%87-informational.svg)](README.md)

引擎与相机界面已发布到 npm：`npm install @livemira/engine @livemira/ui`。预构建模块、npm 离线包、目标图评分和 Demo 见[0.5.0 发布版](release/0.5.0/README.zh-CN.md)。

LiveMira 是用于**图片目标 AR** 的浏览器引擎：在实时相机画面中识别预先准备好的图片，持续跟踪它，并在其上播放视频。识别与跟踪在设备上的 Web Worker 中运行；页面不需要服务端组件，也不上传任何内容。

**状态：** 0.5.0，新一代引擎：识别、跟踪与合成全部重写，引擎 API 也是新的。相机界面 `@livemira/ui` 保持 0.4.1 的接口。独立的评分模块 `@livemira/target-rating` 不加载引擎即可给图片作为识别目标的质量打分。见[升级说明](documentation/migration-0.4-to-0.5.zh-CN.md)与[变更记录](CHANGELOG.md)。

**兼容范围：** 验收目前覆盖 iPhone 浏览器（Safari 与 Chromium 系）的 Demo 与一个集成中的产品。Android 与应用内浏览器尚未验证。桌面浏览器的结果不能代表所有设备上的兼容性与性能。

## 使用

```js
import { createEngine, compileTargetImage } from './livemira-engine.min.mjs';

const engine = createEngine({ container: document.getElementById('stage') });
const target = await compileTargetImage(file); // 也可以先评分：@livemira/target-rating
await engine.setTargets([{ targetId: 'poster', target, media: { url: './poster.mp4' } }]);
startButton.onclick = () => engine.start();
```

相机界面 `@livemira/ui` 在引擎之上挂载全屏扫描视图，接口与 0.4.1 相同；见[相机界面指南](documentation/ui.zh-CN.md)与[目标图评分指南](documentation/target-rating.zh-CN.md)。

## 构建与试用

要求：Node.js ≥ 22.18（直接运行 TypeScript）。构建 WebAssembly 内核另需 Rust 工具链与 `wasm32-unknown-unknown` 目标；普通检出不装 Rust 也能构建和测试——`npm run check:kernels` 校验的是已嵌入的内核。

```sh
npm install
npm run check        # 格式、类型、基线副本、内核、测试
```

构建发布包（输出到 `release/livemira-<版本>`，含校验和与 npm 离线包）：

```sh
npm run build:kernels   # 仅内核变更时需要（需 Rust）
node tools/release.ts
```

试用：把 `release/0.5.0/demo/` 以 HTTPS 或 localhost 提供；相机需要安全上下文与用户授权。示例用的目标图不在本仓库中：可按其中 `demo.js` 里的文件名把图片放进它的 `assets/`，或等下个版本附带的新目标图。

## 仓库结构

产品代码与工程侧（基准套件、真机测试工具、发布工具）在同一个工作区。

| 路径                                           | 内容                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------- |
| `packages/contracts`                           | 共享类型：图像、时间、位姿、模块元数据、层接口                      |
| `packages/geometry`、`filters`、`imaging`      | 鲁棒几何（PROSAC/MSAC/LO/LM）、卡尔曼与 One Euro 滤波、金字塔与采样 |
| `packages/tracking`                            | ESM（默认快环）、KLT、NCC、双环编排与重定位                         |
| `packages/features`                            | 定向多尺度二进制特征、视角合成编译器、WASM SIMD 匹配器              |
| `packages/web`                                 | 浏览器层：能力探测、相机采集路径、方向处理、引擎档位                |
| `packages/engine`（`@livemira/engine`）        | 相机会话生命周期、编译 Worker 池、帧锁定视频平面                    |
| `packages/ui`（`@livemira/ui`）                | 相机界面；保持 0.4.1 接口                                           |
| `packages/rating`（`@livemira/target-rating`） | 目标图评分：自带 Worker，不需要引擎                                 |
| `kernels/vision`                               | Rust → WebAssembly SIMD 内核（Hamming 匹配、FAST-9 打分）           |
| `demo/`                                        | 发布包中的示例站                                                    |
| `bench/`                                       | 基准套件（合成场景、基线适配器、评分）与真机测试工具                |
| `documentation/`                               | 集成指南：相机界面、目标图评分、迁移                                |
| `tools/`、`docs/release/`                      | 构建、同步与检查工具；发布包的说明源文件（README、指南、发布说明）  |
| `release/`                                     | 已发布的版本（源码构建的产物与校验和）                              |

依赖方向：`bench → packages/* → contracts`。产品包不导入 `bench`。

基准所对比的基线（0.4.1 引擎）不参与构建与测试：没有它时基准回退到已记录的结果（环境变量 `LIVEMIRA_BASELINE` 可指定位置）。

## 参与贡献

改动以 `npm run check` 通过为准。安全问题请通过 [GitHub 安全公告](https://github.com/andy-mira/livemira/security/advisories/new) 私下报告。

## 许可

版权所有 2026 Andy (@andy-mira)。依据 [Apache License 2.0](LICENSE) 授权；见 [NOTICE](docs/release/NOTICE)。

## Made with AI

本仓库由人 + AI 团队构建：所有者 **Andy (@andy-mira)** 定方向、审查并验收；代码与产物由 AI Agent 协作完成 —— **Nova**（orchestration & ops，调度与运维）、**Codex**（engineering management & acceptance，工程管理与验收，Claude 达到额度上限时接手开发）和 **Claude**（implementation，实现）。项目以 Apache-2.0 开源，可在许可条款内自由使用。

## 请作者喝杯咖啡 ☕

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/andymira)

如果 LiveMira 帮你省了时间，可以考虑请作者喝杯咖啡。这个项目由 AI Agent 协作建成——你的支持能让人 + AI 团队继续做下去。
