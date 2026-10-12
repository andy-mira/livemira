# LiveMira 命名

[English](livemira-naming.md) | [简体中文](livemira-naming.zh-CN.md)

| 项目 | 名称 |
| --- | --- |
| 引擎品牌 | LiveMira |
| 根 npm 名称 | `livemira` |
| 工作区模块 | `@livemira/contracts`、`@livemira/sdk` 以及其他 `@livemira/*` 软件包 |
| 集成 SDK 软件包 | `@livemira/engine`（版本：根 `package.json`） |
| 稳定导入路径 | `@livemira/engine`、`/browser`、`/single`、`/single/min` 以及各工具名称；仅用于 SDK 的多文件模块使用 `/development/...` |
| 单文件核心 | `lm-engine.mjs` / `lm-engine.min.mjs` |
| 可选模块 | `lm-target-quality`、`lm-tracking-visuals`、`lm-recognition-diagnostics` |
| 发布目录与记录 | `livemira-*` / `lm-*` |

"WebAR" 描述的是技术类别，而非先前的品牌。算法 ID、目标包格式以及持久化或记录的兼容性键均保留其名称，以便现有数据保持可读。

保留其历史名称的兼容性键：`webar-local-evidence`（IndexedDB 归档数据库）；`webar-recognition-diagnostics/1`、`webar-demo-diagnostics-archive/1` 以及 `webar-phone-paired-performance{,-archive}/1`（日志格式）；`webar-target-quality/1`、`webar-target-quality/2` 以及 `webar-target-suitability`（评分数据与公式标识）。新的软件包名称、文件名、构建审计和接口标识符均使用 LiveMira / `lm-`。
